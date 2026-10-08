const { spawnSync } = require("node:child_process");
const { resolve } = require("node:path");
const {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
} = require("node:fs");
const { randomBytes } = require("node:crypto");
const { embeddingProfileFingerprint } = require("../../packages/database/dist");
const root = resolve(__dirname, "../..");
const project = process.env.E2E_PROJECT_NAME || "qyvra-e2e-ai";
if (!/^qyvra-e2e-ai(?:-[a-z0-9-]+)?$/.test(project))
  throw Error("Use an isolated qyvra-e2e-ai project name.");
const profile = {
  provider: "openai-compatible",
  model: "e2e-embedding",
  modelRevision: "v1",
  dimensions: 3,
  distance: "Cosine",
  profileVersion: 1,
  normalizationVersion: "qyvra-embedding-input/v1",
  tokenizer: "cl100k_base",
  tokenizerVersion: "tiktoken-1.0.22",
  documentInstruction: "",
  queryInstruction: "",
};
const envFile = resolve(root, `.tools/${project}.env`);
mkdirSync(resolve(root, ".tools"), { recursive: true });
if (!existsSync(envFile))
  writeFileSync(
    envFile,
    `POSTGRES_USER=qyvra_e2e\nPOSTGRES_DB=qyvra_e2e\nPOSTGRES_PASSWORD=${randomBytes(24).toString("hex")}\nNGINX_PORT=18080\nPUBLIC_APP_URL=http://localhost:18080\nUPLOAD_MAX_BYTES=2097152\n`,
    { mode: 0o600 },
  );
const fixtureEnv = Object.fromEntries(
  readFileSync(envFile, "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
);
if (
  fixtureEnv.POSTGRES_USER !== "qyvra_e2e" ||
  fixtureEnv.POSTGRES_DB !== "qyvra_e2e" ||
  !/^[a-f0-9]{48}$/.test(fixtureEnv.POSTGRES_PASSWORD ?? "")
)
  throw Error("Use the generated isolated AI test environment.");
// Ambient deployment credentials and volume mappings must never enter this fixture stack.
const env = {
  ...process.env,
  ...fixtureEnv,
  POSTGRES_VOLUME_NAME: `${project}_postgres_data`,
  STORAGE_VOLUME_NAME: `${project}_storage_data`,
  RABBITMQ_VOLUME_NAME: `${project}_rabbitmq_data`,
  QDRANT_VOLUME_NAME: `${project}_qdrant_data`,
  PERSISTENT_VOLUMES_EXTERNAL: "false",
  QDRANT_VOLUME_EXTERNAL: "false",
  NODE_ENV: "development",
  RABBITMQ_USER: "qyvra",
  RABBITMQ_PASSWORD: fixtureEnv.POSTGRES_PASSWORD,
  RABBITMQ_HOSTNAME: "rabbitmq",
  EMBEDDING_API_KEY: "",
  GENERATION_API_KEY: "",
  QDRANT_API_KEY: "",
  REDIS_URL: "redis://redis:6379",
  QDRANT_URL: "http://qdrant:6333",
  COOKIE_SECURE: "false",
  PUBLIC_APP_URL: "http://localhost:18080",
  NGINX_PORT: "18080",
  E2E_EMBEDDING_FINGERPRINT: embeddingProfileFingerprint(profile),
  E2E_AI_ENABLED: "true",
  E2E_PROJECT_NAME: project,
};
const args = [
  "compose",
  "-p",
  project,
  "--env-file",
  envFile,
  "-f",
  resolve(root, "docker-compose.yml"),
  "-f",
  resolve(__dirname, "compose.yml"),
  "-f",
  resolve(__dirname, "ai-compose.yml"),
];
function compose(extra, input) {
  const result = spawnSync("docker", [...args, ...extra], {
    cwd: root,
    env,
    shell: false,
    stdio: input ? ["pipe", "inherit", "inherit"] : "inherit",
    input,
  });
  if (result.error || result.status !== 0)
    throw Error(`AI browser stack command failed: ${extra[0]}`);
}
const seed = `const {createPrismaClient,embeddingProfileFingerprint}=require('@qyvra/database');const identity=${JSON.stringify(profile)};const db=createPrismaClient({url:'postgresql://'+encodeURIComponent(process.env.POSTGRES_USER)+':'+encodeURIComponent(process.env.POSTGRES_PASSWORD)+'@postgres:5432/'+process.env.POSTGRES_DB});(async()=>{const fingerprint=embeddingProfileFingerprint(identity);const p=await db.embeddingProfile.upsert({where:{fingerprint},create:{...identity,fingerprint},update:{}});await db.aiServingProfile.upsert({where:{id:1},create:{id:1,embeddingProfileId:p.id},update:{embeddingProfileId:p.id}});})().catch(()=>{console.error('Test profile seed failed');process.exitCode=1}).finally(()=>db.$disconnect());`;
const action = process.argv[2] || "test";
try {
  if (action === "down") compose(["down"]);
  else if (action === "storage-count")
    compose([
      "exec",
      "-T",
      "api",
      "node",
      "-e",
      "const fs=require('node:fs');function count(p){return fs.readdirSync(p,{withFileTypes:true}).reduce((n,e)=>n+(e.isDirectory()?count(p+'/'+e.name):1),0)}console.log(count('/data/qyvra'))",
    ]);
  else if (action === "recreate" || action === "expiry") {
    if (action === "expiry") env.E2E_SESSION_TTL = "8";
    compose([
      "up",
      "-d",
      "--no-deps",
      "--force-recreate",
      "--wait",
      "--wait-timeout",
      "180",
      ...(action === "expiry" ? ["api"] : ["api", "web"]),
    ]);
  } else if (action === "build-web") {
    compose(["build", "web"]);
    compose([
      "up",
      "-d",
      "--no-deps",
      "--force-recreate",
      "--wait",
      "--wait-timeout",
      "180",
      "web",
    ]);
  } else if (action === "validate") {
    compose(["config", "--quiet"]);
    compose(["exec", "-T", "nginx", "nginx", "-t"]);
  } else if (action === "up" || action === "test") {
    compose(["config", "--quiet"]);
    if (process.env.E2E_NO_BUILD !== "true") compose(["build"]);
    compose(["up", "-d", "--wait", "--wait-timeout", "240", "postgres"]);
    compose(["run", "--rm", "migrate"]);
    // Enrollment intentionally refuses startup until its immutable profile exists.
    compose(["run", "--rm", "--no-deps", "-T", "api", "node"], seed);
    compose(["up", "-d", "--wait", "--wait-timeout", "240"]);
    if (action === "test") {
      try {
        const result = spawnSync(
          process.execPath,
          [
            resolve(root, "apps/web/node_modules/@playwright/test/cli.js"),
            "test",
            "phase-four-ai.spec.ts",
            ...process.argv.slice(3),
          ],
          {
            cwd: resolve(root, "apps/web"),
            env,
            shell: false,
            stdio: "inherit",
          },
        );
        if (result.error) throw result.error;
        process.exitCode = result.status ?? 1;
      } finally {
        compose(["down"]);
      }
    }
  } else
    throw Error("Use up, down, recreate, expiry, build-web, validate or test.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
  if (action === "test") {
    try {
      compose(["down"]);
    } catch {
      console.error(
        "AI test stack cleanup failed; inspect the isolated project.",
      );
    }
  }
}
