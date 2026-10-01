const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');

const packageRoot = path.resolve(__dirname, '..');
const migrationName = '20260924010000_document_description';
const migrations = path.join(packageRoot, 'prisma', 'migrations');
const prismaCli = path.join(
  packageRoot,
  'node_modules',
  'prisma',
  'build',
  'index.js',
);

function deploy(config, cwd, databaseUrl) {
  const result = spawnSync(
    process.execPath,
    [prismaCli, 'migrate', 'deploy', '--config', config],
    {
      cwd,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    },
  );
  assert.equal(result.status, 0, 'Prisma migrate deploy failed');
}

test('upgrades an existing Phase 1 database without losing document data', async () => {
  const databaseUrl = process.env.TEST_MIGRATION_DATABASE_URL;
  assert.ok(
    databaseUrl,
    'Set TEST_MIGRATION_DATABASE_URL to an empty, disposable PostgreSQL test database.',
  );
  const databaseName = new URL(databaseUrl).pathname.slice(1);
  assert.match(databaseName, /test/i, 'Use a named test database.');
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  let temporaryRoot;
  try {
    const existing = await client.query(`
      SELECT count(*)::int AS count FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p', 'v', 'm')
    `);
    assert.equal(existing.rows[0].count, 0, 'Test database must be empty.');

    temporaryRoot = fs.mkdtempSync(
      path.join(packageRoot, '.description-migration-'),
    );
    const temporaryPrisma = path.join(temporaryRoot, 'prisma');
    const temporaryMigrations = path.join(temporaryPrisma, 'migrations');
    fs.mkdirSync(temporaryMigrations, { recursive: true });
    fs.copyFileSync(
      path.join(packageRoot, 'prisma', 'schema.prisma'),
      path.join(temporaryPrisma, 'schema.prisma'),
    );
    for (const entry of fs.readdirSync(migrations, { withFileTypes: true })) {
      // Keep this historical v1.0-to-v1.1 upgrade baseline free of later migrations.
      if (entry.isDirectory() && entry.name >= migrationName) continue;
      const source = path.join(migrations, entry.name);
      const target = path.join(temporaryMigrations, entry.name);
      if (entry.isDirectory()) fs.cpSync(source, target, { recursive: true });
      else if (entry.isFile()) fs.copyFileSync(source, target);
    }
    const baselineConfig = path.join(temporaryRoot, 'prisma.config.mjs');
    fs.writeFileSync(
      baselineConfig,
      `import { defineConfig } from 'prisma/config';\n` +
        `export default defineConfig({ schema: 'prisma/schema.prisma', migrations: { path: 'prisma/migrations' }, datasource: { url: process.env.DATABASE_URL ?? '' } });\n`,
    );
    deploy(baselineConfig, temporaryRoot, databaseUrl);
    const beforeColumn = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'documents'
        AND column_name = 'description'
    `);
    assert.equal(beforeColumn.rows.length, 0);

    const owner = (
      await client.query('INSERT INTO users (email) VALUES ($1) RETURNING id', [
        `${randomUUID()}@example.invalid`,
      ])
    ).rows[0].id;
    const category = (
      await client.query(
        'INSERT INTO categories (user_id, name) VALUES ($1, $2) RETURNING id',
        [owner, 'Migration category'],
      )
    ).rows[0].id;
    const tag = (
      await client.query(
        'INSERT INTO tags (user_id, name) VALUES ($1, $2) RETURNING id',
        [owner, 'Migration tag'],
      )
    ).rows[0].id;
    const document = (
      await client.query(
        'INSERT INTO documents (user_id, title, category_id) VALUES ($1, $2, $3) RETURNING id',
        [owner, 'Existing Phase 1 document', category],
      )
    ).rows[0].id;
    await client.query(
      'INSERT INTO document_tags (document_id, tag_id, user_id) VALUES ($1, $2, $3)',
      [document, tag, owner],
    );
    const version = (
      await client.query(
        `INSERT INTO document_versions
         (document_id, user_id, version_number, original_filename, storage_key,
          mime_type, file_size, checksum_sha256)
         VALUES ($1, $2, 1, 'original.png', $3, 'image/png', 12, $4) RETURNING id`,
        [document, owner, `test/${randomUUID()}`, 'a'.repeat(64)],
      )
    ).rows[0].id;

    deploy(
      path.join(packageRoot, 'prisma.config.ts'),
      packageRoot,
      databaseUrl,
    );
    const column = await client.query(`
      SELECT is_nullable, character_maximum_length
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'documents'
        AND column_name = 'description'
    `);
    assert.deepEqual(column.rows, [
      { is_nullable: 'YES', character_maximum_length: 2000 },
    ]);
    const preserved = await client.query(
      `SELECT d.title, d.description, d.category_id,
              dt.tag_id, v.id AS version_id
       FROM documents d
       JOIN document_tags dt ON dt.document_id = d.id
       JOIN document_versions v ON v.document_id = d.id
       WHERE d.id = $1`,
      [document],
    );
    assert.equal(preserved.rows.length, 1);
    assert.equal(preserved.rows[0].title, 'Existing Phase 1 document');
    assert.equal(preserved.rows[0].description, null);
    assert.equal(preserved.rows[0].category_id, category);
    assert.equal(preserved.rows[0].tag_id, tag);
    assert.equal(preserved.rows[0].version_id, version);

    const withoutDescription = await client.query(
      'INSERT INTO documents (user_id, title, description) VALUES ($1, $2, NULL) RETURNING description',
      [owner, 'New document'],
    );
    assert.equal(withoutDescription.rows[0].description, null);
    await client.query('UPDATE documents SET description = $1 WHERE id = $2', [
      'Project requirements',
      document,
    ]);
    deploy(
      path.join(packageRoot, 'prisma.config.ts'),
      packageRoot,
      databaseUrl,
    );
    const retained = await client.query(
      'SELECT description FROM documents WHERE id = $1',
      [document],
    );
    assert.equal(retained.rows[0].description, 'Project requirements');

    await assert.rejects(
      client.query('INSERT INTO documents (user_id, title) VALUES ($1, NULL)', [
        owner,
      ]),
      { code: '23502' },
    );
    await assert.rejects(
      client.query('UPDATE documents SET description = $1 WHERE id = $2', [
        ' padded ',
        document,
      ]),
      { code: '23514' },
    );
    await assert.rejects(
      client.query('UPDATE documents SET category_id = $1 WHERE id = $2', [
        randomUUID(),
        document,
      ]),
      { code: '23503' },
    );
  } finally {
    await client.end();
    if (temporaryRoot && path.dirname(temporaryRoot) === packageRoot)
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
