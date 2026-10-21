// Prototype: zero-dependency QR image (PNG data URL) for the ClawBot QR page URL.
// Vendor encoder: qrcode-generator 1.4.4 (MIT, Kazuhiko Arase) — see vendor/qrcode-generator-1.4.4.js
import { deflateSync } from 'node:zlib'

const crcTable = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  return table
})()
const crc32 = buffer => {
  let c = -1
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
const chunk = (type, data) => {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const name = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])))
  return Buffer.concat([length, name, data, crc])
}
// One PNG scanline per row: filter byte 0 plus gray pixels (0 dark, 255 light).
export const pngOfMatrix = (qr, { scale = 4, margin = 2 } = {}) => {
  const n = qr.getModuleCount()
  const size = (n + margin * 2) * scale
  const raw = Buffer.alloc(size * (size + 1))
  for (let y = 0; y < size; y += 1) {
    const row = y * (size + 1)
    for (let x = 0; x < size; x += 1) {
      const mx = Math.floor(x / scale) - margin
      const my = Math.floor(y / scale) - margin
      raw[row + 1 + x] = mx >= 0 && my >= 0 && mx < n && my < n && qr.isDark(my, mx) ? 0 : 255
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // color type: grayscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
export const qrPngDataUrl = (text, encoder) => {
  const qr = encoder(0, 'M') // 0 = pick the smallest version, M = 15% recovery
  qr.addData(text)
  qr.make()
  return `data:image/png;base64,${pngOfMatrix(qr).toString('base64')}`
}
