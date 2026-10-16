const test=require('node:test');
const assert=require('node:assert/strict');
const {Client}=require('pg');
const {randomUUID}=require('node:crypto');
const {readdir,readFile}=require('node:fs/promises');
const {join}=require('node:path');
test('T10 upgrades a populated T09 schema and preserves immutable version metadata',async()=>{
  const input=process.env.TEST_DATABASE_URL;
  assert.ok(input);assert.match(new URL(input).pathname,/test/i);
  const name='qyvra_search_upgrade_test_'+randomUUID().replaceAll('-','');
  assert.match(name,/^qyvra_search_upgrade_test_[a-f0-9]{32}$/);
  const admin=new Client({connectionString:input});await admin.connect();
  let created=false,db;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);created=true;
    const url=new URL(input);url.pathname='/'+name;db=new Client({connectionString:url.toString()});await db.connect();
    const root=join(__dirname,'../prisma/migrations');
    const folders=(await readdir(root,{withFileTypes:true})).filter(d=>d.isDirectory()).map(d=>d.name).sort();
    const migration='20261015010000_search_maintenance';const index=folders.indexOf(migration);assert.equal(index,17);
    for(const folder of folders.slice(0,index))await db.query(await readFile(join(root,folder,'migration.sql'),'utf8'));
    const owner=randomUUID(),document=randomUUID(),version=randomUUID();
    await db.query('INSERT INTO users(id,email) VALUES($1,$2)',[owner,owner+'@example.invalid']);
    await db.query('INSERT INTO documents(id,user_id,title) VALUES($1,$2,$3)',[document,owner,'Upgrade fixture']);
    await db.query(`INSERT INTO document_versions(id,document_id,user_id,version_number,original_filename,mime_type,file_size,checksum_sha256,storage_key)
      VALUES($1,$2,$3,1,'fixture.png','image/png',12,$4,$5)`,[version,document,owner,'a'.repeat(64),`documents/${owner}/${document}/${version}/original.png`]);
    const before=(await db.query('SELECT * FROM document_versions WHERE id=$1',[version])).rows[0];
    await db.query(await readFile(join(root,migration,'migration.sql'),'utf8'));
    assert.deepEqual((await db.query('SELECT * FROM document_versions WHERE id=$1',[version])).rows[0],before);
    assert.equal((await db.query('SELECT count(*)::integer AS n FROM search_maintenance_operations')).rows[0].n,0);
    const indexes=(await db.query("SELECT indexname FROM pg_indexes WHERE tablename='search_index_generations'")).rows.map(r=>r.indexname);
    assert.ok(indexes.includes('search_index_generations_fingerprint_generation_key'));
    assert.ok(!indexes.includes('search_index_generations_fingerprint_key'));
  } finally {
    await db?.end();
    if(created)await admin.query(`DROP DATABASE "${name}"`);
    await admin.end();
  }
});
