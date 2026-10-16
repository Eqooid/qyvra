// Exercise the PowerShell entry point without starting Docker or using real secrets.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const shell = process.platform === "win32" ? "powershell.exe" : "pwsh";
const available = !spawnSync(shell, ["-NoProfile", "-Command", "exit 0"]).error;
const quote = (value) => "'" + value.replaceAll("'", "''") + "'";

function run(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qyvra-start-local-"));
  try {
    fs.mkdirSync(path.join(root, "scripts"));
    fs.copyFileSync(
      path.join(__dirname, "../../scripts/start-local.ps1"),
      path.join(root, "scripts/start-local.ps1"),
    );
    fs.writeFileSync(path.join(root, ".env"), "# synthetic fixture\n");
    fs.copyFileSync(
      path.join(__dirname, "../../scripts/local-search-setup.cjs"),
      path.join(root, "scripts/local-search-setup.cjs"),
    );
    const assets = path.join(root, "assets");
    fs.mkdirSync(assets);
    fs.writeFileSync(path.join(assets, "nomic-bundle.json"), "{}");
    fs.writeFileSync(path.join(assets, "qwen-bundle.json"), "{}");
    const bootstrap = path.join(root, "bootstrap");
    const runtime = path.join(root, "runtime");
    fs.writeFileSync(bootstrap, "a".repeat(32));
    fs.writeFileSync(
      runtime,
      options.sameSecrets ? "a".repeat(32) : "b".repeat(32),
    );
    if (options.all && !options.missingSecretSettings)
      fs.appendFileSync(
        path.join(root, ".env"),
        `SEARCH_BOOTSTRAP_PASSWORD_FILE=${bootstrap}\nSEARCH_RUNTIME_PASSWORD_FILE=${runtime}\nNODE_ENV=development\n`,
      );
    const config = {
      services: {
        api: {
          environment: {
            EMBEDDING_ENABLED: "true",
            RAG_ENABLED: "true",
            KEYWORD_SEARCH_ENABLED: "false",
            EMBEDDING_TOKENIZER_PATH: "/run/qyvra-ai/nomic-bundle.json",
            GENERATION_TOKENIZER_PATH: "/run/qyvra-ai/qwen-bundle.json",
          },
          volumes: [{ target: "/run/qyvra-ai", source: assets }],
        },
        worker: {},
        postgres: {},
        migrate: {},
        ...(options.search ? { elasticsearch: {}, "search-setup": {} } : {}),
      },
      secrets: {
        search_bootstrap_password: { file: bootstrap },
        search_runtime_password: { file: runtime },
      },
    };
    if (options.missingBundle)
      fs.unlinkSync(path.join(assets, "nomic-bundle.json"));
    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify(config));
    fs.writeFileSync(
      path.join(root, "docker.cjs"),
      `const fs=require('fs');const args=process.argv.slice(2);fs.appendFileSync('calls.jsonl',JSON.stringify(args)+'\\n');
if(args.includes('config')&&args.includes('--format'))console.log(fs.readFileSync('config.json','utf8'));
if(args[0]==='info')console.log('linux');
if(args[0]==='volume'&&args[1]==='inspect')process.exit(${options.existingVolume ? 0 : 1});
if(args.some(a=>a.startsWith('QYVRA_LOCAL_SETUP_PHASE='))) {
  if(${Boolean(options.failPrepare)}) process.exit(8);
  console.log('QYVRA_LOCAL_RESULT='+JSON.stringify({fingerprint:'c'.repeat(64),generationId:'11111111-1111-4111-8111-111111111111'}));
}

if(${Boolean(options.failWait)}&&args.includes('up')&&args.includes('elasticsearch'))process.exit(7);`,
    );
    const wrapper = path.join(root, "run.ps1");
    fs.writeFileSync(
      wrapper,
      `$env:USERPROFILE=${quote(root)}\nfunction docker { & ${quote(process.execPath)} ${quote(path.join(root, "docker.cjs"))} @args; $global:LASTEXITCODE = $LASTEXITCODE }\n& ${quote(path.join(root, "scripts/start-local.ps1"))} ${(options.args || []).join(" ")}\nexit $LASTEXITCODE\n`,
    );
    const result = spawnSync(
      shell,
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", wrapper],
      {
        cwd: os.tmpdir(),
        encoding: "utf8",
        timeout: 30000,
      },
    );
    const callsPath = path.join(root, "calls.jsonl");
    const calls = fs.existsSync(callsPath)
      ? fs.readFileSync(callsPath, "utf8").trim().split("\n").map(JSON.parse)
      : [];
    const secretPaths = ["search-bootstrap.txt", "search-runtime.txt"].map(
      (name) => path.join(root, ".qyvra-secrets", name),
    );
    const generated = secretPaths.every((file) => fs.existsSync(file))
      ? secretPaths.map((file) => fs.readFileSync(file, "utf8"))
      : [];
    return {
      ...result,
      calls,
      env: fs.readFileSync(path.join(root, ".env"), "utf8"),
      secretsGenerated:
        generated.length === 2 &&
        generated.every((value) => /^[a-f0-9]{64}$/.test(value)) &&
        generated[0] !== generated[1],
      secretsDisclosed: generated.some((value) =>
        (result.stdout + result.stderr).includes(value),
      ),
    };
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("qyvra-start-local-"));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test(
  "base startup builds and waits, excluding one-shot helpers",
  { skip: !available },
  () => {
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    const up = result.calls.find((args) => args.includes("up"));
    assert.ok(up.includes("--build") && up.includes("--wait"));
    assert.ok(up.includes("api") && !up.includes("migrate"));
    assert.ok(!up.includes("docker-compose.local-ai.yml"));
  },
);

test(
  "AI validation selects its override without starting containers",
  { skip: !available },
  () => {
    const result = run({ args: ["-AI", "-ValidateOnly"] });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(
      result.calls.every((args) =>
        args.includes("docker-compose.local-ai.yml"),
      ),
    );
    assert.ok(result.calls.every((args) => args.includes("config")));
  },
);

test("missing tokenizer stops before startup", { skip: !available }, () => {
  const result = run({ args: ["-AI"], missingBundle: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing mounted tokenizer/);
  assert.ok(!result.calls.some((args) => args.includes("up")));
});

test(
  "search waits before credential setup and full startup",
  { skip: !available },
  () => {
    const result = run({ search: true, args: ["-AI", "-Search", "-NoBuild"] });
    assert.equal(result.status, 0, result.stderr);
    const steps = result.calls.filter(
      (args) => args.includes("up") || args.includes("run"),
    );
    assert.equal(steps.length, 3);
    assert.equal(steps[0].at(-1), "elasticsearch");
    assert.equal(steps[1].at(-1), "search-setup");
    assert.ok(steps[2].includes("api") && !steps[2].includes("--build"));
    assert.ok(!steps[2].includes("search-setup"));
    assert.ok(
      result.calls.every(
        (args) =>
          args[0] === "info" || args.includes("docker-compose.search.yml"),
      ),
    );
  },
);

test(
  "search health failure stops before credentials or app startup",
  { skip: !available },
  () => {
    const result = run({ search: true, failWait: true, args: ["-Search"] });
    assert.equal(result.status, 1);
    assert.ok(!result.calls.some((args) => args.includes("run")));
    assert.equal(result.calls.filter((args) => args.includes("up")).length, 1);
  },
);

test(
  "identical search secrets are rejected without disclosing values",
  { skip: !available },
  () => {
    const result = run({ search: true, sameSecrets: true, args: ["-Search"] });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /passwords must differ/);
    assert.ok(!(result.stderr + result.stdout).includes("a".repeat(32)));
    assert.ok(!result.calls.some((args) => args.includes("up")));
  },
);

test("native Linux host override requires AI", { skip: !available }, () => {
  const result = run({ args: ["-OllamaHost"] });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires -AI/);
});

test(
  "all-in-one setup derives search fingerprints and verifies before enabling serving",
  { skip: !available },
  () => {
    const result = run({ all: true, search: true, args: ["-All", "-NoBuild"] });
    assert.equal(result.status, 0, result.stderr);
    const prepare = result.calls.findIndex((args) =>
      args.includes("QYVRA_LOCAL_SETUP_PHASE=prepare"),
    );
    const finish = result.calls.findIndex((args) =>
      args.includes("QYVRA_LOCAL_SETUP_PHASE=finish"),
    );
    assert.ok(prepare >= 0 && finish > prepare);
    assert.match(result.env, /SEARCH_GENERATION_FINGERPRINT=c{64}/);
    assert.match(result.env, /KEYWORD_SEARCH_ENABLED=true/);
    assert.ok(
      result.calls
        .slice(finish + 1)
        .some((args) => args.includes("up") && args.includes("api")),
    );
  },
);

test(
  "failed search preparation never enables serving",
  { skip: !available },
  () => {
    const result = run({
      all: true,
      search: true,
      failPrepare: true,
      args: ["-All", "-NoBuild"],
    });
    assert.equal(result.status, 1);
    assert.ok(!result.env.includes("KEYWORD_SEARCH_ENABLED=true"));
    assert.ok(
      !result.calls.some((args) =>
        args.includes("QYVRA_LOCAL_SETUP_PHASE=finish"),
      ),
    );
  },
);

test(
  "first local startup creates private secrets without exposing them",
  { skip: !available },
  () => {
    const result = run({
      all: true,
      search: true,
      missingSecretSettings: true,
      args: ["-All", "-NoBuild"],
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.secretsGenerated, true);
    assert.equal(result.secretsDisclosed, false);
    assert.match(
      result.env,
      /SEARCH_BOOTSTRAP_PASSWORD_FILE=.*search-bootstrap.txt/,
    );
  },
);

test(
  "existing search data blocks generating replacement credentials",
  { skip: !available },
  () => {
    const result = run({
      all: true,
      search: true,
      missingSecretSettings: true,
      existingVolume: true,
      args: ["-All", "-NoBuild"],
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Restore its original secret-file paths/);
    assert.equal(result.secretsGenerated, false);
    assert.ok(!result.calls.some((args) => args.includes("up")));
  },
);
