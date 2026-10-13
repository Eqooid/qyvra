# Local AI setup — v1.3.1

This is the reproducible operator guide for the **T05-certified pair**, not automatic
model management. Start with [host/Docker basics](getting-started.md),
[provider configuration](../local-provider-configuration.md) and
[the evidence](../local-provider-verification.md). Keep existing production `.env`,
volumes and serving profiles intact; validate in a separate test environment first.

## Verified assets

| Component             | Certified value                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Ollama                | 0.40.3, native `/api/embed` and `/api/chat`; sibling `/api/tags` required                                          |
| Embedding model       | `nomic-embed-text:v1.5`, 768 dimensions, digest `0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f` |
| Generation model      | `qwen3:0.6b`, digest `7df6b6e09427a769808717c0a93cadc4ae99ed4eb8bf5ca557c90846becea435`                            |
| Embedding upstream    | `nomic-ai/nomic-embed-text-v1.5`, revision `e9b6763023c676ca8431644204f50c2b100d9aab`                              |
| Generation upstream   | `Qwen/Qwen3-0.6B`, revision `c1899de289a04d12100db370d81485cdf75e47ca`                                             |
| Runtime tokenizer     | `@huggingface/tokenizers` 0.2.0; no Python runtime required by Qyvra                                               |
| Independent reference | `tokenizers` 0.22.1 for explicit bundle preparation only                                                           |
| Certified budgets     | 2048 embedding input tokens, 4096 generation context, 256 output, thinking false                                   |

T05 used Windows x64, Docker Desktop Linux engine 27.4.0, 16 GB RAM and a detected
4 GB NVIDIA GPU. Nomic download was about 274 MB; Qwen was already installed
(about 523 MB). These are observations, not minimum requirements or CPU/GPU speed
guarantees. Ensure disk/RAM are sufficient before pulling; do not delete data to
make room. Ollama installation, drivers and protected listener/firewall configuration
remain operator responsibilities. No mandatory GPU, Compose Ollama service or downloads.

## Check and provision models

Run on the Ollama host. Existing installations can reuse installed models:

```sh
ollama --version
ollama list
ollama show nomic-embed-text:v1.5
ollama show qwen3:0.6b
```

Only when missing and resources permit, explicitly run `ollama pull nomic-embed-text:v1.5`
or `ollama pull qwen3:0.6b`. Tags can change: compare `/api/tags` digest to the table
before preparing assets. A different digest requires fresh certification, not editing
the expected digest to bypass checks. `/api/show` reports embedding vs chat capabilities;
a chat model's internal embedding length is not proof that it supports `/api/embed`.

PowerShell read-only probes:

```powershell
Invoke-RestMethod http://127.0.0.1:11434/api/version
Invoke-RestMethod http://127.0.0.1:11434/api/tags
Invoke-RestMethod http://127.0.0.1:11434/api/show -Method Post -ContentType application/json -Body '{"model":"nomic-embed-text:v1.5"}'
```

Use a trusted configured address for another host. Container `localhost` is not the
Ollama host. Protect LAN/remote inference; never route Ollama through browser/Nginx.

## Prepare pinned tokenizer data

Build the API/shared packages with the normal npm convention first:
`npm --prefix apps/api run build` (`npm.cmd` on Windows). The explicit preparation
steps below run from repository root; nothing downloads at application startup.
The ignored `.tools` directory keeps assets/reference wheels out of Git.

Save this data-only downloader as `.tools/fetch-local-tokenizers.cjs`, then run
`node .tools/fetch-local-tokenizers.cjs`. It fetches only the four pinned JSON files,
verifies fixed SHA-256 and writes the manifest consumed by the existing reference tool:

```js
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const root = path.resolve(".tools/v131-local-assets");
fs.mkdirSync(root, { recursive: true });
const models = [
  [
    "nomic",
    "nomic-ai/nomic-embed-text-v1.5",
    "e9b6763023c676ca8431644204f50c2b100d9aab",
    "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66",
    "d7e0000bcc80134debd2222220427e6bf5fa20a669f40a0d0d1409cc18e0a9bc",
  ],
  [
    "qwen",
    "Qwen/Qwen3-0.6B",
    "c1899de289a04d12100db370d81485cdf75e47ca",
    "aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4",
    "d5d09f07b48c3086c508b30d1c9114bd1189145b74e982a265350c923acd8101",
  ],
];
(async () => {
  const manifest = [];
  for (const [alias, repo, revision, ...hashes] of models) {
    for (const [i, file] of [
      "tokenizer.json",
      "tokenizer_config.json",
    ].entries()) {
      const url = `https://huggingface.co/${repo}/resolve/${revision}/${file}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw Error("Pinned artifact unavailable");
      const bytes = Buffer.from(await response.arrayBuffer());
      const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
      if (bytes.length > 32000000 || sha256 !== hashes[i])
        throw Error("Artifact integrity mismatch");
      JSON.parse(bytes.toString("utf8"));
      fs.writeFileSync(path.join(root, alias + "-" + file), bytes);
      manifest.push({ repo, revision, file, bytes: bytes.length, sha256, url });
    }
  }
  fs.writeFileSync(
    path.join(root, "upstream-manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
})().catch(() => {
  console.error("Pinned tokenizer preparation failed");
  process.exitCode = 1;
});
```

Install the independent reference wheel **in the workspace only**, then generate
bundles using the already-implemented, data-only helper:

```sh
python -m pip install --target .tools/v131-reference --no-deps tokenizers==0.22.1
python infrastructure/e2e/local-tokenizer-reference.py
```

The helper is specific to this certified pair; it does not certify arbitrary models.
It checks manifest hashes and writes `nomic-bundle.json` / `qwen-bundle.json` with
model digest, tokenizer/config JSON, token-ID parity samples and restricted Qwen
system/user framing. It never executes downloaded template code. Expected bundle
SHA-256 values are respectively `572ea76f7a75cfd6afcdc2a0bb759b2018490f4823303529ddcd6a14e73f57ba`
and `e8dc4542a4ef7dc43a93519443e67b1e13a0f5a67c870b80793e568933093f73`.
Do not use synthetic test fixture tokenizers with real models.

Tokenizers serve embedding input-limit/parity checks and API generation context
budgeting. Canonical PDF chunking retains its existing deterministic strategy; it
is not rewritten under a new model tokenizer. Runtime reads local bundles once at
provider creation; no assets network/cache fetching. Missing/corrupt/mismatched
bundles fail clearly. Nomic CLS/SEP and literal prefixes must match; Qwen thinking,
chat framing and exact prompt counts must match. Bundles at most 64 MB, no tokenizer
padding/truncation. Changing bundle bytes changes embedding tokenizer version.

## Produce the immutable profile and test calibration

Save this as `.tools/prepare-local-profile.cjs` and run it from repository root
after a build. It uses the actual adapter and real Ollama to calibrate only the
small T05 synthetic corpus. It does not create SQL records or change your deployment.

```js
const fs = require("node:fs");
const path = require("node:path");
const { embeddingProfileFingerprint } = require("../packages/database/dist");
const {
  LocalEmbeddingTokenizer,
} = require("../apps/api/dist/infrastructure/embeddings/local-tokenizer");
const {
  createEmbeddingProvider,
} = require("../apps/api/dist/infrastructure/embeddings/embedding-provider.factory");
const root = path.resolve(".tools/v131-local-assets");
const tokenizer = new LocalEmbeddingTokenizer(root + "/nomic-bundle.json");
const profile = {
  provider: "ollama",
  model: "nomic-embed-text:v1.5",
  modelRevision:
    "sha256:0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f",
  dimensions: 768,
  distance: "Cosine",
  profileVersion: 1,
  normalizationVersion: "qyvra-embedding-prefix/v1",
  tokenizer: "huggingface-json",
  tokenizerVersion: tokenizer.version,
  documentInstruction: "search_document: ",
  queryInstruction: "search_query: ",
};
const fingerprint = embeddingProfileFingerprint(profile);
fs.writeFileSync(
  root + "/profile.json",
  JSON.stringify({ ...profile, fingerprint }, null, 2),
);
const provider = createEmbeddingProvider({
  enabled: true,
  endpoint: "http://127.0.0.1:11434/api/embed",
  tokenizerPath: root + "/nomic-bundle.json",
  batchSize: 4,
  maxInputTokens: 2048,
  maxBatchTokens: 4096,
  timeoutMs: 60000,
  sendDimensions: false,
});
const documents = [
  "Project ORBIT-731 launches from Meridian Harbor. The mission launch code is ORBIT-731. The planned launch date is 17 June 2032.",
  "Project ORBIT-731 carries exactly 24 equipment crates. The logistics lead is Mira Sen.",
  "The mission safety color is amber.",
];
const queries = [
  "Where does project ORBIT-731 launch from?",
  "How many equipment crates are carried?",
  "What is the mission safety color?",
  "What is the ocean depth in meters?",
];
const embed = (purpose, texts) =>
  provider.embed({
    profile,
    purpose,
    inputs: texts.map((text, i) => ({ id: String(i), text })),
    signal: AbortSignal.timeout(60000),
  });
(async () => {
  const docs = await embed("document", documents),
    qs = await embed("query", queries);
  const cosine = (a, b) =>
    a.reduce((sum, v, i) => sum + v * b[i], 0) /
    (Math.hypot(...a) * Math.hypot(...b));
  const scores = qs.map((q, i) => ({
    query: queries[i],
    scores: docs.map((d) => cosine(q.vector, d.vector)),
  }));
  const positive = Math.min(...scores.slice(0, 3).map((s, i) => s.scores[i]));
  const negative = Math.max(...scores[3].scores);
  if (positive <= negative)
    throw Error("Synthetic calibration does not separate evidence");
  fs.writeFileSync(
    root + "/calibration.json",
    JSON.stringify(
      {
        fingerprint,
        scores,
        threshold: (positive + negative) / 2,
        scope: "synthetic T05 only, not production calibration",
      },
      null,
      2,
    ),
  );
})().catch(() => {
  console.error("Local profile/calibration failed");
  process.exitCode = 1;
});
```

Certified profile fingerprint is `d974061c6457904b1bc92abd1ec496798cb8d39d2939383621f6d8a624d7cf92`.
The native adapter verifies installed digest before/after inference, finite vectors,
768 dimensions, response count/order and exact aggregate token count. Production
score calibration must use your actual corpus; the T05 threshold is not universal.

## Reproduce the isolated application workflow

Check loopback ports 18081, 55440, 55672, 56379 and 56333 are free. The runner
creates a generated `qyvra-e2e-ai-v131-*` project, random private credentials and
new test volumes, then seeds only that database. It uses a private relay to real
host Ollama; only controlled failures are synthetic, never vectors/answers.
It requires the cached infrastructure images named in [the fixture](../../infrastructure/e2e/local-ai-compose.yml).
For a fresh workstation, use the normal root `.env` setup first and explicitly
`docker compose pull postgres rabbitmq redis qdrant` if those images are absent.
That is an operator image-preparation action; the fixture itself refuses image pulls.

```sh
docker build --target runtime -t qyvra-v131-local-test:latest -f infrastructure/docker/api.Dockerfile .
docker build --target migration -t qyvra-migrate:latest -f infrastructure/docker/api.Dockerfile .
docker compose build web nginx
node infrastructure/e2e/local-ai-run.cjs infra
node infrastructure/e2e/local-ai-run.cjs up
node infrastructure/e2e/local-ai-verify.cjs
node infrastructure/e2e/local-ai-run.cjs down
```

These commands build images but do not recreate the normal running Qyvra services.
The verification tool authenticates synthetic users, generates/uploads a multi-page
PDF through real API, checks workers/checkpoints/indexes, asks real Qwen, verifies
citations, cross-user isolation, controlled outage/rebuild and browser source navigation.
Playwright Chromium must already be installed through existing development setup.
For a recorded browser-only continuation use `local-ai-verify.cjs --browser-only`.
Keep prior results/logs; do not repeatedly redo passing workflows. `down` never
adds `-v`; models/assets/test volumes remain. Normal app startup does not run this tool.

## Configure your own development deployment

1. Preserve existing configuration/data and decide whether this is a fresh local
   profile or a staged cutover from cloud. Seed the immutable profile with the
   existing Prisma client from trusted operator code. There is no public profile
   administration endpoint or implicit model selection via request data.
2. On a fresh installation, set SQL `AiServingProfile` id 1 to the new profile.
   On an existing installation, follow the [cutover procedure](../developer/versions/v1.3.1.md#profiles-indexing-and-cutover);
   do not overwrite serving selection while incompatible transport remains enabled.
3. Set `LOCAL_AI_ASSETS_DIR` to the absolute directory holding certified bundles.
   Use the optional `docker-compose.local-ai.yml` to bind it read-only to `/run/qyvra-ai`.
   For your own deployment, use an asset-only directory: copy certified bundles,
   not the isolated fixture's env, password/session state or model weights.
4. Set `EMBEDDING_ENDPOINT` to the full trusted `/api/embed` URL, the profile and
   ingestion fingerprints, input cap 2048, batch size appropriate to hardware,
   `EMBEDDING_SEND_DIMENSIONS=false`, and `EMBEDDING_TOKENIZER_PATH` to the mounted bundle.
5. Set independent `GENERATION_PROVIDER=ollama`, model `qwen3:0.6b`, full `/api/chat`
   URL, `GENERATION_TOKENIZER=huggingface-json`, bundle path, thinking false,
   output cap 256 and `RAG_CONTEXT_TOKENS=4096`. Local HTTP requires explicit
   `*_ALLOW_HTTP=true`; use a protected endpoint. Native keys may be empty.
6. Enable indexing/search/ingestion and RAG only after profile provisioning and
   calibrated `SEMANTIC_SEARCH_MIN_SCORE`. Use existing backfill/reprocess for old
   documents. Restart API/worker after settings/assets change, retaining matching
   code/images/outbox and persistent volume mappings.

For host Docker Desktop, the URL host is `host.docker.internal:11434`. On native
Linux load the explicit `docker-compose.ollama-host.yml` host-gateway override.
An existing Ollama container can join a private provider network via service DNS;
Qyvra supplies no mandatory Ollama container/GPU/model pull. A LAN/remote endpoint
uses operator DNS/address, private networking and TLS/authentication as appropriate.
Do not change firewall rules or expose unauthenticated inference publicly just to
resolve connectivity. Host/LAN listener binding and firewall must permit the trusted
API/worker path. Test from **both containers**, not merely from the host.

```sh
docker compose -f docker-compose.yml -f docker-compose.local-ai.yml up --build -d
# Native Linux host access, when needed:
docker compose -f docker-compose.yml -f docker-compose.local-ai.yml -f docker-compose.ollama-host.yml up --build -d
```

## Troubleshooting and recovery

- Catalog unavailable: inspect DNS, host-gateway, listener binding and trusted firewall
  path. Wrong `/v1` or bare base URL is not the native request endpoint.
- Bundle invalid/digest changed: restore pinned assets/model or create a newly certified
  profile. Do not guess token counts, trim/pad vectors or bypass exact checks.
- Embedding outage: PostgreSQL retry/recovery retains valid checkpoints; inspect the
  existing owned processing-status API and worker/outbox logs. Permanent configuration
  errors require correction plus intentional reprocess, not an infinite retry loop.
- Generation 503/504/429/502: controlled provider/timeout/rate/invalid-output error;
  no unvalidated partial answer is published. Original documents remain accessible.
- Lost Qdrant: owned `mode:index` reprocess rebuilds from valid stored embeddings.
  Wait for replacement READY, not merely a retained old ready pointer. Never delete
  shared/production collections to reproduce the test.
- Missing evidence or invalid citation: preserve abstention/rejection. Tiny Qwen may
  fail closed on adversarial text; changing generation alone does not re-embed files.

[Upgrade/rollback](../releases/v1.3.1.md#upgrade-from-v130) |
[Configuration/defaults](../local-provider-configuration.md) |
[Security/recovery walkthrough](../developer/versions/v1.3.1.md)
