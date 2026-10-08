// Trusted child entry point. Only bytes from stdin enter PDF.js; no URL/rendering APIs.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import dgram from 'node:dgram';
import { syncBuiltinESMExports } from 'node:module';
import { canonicalContent, normalizePage } from './canonical-text.mjs';

// Defense in depth on development hosts; Linux also denies sockets in seccomp.
const noNetwork = () => {
  throw new Error('Network disabled');
};
http.request = http.get = https.request = https.get = noNetwork;
net.connect =
  net.createConnection =
  tls.connect =
  dgram.createSocket =
    noNetwork;
dns.lookup = dns.resolve = noNetwork;
globalThis.fetch = noNetwork;
globalThis.WebSocket = noNetwork;
syncBuiltinESMExports();
console.log = console.warn = console.error = () => {}; // Discard untrusted parser diagnostics.
const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');

const [maxBytes, maxPages, maxCharacters, maxTextBytes] = process.argv
  .slice(2)
  .map(Number);
const limit = () => {
  throw Object.assign(new Error(), { name: 'ExtractionLimit' });
};
let task;
try {
  if (
    ![maxBytes, maxPages, maxCharacters, maxTextBytes].every(
      (n) => Number.isSafeInteger(n) && n > 0,
    )
  )
    limit();
  const buffers = [];
  let size = 0;
  for await (const buffer of process.stdin) {
    size += buffer.length;
    if (size > maxBytes) limit();
    buffers.push(buffer);
  }
  const bytes = new Uint8Array(Buffer.concat(buffers));
  task = getDocument({
    data: bytes,
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    useWorkerFetch: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    useWasm: false,
    stopAtErrors: true,
    verbosity: 0,
  });
  const document = await task.promise;
  // Even encryption permitting an empty password is outside the supported contract.
  if ((await document.getMetadata()).info.EncryptFilterName)
    throw Object.assign(new Error(), { name: 'PasswordException' });
  if (document.numPages > maxPages) limit();
  const pages = [];
  let rawCharacters = 0,
    rawBytes = 0;
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
    const page = await document.getPage(pageNumber);
    const reader = page
      .streamTextContent({ disableNormalization: true })
      .getReader();
    const pieces = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const item of value.items) {
        if (typeof item.str !== 'string') continue;
        const piece = item.str + (item.hasEOL ? '\n' : ' ');
        for (const ignored of piece) {
          void ignored;
          rawCharacters++;
        }
        rawBytes += Buffer.byteLength(piece);
        // Bound intermediates as well as the canonical result.
        if (rawCharacters > maxCharacters || rawBytes > maxTextBytes) limit();
        pieces.push(piece);
      }
    }
    pages.push(normalizePage(pieces.join('')));
    page.cleanup();
  }
  const content = canonicalContent(pages);
  if (
    content.characterCount > maxCharacters ||
    Buffer.byteLength(content.text) > maxTextBytes
  )
    limit();
  if (!content.text.trim())
    throw Object.assign(new Error(), { name: 'NoText' });
  await task.destroy();
  task = undefined;
  process.stdout.write(JSON.stringify({ kind: 'success', content }));
} catch (error) {
  const failureCode =
    error?.name === 'PasswordException'
      ? 'PDF_ENCRYPTED'
      : error?.name === 'ExtractionLimit'
        ? 'EXTRACTION_LIMIT_EXCEEDED'
        : error?.name === 'NoText'
          ? 'OCR_REQUIRED'
          : 'PDF_MALFORMED';
  try {
    await task?.destroy();
  } catch {
    /* Parent enforces an independent deadline. */
  }
  process.stdout.write(JSON.stringify({ kind: 'terminal', failureCode }));
}
