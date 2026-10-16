// Live Docker test only. Uses a unique project and validates every volume before cleanup.
const {spawnSync}=require('node:child_process');
const {randomBytes,randomUUID,createHash}=require('node:crypto');
const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..');
fs.mkdirSync(path.join(root,'.tools'),{recursive:true});
const project='qyvra-search-test-'+randomBytes(6).toString('hex');
const directory=fs.mkdtempSync(path.join(root,'.tools/search-runtime-'));
const env={...process.env,COMPOSE_PROJECT_NAME:project,POSTGRES_USER:'qyvra_test',POSTGRES_DB:'qyvra_test',
  POSTGRES_PASSWORD:randomBytes(24).toString('hex'),PERSISTENT_VOLUMES_EXTERNAL:'false',QDRANT_VOLUME_EXTERNAL:'false',SEARCH_VOLUME_EXTERNAL:'false',
  POSTGRES_VOLUME_NAME:project+'_postgres',STORAGE_VOLUME_NAME:project+'_storage',RABBITMQ_VOLUME_NAME:project+'_rabbitmq',
  QDRANT_VOLUME_NAME:project+'_qdrant',SEARCH_VOLUME_NAME:project+'_search',
  SEARCH_BOOTSTRAP_PASSWORD_FILE:path.join(directory,'admin'),SEARCH_RUNTIME_PASSWORD_FILE:path.join(directory,'runtime'),
  NODE_ENV:'test',ELASTICSEARCH_PASSWORD:'',ELASTICSEARCH_PASSWORD_FILE:'',ELASTICSEARCH_CA_FILE:'',ELASTICSEARCH_API_KEY:'',ELASTICSEARCH_API_KEY_FILE:'',
  SEARCH_ENROLLMENT_ENABLED:'false',AI_INGESTION_ENABLED:'false',EMBEDDING_ENABLED:'false',VECTOR_INDEX_ENABLED:'false',
  SEMANTIC_SEARCH_ENABLED:'false',RAG_ENABLED:'false'};
const admin=randomBytes(24).toString('hex');fs.writeFileSync(env.SEARCH_BOOTSTRAP_PASSWORD_FILE,admin,{mode:0o600});
fs.writeFileSync(env.SEARCH_RUNTIME_PASSWORD_FILE,randomBytes(24).toString('hex'),{mode:0o600});
// The production search network stays internal. A test-only bridge is required
// for Docker Desktop to honor the explicit loopback port used by host Jest.
const override=path.join(directory,'ports.yml');fs.writeFileSync(override,'services:\n  elasticsearch:\n    networks: [search, search_test_host]\n    ports: ["127.0.0.1::9200"]\nnetworks:\n  search_test_host: {}\n');
const args=['--config',path.join(root,'.tools/docker-public'),'compose','-p',project,'-f','docker-compose.yml','-f','docker-compose.search.yml','-f',override];
function run(executable,arguments_,capture=false,extra={}) {
  const result=spawnSync(executable,arguments_,{cwd:root,env:{...env,...extra},stdio:capture?'pipe':'inherit',encoding:'utf8',timeout:1200000,maxBuffer:4*1024*1024});
  if(result.status!==0){
    if(arguments_.includes('port'))console.error('Isolated test port inspection failed: '+(result.stderr||'').slice(0,1000));
    throw new Error('Live search test command failed; inspect the preceding sanitized test output.');
  }
  return result.stdout;
}
const target={id:randomUUID(),generation:1,fingerprint:createHash('sha256').update(project).digest('hex')};
const state={target,userId:randomUUID(),documentId:randomUUID(),documentVersionId:randomUUID()};
// Same module is imported by API and worker; no HTTP routes or handlers are started.
const probe=`let probeStage='BOOTSTRAP';(async()=>{
 const {NestFactory}=require('@nestjs/core');
 const {LexicalStoreModule}=require('./dist/infrastructure/search/lexical-store.module');
 const {LEXICAL_STORE}=require('./dist/infrastructure/search/lexical-store');
 const {searchProjectionId,searchRecordId}=require('@qyvra/database');
 const context=await NestFactory.createApplicationContext(LexicalStoreModule,{logger:false});
 try {
  const store=context.get(LEXICAL_STORE); probeStage='AVAILABILITY'; await store.availability();
  const s=JSON.parse(process.argv[1]),mode=process.argv[2];
  const r={kind:'metadata',userId:s.userId,documentId:s.documentId,documentVersionId:s.documentVersionId,
   projectionId:searchProjectionId(s.documentVersionId,s.target.id,1),revision:1,indexGenerationId:s.target.id,
   sourceHash:'a'.repeat(64),title:'Disposable persistence fixture',filename:'fixture.png',mimeType:'image/png',
   documentType:'OTHER',status:'UPLOADED',tagIds:[],fileSize:12,createdAt:'2026-10-14T00:00:00.000Z',updatedAt:'2026-10-14T00:00:00.000Z'};
  if(mode==='write'){
   probeStage='CREATE_INDEXES';await store.createIndexes(s.target);
   const inspected=await store.inspect(s.target,'metadata');
   if(!inspected.compatible){
    const {indexName,indexDefinition}=require('./dist/infrastructure/search/search-index');
    const name=indexName('qyvra-search',s.target,'metadata'),got=(await store.client.indices.get({index:name}))[name],expected=indexDefinition(s.target,'metadata');
    const paths=[];function compare(a,b,p){if(a&&typeof a==='object'&&!Array.isArray(a)){for(const [k,v] of Object.entries(a))compare(v,b?.[k],p+'.'+k);}else if(JSON.stringify(a)!==JSON.stringify(b))paths.push({path:p,expected:a,actual:b});}
    compare(expected.mappings,got.mappings,'mappings');compare(expected.settings.analysis,got.settings?.index?.analysis,'analysis');
    console.error('Fresh index compatibility differences: '+JSON.stringify(paths));
   }
   probeStage='UPSERT';await store.upsert(s.target,[r]);
  }
  if(mode==='read'){probeStage='VERIFY';const records=await store.verify(s.target,'metadata',s.userId,r,[searchRecordId(r.projectionId,{kind:'metadata'})]);if(records.length!==1)throw Error('Persistence verification failed');}
  console.log('Private search runtime connectivity verified: '+mode);
 }finally{await context.close();}
})().catch(error=>{const code=typeof error?.code==='string'&&/^[A-Z_]{1,64}$/.test(error.code)?error.code:'UNKNOWN';console.error('Search runtime probe failed: '+probeStage+' '+code);process.exitCode=1;});`;
let validated=false,startupFinished=false;
try {
  // Do not start anything unless all potential volumes are provably isolated.
  const configuration=JSON.parse(run('docker',[...args,'config','--format','json'],true));
  assert.ok(Object.values(configuration.volumes).every(v=>v.name.startsWith(project+'_')&&!v.external));validated=true;
  run('docker',[...args,'build','api','worker']);
  run('docker',[...args,'up','-d','--wait','--wait-timeout','180','elasticsearch']);
  run('docker',[...args,'run','--rm','--no-deps','search-setup']);
  startupFinished=true;
  for(const [runtime,mode] of [['api','write'],['worker','read']])run('docker',[...args,'run','--rm','--no-deps','-e',
    'DATABASE_URL=postgresql://qyvra_test@postgres/qyvra_test',runtime,'node','-e',probe,JSON.stringify(state),mode]);
  const endpoint=run('docker',[...args,'port','elasticsearch','9200'],true).trim();
  assert.match(endpoint,/^127\.0\.0\.1:\d+$/);
  run(process.execPath,['apps/api/node_modules/jest/bin/jest.js','--config','apps/api/test/jest-integration.json','--runInBand',
    '--runTestsByPath','apps/api/test/elasticsearch.integration-spec.ts',
    ...(process.env.TEST_DATABASE_URL?['apps/api/test/search-publication.integration-spec.ts','apps/api/test/keyword-search.integration-spec.ts','apps/api/test/search-maintenance-live.integration-spec.ts']:[])],false,
    {TEST_ELASTICSEARCH_URL:'http://'+endpoint,TEST_ELASTICSEARCH_USERNAME:'elastic',TEST_ELASTICSEARCH_PASSWORD:admin,TEST_ELASTICSEARCH_API_KEY:''});
  run('docker',[...args,'restart','elasticsearch']);run('docker',[...args,'up','-d','--wait','--wait-timeout','180','elasticsearch']);
  run('docker',[...args,'run','--rm','--no-deps','-e','DATABASE_URL=postgresql://qyvra_test@postgres/qyvra_test',
    'worker','node','-e',probe,JSON.stringify(state),'read']);
  console.log('Live private deployment, mappings, delivery primitives and persistence passed.');
} catch (error) {
  // Preserve only container state/health diagnostics, never configuration/env secrets.
  try {
    const state=run('docker',['--config',path.join(root,'.tools/docker-public'),'inspect','--format','{{json .State}}',project+'-elasticsearch-1'],true);
    const redacted=state.split(admin).join('[REDACTED]').split(fs.readFileSync(env.SEARCH_RUNTIME_PASSWORD_FILE,'utf8')).join('[REDACTED]');
    fs.writeFileSync(path.join(root,'.tools',project+'-failure-state.json'),redacted,{mode:0o600});
    if(!startupFinished){
      // No test documents have been sent yet: retain redacted bootstrap errors only.
      const log=spawnSync('docker',['--config',path.join(root,'.tools/docker-public'),'logs','--tail','60',project+'-elasticsearch-1'],{encoding:'utf8',maxBuffer:1024*1024,timeout:10000});
      const text=[log.stdout||'',log.stderr||''].join('\n').split(admin).join('[REDACTED]').split(fs.readFileSync(env.SEARCH_RUNTIME_PASSWORD_FILE,'utf8')).join('[REDACTED]');
      fs.writeFileSync(path.join(root,'.tools',project+'-bootstrap.log'),text,{mode:0o600});
    }
    console.error('Isolated Elasticsearch state/health diagnostic saved in .tools/'+project+'-failure-state.json');
  } catch {
    console.error('Isolated Elasticsearch state diagnostic unavailable.');
  }
  throw error;
} finally {
  try {if(validated)run('docker',[...args,'down','--volumes','--remove-orphans']);}
  finally {
    assert.equal(path.dirname(directory),path.join(root,'.tools'));
    fs.rmSync(directory,{recursive:true,force:true});
  }
}
