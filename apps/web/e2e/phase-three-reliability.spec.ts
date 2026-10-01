import { test, expect, type Page } from "@playwright/test"
import { randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import { resolve } from "node:path"
import { png } from "./fixtures"
import { password, register } from "./auth"

const root = resolve(process.cwd(), "../..")
const project = process.env.E2E_PROJECT_NAME
if (!project?.startsWith("brainless-e2e-t13"))
  throw new Error("Reliability tests require the isolated T13 Compose project")
const composeArgs = [
  "compose",
  "-p",
  project,
  "--env-file",
  resolve(root, ".tools/brainless-e2e.env"),
  "-f",
  resolve(root, "docker-compose.yml"),
  "-f",
  resolve(root, "infrastructure/e2e/compose.yml"),
]
function compose(...args: string[]) {
  return execFileSync("docker", [...composeArgs, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 240000,
  }).trim()
}
function sql(query: string) {
  return compose(
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "brainless_e2e",
    "-d",
    "brainless_e2e",
    "-tAc",
    query
  )
}
function outboxStatus(jobId: string) {
  if (!/^[0-9a-f-]{36}$/.test(jobId)) throw new Error("Invalid job ID")
  return sql(
    `SELECT status FROM processing_outbox WHERE processing_job_id='${jobId}'::uuid ORDER BY dispatch_sequence LIMIT 1`
  )
}
function changeStoredFile(
  versionId: string,
  operation: "corrupt" | "remove" | "deny" | "restore"
) {
  if (!/^[0-9a-f-]{36}$/.test(versionId)) throw new Error("Invalid version ID")
  const key = sql(
    `SELECT storage_key FROM document_versions WHERE id='${versionId}'::uuid`
  )
  if (
    !/^documents\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/original\.[a-z0-9]+$/.test(
      key
    )
  )
    throw new Error("Unexpected isolated storage key")
  const script = {
    corrupt:
      "require('node:fs').writeFileSync('/data/brainless/'+process.argv[1],Buffer.from('corrupt'))",
    remove: "require('node:fs').unlinkSync('/data/brainless/'+process.argv[1])",
    deny: "require('node:fs').chmodSync('/data/brainless/'+process.argv[1],0)",
    restore:
      "require('node:fs').chmodSync('/data/brainless/'+process.argv[1],0o600)",
  }[operation]
  compose("exec", "-T", "api", "node", "-e", script, key)
}
function publishDuplicate(jobId: string) {
  if (!/^[0-9a-f-]{36}$/.test(jobId)) throw new Error("Invalid job ID")
  const payload = sql(
    `SELECT payload::text FROM processing_outbox WHERE processing_job_id='${jobId}'::uuid AND dispatch_sequence=1`
  )
  const script = `const amqp=require('amqplib');(async()=>{const m=JSON.parse(process.argv[1]);const url='amqp://'+encodeURIComponent(process.env.RABBITMQ_USER)+':'+encodeURIComponent(process.env.RABBITMQ_PASSWORD)+'@rabbitmq:5672/';const c=await amqp.connect(url);try{const ch=await c.createConfirmChannel();ch.publish('brainless.processing.v1','processing.execute.v1',Buffer.from(JSON.stringify(m)),{persistent:true,contentType:'application/json',messageId:m.messageId,correlationId:m.correlationId});await ch.waitForConfirms();await ch.close()}finally{await c.close()}})().catch(()=>process.exit(1))`
  compose("exec", "-T", "outbox", "node", "-e", script, payload)
}
async function upload(page: Page, seed: number, width = 16, height = 16) {
  const response = await page.request.post("/api/v1/documents", {
    headers: {
      Origin: "http://localhost:18080",
      "X-CSRF-Protection": "1",
      "Idempotency-Key": randomUUID(),
    },
    multipart: {
      title: `Recovery ${randomUUID()}`,
      documentType: "OTHER",
      file: {
        name: `recovery-${seed}.png`,
        mimeType: "image/png",
        buffer: png(seed, width, height),
      },
    },
  })
  expect(response.status()).toBe(201)
  const documentId = (await response.json()).data.id as string
  const detail = await page.request.get(`/api/v1/documents/${documentId}`)
  expect(detail.status()).toBe(200)
  const versionId = (await detail.json()).data.currentVersion.id as string
  return { documentId, versionId }
}
async function status(page: Page, documentId: string, versionId: string) {
  const response = await page.request.get(
    `/api/v1/documents/${documentId}/versions/${versionId}/processing`
  )
  expect(response.status()).toBe(200)
  return (await response.json()).data.jobs[0] as {
    id: string
    status: string
    attempts: number
    maxAttempts: number
    progress: unknown
    failureCode: string | null
  }
}

test("worker outage retains published work until consumer restart", async ({
  page,
}) => {
  test.setTimeout(180000)
  await register(
    page,
    `worker-recovery-${randomUUID()}@example.invalid`,
    password()
  )
  compose("stop", "worker")
  try {
    const { documentId, versionId } = await upload(page, Date.now())
    const job = await status(page, documentId, versionId)
    await expect
      .poll(() => outboxStatus(job.id), { timeout: 30000 })
      .toBe("PUBLISHED")
    expect((await status(page, documentId, versionId)).status).not.toBe(
      "COMPLETED"
    )
    compose("start", "worker")
    await expect
      .poll(async () => (await status(page, documentId, versionId)).status, {
        timeout: 90000,
      })
      .toBe("COMPLETED")
  } finally {
    compose("start", "worker")
  }
})

test("broker outage leaves outbox durable and resumes on restart", async ({
  page,
}) => {
  test.setTimeout(180000)
  await register(
    page,
    `broker-recovery-${randomUUID()}@example.invalid`,
    password()
  )
  compose("stop", "rabbitmq")
  try {
    const { documentId, versionId } = await upload(page, Date.now() + 1)
    const job = await status(page, documentId, versionId)
    expect(outboxStatus(job.id)).not.toBe("PUBLISHED")
    compose("start", "rabbitmq")
    await expect
      .poll(() => outboxStatus(job.id), { timeout: 90000 })
      .toBe("PUBLISHED")
    await expect
      .poll(async () => (await status(page, documentId, versionId)).status, {
        timeout: 90000,
      })
      .toBe("COMPLETED")
  } finally {
    compose("start", "rabbitmq")
  }
})

test("Redis outage leaves processing and owned status available", async ({
  page,
}) => {
  test.setTimeout(180000)
  await register(
    page,
    `redis-recovery-${randomUUID()}@example.invalid`,
    password()
  )
  compose("stop", "redis")
  try {
    const { documentId, versionId } = await upload(page, Date.now() + 2)
    await expect
      .poll(async () => (await status(page, documentId, versionId)).status, {
        timeout: 90000,
      })
      .toBe("COMPLETED")
    const job = await status(page, documentId, versionId)
    expect(job.attempts).toBe(1)
    expect(job.progress).toBeNull()
    await page.goto(`/documents/${documentId}`)
    await expect(page.getByText("Integrity verified")).toBeVisible()
    expect(await page.getByText("Redis unavailable").count()).toBe(0)
  } finally {
    compose("start", "redis")
  }
})

test("corrupted private bytes produce a terminal, sanitized integrity failure", async ({
  page,
}) => {
  test.setTimeout(180000)
  await register(page, `corrupt-${randomUUID()}@example.invalid`, password())
  compose("stop", "worker")
  try {
    const { documentId, versionId } = await upload(page, Date.now() + 3)
    changeStoredFile(versionId, "corrupt")
    compose("start", "worker")
    await expect
      .poll(async () => (await status(page, documentId, versionId)).status, {
        timeout: 90000,
      })
      .toBe("FAILED")
    const job = await status(page, documentId, versionId)
    expect(job.attempts).toBe(1)
    expect(job.failureCode).toBe("FILE_INTEGRITY_FAILED")
    await page.goto(`/documents/${documentId}`)
    await expect(page.getByText("Integrity verification failed")).toBeVisible()
    await expect(
      page.getByText("The stored file did not pass integrity verification.")
    ).toBeVisible()
    expect(await page.getByText("/data/brainless").count()).toBe(0)
  } finally {
    compose("start", "worker")
  }
})

test("missing private bytes report a sanitized missing-file failure", async ({
  page,
}) => {
  test.setTimeout(180000)
  await register(page, `missing-${randomUUID()}@example.invalid`, password())
  compose("stop", "worker")
  try {
    const { documentId, versionId } = await upload(page, Date.now() + 4)
    changeStoredFile(versionId, "remove")
    compose("start", "worker")
    await expect
      .poll(async () => (await status(page, documentId, versionId)).status, {
        timeout: 90000,
      })
      .toBe("FAILED")
    const job = await status(page, documentId, versionId)
    expect(job.attempts).toBe(1)
    expect(job.failureCode).toBe("STORED_FILE_MISSING")
    await page.goto(`/documents/${documentId}`)
    await expect(
      page.getByText("The stored file could not be found.")
    ).toBeVisible()
  } finally {
    compose("start", "worker")
  }
})

test("transient storage denial retries the same durable job after access returns", async ({
  page,
}) => {
  test.setTimeout(180000)
  await register(page, `transient-${randomUUID()}@example.invalid`, password())
  compose("stop", "worker")
  let versionId: string | undefined
  try {
    const uploaded = await upload(page, Date.now() + 5)
    versionId = uploaded.versionId
    changeStoredFile(versionId, "deny")
    compose("start", "worker")
    await expect
      .poll(
        async () =>
          (await status(page, uploaded.documentId, versionId!)).status,
        {
          timeout: 30000,
          intervals: [200, 500],
        }
      )
      .toBe("RETRYING")
    const pending = await status(page, uploaded.documentId, versionId)
    expect(pending.attempts).toBe(1)
    expect(pending.failureCode).toBe("TEMPORARY_PROCESSING_ERROR")
    changeStoredFile(versionId, "restore")
    await expect
      .poll(
        async () =>
          (await status(page, uploaded.documentId, versionId!)).status,
        {
          timeout: 90000,
        }
      )
      .toBe("COMPLETED")
    const completed = await status(page, uploaded.documentId, versionId)
    expect(completed.id).toBe(pending.id)
    expect(completed.attempts).toBeGreaterThan(1)
    expect(
      sql(
        `SELECT count(*) FROM processing_outbox WHERE processing_job_id='${completed.id}'::uuid`
      )
    ).toBe("2")
  } finally {
    if (versionId) changeStoredFile(versionId, "restore")
    compose("start", "worker")
  }
})

test("persistent retryable storage denial exhausts attempts without a message loop", async ({
  page,
}) => {
  test.setTimeout(180000)
  await register(page, `exhausted-${randomUUID()}@example.invalid`, password())
  compose("stop", "worker")
  let versionId: string | undefined
  try {
    const uploaded = await upload(page, Date.now() + 6)
    versionId = uploaded.versionId
    changeStoredFile(versionId, "deny")
    compose("start", "worker")
    await expect
      .poll(
        async () =>
          (await status(page, uploaded.documentId, versionId!)).status,
        {
          timeout: 120000,
        }
      )
      .toBe("FAILED")
    const job = await status(page, uploaded.documentId, versionId)
    expect(job.attempts).toBe(job.maxAttempts)
    expect(job.failureCode).toBe("TEMPORARY_PROCESSING_ERROR")
    expect(
      sql(
        `SELECT count(*) FROM processing_outbox WHERE processing_job_id='${job.id}'::uuid`
      )
    ).toBe(String(job.maxAttempts))
    await page.goto(`/documents/${uploaded.documentId}`)
    await expect(page.getByText("Integrity verification failed")).toBeVisible()
  } finally {
    if (versionId) changeStoredFile(versionId, "restore")
    compose("start", "worker")
  }
})

test("an expired processing lease creates one durable recovery delivery", async ({
  page,
}) => {
  test.setTimeout(180000)
  await register(page, `stale-${randomUUID()}@example.invalid`, password())
  compose("stop", "worker")
  try {
    const { documentId, versionId } = await upload(page, Date.now() + 7)
    const job = await status(page, documentId, versionId)
    await expect
      .poll(() => outboxStatus(job.id), { timeout: 30000 })
      .toBe("PUBLISHED")
    sql(
      `UPDATE processing_jobs SET status='PROCESSING', attempts=1, lease_token=gen_random_uuid(), lease_expires_at=NOW()-interval '1 minute', heartbeat_at=NOW()-interval '1 minute', started_at=NOW()-interval '2 minutes' WHERE id='${job.id}'::uuid`
    )
    await expect
      .poll(async () => (await status(page, documentId, versionId)).status, {
        timeout: 30000,
      })
      .toBe("RETRYING")
    await expect
      .poll(
        () =>
          sql(
            `SELECT count(*) FROM processing_outbox WHERE processing_job_id='${job.id}'::uuid`
          ),
        {
          timeout: 30000,
        }
      )
      .toBe("2")
    compose("start", "worker")
    await expect
      .poll(async () => (await status(page, documentId, versionId)).status, {
        timeout: 90000,
      })
      .toBe("COMPLETED")
    expect((await status(page, documentId, versionId)).attempts).toBe(2)
  } finally {
    compose("start", "worker")
  }
})

test("pending work survives a complete isolated stack stop and restart", async ({
  page,
}) => {
  test.setTimeout(240000)
  await register(page, `restart-${randomUUID()}@example.invalid`, password())
  compose("stop", "worker")
  try {
    const { documentId, versionId } = await upload(page, Date.now() + 8)
    const job = await status(page, documentId, versionId)
    await expect
      .poll(() => outboxStatus(job.id), { timeout: 30000 })
      .toBe("PUBLISHED")
    expect((await status(page, documentId, versionId)).status).not.toBe(
      "COMPLETED"
    )
    compose("stop")
    compose("up", "-d", "--wait", "--wait-timeout", "180")
    await expect
      .poll(async () => (await status(page, documentId, versionId)).status, {
        timeout: 90000,
      })
      .toBe("COMPLETED")
    expect((await status(page, documentId, versionId)).id).toBe(job.id)
  } finally {
    compose("up", "-d", "--wait", "--wait-timeout", "180")
  }
})

test("a duplicate confirmed broker delivery cannot restart a completed job", async ({
  page,
}) => {
  test.setTimeout(180000)
  await register(page, `duplicate-${randomUUID()}@example.invalid`, password())
  const { documentId, versionId } = await upload(page, Date.now() + 9)
  await expect
    .poll(async () => (await status(page, documentId, versionId)).status, {
      timeout: 90000,
    })
    .toBe("COMPLETED")
  const before = await status(page, documentId, versionId)
  publishDuplicate(before.id)
  await expect
    .poll(
      () => {
        const lines = compose(
          "exec",
          "-T",
          "rabbitmq",
          "rabbitmqctl",
          "list_queues",
          "-q",
          "name",
          "messages_ready",
          "messages_unacknowledged"
        )
        const queue = lines
          .split(/\r?\n/)
          .find((line) => line.startsWith("brainless.processing.execute.v1\t"))
        return queue?.split("\t").slice(1).join(":")
      },
      { timeout: 30000 }
    )
    .toBe("0:0")
  const after = await status(page, documentId, versionId)
  expect(after.id).toBe(before.id)
  expect(after.status).toBe("COMPLETED")
  expect(after.attempts).toBe(before.attempts)
  expect(
    sql(
      `SELECT count(*) FROM processing_outbox WHERE processing_job_id='${before.id}'::uuid`
    )
  ).toBe("1")
})

test("two worker instances preserve one processing attempt for a job", async ({
  page,
}) => {
  test.setTimeout(180000)
  await register(page, `concurrent-${randomUUID()}@example.invalid`, password())
  compose("up", "-d", "--no-deps", "--scale", "worker=2", "--wait", "worker")
  try {
    const { documentId, versionId } = await upload(page, Date.now() + 10)
    await expect
      .poll(async () => (await status(page, documentId, versionId)).status, {
        timeout: 90000,
      })
      .toBe("COMPLETED")
    const job = await status(page, documentId, versionId)
    expect(job.attempts).toBe(1)
    expect(
      sql(
        `SELECT count(*) FROM processing_outbox WHERE processing_job_id='${job.id}'::uuid`
      )
    ).toBe("1")
  } finally {
    compose("up", "-d", "--no-deps", "--scale", "worker=1", "--wait", "worker")
  }
})

test("a generated near-limit PNG completes streamed integrity verification", async ({
  page,
}) => {
  test.setTimeout(180000)
  await register(page, `large-${randomUUID()}@example.invalid`, password())
  const { documentId, versionId } = await upload(
    page,
    Date.now() + 11,
    768,
    768
  )
  await expect
    .poll(async () => (await status(page, documentId, versionId)).status, {
      timeout: 90000,
    })
    .toBe("COMPLETED")
  const job = await status(page, documentId, versionId)
  expect(job.attempts).toBe(1)
  expect(outboxStatus(job.id)).toBe("PUBLISHED")
})
