const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');

const packageRoot = path.resolve(__dirname, '..');
const migrationName = '20261004010000_ai_data_foundation';
const cli = path.join(packageRoot, 'node_modules/prisma/build/index.js');
function deploy(config, cwd, url) {
  const result = spawnSync(
    process.execPath,
    [cli, 'migrate', 'deploy', '--config', config],
    {
      cwd,
      env: { ...process.env, DATABASE_URL: url },
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    },
  );
  // Do not emit connection strings or credentials on migration failure.
  assert.equal(result.status, 0, 'Prisma migration deployment failed.');
}

test('Phase 3 to Phase 4 additive upgrade preserves jobs, originals and receipts without backfill', async () => {
  const url = process.env.TEST_MIGRATION_DATABASE_URL;
  assert.ok(url, 'Use an empty disposable TEST_MIGRATION_DATABASE_URL.');
  assert.match(new URL(url).pathname, /test/i);
  const client = new Client({ connectionString: url });
  await client.connect();
  let temporaryRoot;
  try {
    const existing = await client.query(
      "SELECT count(*)::int AS count FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p','v','m')",
    );
    assert.equal(existing.rows[0].count, 0, 'Test database must be empty.');
    temporaryRoot = fs.mkdtempSync(path.join(packageRoot, '.ai-migration-'));
    const target = path.join(temporaryRoot, 'prisma/migrations');
    fs.mkdirSync(target, { recursive: true });
    fs.copyFileSync(
      path.join(packageRoot, 'prisma/schema.prisma'),
      path.join(temporaryRoot, 'prisma/schema.prisma'),
    );
    for (const entry of fs.readdirSync(
      path.join(packageRoot, 'prisma/migrations'),
      { withFileTypes: true },
    )) {
      if (entry.isDirectory() && entry.name >= migrationName) continue;
      const source = path.join(packageRoot, 'prisma/migrations', entry.name);
      if (entry.isDirectory())
        fs.cpSync(source, path.join(target, entry.name), { recursive: true });
      else if (entry.isFile())
        fs.copyFileSync(source, path.join(target, entry.name));
    }
    const config = path.join(temporaryRoot, 'prisma.config.mjs');
    fs.writeFileSync(
      config,
      "import {defineConfig} from 'prisma/config';\nexport default defineConfig({schema:'prisma/schema.prisma',migrations:{path:'prisma/migrations'},datasource:{url:process.env.DATABASE_URL??''}});\n",
    );
    deploy(config, temporaryRoot, url);
    const owner = (
      await client.query('INSERT INTO users(email) VALUES($1) RETURNING id', [
        `${randomUUID()}@example.invalid`,
      ])
    ).rows[0].id;
    const document = (
      await client.query(
        "INSERT INTO documents(user_id,title,description) VALUES($1,'Existing Phase 3','Preserved') RETURNING id",
        [owner],
      )
    ).rows[0].id;
    const version = (
      await client.query(
        "INSERT INTO document_versions(document_id,user_id,version_number,original_filename,storage_key,mime_type,file_size,checksum_sha256) VALUES($1,$2,1,'old.png',$3,'image/png',12,$4) RETURNING id",
        [document, owner, `test/${randomUUID()}`, 'a'.repeat(64)],
      )
    ).rows[0].id;
    const job = randomUUID();
    const message = randomUUID();
    const correlation = randomUUID();
    const key = randomUUID();
    await client.query(
      "INSERT INTO processing_jobs(id,user_id,document_id,document_version_id,job_type,max_attempts,correlation_id,status,attempts,last_failure_code) VALUES($1,$2,$3,$4,'VERIFY_STORED_FILE',3,$5,'RETRYING',1,'STORAGE_READ_FAILED')",
      [job, owner, document, version, correlation],
    );
    const now = new Date().toISOString();
    const envelope = {
      schemaVersion: 1,
      messageId: message,
      type: 'processing.execute',
      occurredAt: now,
      correlationId: correlation,
      jobId: job,
      documentId: document,
      documentVersionId: version,
      jobType: 'VERIFY_STORED_FILE',
      dispatchSequence: 1,
    };
    await client.query(
      "INSERT INTO processing_outbox(id,processing_job_id,event_type,schema_version,dispatch_sequence,payload,correlation_id,occurred_at) VALUES($1,$2,'processing.execute',1,1,$3,$4,$5)",
      [message, job, envelope, correlation, now],
    );
    await client.query(
      "INSERT INTO document_uploads(user_id,scope,key,attempt_id,state,fingerprint,document_id,response,expires_at) VALUES($1,'create',$2,$3,'COMPLETED',$4,$5,$6,CURRENT_TIMESTAMP+INTERVAL '1 day')",
      [
        owner,
        key,
        randomUUID(),
        'b'.repeat(64),
        document,
        { data: { id: document } },
      ],
    );
    const snapshot = async () => {
      const rows = {};
      for (const table of [
        'documents',
        'document_versions',
        'document_uploads',
        'processing_outbox',
      ]) {
        rows[table] = (
          await client.query(`SELECT row_to_json(t) AS row FROM ${table} t`)
        ).rows;
      }
      rows.processing_jobs = (
        await client.query(
          'SELECT row_to_json(t) AS row FROM processing_jobs t',
        )
      ).rows;
      return rows;
    };
    const before = await snapshot();
    deploy(path.join(packageRoot, 'prisma.config.ts'), packageRoot, url);
    const after = await snapshot();
    const upgradedJob = after.processing_jobs[0].row;
    for (const field of [
      'ai_run_id',
      'predecessor_job_id',
      'extracted_text_id',
      'chunk_set_id',
      'vector_index_id',
    ]) {
      assert.equal(upgradedJob[field], null);
      delete upgradedJob[field];
    }
    assert.deepEqual(after, before);
    for (const table of [
      'embedding_profiles',
      'ai_processing_runs',
      'extracted_texts',
      'chunk_sets',
      'document_chunks',
      'chunk_embeddings',
      'version_vector_indexes',
      'version_ai_states',
      'version_ready_indexes',
      'ai_serving_profile',
    ]) {
      assert.equal(
        (await client.query(`SELECT count(*)::int AS count FROM ${table}`))
          .rows[0].count,
        0,
        table,
      );
    }
    deploy(path.join(packageRoot, 'prisma.config.ts'), packageRoot, url);
    assert.equal(
      (
        await client.query(
          'SELECT count(*)::int AS count FROM _prisma_migrations WHERE migration_name=$1 AND finished_at IS NOT NULL',
          [migrationName],
        )
      ).rows[0].count,
      1,
    );
    // Ordinary transaction rollback must leave no artifact rows behind.
    await client.query('BEGIN');
    await client.query(
      "INSERT INTO extracted_texts(user_id,document_id,document_version_id,extraction_fingerprint,extractor,extractor_version,normalization_version,source_checksum,content_hash,text,page_spans,character_count,page_count) VALUES($1,$2,$3,$4,'test','v1','v1',$4,$4,'a',$5,1,1)",
      [
        owner,
        document,
        version,
        'a'.repeat(64),
        JSON.stringify([{ pageNumber: 1, startOffset: 0, endOffset: 1 }]),
      ],
    );
    await client.query('ROLLBACK');
    assert.equal(
      (await client.query('SELECT count(*)::int AS count FROM extracted_texts'))
        .rows[0].count,
      0,
    );
  } finally {
    await client.end();
    if (temporaryRoot && path.dirname(temporaryRoot) === packageRoot)
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
