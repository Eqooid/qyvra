const { spawn } = require('node:child_process');
const { databaseUrl } = require('./database-command.cjs');

function rabbitUrl(env) {
  for (const key of ['RABBITMQ_USER', 'RABBITMQ_PASSWORD']) {
    if (!env[key] || /[<>\r\n]/.test(env[key]))
      throw new Error(`Set a non-placeholder ${key}`);
  }
  return `amqp://${encodeURIComponent(env.RABBITMQ_USER)}:${encodeURIComponent(env.RABBITMQ_PASSWORD)}@rabbitmq:5672/`;
}

function runMessagingCommand(entry) {
  if (!['dist/outbox-main.js', 'dist/worker-main.js'].includes(entry))
    throw new Error('Invalid messaging entry point');
  try {
    const env = {
      ...process.env,
      DATABASE_URL: databaseUrl(process.env),
      RABBITMQ_URL: rabbitUrl(process.env),
    };
    const child = spawn('node', [entry], {
      env,
      stdio: 'inherit',
      shell: false,
    });
    for (const signal of ['SIGTERM', 'SIGINT'])
      process.on(signal, () => child.kill(signal));
    child.on('error', () => {
      console.error('Messaging process could not start');
      process.exitCode = 1;
    });
    child.on('exit', (code, signal) => {
      process.exitCode = code ?? (signal ? 1 : 0);
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { runMessagingCommand };
if (require.main === module) runMessagingCommand('dist/outbox-main.js');
