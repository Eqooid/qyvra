/**
 * @author Cristono Wijaya
 * @description Defines the immutable configuration contract shared by API providers after runtime validation.
 * @tags Configuration
 * @interface ApiConfiguration
 */
export interface ApiConfiguration {
  readonly rag: {
    readonly enabled: boolean;
    readonly maxSources: number;
    readonly perDocument: number;
    readonly contextTokens: number;
    readonly timeoutMs: number;
    readonly concurrency: number;
    readonly perUserPerMinute: number;
    readonly globalPerMinute: number;
  };
  readonly generation: {
    readonly tokenizer: 'cl100k_base' | 'o200k_base';
    readonly provider: 'openai-compatible';
    readonly model?: string;
    readonly endpoint?: string;
    readonly apiKey?: string;
    readonly timeoutMs: number;
    readonly maxOutputTokens: number;
    readonly temperature: number;
    readonly outputTokenField: 'max_completion_tokens' | 'max_tokens';
  };
  readonly semanticSearch: {
    readonly enabled: boolean;
    readonly minScore?: number;
    readonly maxManifests: number;
    readonly timeoutMs: number;
    readonly concurrency: number;
    readonly perUserPerMinute: number;
    readonly globalPerMinute: number;
  };
  readonly aiIngestion: {
    readonly enabled: boolean;
    readonly profileFingerprint?: string;
  };
  readonly vectorIndex: {
    readonly enabled: boolean;
    readonly url?: string;
    readonly apiKey?: string;
    readonly timeoutMs: number;
    readonly batchSize: number;
  };
  readonly embedding: {
    readonly enabled: boolean;
    readonly endpoint?: string;
    readonly apiKey?: string;
    readonly profileFingerprint?: string;
    readonly batchSize: number;
    readonly maxInputTokens: number;
    readonly maxBatchTokens: number;
    readonly timeoutMs: number;
    readonly sendDimensions: boolean;
  };
  readonly chunking: {
    readonly chunkSize: number;
    readonly chunkOverlap: number;
    readonly maxChunks: number;
    readonly maxOutputBytes: number;
    readonly timeoutMs: number;
  };
  readonly extraction: {
    readonly maxBytes: number;
    readonly maxPages: number;
    readonly maxCharacters: number;
    readonly maxTextBytes: number;
    readonly timeoutMs: number;
    readonly heapMb: number;
  };
  /** Optional, disposable processing progress; PostgreSQL remains authoritative. */
  readonly progress: {
    readonly url?: string;
    readonly ttlSeconds: number;
    readonly connectTimeoutMs: number;
    readonly commandTimeoutMs: number;
  };
  /** Optional until the outbox dispatcher is wired into the HTTP process. */
  readonly messaging: {
    readonly url?: string;
    readonly connectTimeoutMs: number;
    readonly confirmTimeoutMs: number;
  };
  readonly outbox: {
    readonly pollIntervalMs: number;
    readonly batchSize: number;
    readonly leaseMs: number;
  };
  readonly processingRecovery: {
    readonly pollIntervalMs: number;
    readonly batchSize: number;
  };
  readonly worker: {
    readonly prefetch: number;
    readonly jobLeaseMs: number;
    readonly reconnectDelayMs: number;
    readonly shutdownTimeoutMs: number;
  };
  readonly upload: {
    readonly maxBytes: number;
    readonly maxPages: number;
    readonly maxPixels: number;
    readonly timeoutMs: number;
    readonly inspectionTimeoutMs: number;
    readonly concurrency: number;
    readonly qpdfPath: string;
  };
  /** @description Provider-neutral selection plus private adapter configuration. */
  readonly storage: { readonly provider: 'local'; readonly localRoot: string };
  /**
   * @author Cristono Wijaya
   * @description Identifies the application and distinguishes development, test, and production behavior.
   * @tags Configuration
   * @type {{ readonly environment: 'development' | 'test' | 'production'; readonly name: string; }}
   * @readonly - Cannot be reassigned through this contract.
   */
  readonly application: {
    /**
     * @author Cristono Wijaya
     * @description The validated runtime mode: development, test, or production.
     * @tags Configuration
     * @type {'development' | 'test' | 'production'}
     * @readonly - Cannot be reassigned through this contract.
     */
    readonly environment: 'development' | 'test' | 'production';
    /**
     * @author Cristono Wijaya
     * @description The configured name for this application or cookie.
     * @tags Configuration
     * @type {string}
     * @readonly - Cannot be reassigned through this contract.
     */
    readonly name: string;
  };
  /**
   * @author Cristono Wijaya
   * @description Defines listener settings and the maximum accepted JSON body size in bytes.
   * @tags Configuration
   * @type {{ readonly host: string; readonly port: number; readonly bodyLimitBytes: number; }}
   * @readonly - Cannot be reassigned through this contract.
   */
  readonly http: {
    /**
     * @author Cristono Wijaya
     * @description The IPv4 or IPv6 address on which the HTTP server listens.
     * @tags Configuration
     * @type {string}
     * @readonly - Cannot be reassigned through this contract.
     */
    readonly host: string;
    /**
     * @author Cristono Wijaya
     * @description The TCP port on which the API accepts requests.
     * @tags Configuration
     * @type {number}
     * @readonly - Cannot be reassigned through this contract.
     */
    readonly port: number;
    /**
     * @author Cristono Wijaya
     * @description The maximum permitted JSON request-body size in bytes.
     * @tags Configuration
     * @type {number}
     * @readonly - Cannot be reassigned through this contract.
     */
    readonly bodyLimitBytes: number;
  };
  /**
   * @author Cristono Wijaya
   * @description Defines the private PostgreSQL URL, bounded timeouts in milliseconds, and pool capacity.
   * @tags Configuration
   * @type {{ readonly url: string; readonly connectTimeoutMs: number; readonly queryTimeoutMs: number; readonly poolSize: number; }}
   * @readonly - Cannot be reassigned through this contract.
   */
  readonly database: {
    /**
     * @author Cristono Wijaya
     * @description The private PostgreSQL connection URL. Never log or expose its credentials.
     * @tags Configuration
     * @type {string}
     * @readonly - Cannot be reassigned through this contract.
     */
    readonly url: string;
    /**
     * @author Cristono Wijaya
     * @description The maximum connection-acquisition wait in milliseconds.
     * @tags Configuration
     * @type {number}
     * @readonly - Cannot be reassigned through this contract.
     */
    readonly connectTimeoutMs: number;
    /**
     * @author Cristono Wijaya
     * @description The query execution timeout in milliseconds.
     * @tags Configuration
     * @type {number}
     * @readonly - Cannot be reassigned through this contract.
     */
    readonly queryTimeoutMs: number;
    /**
     * @author Cristono Wijaya
     * @description The maximum number of PostgreSQL connections in the API pool.
     * @tags Configuration
     * @type {number}
     * @readonly - Cannot be reassigned through this contract.
     */
    readonly poolSize: number;
  };
  /**
   * @author Cristono Wijaya
   * @description Defines exact allowed origins and whether browsers may share credentials.
   * @tags Configuration
   * @type {{ readonly origins: readonly string[]; readonly credentials: boolean; }}
   * @readonly - Cannot be reassigned through this contract.
   */
  readonly cors: {
    /**
     * @author Cristono Wijaya
     * @description The exact browser origins allowed by the validated CORS policy.
     * @tags Configuration
     * @type {readonly string[]}
     * @readonly - Cannot be reassigned through this contract.
     */
    readonly origins: readonly string[];
    /**
     * @author Cristono Wijaya
     * @description Whether CORS responses allow browser credential sharing.
     * @tags Configuration
     * @type {boolean}
     * @readonly - Cannot be reassigned through this contract.
     */
    readonly credentials: boolean;
  };
  /**
   * @author Cristono Wijaya
   * @description Defines password code-point limits, session lifetimes, lockout windows, and request budgets. Time values use seconds.
   * @tags Configuration
   * @type {{ readonly rateWindowSeconds: number; readonly registerRateLimit: number; readonly loginRateLimit: number; readonly refreshRateLimit: number; readonly globalRateLimit: number; readonly passwordMinLength: number; readonly passwordMaxLength: number; readonly sessionTtlSeconds: number; readonly refreshTtlSeconds: number; readonly loginLockoutSeconds: number; readonly loginMaxAttempts: number; readonly loginWindowSeconds: number; }}
   * @readonly - Cannot be reassigned through this contract.
   */
  readonly authentication: {
    /**
     * @author Cristono Wijaya
     * @description The authentication request-budget window in seconds.
     * @tags Configuration
     * @type {number}
     * @readonly - Cannot be reassigned through this contract.
     */
    readonly rateWindowSeconds: number;
    /**
     * @author Cristono Wijaya
     * @description The maximum registration attempts per peer within a rate window.
     * @tags Configuration
     * @type {number}
     * @readonly - Cannot be reassigned through this contract.
     */
    readonly registerRateLimit: number;
    /**
     * @author Cristono Wijaya
     * @description The maximum login attempts per peer within a rate window.
     * @tags Configuration
     * @type {number}
     * @readonly - Cannot be reassigned through this contract.
     */
    readonly loginRateLimit: number;
    /**
     * @author Cristono Wijaya
     * @description The maximum refresh attempts per peer within a rate window.
     * @tags Configuration
     * @type {number}
     * @readonly - Cannot be reassigned through this contract.
     */
    readonly refreshRateLimit: number;
    /**
     * @author Cristono Wijaya
     * @description The combined authentication request budget across all peers within a rate window.
     * @tags Configuration
     * @type {number}
     * @readonly - Cannot be reassigned through this contract.
     */
    readonly globalRateLimit: number;
    /**
     * @author Cristono Wijaya
     * @description The minimum registration password length in Unicode code points.
     * @tags Configuration
     * @type {number}
     * @readonly - Cannot be reassigned through this contract.
     */
    readonly passwordMinLength: number;
    /**
     * @author Cristono Wijaya
     * @description The maximum registration password length in Unicode code points.
     * @tags Configuration
     * @type {number}
     * @readonly - Cannot be reassigned through this contract.
     */
    readonly passwordMaxLength: number;
    /**
     * @author Cristono Wijaya
     * @description The lifetime of a newly issued access session in seconds.
     * @tags Configuration
     * @type {number}
     * @readonly - Cannot be reassigned through this contract.
     */
    readonly sessionTtlSeconds: number;
    /**
     * @author Cristono Wijaya
     * @description The absolute renewal lifetime established at login, in seconds.
     * @tags Configuration
     * @type {number}
     * @readonly - Cannot be reassigned through this contract.
     */
    readonly refreshTtlSeconds: number;
    /**
     * @author Cristono Wijaya
     * @description The temporary account lockout duration in seconds.
     * @tags Configuration
     * @type {number}
     * @readonly - Cannot be reassigned through this contract.
     */
    readonly loginLockoutSeconds: number;
    /**
     * @author Cristono Wijaya
     * @description The failed-login count that triggers a temporary lockout.
     * @tags Configuration
     * @type {number}
     * @readonly - Cannot be reassigned through this contract.
     */
    readonly loginMaxAttempts: number;
    /**
     * @author Cristono Wijaya
     * @description The idle interval in seconds after which failed-login tracking starts over.
     * @tags Configuration
     * @type {number}
     * @readonly - Cannot be reassigned through this contract.
     */
    readonly loginWindowSeconds: number;
  };
  /**
   * @author Cristono Wijaya
   * @description Defines HttpOnly cookie attributes. maxAgeMs uses milliseconds; domain is absent for host-only cookies.
   * @tags Configuration
   * @type {{ readonly name: string; readonly refreshName: string; readonly domain: string | undefined; readonly refreshPath: string; readonly httpOnly: true; readonly secure: boolean; readonly sameSite: 'lax' | 'strict' | 'none'; readonly path: string; readonly maxAgeMs: number; }}
   * @readonly - Cannot be reassigned through this contract.
   */
  readonly cookie: {
    /**
     * @author Cristono Wijaya
     * @description The configured name for this application or cookie.
     * @tags Configuration
     * @type {string}
     * @readonly - Cannot be reassigned through this contract.
     */
    readonly name: string;
    /**
     * @author Cristono Wijaya
     * @description The configured refresh-cookie name, distinct from the session-cookie name.
     * @tags Configuration
     * @type {string}
     * @readonly - Cannot be reassigned through this contract.
     */
    readonly refreshName: string;
    /**
     * @author Cristono Wijaya
     * @description The optional cookie domain; undefined keeps the cookie host-only.
     * @tags Configuration
     * @type {string | undefined}
     * @readonly - Cannot be reassigned through this contract.
     */
    readonly domain: string | undefined;
    /**
     * @author Cristono Wijaya
     * @description The path to which the browser sends the refresh cookie.
     * @tags Configuration
     * @type {string}
     * @readonly - Cannot be reassigned through this contract.
     */
    readonly refreshPath: string;
    /**
     * @author Cristono Wijaya
     * @description The fixed HttpOnly flag preventing JavaScript from reading authentication cookies.
     * @tags Configuration
     * @type {true}
     * @readonly - Cannot be reassigned through this contract.
     */
    readonly httpOnly: true;
    /**
     * @author Cristono Wijaya
     * @description Whether authentication cookies require HTTPS transport.
     * @tags Configuration
     * @type {boolean}
     * @readonly - Cannot be reassigned through this contract.
     */
    readonly secure: boolean;
    /**
     * @author Cristono Wijaya
     * @description The validated browser policy for sending cookies across sites.
     * @tags Configuration
     * @type {'lax' | 'strict' | 'none'}
     * @readonly - Cannot be reassigned through this contract.
     */
    readonly sameSite: 'lax' | 'strict' | 'none';
    /**
     * @author Cristono Wijaya
     * @description The path to which the browser sends the session cookie.
     * @tags Configuration
     * @type {string}
     * @readonly - Cannot be reassigned through this contract.
     */
    readonly path: string;
    /**
     * @author Cristono Wijaya
     * @description The configured session lifetime expressed in milliseconds.
     * @tags Configuration
     * @type {number}
     * @readonly - Cannot be reassigned through this contract.
     */
    readonly maxAgeMs: number;
  };
}
