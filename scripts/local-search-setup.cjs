// Trusted local-development setup, executed inside the API image by start-local.ps1.
// Reuses the existing operator service and its verified cutover; never an HTTP route.
require("reflect-metadata");
const { randomUUID } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const {
  createPrismaClient,
  SearchPersistenceRepository,
  searchGenerationFingerprint,
} = require("@qyvra/database");
const { validateEnvironment } = require("./dist/configuration/environment");
const {
  databaseUrl,
} = require("/app/infrastructure/docker/database-command.cjs");
const {
  ElasticsearchStore,
} = require("./dist/infrastructure/search/elasticsearch-store");
const {
  SearchMaintenanceService,
  authorizeSearchOperator,
} = require("./dist/modules/search/search-maintenance.service");
const {
  PDF_EXTRACTOR,
} = require("./dist/infrastructure/extraction/pdf-parser");
const {
  indexName,
  SEARCH_SCHEMA_VERSION,
  SEARCH_MAPPING_VERSION,
  SEARCH_ANALYZER_VERSION,
  SEARCH_SEGMENTATION_VERSION,
  targetFromGeneration,
} = require("./dist/infrastructure/search/search-index");

async function main() {
  if (process.env.NODE_ENV !== "development")
    throw Error("LOCAL_SETUP_REQUIRES_DEVELOPMENT_ENVIRONMENT");
  const phase = process.env.QYVRA_LOCAL_SETUP_PHASE;
  if (!["prepare", "finish"].includes(phase))
    throw Error("INVALID_SETUP_PHASE");
  const settings = validateEnvironment({
    ...process.env,
    DATABASE_URL: databaseUrl(process.env),
    SEARCH_ENROLLMENT_ENABLED: "false",
    KEYWORD_SEARCH_ENABLED: "false",
    HYBRID_SEARCH_ENABLED: "false",
  });
  const db = createPrismaClient(settings.database);
  const store = new ElasticsearchStore(settings.elasticsearch);
  const initiator = "qyvra:local-start";
  try {
    const identity = {
      schemaVersion: SEARCH_SCHEMA_VERSION,
      mappingVersion: SEARCH_MAPPING_VERSION,
      analyzerVersion: SEARCH_ANALYZER_VERSION,
      segmentationVersion: SEARCH_SEGMENTATION_VERSION,
      ...PDF_EXTRACTOR,
    };
    const fingerprint = searchGenerationFingerprint(identity);
    // The documented local Compose database uses a superuser. Create only the
    // NOLOGIN marker role; never grant maintenance membership to the API login.
    const roles =
      await db.$queryRaw`SELECT rolname FROM pg_roles WHERE rolname = 'qyvra_search_operator'`;
    if (!roles.length) {
      const user =
        await db.$queryRaw`SELECT rolsuper FROM pg_roles WHERE rolname = current_user`;
      if (!user[0]?.rolsuper)
        throw Error("SEARCH_OPERATOR_MUST_BE_PROVISIONED_BY_DBA");
      await db.$executeRawUnsafe("CREATE ROLE qyvra_search_operator NOLOGIN");
    }
    await authorizeSearchOperator(db);
    const service = new SearchMaintenanceService(
      db,
      store,
      settings.elasticsearch.indexPrefix,
    );
    let generation = await db.searchIndexGeneration.findFirst({
      where: { status: "SERVING" },
    });
    if (generation && generation.fingerprint !== fingerprint)
      throw Error("EXISTING_SEARCH_REQUIRES_EXPLICIT_UPGRADE");
    if (!generation)
      generation = await db.searchIndexGeneration.findFirst({
        where: { fingerprint, status: "BUILDING" },
        orderBy: { generation: "desc" },
      });
    if (!generation && phase === "finish") throw Error("PREPARE_SEARCH_FIRST");
    if (!generation) {
      const last = await db.searchIndexGeneration.aggregate({
        _max: { generation: true },
      });
      const target = {
        id: randomUUID(),
        fingerprint,
        generation: (last._max.generation || 0) + 1,
      };
      generation = await new SearchPersistenceRepository(db).createGeneration({
        ...identity,
        generation: target.generation,
        metadataIndexName: indexName(
          settings.elasticsearch.indexPrefix,
          target,
          "metadata",
        ),
        pageIndexName: indexName(
          settings.elasticsearch.indexPrefix,
          target,
          "pages",
        ),
      });
    }
    if (generation.status === "SERVING") {
      for (const kind of ["metadata", "pages"]) {
        const inspected = await store.inspect(
          targetFromGeneration(settings.elasticsearch.indexPrefix, generation),
          kind,
          AbortSignal.timeout(60000),
        );
        if (!inspected.exists || !inspected.compatible)
          throw Error("EXISTING_SEARCH_INDEXES_NEED_OPERATOR_RECOVERY");
      }
    }
    if (generation.status === "BUILDING") {
      if (phase === "prepare") {
        await store.createIndexes(generation, AbortSignal.timeout(60000));
        const foreignOperation = await db.searchMaintenanceOperation.findFirst({
          where: {
            status: "RUNNING",
            NOT: { initiator, generationId: generation.id, kind: "REBUILD" },
          },
        });
        if (foreignOperation)
          throw Error("ANOTHER_SEARCH_MAINTENANCE_OPERATION_IS_RUNNING");
        let operation = await db.searchMaintenanceOperation.findFirst({
          where: {
            initiator,
            generationId: generation.id,
            kind: "REBUILD",
            status: "RUNNING",
          },
        });
        if (!operation)
          operation = await service.start({
            id: randomUUID(),
            kind: "REBUILD",
            initiator,
            generationId: generation.id,
          });
        let batches = 0;
        while (operation.status === "RUNNING" && batches++ < 100) {
          operation = await service.runBatch(
            operation.id,
            initiator,
            10,
            AbortSignal.timeout(60000),
          );
        }
        if (operation.status !== "COMPLETED" || operation.failures > 0)
          throw Error(
            "SEARCH_ENROLLMENT_INCOMPLETE_RERUN_OR_INSPECT_MAINTENANCE",
          );
      } else {
        const deadline =
          Date.now() +
          Number(process.env.QYVRA_LOCAL_WAIT_SECONDS || 360) * 1000;
        for (;;) {
          try {
            await service.verifyCutover(generation.id);
            break;
          } catch {
            if (Date.now() >= deadline)
              throw Error(
                "SEARCH_INDEXING_NOT_READY_CHECK_WORKER_LOGS_AND_RERUN",
              );
            await delay(2000);
          }
        }
        const previous = await db.searchMaintenanceOperation.findFirst({
          where: {
            initiator,
            generationId: generation.id,
            kind: "CUTOVER",
            status: { not: "COMPLETED" },
          },
          orderBy: { createdAt: "desc" },
        });
        await service.cutover(
          previous?.id || randomUUID(),
          initiator,
          generation.id,
          generation.id,
          AbortSignal.timeout(60000),
        );
      }
    }
    console.log(
      "QYVRA_LOCAL_RESULT=" +
        JSON.stringify({ fingerprint, generationId: generation.id }),
    );
  } finally {
    await store.close();
    await db.$disconnect();
  }
}

main().catch((error) => {
  // Only controlled codes; never print driver errors, credentials or document data.
  const code = /^[A-Z][A-Z_]+$/.test(error.message || "")
    ? error.message
    : "LOCAL_SEARCH_SETUP_FAILED_CHECK_SERVICE_LOGS";
  console.error(code);
  process.exitCode = 1;
});
