// Remaining real-service gates only. Separate SQL DB and a fresh RabbitMQ vhost per suite.
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const assets = path.resolve(__dirname, "../../.tools/v131-local-assets");
const { project, password } = JSON.parse(
  fs.readFileSync(path.join(assets, "stack.json")),
);
if (!/^qyvra-e2e-ai-v131-[a-f0-9]{8}$/.test(project))
  throw Error("Invalid isolated project");
function docker(args, inherit = false) {
  const r = spawnSync("docker", args, {
    encoding: "utf8",
    stdio: inherit ? "inherit" : "pipe",
  });
  if (r.status !== 0) throw Error("Isolated service check failed: " + args[0]);
  return r.stdout?.trim();
}
const tests = [
  ["vector-indexing.integration-spec.ts", null],
  ["semantic-search.integration-spec.ts", null],
  ["rag-answer.integration-spec.ts", null],
  ["outbox.integration-spec.ts", "delivers a stored outbox envelope"],
  ["embedding-generation.integration-spec.ts", "duplicate real RabbitMQ"],
  ["processing-status.integration-spec.ts", "progress"],
  ["ai-ingestion.integration-spec.ts", "real legacy PDF backfill"],
];
const selected = process.argv.slice(2);
if (selected.some((file) => !tests.some((test) => test[0] === file)))
  throw Error("Unknown integration suite");
for (const [file, filter] of tests.filter(
  (test) => !selected.length || selected.includes(test[0]),
)) {
  const vhost = "qyvra-test-" + randomUUID();
  const name = "qyvra-v131-service-test-" + randomUUID().slice(0, 8);
  const broker = project + "-rabbitmq-1";
  docker(["exec", broker, "rabbitmqctl", "add_vhost", vhost]);
  try {
    docker([
      "exec",
      broker,
      "rabbitmqctl",
      "set_permissions",
      "-p",
      vhost,
      "qyvra",
      ".*",
      ".*",
      ".*",
    ]);
    const envFile = path.join(assets, "integration.env");
    fs.writeFileSync(
      envFile,
      [
        "TEST_DATABASE_URL=postgresql://qyvra_e2e:" +
          password +
          "@postgres:5432/qyvra_v131_test",
        "TEST_RABBITMQ_URL=amqp://qyvra:" +
          password +
          "@rabbitmq:5672/" +
          vhost,
        "TEST_QDRANT_URL=http://qdrant:6333",
        "TEST_REDIS_URL=redis://redis:6379",
      ].join("\n"),
      { mode: 0o600 },
    );
    docker([
      "create",
      "--name",
      name,
      "--network",
      project + "_default",
      "--env-file",
      envFile,
      "--mount",
      "type=bind,source=" +
        path.resolve(__dirname, "../../apps/api/test") +
        ",target=/app/apps/api/test,readonly",
      "--memory",
      "1g",
      "qyvra-v131-local-integration:latest",
      "node",
      "node_modules/jest/bin/jest.js",
      "--config",
      "test/jest-integration.json",
      "--runInBand",
      "--testPathPattern",
      file,
      ...(filter ? ["--testNamePattern", filter] : []),
    ]);
    docker(["network", "connect", project + "_vector", name]);
    console.log(
      "RUN",
      file,
      filter ?? "all previously blocked real-service cases",
    );
    docker(["start", "-a", name], true);
    const code = docker(["inspect", "--format", "{{.State.ExitCode}}", name]);
    if (code !== "0") throw Error("Integration suite failed: " + file);
  } finally {
    docker(["rm", "-f", name]);
    docker(["exec", broker, "rabbitmqctl", "delete_vhost", vhost]);
  }
}
