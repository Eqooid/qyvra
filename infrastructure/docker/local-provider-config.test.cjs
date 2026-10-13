const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, writeFileSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { randomUUID } = require("node:crypto");

const root = resolve(__dirname, "../..");
const temp = mkdtempSync(join(tmpdir(), "qyvra-provider-config-"));
after(() => rmSync(temp, { recursive: true, force: true }));
const appKeys = [
  ...readFileSync(join(root, ".env.example"), "utf8").matchAll(
    /^([A-Z_0-9]+)=/gm,
  ),
].map((m) => m[1]);
const env = { ...process.env };
for (const key of appKeys) delete env[key];
function docker(args, timeout = 30000) {
  return spawnSync("docker", args, {
    cwd: root,
    env,
    encoding: "utf8",
    timeout,
    maxBuffer: 8000000,
  });
}
function config(overrides = [], values = {}) {
  const file = join(temp, "synthetic.env");
  writeFileSync(
    file,
    Object.entries({
      COMPOSE_PROJECT_NAME: "qyvra-provider-test",
      POSTGRES_USER: "synthetic",
      POSTGRES_DB: "synthetic",
      POSTGRES_PASSWORD: "synthetic-test-only",
      LOCAL_AI_ASSETS_DIR: temp.replaceAll("\\", "/"),
      ...values,
    })
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
  );
  const result = docker([
    "compose",
    "--env-file",
    file,
    "-p",
    "qyvra-provider-test",
    "-f",
    "docker-compose.yml",
    ...overrides.flatMap((f) => ["-f", f]),
    "config",
    "--format",
    "json",
  ]);
  assert.equal(
    result.status,
    0,
    "Compose configuration failed (resolved settings intentionally withheld)",
  );
  return JSON.parse(result.stdout);
}

for (const embedding of ["openai-compatible", "ollama"])
  for (const generation of ["openai-compatible", "ollama"]) {
    test(`Compose forwards independent ${embedding}/${generation} settings only to intended servers`, () => {
      const c = config([], {
        EMBEDDING_ENABLED: "true",
        EMBEDDING_ENDPOINT:
          embedding === "ollama"
            ? "http://ollama:11434/api/embed"
            : "https://api.openai.com/v1/embeddings",
        EMBEDDING_PROFILE_FINGERPRINT: (embedding === "ollama"
          ? "b"
          : "a"
        ).repeat(64),
        EMBEDDING_API_KEY:
          embedding === "ollama" ? "" : "synthetic-embedding-key",
        GENERATION_PROVIDER: generation,
        GENERATION_MODEL: `${generation}-model`,
        GENERATION_ENDPOINT:
          generation === "ollama"
            ? "http://ollama:11434/api/chat"
            : "https://api.openai.com/v1/chat/completions",
        GENERATION_API_KEY:
          generation === "ollama" ? "" : "synthetic-generation-key",
        GENERATION_TOKENIZER:
          generation === "ollama" ? "huggingface-json" : "o200k_base",
      });
      for (const key of [
        "EMBEDDING_ENDPOINT",
        "EMBEDDING_PROFILE_FINGERPRINT",
        "EMBEDDING_API_KEY",
        "EMBEDDING_TIMEOUT_MS",
        "EMBEDDING_TOKENIZER_PATH",
      ])
        assert.equal(
          c.services.api.environment[key],
          c.services.worker.environment[key],
        );
      assert.equal(c.services.api.environment.GENERATION_PROVIDER, generation);
      assert.equal(c.services.worker.environment.GENERATION_API_KEY, undefined);
      for (const service of [
        "web",
        "nginx",
        "postgres",
        "rabbitmq",
        "redis",
        "qdrant",
      ])
        assert.ok(
          !Object.keys(c.services[service].environment || {}).some((k) =>
            /^(EMBEDDING|GENERATION)_/.test(k),
          ),
        );
    });
  }
test("default Compose keeps OpenAI defaults and has no mandatory inference or host mapping", () => {
  const c = config();
  assert.equal(
    c.services.api.environment.GENERATION_PROVIDER,
    "openai-compatible",
  );
  assert.equal(c.services.api.environment.RAG_ENABLED, "false");
  assert.equal(c.services.api.environment.EMBEDDING_ENABLED, "false");
  assert.equal(c.services.ollama, undefined);
  assert.equal(c.services.api.extra_hosts, undefined);
  assert.equal(c.networks.ai_provider, undefined);
});
test("optional asset override preserves storage/vector networks and creates private inference connectivity", () => {
  const c = config(["docker-compose.local-ai.yml"]);
  assert.equal(c.networks.ai_provider.internal, true);
  for (const name of ["api", "worker"]) {
    for (const network of ["default", "vector", "ai_provider"])
      assert.ok(network in c.services[name].networks);
    const assets = c.services[name].volumes.find(
      (v) => v.target === "/run/qyvra-ai",
    );
    assert.equal(assets.read_only, true);
    // Normalized Compose JSON omits false flags; absence here represents false.
    assert.equal(assets.bind.create_host_path ?? false, false);
    assert.ok(c.services[name].volumes.some((v) => v.target === "/data/qyvra"));
  }
  assert.ok(!("ai_provider" in c.services.web.networks));
  assert.ok(!("ai_provider" in c.services.nginx.networks));
});
test("optional host override maps API and worker without publishing provider ports", () => {
  const c = config([
    "docker-compose.local-ai.yml",
    "docker-compose.ollama-host.yml",
  ]);
  for (const name of ["api", "worker"])
    assert.ok(
      c.services[name].extra_hosts.includes(
        "host.docker.internal=host-gateway",
      ),
    );
  for (const service of Object.values(c.services))
    for (const port of service.ports || [])
      assert.notEqual(Number(port.target), 11434);
});
test("Nginx/web keep providers server-side and out of public routes/build variables", () => {
  const nginx = readFileSync(
    join(root, "infrastructure/nginx/default.conf.template"),
    "utf8",
  );
  assert.ok(!/ollama|11434|GENERATION_ENDPOINT|EMBEDDING_ENDPOINT/.test(nginx));
  const web = readFileSync(
    join(root, "infrastructure/docker/web.Dockerfile"),
    "utf8",
  );
  assert.ok(!/GENERATION_|EMBEDDING_/.test(web));
});
test("isolated network fixture is valid and has no ports, models or persistent volumes", () => {
  const result = docker([
    "compose",
    "-p",
    "qyvra-provider-fixture-check",
    "-f",
    "infrastructure/test/local-provider-network.compose.yml",
    "config",
    "--format",
    "json",
  ]);
  assert.equal(
    result.status,
    0,
    "isolated network fixture configuration failed",
  );
  const c = JSON.parse(result.stdout);
  assert.equal(c.networks.ai_provider.internal, true);
  for (const service of Object.values(c.services)) {
    assert.equal(service.ports, undefined);
    assert.equal(service.volumes, undefined);
    assert.equal(service.pull_policy, "never");
  }
});
test("isolated API/worker network probes reach a model-free mock without pulling images", (t) => {
  if (
    docker(["version", "--format", "{{.Server.Version}}"], 10000).status !== 0
  )
    return t.skip(
      "Docker daemon unavailable; live container/network checks NOT RUN",
    );
  if (docker(["image", "inspect", "node:24-bookworm-slim"], 10000).status !== 0)
    return t.skip(
      "Node test image not locally cached; automatic image pulls disabled",
    );
  const project = `qyvra-provider-net-${randomUUID().slice(0, 8)}`;
  const base = [
    "compose",
    "-p",
    project,
    "-f",
    "infrastructure/test/local-provider-network.compose.yml",
  ];
  try {
    assert.equal(
      docker([
        ...base,
        "up",
        "-d",
        "--pull",
        "never",
        "--no-build",
        "provider-mock",
      ]).status,
      0,
      "isolated mock startup failed",
    );
    for (const probe of ["api-probe", "worker-probe"])
      assert.equal(
        docker([...base, "run", "--rm", "--no-deps", probe]).status,
        0,
        `${probe} connectivity failed`,
      );
  } finally {
    assert.equal(
      docker([...base, "down", "--remove-orphans"]).status,
      0,
      "isolated test cleanup failed",
    );
  }
});
