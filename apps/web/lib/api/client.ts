import { z } from "zod"

export const profileSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  displayName: z.string().nullable(),
  locale: z.string(),
  timezone: z.string(),
})
export type Profile = z.infer<typeof profileSchema>
export type RequestOptions = {
  signal?: AbortSignal
  timeoutMs?: number
  headers?: Record<string, string>
}
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly traceId?: string
  ) {
    super(
      status === 0
        ? "Unable to reach the API. Check your connection and try again."
        : status === 401
          ? "Your session has expired. Please log in again."
          : status === 429
            ? "Too many attempts. Please wait before trying again."
            : status === 403
              ? "This request was blocked. Check the application's allowed origin settings."
              : "The request could not be completed. Please try again."
    )
  }
}
export class UploadCancelled extends Error {
  constructor() {
    super(
      "Upload cancelled. Check the document list: the server may already have completed it."
    )
  }
}
export type UploadOptions = {
  signal: AbortSignal
  onProgress: (percentage: number | null) => void
}
export function apiBaseUrl(
  value = process.env.NEXT_PUBLIC_API_BASE_URL
): string {
  const base = value || "/api/v1"
  if (base === "/api/v1") return base
  let url: URL
  try {
    url = new URL(base)
  } catch {
    throw new Error(
      "NEXT_PUBLIC_API_BASE_URL must be /api/v1 or an HTTP(S) URL ending in /api/v1."
    )
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname.replace(/\/$/, "") !== "/api/v1"
  )
    throw new Error(
      "Invalid NEXT_PUBLIC_API_BASE_URL. Use a public API address without credentials."
    )
  return base.replace(/\/$/, "")
}
export class AuthApi {
  private inFlight: Promise<Profile | null> | undefined
  private refreshUncertain = false
  constructor(
    private readonly base = apiBaseUrl(),
    private readonly fetcher: typeof fetch = fetch
  ) {}
  private async request<T>(
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
    csrf = false,
    envelope = false,
    method?: "PATCH" | "DELETE" | "POST",
    options: RequestOptions = {}
  ): Promise<T> {
    let response: Response
    try {
      // Native browser fetch must not receive the AuthApi instance as `this`.
      const fetcher = this.fetcher
      response = await fetcher(`${this.base}${path}`, {
        method: method ?? (body !== undefined || csrf ? "POST" : "GET"),
        credentials: "include",
        cache: "no-store",
        signal: options.signal
          ? AbortSignal.any([
              options.signal,
              AbortSignal.timeout(options.timeoutMs ?? 10000),
            ])
          : AbortSignal.timeout(options.timeoutMs ?? 10000),
        headers: {
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(csrf ? { "X-CSRF-Protection": "1" } : {}),
          ...options.headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
    } catch {
      throw new ApiError(0)
    }
    const payload: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      const error = z
        .object({ error: z.object({ traceId: z.string().uuid() }) })
        .safeParse(payload)
      throw new ApiError(
        response.status,
        error.success ? error.data.error.traceId : undefined
      )
    }
    if (envelope) {
      const parsed = schema.safeParse(payload)
      if (!parsed.success) throw new ApiError(502)
      return parsed.data
    }
    const parsed = z.object({ data: schema }).safeParse(payload)
    if (!parsed.success) throw new ApiError(502)
    return parsed.data.data
  }
  private async lock<T>(operation: () => Promise<T>): Promise<T> {
    return typeof navigator !== "undefined" && navigator.locks
      ? await navigator.locks.request(
          `document-tracker-auth:${this.base}`,
          operation
        )
      : await operation()
  }
  /** Authenticated reads share the existing transport and serialized refresh. */
  async get<T>(
    path: string,
    schema: z.ZodType<T>,
    options: RequestOptions = {}
  ): Promise<T> {
    try {
      return await this.request(
        path,
        schema,
        undefined,
        false,
        true,
        undefined,
        options
      )
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error
      if (!(await this.currentUser())) throw new ApiError(401)
      return this.request(
        path,
        schema,
        undefined,
        false,
        true,
        undefined,
        options
      )
    }
  }
  /** JSON mutations preserve the existing cookie, CSRF and refresh policy. */
  async mutate<T>(
    path: string,
    method: "PATCH" | "DELETE" | "POST",
    schema: z.ZodType<T>,
    body?: unknown,
    options: RequestOptions = {}
  ): Promise<T> {
    const send = () =>
      this.request(path, schema, body, true, false, method, options)
    try {
      return await send()
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error
      if (!(await this.currentUser())) throw new ApiError(401)
      return send()
    }
  }
  /** Read only response headers, cancel the probe, then let browser navigation stream to disk. */
  async prepareDownload(path: string): Promise<string> {
    const url = `${this.base}${path}`
    const check = async () => {
      let response: Response
      try {
        const fetcher = this.fetcher
        response = await fetcher(url, {
          credentials: "include",
          cache: "no-store",
          signal: AbortSignal.timeout(10000),
        })
        await response.body?.cancel()
      } catch {
        throw new ApiError(0)
      }
      if (!response.ok) throw new ApiError(response.status)
      if (
        !["application/pdf", "image/jpeg", "image/png"].includes(
          response.headers.get("Content-Type")?.split(";")[0] ?? ""
        )
      )
        throw new ApiError(502)
    }
    try {
      await check()
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error
      if (!(await this.currentUser())) throw new ApiError(401)
      await check()
    }
    return url
  }
  /** XHR is limited to multipart progress; cookies and refresh use the same client. */
  async upload<T>(
    body: FormData,
    key: string,
    schema: z.ZodType<T>,
    options: UploadOptions,
    path = "/documents"
  ): Promise<T> {
    const send = () =>
      new Promise<T>((resolve, reject) => {
        if (options.signal.aborted) {
          reject(new UploadCancelled())
          return
        }
        const xhr = new XMLHttpRequest()
        const abort = () => xhr.abort()
        const finish = (error?: Error, value?: T) => {
          options.signal.removeEventListener("abort", abort)
          if (error) reject(error)
          else resolve(value as T)
        }
        xhr.open("POST", `${this.base}${path}`)
        xhr.withCredentials = true
        xhr.timeout = 240000
        xhr.setRequestHeader("X-CSRF-Protection", "1")
        xhr.setRequestHeader("Idempotency-Key", key)
        xhr.upload.onprogress = (event) =>
          options.onProgress(
            event.lengthComputable && event.total > 0
              ? Math.min(100, Math.round((event.loaded / event.total) * 100))
              : null
          )
        xhr.onerror = () => finish(new ApiError(0))
        xhr.ontimeout = () => finish(new ApiError(408))
        xhr.onabort = () => finish(new UploadCancelled())
        xhr.onload = () => {
          let payload: unknown
          try {
            payload = JSON.parse(xhr.responseText)
          } catch {
            finish(new ApiError(xhr.status >= 400 ? xhr.status : 502))
            return
          }
          if (xhr.status < 200 || xhr.status >= 300) {
            const error = z
              .object({
                error: z.object({ traceId: z.string().uuid().optional() }),
              })
              .safeParse(payload)
            finish(
              new ApiError(
                xhr.status,
                error.success ? error.data.error.traceId : undefined
              )
            )
            return
          }
          const parsed = z.object({ data: schema }).safeParse(payload)
          if (!parsed.success) finish(new ApiError(502))
          else finish(undefined, parsed.data.data)
        }
        options.signal.addEventListener("abort", abort, { once: true })
        try {
          xhr.send(body)
        } catch {
          finish(new ApiError(0))
        }
      })
    try {
      return await send()
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error
      if (!(await this.currentUser())) throw new ApiError(401)
      if (options.signal.aborted) throw new UploadCancelled()
      options.onProgress(null)
      return send()
    }
  }
  register(email: string, password: string) {
    return this.request(
      "/auth/register",
      z.object({ id: z.string().uuid(), email: z.string().email() }),
      { email, password }
    )
  }
  login(email: string, password: string) {
    return this.lock(async () => {
      await this.request(
        "/auth/login",
        z.object({
          user: z.object({ id: z.string().uuid(), email: z.string().email() }),
          expiresAt: z.string(),
        }),
        { email, password }
      )
      this.refreshUncertain = false
    })
  }
  currentUser(): Promise<Profile | null> {
    // Web Locks serialize tabs; recheck access inside the lock before rotation.
    this.inFlight ??= this.lock(async () => {
      try {
        return await this.request("/auth/me", profileSchema)
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 401) throw error
      }
      if (
        this.refreshUncertain ||
        typeof navigator === "undefined" ||
        !navigator.locks
      )
        return null
      try {
        await this.request(
          "/auth/refresh",
          z.object({ expiresAt: z.string() }),
          undefined,
          true
        )
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null
        // Never automatically reuse a token after an ambiguous rotation outcome.
        if (!(error instanceof ApiError) || ![403, 429].includes(error.status))
          this.refreshUncertain = true
        throw error
      }
      try {
        return await this.request("/auth/me", profileSchema)
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null
        throw error
      }
    }).finally(() => {
      this.inFlight = undefined
    })
    return this.inFlight
  }
  logout() {
    return this.lock(() =>
      this.request(
        "/auth/logout",
        z.object({ loggedOut: z.literal(true) }),
        undefined,
        true
      )
    )
  }
  /** A credential rejection is not a refresh trigger; never retry a password write. */
  async changePassword(currentPassword: string, newPassword: string) {
    if (!(await this.currentUser())) throw new ApiError(401)
    return this.request(
      "/me/password",
      z.object({ passwordChanged: z.literal(true) }),
      { currentPassword, newPassword },
      true,
      false,
      "PATCH"
    )
  }
}
