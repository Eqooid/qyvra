const { runMessagingCommand } = require('./outbox-command.cjs');
runMessagingCommand('dist/worker-main.js');
