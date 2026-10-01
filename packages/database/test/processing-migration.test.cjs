const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');

const packageRoot = path.resolve(__dirname, '..');
const migrationName = '20260927010000_processing_persistence';
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

test('upgrades a v1.1.0 database without changing existing documents or receipts', async () => {
  const databaseUrl = process.env.TEST_MIGRATION_DATABASE_URL;
  assert.ok(
    databaseUrl,
    'Set TEST_MIGRATION_DATABASE_URL to an empty, disposable PostgreSQL test database.',
  );
  assert.match(new URL(databaseUrl).pathname.slice(1), /test/i);
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
      path.join(packageRoot, '.processing-migration-'),
    );
    const temporaryPrisma = path.join(temporaryRoot, 'prisma');
    const temporaryMigrations = path.join(temporaryPrisma, 'migrations');
    fs.mkdirSync(temporaryMigrations, { recursive: true });
    fs.copyFileSync(
      path.join(packageRoot, 'prisma', 'schema.prisma'),
      path.join(temporaryPrisma, 'schema.prisma'),
    );
    for (const entry of fs.readdirSync(migrations, { withFileTypes: true })) {
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

    const owner = (
      await client.query('INSERT INTO users (email) VALUES ($1) RETURNING id', [
        `${randomUUID()}@example.invalid`,
      ])
    ).rows[0].id;
    const document = (
      await client.query(
        'INSERT INTO documents (user_id, title, description) VALUES ($1, $2, $3) RETURNING id',
        [owner, 'Existing v1.1.0 document', 'Owner description'],
      )
    ).rows[0].id;
    const version = (
      await client.query(
        `INSERT INTO document_versions
          (document_id, user_id, version_number, original_filename, storage_key,
           mime_type, file_size, checksum_sha256)
         VALUES ($1, $2, 1, 'original.png', $3, 'image/png', 12, $4) RETURNING id`,
        [document, owner, `test/${randomUUID()}`, 'a'.repeat(64)],
      )
    ).rows[0].id;
    const receiptKey = randomUUID();
    const receipt = { data: { id: document, version: { id: version } } };
    await client.query(
      `INSERT INTO document_uploads
        (user_id, scope, key, attempt_id, state, fingerprint, document_id,
         response, expires_at)
       VALUES ($1, 'create', $2, $3, 'COMPLETED', $4, $5, $6,
         CURRENT_TIMESTAMP + INTERVAL '1 day')`,
      [owner, receiptKey, randomUUID(), 'b'.repeat(64), document, receipt],
    );

    deploy(
      path.join(packageRoot, 'prisma.config.ts'),
      packageRoot,
      databaseUrl,
    );
    const preserved = await client.query(
      `SELECT d.title, d.description, d.status, d.is_archived,
              v.id AS version_id, v.extraction_status, u.response
       FROM documents d
       JOIN document_versions v ON v.document_id = d.id
       JOIN document_uploads u ON u.document_id = d.id
       WHERE d.id = $1 AND u.key = $2`,
      [document, receiptKey],
    );
    assert.deepEqual(preserved.rows, [
      {
        title: 'Existing v1.1.0 document',
        description: 'Owner description',
        status: 'UPLOADED',
        is_archived: false,
        version_id: version,
        extraction_status: 'PENDING',
        response: receipt,
      },
    ]);

    const tables = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('processing_jobs', 'processing_outbox')
      ORDER BY table_name
    `);
    assert.deepEqual(
      tables.rows.map((row) => row.table_name),
      ['processing_jobs', 'processing_outbox'],
    );
    const indexes = await client.query(`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN (
          'document_versions_id_document_id_user_id_key',
          'processing_jobs_one_active_version_type_key',
          'processing_jobs_status_available_at_id_idx',
          'processing_outbox_status_available_at_id_idx',
          'processing_jobs_owner_version_created_idx',
          'processing_outbox_job_type_sequence_key'
        )
    `);
    assert.equal(indexes.rows.length, 6);
    deploy(
      path.join(packageRoot, 'prisma.config.ts'),
      packageRoot,
      databaseUrl,
    );
  } finally {
    await client.end();
    if (temporaryRoot && path.dirname(temporaryRoot) === packageRoot)
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
