// Trusted maintenance command. Uses the same application scheduler as uploads/restore.
require('reflect-metadata');
const { createPrismaClient } = require('@qyvra/database');
const { validateEnvironment } = require('../dist/configuration/environment');
const { ConfigurationService } = require('../dist/configuration/configuration.module');
const { PrismaService } = require('../dist/database/prisma.service');
const { AiIngestionService } = require('../dist/modules/ai/ai-ingestion.service');

async function main() {
  const args = process.argv.slice(2);
  const options = { batch: 25, max: 100, after: undefined, apply: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') options.apply = true;
    else if (['--batch', '--max', '--after'].includes(args[i]) && args[i + 1]) {
      const name = args[i].slice(2);
      options[name] = name === 'after' ? args[++i] : Number(args[++i]);
    } else throw Error('Use --apply, --batch 1..100, --max 1..10000, --after UUID. Default is dry-run.');
  }
  if (!Number.isSafeInteger(options.batch) || options.batch < 1 || options.batch > 100 ||
      !Number.isSafeInteger(options.max) || options.max < 1 || options.max > 10000)
    throw Error('Invalid bounded backfill options.');
  const settings = validateEnvironment(process.env);
  const client = createPrismaClient(settings.database);
  try {
    await client.$connect();
    const scheduler = new AiIngestionService(new PrismaService(client), new ConfigurationService(settings));
    let scanned = 0, after = options.after;
    while (scanned < options.max) {
      const batch = await scheduler.backfillBatch(Math.min(options.batch, options.max - scanned), after, !options.apply);
      scanned += batch.scanned;
      after = batch.cursor;
      process.stdout.write(JSON.stringify({ dryRun: !options.apply, totalScanned: scanned, ...batch }) + '\n');
      if (!batch.hasMore) break;
    }
  } finally { await client.$disconnect(); }
}
main().catch(() => { process.stderr.write('AI backfill failed; check configuration and infrastructure. Resume from the last emitted cursor.\n'); process.exitCode = 1; });
