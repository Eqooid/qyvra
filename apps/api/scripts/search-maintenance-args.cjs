const { randomUUID } = require('node:crypto');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function parseSearchMaintenanceArgs(argv) {
  const [command, ...args] = argv;
  if (
    ![
      'generation',
      'backfill',
      'rebuild',
      'reconcile',
      'cleanup',
      'resume',
      'status',
      'cancel',
      'verify',
      'cutover',
      'scan',
    ].includes(command)
  )
    throw Error('INVALID_COMMAND');
  const options = {
    command,
    apply: false,
    batch: 10,
    maxBatches: 1,
    operation: undefined,
    operator: undefined,
    generation: undefined,
    owner: undefined,
    allOwners: false,
    number: undefined,
    confirmGeneration: undefined,
    after: undefined,
    kind: 'metadata',
  };
  const names = {
    '--batch': 'batch',
    '--max-batches': 'maxBatches',
    '--operation': 'operation',
    '--operator': 'operator',
    '--generation': 'generation',
    '--owner': 'owner',
    '--number': 'number',
    '--confirm-generation': 'confirmGeneration',
    '--after': 'after',
    '--kind': 'kind',
  };
  const seen = new Set();
  const allowed = {
    generation: ['--number', '--apply'],
    backfill: [
      '--generation',
      '--owner',
      '--batch',
      '--max-batches',
      '--operation',
      '--apply',
      '--after',
    ],
    rebuild: [
      '--generation',
      '--all-owners',
      '--batch',
      '--max-batches',
      '--operation',
      '--apply',
      '--after',
    ],
    reconcile: [
      '--generation',
      '--owner',
      '--batch',
      '--max-batches',
      '--operation',
      '--apply',
      '--after',
    ],
    cleanup: [
      '--generation',
      '--owner',
      '--all-owners',
      '--batch',
      '--max-batches',
      '--operation',
      '--apply',
      '--after',
    ],
    resume: ['--operation', '--apply', '--batch', '--max-batches'],
    status: ['--operation'],
    cancel: ['--operation', '--apply'],
    verify: ['--generation'],
    cutover: [
      '--generation',
      '--all-owners',
      '--operation',
      '--confirm-generation',
      '--apply',
    ],
    scan: ['--generation', '--owner', '--kind', '--after', '--batch'],
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg !== '--operator' && !allowed[command].includes(arg))
      throw Error('INVALID_OPTION');
    if (seen.has(arg)) throw Error('DUPLICATE_OPTION');
    seen.add(arg);
    if (arg === '--apply') options.apply = true;
    else if (arg === '--all-owners') options.allOwners = true;
    else if (names[arg] && args[i + 1] && !args[i + 1].startsWith('--'))
      options[names[arg]] = args[++i];
    else throw Error('INVALID_OPTION');
  }
  for (const [name, min, max] of [
    ['batch', 1, 25],
    ['maxBatches', 1, 10],
    ['number', 1, 2147483647],
  ]) {
    if (options[name] === undefined) continue;
    if (!/^[1-9][0-9]*$/.test(String(options[name])))
      throw Error('INVALID_BOUND');
    options[name] = Number(options[name]);
    if (options[name] < min || options[name] > max)
      throw Error('INVALID_BOUND');
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9@._:-]{0,99}$/.test(options.operator ?? ''))
    throw Error('OPERATOR_REQUIRED');
  for (const name of ['generation', 'owner', 'operation', 'confirmGeneration'])
    if (options[name] !== undefined && !uuid.test(options[name]))
      throw Error('INVALID_IDENTIFIER');
  if (options.owner && options.allOwners) throw Error('AMBIGUOUS_SCOPE');
  if (options.apply && options.after)
    throw Error('RESUME_REQUIRES_DURABLE_OPERATION');
  if (['backfill', 'reconcile', 'scan'].includes(command) && !options.owner)
    throw Error('OWNER_REQUIRED');
  if (
    ['rebuild', 'cutover'].includes(command) &&
    (!options.allOwners || options.owner)
  )
    throw Error('GLOBAL_SCOPE_REQUIRED');
  if (command === 'cleanup' && !options.owner && !options.allOwners)
    throw Error('SCOPE_REQUIRED');
  if (
    !['generation', 'resume', 'status', 'cancel'].includes(command) &&
    !options.generation
  )
    throw Error('GENERATION_REQUIRED');
  if (command === 'generation' && !options.number)
    throw Error('GENERATION_NUMBER_REQUIRED');
  if (['resume', 'status', 'cancel'].includes(command) && !options.operation)
    throw Error('OPERATION_REQUIRED');
  if (
    command === 'cutover' &&
    options.apply &&
    options.confirmGeneration !== options.generation
  )
    throw Error('CONFIRM_GENERATION_REQUIRED');
  if (options.after && command !== 'scan' && !uuid.test(options.after))
    throw Error('INVALID_IDENTIFIER');
  if (!['metadata', 'pages'].includes(options.kind))
    throw Error('INVALID_KIND');
  if (command === 'scan' && options.after) {
    if (options.after.length > 300) throw Error('INVALID_CURSOR');
    options.after = JSON.parse(options.after);
    if (
      !Array.isArray(options.after) ||
      options.after.length !== (options.kind === 'metadata' ? 1 : 3) ||
      !uuid.test(options.after[0]) ||
      options.after.slice(1).some((x) => !Number.isSafeInteger(x) || x < 0)
    )
      throw Error('INVALID_CURSOR');
  }
  options.operation ??= randomUUID();
  return options;
}
module.exports = { parseSearchMaintenanceArgs };
