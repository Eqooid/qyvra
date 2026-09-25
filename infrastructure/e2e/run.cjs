const { spawnSync } = require('node:child_process');
const { existsSync, mkdirSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { randomBytes } = require('node:crypto');
const root = resolve(__dirname, '../..');
const env = resolve(root, '.tools/brainless-e2e.env');
mkdirSync(resolve(root, '.tools'), { recursive: true });
if (!existsSync(env)) writeFileSync(env, `POSTGRES_USER=brainless_e2e\nPOSTGRES_DB=brainless_e2e\nPOSTGRES_PASSWORD=${randomBytes(24).toString('hex')}\nNGINX_PORT=18080\nPUBLIC_APP_URL=http://localhost:18080\nUPLOAD_MAX_BYTES=2097152\n`, { mode: 0o600 });
const project = process.env.E2E_PROJECT_NAME || 'brainless-e2e';
if (!/^brainless-e2e(?:-[a-z0-9-]+)?$/.test(project)) throw new Error('Use an isolated brainless-e2e project name.');
const args = ['compose', '-p', project, '--env-file', env, '-f', resolve(root, 'docker-compose.yml'), '-f', resolve(__dirname, 'compose.yml')];
function compose(extra, overrides = {}) {
  const result = spawnSync('docker', [...args, ...extra], { cwd: root, stdio: 'inherit', env: { ...process.env, ...overrides }, shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Isolated Compose command failed (${extra[0]}).`);
}
const action = process.argv[2] || 'test';
try {
  if (action === 'up') { compose(['config', '--quiet']); compose(['up', '--build', '-d', '--wait', '--wait-timeout', '240']); }
  else if (action === 'down') compose(['down']);
  else if (action === 'logs') compose(['logs', '--tail', '100']);
  else if (action === 'storage-count') compose(['exec', '-T', 'api', 'node', '-e', "const fs=require('node:fs');function count(p){return fs.readdirSync(p,{withFileTypes:true}).reduce((n,e)=>n+(e.isDirectory()?count(p+'/'+e.name):1),0)}console.log(count('/data/brainless'))"]);
  else if (action === 'recreate') compose(['up', '-d', '--no-deps', '--force-recreate', '--wait', '--wait-timeout', '180', 'api', 'web']);
  else if (action === 'expiry') compose(['up', '-d', '--no-deps', '--force-recreate', '--wait', '--wait-timeout', '180', 'api'], { E2E_SESSION_TTL: '8' });
  else if (action === 'validate') { compose(['config', '--quiet']); compose(['exec', '-T', 'nginx', 'nginx', '-t']); }
  else if (action === 'test') {
    try {
      compose(['config', '--quiet']);
      compose(['up', '--build', '-d', '--wait', '--wait-timeout', '240']);
      const result = spawnSync(process.execPath, [resolve(root, 'apps/web/node_modules/@playwright/test/cli.js'), 'test', ...process.argv.slice(3)], { cwd: resolve(root, 'apps/web'), stdio: 'inherit', shell: false });
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
    } finally { compose(['down']); }
  } else throw new Error('Use up, down, logs, recreate, expiry, validate, or test.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
