const test=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const fs=require('node:fs');const path=require('node:path');
const root=path.resolve(__dirname,'../..');
fs.mkdirSync(path.join(root,'.tools'),{recursive:true});
function config(files,env){
  const parsed=spawnSync('docker',['--config',path.join(root,'.tools/docker-public'),'compose',...files.flatMap(f=>['-f',f]),'config','--format','json'],
    {cwd:root,env:{...process.env,...env},encoding:'utf8',maxBuffer:1024*1024});
  assert.equal(parsed.status,0,'Compose configuration could not be rendered.');
  return JSON.parse(parsed.stdout);
}
test('private search shell entrypoints use LF for Linux bind mounts',()=>{
  for(const name of ['health.sh','setup.sh','entrypoint.sh']){
    const script=fs.readFileSync(path.join(root,'infrastructure/search',name),'utf8');
    assert.ok(!script.includes('\r'),`${name} must not contain Windows carriage returns`);
  }
});

test('optional search Compose has private authenticated topology and unchanged existing services',()=>{
  const directory=fs.mkdtempSync(path.join(root,'.tools/search-compose-'));
  try {
    const admin=path.join(directory,'admin'),runtime=path.join(directory,'runtime');
    fs.writeFileSync(admin,'SyntheticBootstrapFixture123');fs.writeFileSync(runtime,'SyntheticRuntimeFixture123');
    const env={POSTGRES_USER:'qyvra_test',POSTGRES_DB:'qyvra_test',POSTGRES_PASSWORD:'SyntheticComposeFixture123',
      SEARCH_BOOTSTRAP_PASSWORD_FILE:admin,SEARCH_RUNTIME_PASSWORD_FILE:runtime};
    const base=config(['docker-compose.yml'],env);
    const search=config(['docker-compose.yml','docker-compose.search.yml'],env);
    assert.equal(base.services.elasticsearch,undefined);
    const es=search.services.elasticsearch;
    assert.match(es.image,/elasticsearch:9\.4\.6@sha256:[0-9a-f]{64}$/);
    assert.deepEqual(Object.keys(es.networks),['search']);assert.ok(!es.ports || !es.ports.length);
    assert.equal(search.networks.search.internal,true);assert.equal(es.environment['xpack.security.enabled'],'true');
    assert.equal(es.environment['action.auto_create_index'],'false');assert.equal(es.privileged,undefined);
    assert.deepEqual(es.entrypoint,['bash','/usr/share/elasticsearch/qyvra-entrypoint.sh']);
    assert.deepEqual(es.command,['eswrapper']);
    assert.ok(es.tmpfs.some(v=>v.includes('/run/qyvra-search-secrets:')&&v.includes('mode=0700')&&v.includes('uid=1000')));
    assert.match(es.environment.ES_JAVA_OPTS,/-Xms512m -Xmx512m/);assert.ok(es.healthcheck);
    for(const name of ['api','worker']){
      const s=search.services[name];assert.ok(Object.hasOwn(s.networks,'search'));
      assert.equal(s.environment.ELASTICSEARCH_URL,'http://elasticsearch:9200');
      assert.equal(s.environment.ELASTICSEARCH_USERNAME,'qyvra_search');
      assert.ok(s.secrets.some(v=>v.source==='search_runtime_password'));
      assert.ok(!s.secrets.some(v=>v.source==='search_bootstrap_password'));
      assert.equal(s.depends_on?.elasticsearch,undefined);
    }
    const relay=search.services.outbox;
    assert.equal(relay.environment.SEARCH_OUTBOX_DELIVERY_ENABLED,'true');
    assert.deepEqual(relay.secrets,base.services.outbox.secrets);
    assert.deepEqual(relay.networks,base.services.outbox.networks);
    const relayWithoutDelivery=structuredClone(relay);
    delete relayWithoutDelivery.environment.SEARCH_OUTBOX_DELIVERY_ENABLED;
    assert.deepEqual(relayWithoutDelivery,base.services.outbox);
    for(const name of ['postgres','rabbitmq','redis','qdrant','nginx','web','migrate'])
      assert.deepEqual(search.services[name],base.services[name],`Existing ${name} configuration must be preserved.`);
    const debug=config(['docker-compose.yml','docker-compose.search.yml','docker-compose.search-debug.yml'],env);
    assert.equal(debug.services.elasticsearch.ports[0].host_ip,'127.0.0.1');
    assert.equal(debug.services.elasticsearch.ports[0].target,9200);
  } finally {
    assert.equal(path.dirname(directory),path.join(root,'.tools'));
    fs.rmSync(directory,{recursive:true,force:true});
  }
});
