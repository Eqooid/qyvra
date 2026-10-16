// Trusted operator process; not imported by any HTTP runtime. Dry-run by default.
require('reflect-metadata');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { parseSearchMaintenanceArgs } = require('./search-maintenance-args.cjs');
const {
  createPrismaClient,
  SearchPersistenceRepository,
  searchGenerationFingerprint,
} = require('@qyvra/database');
const { validateEnvironment } = require('../dist/configuration/environment');
const {
  SearchMaintenanceService,
  authorizeSearchOperator,
} = require('../dist/modules/search/search-maintenance.service');
const {
  ElasticsearchStore,
} = require('../dist/infrastructure/search/elasticsearch-store');
const {
  PDF_EXTRACTOR,
} = require('../dist/infrastructure/extraction/pdf-parser');
const {
  indexName,
  SEARCH_SCHEMA_VERSION,
  SEARCH_MAPPING_VERSION,
  SEARCH_ANALYZER_VERSION,
  SEARCH_SEGMENTATION_VERSION,
} = require('../dist/infrastructure/search/search-index');
async function main() {
  const args = parseSearchMaintenanceArgs(process.argv.slice(2));
  const settings = validateEnvironment(process.env);
  const db = createPrismaClient(settings.database),
    store = new ElasticsearchStore(settings.elasticsearch);
  const output = (value) => process.stdout.write(JSON.stringify(value) + '\n');
  let stopping = false;
  const cancellation = new AbortController();
  const stop = () => {
    stopping = true;
    cancellation.abort();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    await db.$connect();
    await authorizeSearchOperator(db);
    const service = new SearchMaintenanceService(
      db,
      store,
      settings.elasticsearch.indexPrefix,
    );
    if (args.command === 'generation') {
      const identity = {
        schemaVersion: SEARCH_SCHEMA_VERSION,
        mappingVersion: SEARCH_MAPPING_VERSION,
        analyzerVersion: SEARCH_ANALYZER_VERSION,
        segmentationVersion: SEARCH_SEGMENTATION_VERSION,
        ...PDF_EXTRACTOR,
      };
      const target = {
        id: randomUUID(),
        generation: args.number,
        fingerprint: searchGenerationFingerprint(identity),
      };
      const input = {
        ...identity,
        generation: target.generation,
        metadataIndexName: indexName(
          settings.elasticsearch.indexPrefix,
          target,
          'metadata',
        ),
        pageIndexName: indexName(
          settings.elasticsearch.indexPrefix,
          target,
          'pages',
        ),
      };
      if (!args.apply)
        return output({
          dryRun: true,
          ...input,
          fingerprint: target.fingerprint,
        });
      const generation = await new SearchPersistenceRepository(
        db,
      ).createGeneration(input);
      if (generation.status !== 'BUILDING')
        throw Error('GENERATION_NOT_BUILDING');
      await store.createIndexes(generation, AbortSignal.timeout(60000));
      return output({
        generationId: generation.id,
        fingerprint: generation.fingerprint,
        status: generation.status,
      });
    }
    if (args.command === 'status')
      return output(await service.inspect(args.operation, args.operator));
    if (args.command === 'cancel') {
      if (!args.apply)
        return output({ dryRun: true, operation: args.operation });
      return output(await service.cancel(args.operation, args.operator));
    }
    if (args.command === 'verify' || args.command === 'cutover') {
      if (args.command === 'cutover' && args.apply)
        return output(
          await service.cutover(
            args.operation,
            args.operator,
            args.generation,
            args.confirmGeneration,
            cancellation.signal,
          ),
        );
      const verified = await service.verifyCutover(args.generation);
      return output({
        dryRun: true,
        generationId: verified.generationId,
        verifiedPublications: verified.proofs.length,
        cutover: false,
      });
    }
    if (args.command === 'scan')
      return output(
        await service.inspectOwner(
          args.generation,
          args.owner,
          args.kind,
          args.after,
          args.batch,
        ),
      );
    if (!args.apply) {
      if (args.command === 'resume')
        return output({
          dryRun: true,
          ...(await service.inspect(args.operation, args.operator)),
        });
      if (args.command === 'reconcile')
        return output({
          dryRun: true,
          ...(await service.diagnose(
            args.generation,
            args.owner,
            args.batch,
            args.after,
          )),
        });
      return output({
        dryRun: true,
        documents: await service.preview(
          args.generation,
          args.owner,
          args.batch,
          args.after,
        ),
      });
    }
    const resumed =
      args.command === 'resume'
        ? await service.inspect(args.operation, args.operator)
        : undefined;
    const kind = resumed?.kind ?? args.command.toUpperCase();
    if (kind === 'CUTOVER')
      throw Error('RESUME_CUTOVER_WITH_EXPLICIT_GENERATION_CONFIRMATION');
    if (['BACKFILL', 'REBUILD', 'RECONCILE'].includes(kind)) {
      const { generation } = await service.generation(
        resumed?.generationId ?? args.generation,
      );
      if (
        !settings.searchEnrollment.enabled ||
        settings.searchEnrollment.generationFingerprint !==
          generation.fingerprint
      )
        throw Error('ENROLLMENT_CONFIGURATION_MISMATCH');
    }
    let operation =
      resumed ??
      (await service.start({
        id: args.operation,
        kind,
        initiator: args.operator,
        generationId: args.generation,
        userId: args.owner,
      }));
    output({
      event: 'search.maintenance.started',
      operationId: operation.id,
      kind: operation.kind,
    });
    for (
      let i = 0;
      i < args.maxBatches && !stopping && operation.status === 'RUNNING';
      i++
    ) {
      operation = await service.runBatch(
        operation.id,
        args.operator,
        args.batch,
        cancellation.signal,
      );
      output(operation);
      if (operation.status === 'RUNNING' && i + 1 < args.maxBatches)
        await delay(250);
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await store.close();
    await db.$disconnect();
  }
}
main().catch(() => {
  process.stderr.write(
    'Search maintenance failed. Check operator role, validated options, configuration and operation status; resume the durable checkpoint. No remote error content is logged.\n',
  );
  process.exitCode = 1;
});
