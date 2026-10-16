const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');
const { createPrismaClient, SearchPersistenceRepository } = require('../dist');

test('T02 to T03 upgrade preserves enrolled rows and does not enroll or publish work', async () => {
  const url = process.env.TEST_SEARCH_ENROLLMENT_MIGRATION_DATABASE_URL;
  assert.ok(
    url,
    'Use an empty disposable TEST_SEARCH_ENROLLMENT_MIGRATION_DATABASE_URL.',
  );
  assert.match(new URL(url).pathname, /test/i);
  const root = path.resolve(__dirname, '..');
  const client = new Client({ connectionString: url });
  await client.connect();
  const db = createPrismaClient({
    url,
    connectTimeoutMs: 2000,
    queryTimeoutMs: 8000,
    poolSize: 2,
  });
  let temporary;
  function deploy(config, cwd) {
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, 'node_modules/prisma/build/index.js'),
        'migrate',
        'deploy',
        '--config',
        config,
      ],
      {
        cwd,
        env: { ...process.env, DATABASE_URL: url },
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
      },
    );
    assert.equal(result.status, 0, 'Migration deployment failed.');
  }
  try {
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::int AS n FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r'",
        )
      ).rows[0].n,
      0,
    );
    temporary = fs.mkdtempSync(
      path.join(root, '.search-enrollment-migration-'),
    );
    const target = path.join(temporary, 'prisma/migrations');
    fs.mkdirSync(target, { recursive: true });
    fs.copyFileSync(
      path.join(root, 'prisma/schema.prisma'),
      path.join(temporary, 'prisma/schema.prisma'),
    );
    for (const entry of fs.readdirSync(path.join(root, 'prisma/migrations'), {
      withFileTypes: true,
    })) {
      if (
        entry.isDirectory() &&
        entry.name >= '20261014010000_search_lifecycle_fencing'
      )
        continue;
      fs.cpSync(
        path.join(root, 'prisma/migrations', entry.name),
        path.join(target, entry.name),
        { recursive: entry.isDirectory() },
      );
    }
    const config = path.join(temporary, 'prisma.config.mjs');
    fs.writeFileSync(
      config,
      "import {defineConfig} from 'prisma/config';\nexport default defineConfig({schema:'prisma/schema.prisma',migrations:{path:'prisma/migrations'},datasource:{url:process.env.DATABASE_URL??''}});\n",
    );
    deploy(config, temporary);
    const search = new SearchPersistenceRepository(db),
      key = randomUUID();
    const g = await search.createGeneration({
      generation: 1,
      schemaVersion: 1,
      mappingVersion: key,
      analyzerVersion: 'v1',
      extractor: 'pdf',
      extractorVersion: 'v1',
      normalizationVersion: 'nfc-lf-v1',
      segmentationVersion: 'v1',
      metadataIndexName: 'qyvra-search-' + key + '-metadata',
      pageIndexName: 'qyvra-search-' + key + '-pages',
    });
    const u = await db.user.create({
      data: { email: key + '@example.invalid' },
    });
    const d = await db.document.create({
      data: { userId: u.id, title: 'Upgrade fixture' },
    });
    const v = await db.documentVersion.create({
      data: {
        userId: u.id,
        documentId: d.id,
        versionNumber: 1,
        originalFilename: 'fixture.png',
        mimeType: 'image/png',
        fileSize: 12,
        storageKey: 'test/' + key,
        checksumSha256: 'a'.repeat(64),
      },
    });
    const owned = { userId: u.id, documentId: d.id, documentVersionId: v.id };
    await db.$transaction(async (tx) => {
      await search.initializeStateInTransaction(tx, owned);
      const p = await search.createProjectionInTransaction(tx, {
        ...owned,
        indexGenerationId: g.id,
        revision: 1,
        metadataHash: createHash('sha256')
          .update('T02 opaque hash')
          .digest('hex'),
      });
      await search.createJobInTransaction(tx, {
        ...owned,
        searchProjectionId: p.id,
        jobType: 'INDEX_SEARCH',
        maxAttempts: 5,
        correlationId: randomUUID(),
      });
      await search.createChangeInTransaction(tx, {
        id: randomUUID(),
        userId: u.id,
        resourceId: randomUUID(),
        reason: 'TAG_DELETED',
      });
    });
    const tables = [
      'users',
      'documents',
      'document_versions',
      'search_index_generations',
      'document_search_states',
      'version_search_projections',
      'search_projection_changes',
      'processing_jobs',
      'processing_outbox',
    ];
    async function snapshot() {
      const rows = {};
      for (const table of tables)
        rows[table] = (
          await client
            .query(
              `SELECT row_to_json(t) AS row FROM ${table} t ORDER BY id`,
              [],
            )
            .catch(async (error) => {
              if (table === 'document_search_states')
                return client.query(
                  'SELECT row_to_json(t) AS row FROM document_search_states t ORDER BY document_id',
                );
              throw error;
            })
        ).rows;
      return rows;
    }
    const before = await snapshot();
    deploy(path.join(root, 'prisma.config.ts'), root);
    assert.ok(
      JSON.stringify(await snapshot()) === JSON.stringify(before),
      'T02 rows must remain unchanged.',
    );
    const canonical = (
      await client.query('SELECT search_metadata_hash($1::uuid) AS hash', [
        v.id,
      ])
    ).rows[0].hash;
    assert.match(canonical, /^[0-9a-f]{64}$/);
    deploy(path.join(root, 'prisma.config.ts'), root);
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::int AS n FROM _prisma_migrations WHERE migration_name='20261014010000_search_lifecycle_fencing' AND finished_at IS NOT NULL",
        )
      ).rows[0].n,
      1,
    );
  } finally {
    await db.$disconnect();
    await client.end();
    if (temporary && path.dirname(temporary) === root)
      fs.rmSync(temporary, { recursive: true, force: true });
  }
});
