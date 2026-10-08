// Existing Jest suites, sequential execution, one temporary RabbitMQ vhost each.
// Never purges a shared queue or changes production topology.
const { spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { readdirSync, readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const root = resolve(__dirname, "../../apps/api");
const cli = resolve(root, "node_modules/jest/bin/jest.js");
const container = process.env.TEST_RABBITMQ_CONTAINER;
if (
  !process.env.TEST_DATABASE_URL ||
  !/test/i.test(new URL(process.env.TEST_DATABASE_URL).pathname)
)
  throw Error("Use a migrated disposable TEST_DATABASE_URL.");
if (
  process.env.TEST_RABBITMQ_URL &&
  (!container || !/^(?:qyvra-[a-z0-9-]+-test|[a-f0-9]{64})$/.test(container))
)
  throw Error(
    "Set TEST_RABBITMQ_CONTAINER to the isolated test broker name or CI service container ID.",
  );
let files = readdirSync(resolve(root, "test")).filter((f) =>
  f.endsWith(".integration-spec.ts"),
);
const selected = process.argv.slice(2);
if (selected.some((name) => !files.includes(name)))
  throw Error("Select existing integration-spec.ts filenames.");
if (selected.length) files = files.filter((name) => selected.includes(name));
const brokerFiles = files.filter((f) =>
  /TEST_RABBITMQ_URL/.test(readFileSync(resolve(root, "test", f), "utf8")),
);
const ordinary = files.filter((f) => !brokerFiles.includes(f));
let failed = false;
function run(tests, url) {
  if (!tests.length) return;
  const result = spawnSync(
    process.execPath,
    [
      cli,
      "--config",
      "./test/jest-integration.json",
      "--runInBand",
      ...tests.map((f) => `test/${f}`),
    ],
    {
      cwd: root,
      env: { ...process.env, TEST_RABBITMQ_URL: url ?? "" },
      stdio: "inherit",
      shell: false,
    },
  );
  if (result.error || result.status !== 0) failed = true;
}
function broker(...args) {
  const result = spawnSync(
    "docker",
    ["exec", container, "rabbitmqctl", ...args],
    { stdio: "pipe", encoding: "utf8", shell: false, windowsHide: true },
  );
  if (result.error || result.status !== 0)
    throw Error("Isolated broker provisioning/cleanup failed.");
}
run(ordinary);
for (const file of brokerFiles) {
  if (!process.env.TEST_RABBITMQ_URL) {
    run([file]);
    continue;
  }
  const url = new URL(process.env.TEST_RABBITMQ_URL);
  const vhost = `qyvra-test-${randomUUID()}`;
  broker("add_vhost", vhost);
  try {
    broker(
      "set_permissions",
      "-p",
      vhost,
      decodeURIComponent(url.username),
      ".*",
      ".*",
      ".*",
    );
    url.pathname = `/${vhost}`;
    run([file], url.toString());
  } finally {
    broker("delete_vhost", vhost);
  }
}
process.exitCode = failed ? 1 : 0;
