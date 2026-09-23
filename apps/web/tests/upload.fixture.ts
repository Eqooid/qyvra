import { vi } from "vitest"
import { id } from "./documents.fixture"
export const values = {
  title: "Policy",
  documentType: "OTHER",
  issuer: "",
  referenceNumber: "",
  documentDate: "",
  expirationDate: "",
  categoryId: "",
  tagIds: [] as string[],
}
export const receipt = {
  id,
  status: "UPLOADED",
  version: { id, versionNumber: 1, extractionStatus: "PENDING" },
  storageKey: "private-path",
}
/** Mock only the browser transport boundary; production parsing and form logic run. */
export class TestXHR {
  static requests: TestXHR[] = []
  status = 0
  responseText = ""
  withCredentials = false
  timeout = 0
  method = ""
  url = ""
  headers: Record<string, string> = {}
  body?: FormData
  upload: {
    onprogress?: (event: {
      loaded: number
      total: number
      lengthComputable: boolean
    }) => void
  } = {}
  onload?: () => void
  onabort?: () => void
  onerror?: () => void
  ontimeout?: () => void
  constructor() {
    TestXHR.requests.push(this)
  }
  open(method: string, url: string) {
    this.method = method
    this.url = url
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value
  }
  send(body: FormData) {
    this.body = body
  }
  abort = vi.fn(() => this.onabort?.())
  respond(status = 201, payload: unknown = { data: receipt }) {
    this.status = status
    this.responseText = JSON.stringify(payload)
    this.onload?.()
  }
  progress(loaded: number, total = 100) {
    this.upload.onprogress?.({ loaded, total, lengthComputable: total > 0 })
  }
}
