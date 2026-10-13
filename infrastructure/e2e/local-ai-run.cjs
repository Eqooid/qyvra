// Explicit T05 operator tool, not application startup. No downloads or builds.
const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "../..");
const assets = path.join(root, ".tools/v131-local-assets");
const stateFile = path.join(assets, "stack.json");
const profile = JSON.parse(
  fs.readFileSync(path.join(assets, "profile.json"), "utf8"),
);
const calibration = JSON.parse(
  fs.readFileSync(path.join(assets, "calibration.json"), "utf8"),
);
if (
  calibration.fingerprint !== profile.fingerprint ||
  !Number.isFinite(calibration.threshold)
)
  throw Error("Missing compatible test calibration");
if (!fs.existsSync(stateFile))
  fs.writeFileSync(
    stateFile,
    JSON.stringify({
      project: "qyvra-e2e-ai-v131-" + randomBytes(4).toString("hex"),
      password: randomBytes(24).toString("hex"),
    }),
    { mode: 0o600 },
  );
const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
if (
  !/^qyvra-e2e-ai-v131-[a-f0-9]{8}$/.test(state.project) ||
  !/^[a-f0-9]{48}$/.test(state.password)
)
  throw Error("Invalid isolated stack identity");
const envFile = path.join(assets, "stack.env");
const values = {
  COMPOSE_PROJECT_NAME: state.project,
  POSTGRES_USER: "qyvra_e2e",
  POSTGRES_DB: "qyvra_e2e",
  POSTGRES_PASSWORD: state.password,
  RABBITMQ_USER: "qyvra",
  RABBITMQ_PASSWORD: state.password,
  POSTGRES_VOLUME_NAME: state.project + "_postgres_data",
  STORAGE_VOLUME_NAME: state.project + "_storage_data",
  RABBITMQ_VOLUME_NAME: state.project + "_rabbitmq_data",
  QDRANT_VOLUME_NAME: state.project + "_qdrant_data",
  PERSISTENT_VOLUMES_EXTERNAL: "false",
  QDRANT_VOLUME_EXTERNAL: "false",
  NODE_ENV: "development",
  NGINX_PORT: "18081",
  PUBLIC_APP_URL: "http://localhost:18081",
  COOKIE_SECURE: "false",
  LOCAL_AI_ASSETS_DIR: assets.replaceAll("\\", "/"),
  AI_INGESTION_ENABLED: "true",
  AI_INGESTION_PROFILE_FINGERPRINT: profile.fingerprint,
  EMBEDDING_ENABLED: "true",
  EMBEDDING_PROFILE_FINGERPRINT: profile.fingerprint,
  EMBEDDING_ENDPOINT: "http://local-provider-relay:11434/api/embed",
  EMBEDDING_ALLOW_HTTP: "true",
  EMBEDDING_API_KEY: "",
  EMBEDDING_TOKENIZER_PATH: "/run/qyvra-ai/nomic-bundle.json",
  EMBEDDING_SEND_DIMENSIONS: "false",
  EMBEDDING_BATCH_SIZE: "1",
  EMBEDDING_MAX_INPUT_TOKENS: "2048",
  EMBEDDING_MAX_BATCH_TOKENS: "4096",
  EMBEDDING_TIMEOUT_MS: "60000",
  VECTOR_INDEX_ENABLED: "true",
  QDRANT_URL: "http://qdrant:6333",
  QDRANT_API_KEY: "",
  QDRANT_ALLOW_HTTP: "true",
  SEMANTIC_SEARCH_ENABLED: "true",
  SEMANTIC_SEARCH_MIN_SCORE: String(calibration.threshold),
  RAG_ENABLED: "true",
  RAG_CONTEXT_TOKENS: "4096",
  RAG_TIMEOUT_MS: "120000",
  GENERATION_PROVIDER: "ollama",
  GENERATION_MODEL: "qwen3:0.6b",
  GENERATION_ENDPOINT: "http://local-provider-relay:11434/api/chat",
  GENERATION_ALLOW_HTTP: "true",
  GENERATION_API_KEY: "",
  GENERATION_TOKENIZER: "huggingface-json",
  GENERATION_TOKENIZER_PATH: "/run/qyvra-ai/qwen-bundle.json",
  GENERATION_THINK: "false",
  GENERATION_TIMEOUT_MS: "60000",
  GENERATION_MAX_OUTPUT_TOKENS: "256",
  GENERATION_TEMPERATURE: "0",
  REDIS_URL: "redis://redis:6379",
  CHUNK_SIZE_TOKENS: "80",
  CHUNK_OVERLAP_TOKENS: "10",
  WORKER_PREFETCH: "1",
};
fs.writeFileSync(
  envFile,
  Object.entries(values)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n") + "\n",
  { mode: 0o600 },
);
// Clear deployment environment keys; never inherit operator volume/AI credentials.
const env = { ...process.env };
for (const match of fs
  .readFileSync(path.join(root, ".env.example"), "utf8")
  .matchAll(/^([A-Z_0-9]+)=/gm))
  delete env[match[1]];
Object.assign(env, values);
const args = [
  "compose",
  "-p",
  state.project,
  "--env-file",
  envFile,
  "-f",
  path.join(root, "docker-compose.yml"),
  "-f",
  path.join(root, "docker-compose.local-ai.yml"),
  "-f",
  path.join(__dirname, "local-ai-compose.yml"),
];
function compose(extra, input) {
  const r = spawnSync("docker", [...args, ...extra], {
    cwd: root,
    env,
    input,
    stdio: input ? ["pipe", "inherit", "inherit"] : "inherit",
  });
  if (r.error || r.status !== 0)
    throw Error("Isolated local-AI command failed: " + extra[0]);
}
const action = process.argv[2];
if (action === "infra") {
  compose(["config", "--quiet"]);
  compose([
    "up",
    "-d",
    "--no-build",
    "--pull",
    "never",
    "postgres",
    "rabbitmq",
    "redis",
    "qdrant",
    "local-provider-relay",
  ]);
} else if (action === "up") {
  compose(["run", "--rm", "migrate"]);
  const { fingerprint } = profile;
  const seed = `const {createPrismaClient}=require('@qyvra/database');const db=createPrismaClient({url:'postgresql://'+process.env.POSTGRES_USER+':'+process.env.POSTGRES_PASSWORD+'@postgres:5432/'+process.env.POSTGRES_DB});(async()=>{const p=await db.embeddingProfile.upsert({where:{fingerprint:${JSON.stringify(fingerprint)}},create:${JSON.stringify(profile)},update:{}});await db.aiServingProfile.upsert({where:{id:1},create:{id:1,embeddingProfileId:p.id},update:{embeddingProfileId:p.id}})})().catch(()=>{console.error('Isolated profile seed failed');process.exitCode=1}).finally(()=>db.$disconnect());`;
  compose(["run", "--rm", "--no-deps", "-T", "api", "node"], seed);
  compose([
    "up",
    "-d",
    "--no-build",
    "--pull",
    "never",
    "--wait",
    "--wait-timeout",
    "240",
  ]);
} else if (action === "down") compose(["down"]);
else if (action === "exec")
  compose(["exec", "-T", "api", "node"], fs.readFileSync(process.argv[3]));
else if (action === "compose") compose(process.argv.slice(3));
else throw Error("Use infra, up, down, exec <script>, or compose <args>.");
