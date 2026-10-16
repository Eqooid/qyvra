import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { createClient } from 'redis';
import type { ApiConfiguration } from '../../configuration/settings';
import { ConfigurationService } from '../../configuration/configuration.module';
import type {
  SearchWindowEntry,
  SearchMode,
} from '../../modules/search/search-ranking';

export interface SearchWindow {
  version: 'document-rrf60-v1';
  owner: string;
  session: string;
  digest: string;
  mode: SearchMode;
  generationId: string;
  profileId?: string;
  profileFingerprint?: string;
  expires: number;
  nonce: string;
  limit: number;
  truncated: boolean;
  entries: SearchWindowEntry[];
}
export const WINDOW_TTL_SECONDS = 300;
export const WINDOW_MAX_BYTES = 262144;
export const WINDOW_OWNER_LIMIT = 8;
export const WINDOW_GLOBAL_LIMIT = 256;
const root = 'qyvra:{search-windows}:v1:';

const uuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const digest = (v: unknown) =>
  typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
export function validSearchWindow(w: SearchWindow): boolean {
  if (
    !w ||
    w.version !== 'document-rrf60-v1' ||
    !uuid(w.owner) ||
    !digest(w.session) ||
    !digest(w.digest) ||
    !uuid(w.generationId) ||
    !['keyword', 'hybrid'].includes(w.mode) ||
    !Number.isSafeInteger(w.limit) ||
    w.limit < 1 ||
    w.limit > 20 ||
    !Number.isSafeInteger(w.expires) ||
    typeof w.nonce !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(w.nonce) ||
    !Array.isArray(w.entries) ||
    w.entries.length > 200 ||
    typeof w.truncated !== 'boolean' ||
    (w.mode === 'hybrid' &&
      (!uuid(w.profileId) || !digest(w.profileFingerprint)))
  )
    return false;
  const seen = new Set<string>();
  return w.entries.every((e, i) => {
    if (
      !e ||
      !uuid(e.documentId) ||
      !uuid(e.documentVersionId) ||
      seen.has(e.documentId) ||
      e.rank !== i + 1 ||
      !Array.isArray(e.lexical) ||
      !Array.isArray(e.semantic) ||
      e.lexical.length > 3 ||
      e.semantic.length > 3
    )
      return false;
    seen.add(e.documentId);
    return (
      e.lexical.every(
        (h) =>
          h &&
          typeof h.id === 'string' &&
          h.id.length <= 128 &&
          h.record &&
          uuid(h.record.projectionId) &&
          h.record.documentId === e.documentId &&
          h.record.documentVersionId === e.documentVersionId &&
          Number.isSafeInteger(h.record.revision) &&
          h.record.revision > 0 &&
          digest(h.record.sourceHash) &&
          (h.record.kind === 'metadata' ||
            (h.record.kind === 'page' &&
              [
                h.record.pageNumber,
                h.record.segment,
                h.record.startOffset,
                h.record.endOffset,
              ].every((n) => Number.isSafeInteger(n) && n! >= 0))),
      ) &&
      e.semantic.every(
        (h) =>
          h &&
          h.documentId === e.documentId &&
          h.documentVersionId === e.documentVersionId &&
          uuid(h.chunkId) &&
          uuid(h.chunkSetId) &&
          uuid(h.indexManifestId),
      )
    );
  });
}
function newWindowClient(p: ApiConfiguration['progress']) {
  return createClient({
    url: p.url,
    disableOfflineQueue: true,
    socket: { connectTimeout: p.connectTimeoutMs, reconnectStrategy: false },
    commandOptions: { timeout: p.commandTimeoutMs },
  });
}
/** One bounded hash keeps payloads and quota membership in the same evictable object. */
export const saveWindowScript = `
local t=redis.call('TIME')
local now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)
local count=0
local ownerCount=0
for _,field in ipairs(redis.call('HKEYS',KEYS[1])) do
  local expiry,owner,id=string.match(field,'^(%d+):([^:]+):([^:]+)$')
  if not expiry or tonumber(expiry)<=now then redis.call('HDEL',KEYS[1],field)
  else
    count=count+1
    if owner==ARGV[1] then ownerCount=ownerCount+1 end
    if id==ARGV[2] then return 0 end
  end
end
if count>=256 or ownerCount>=8 then return 0 end
redis.call('HSET',KEYS[1],string.format('%.0f',now+300000)..':'..ARGV[1]..':'..ARGV[2],ARGV[3])
redis.call('EXPIRE',KEYS[1],305)
return 1`;
export const readWindowScript = `
local t=redis.call('TIME')
local now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)
for _,field in ipairs(redis.call('HKEYS',KEYS[1])) do
  local expiry,owner,id=string.match(field,'^(%d+):([^:]+):([^:]+)$')
  if not expiry or tonumber(expiry)<=now then redis.call('HDEL',KEYS[1],field)
  elseif id==ARGV[1] then return redis.call('HGET',KEYS[1],field) end
end
return false`;
export const SEARCH_WINDOWS_KEY = root + 'windows';

/** Private disposable navigation state. Connection failure is explicit to the caller. */
@Injectable()
export class SearchWindowStore implements OnApplicationShutdown {
  private client?: ReturnType<typeof newWindowClient>;
  private connecting?: Promise<ReturnType<typeof newWindowClient>>;
  private retryAt = 0;
  constructor(private readonly config: ConfigurationService) {}
  private async ready() {
    if (this.client?.isReady) return this.client;
    if (this.connecting) return this.connecting;
    const p = this.config.progress;
    if (!p.url || Date.now() < this.retryAt)
      throw new Error('SEARCH_WINDOW_UNAVAILABLE');
    const client = newWindowClient(p);
    client.on('error', () => {
      this.retryAt = Date.now() + 5000;
    });
    if (this.client?.isOpen) this.client.destroy();
    this.client = client;
    this.connecting = client
      .connect()
      .then(() => client as ReturnType<typeof newWindowClient>)
      .catch(() => {
        this.retryAt = Date.now() + 5000;
        if (client.isOpen) client.destroy();
        throw new Error('SEARCH_WINDOW_UNAVAILABLE');
      })
      .finally(() => {
        this.connecting = undefined;
      });
    return this.connecting;
  }
  async save(id: string, window: SearchWindow): Promise<boolean> {
    const value = JSON.stringify(window);
    if (
      !/^[A-Za-z0-9_-]{22}$/.test(id) ||
      !validSearchWindow(window) ||
      Buffer.byteLength(value) > WINDOW_MAX_BYTES
    )
      return false;
    const client = await this.ready();
    return (
      (await client.eval(saveWindowScript, {
        keys: [SEARCH_WINDOWS_KEY],
        arguments: [window.owner, id, value],
      })) === 1
    );
  }
  async read(id: string): Promise<SearchWindow | null> {
    if (!/^[A-Za-z0-9_-]{22}$/.test(id)) return null;
    const value = await (
      await this.ready()
    ).eval(readWindowScript, { keys: [SEARCH_WINDOWS_KEY], arguments: [id] });
    if (!value) return null;
    if (
      typeof value !== 'string' ||
      Buffer.byteLength(value) > WINDOW_MAX_BYTES
    )
      throw new Error('SEARCH_WINDOW_INVALID');
    const window = JSON.parse(value) as SearchWindow;
    if (!validSearchWindow(window)) throw new Error('SEARCH_WINDOW_INVALID');
    if (window.expires < Date.now()) return null;
    return window;
  }
  async onApplicationShutdown() {
    if (this.client?.isOpen) this.client.destroy();
  }
}
