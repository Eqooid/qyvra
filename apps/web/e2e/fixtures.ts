import { deflateSync } from "node:zlib"
/** Generated, non-sensitive PNG; each seed produces distinct valid content. */
export function png(seed: number, width = 16, height = 16): Buffer {
  function chunk(type: string, data: Buffer) {
    const body = Buffer.concat([Buffer.from(type), data])
    let crc = 0xffffffff
    for (const byte of body) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
    const out = Buffer.alloc(12 + data.length)
    out.writeUInt32BE(data.length)
    body.copy(out, 4)
    out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4)
    return out
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const pixels = Buffer.alloc((width * 3 + 1) * height)
  let state = seed >>> 0
  for (let y = 0; y < height; y++)
    for (let x = 1; x <= width * 3; x++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      pixels[y * (width * 3 + 1) + x] = state >>> 24
    }
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ])
}
