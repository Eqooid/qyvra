const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { embeddingProfileFingerprint } = require('../dist');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');

const packageRoot = path.resolve(__dirname, '..');
const migrationName = '20261013010000_search_persistence';
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

test('v1.3.1 to Phase 5 additive upgrade preserves prior rows with no search backfill', async () => {
  const url = process.env.TEST_SEARCH_MIGRATION_DATABASE_URL;
  assert.ok(url, 'Use an empty disposable TEST_SEARCH_MIGRATION_DATABASE_URL.');
  assert.match(new URL(url).pathname, /test/i);
  const client = new Client({ connectionString: url });
  await client.connect();
  let temporaryRoot;
  try {
    const existing = await client.query(
      "SELECT count(*)::int AS count FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p','v','m')",
    );
    assert.equal(existing.rows[0].count, 0, 'Test database must be empty.');
    temporaryRoot = fs.mkdtempSync(
      path.join(packageRoot, '.search-migration-'),
    );
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
    await client.query(
      "INSERT INTO user_identities(user_id,provider,issuer,subject) VALUES($1,'LOCAL','local',$2)",
      [owner, owner],
    );
    // Synthetic auth hashes only; never include them in diagnostic output.
    await client.query(
      "INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES($1,$2,CURRENT_TIMESTAMP + INTERVAL '1 hour')",
      [owner, createHash('sha256').update(randomUUID()).digest('hex')],
    );
    const document = (
      await client.query(
        "INSERT INTO documents(user_id,title,description) VALUES($1,'Existing v1.3.1','Preserved') RETURNING id",
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
    const pdf = (
      await client.query(
        "INSERT INTO document_versions(document_id,user_id,version_number,original_filename,storage_key,mime_type,file_size,page_count,checksum_sha256) VALUES($1,$2,2,'old.pdf',$3,'application/pdf',12,1,$4) RETURNING id",
        [document, owner, 'test/' + randomUUID(), 'c'.repeat(64)],
      )
    ).rows[0].id;
    await client.query(
      "INSERT INTO extracted_texts(user_id,document_id,document_version_id,extraction_fingerprint,extractor,extractor_version,normalization_version,source_checksum,content_hash,text,page_spans,character_count,page_count) VALUES($1,$2,$3,$4,'pdf','v1','nfc-lf-v1',$5,$6,'A',$7,1,1)",
      [
        owner,
        document,
        pdf,
        'd'.repeat(64),
        'c'.repeat(64),
        createHash('sha256').update('A').digest('hex'),
        JSON.stringify([{ pageNumber: 1, startOffset: 0, endOffset: 1 }]),
      ],
    );
    const profile = {
      profileVersion: 1,
      provider: 'test',
      model: 'migration-fixture',
      modelRevision: 'v1',
      dimensions: 3,
      distance: 'Cosine',
      normalizationVersion: 'nfc-lf-v1',
      tokenizer: 'test',
      tokenizerVersion: 'v1',
      documentInstruction: '',
      queryInstruction: '',
    };
    await client.query(
      "INSERT INTO embedding_profiles(profile_version,provider,model,model_revision,dimensions,distance,normalization_version,tokenizer,tokenizer_version,document_instruction,query_instruction,fingerprint) VALUES(1,'test','migration-fixture','v1',3,'Cosine','nfc-lf-v1','test','v1','','',$1)",
      [embeddingProfileFingerprint(profile)],
    );
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
        'users',
        'user_identities',
        'auth_sessions',
        'extracted_texts',
        'embedding_profiles',
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
    for (const field of ['search_projection_id']) {
      assert.equal(upgradedJob[field], null);
      delete upgradedJob[field];
    }
    assert.ok(
      JSON.stringify(after) === JSON.stringify(before),
      'Prior rows must be preserved without logging auth material.',
    );
    for (const table of [
      'search_index_generations',
      'document_search_states',
      'version_search_projections',
      'search_projection_changes',
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
    // Ordinary transaction rollback must preserve the original canonical row.
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
      1,
    );
  } finally {
    await client.end();
    if (temporaryRoot && path.dirname(temporaryRoot) === packageRoot)
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
