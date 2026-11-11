// Generates figure.png deterministically: a 320x180 RGB gradient with a diagonal band.
// Run: node make-figure.mjs
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'

const W = 320
const H = 180
const raw = Buffer.alloc((W * 3 + 1) * H)
for (let y = 0; y < H; y++) {
  const rowStart = y * (W * 3 + 1)
  raw[rowStart] = 0 // filter type: none
  for (let x = 0; x < W; x++) {
    const i = rowStart + 1 + x * 3
    const band = Math.abs(x - y * 1.6) < 24 ? 60 : 0
    raw[i] = 40 + Math.floor((x / W) * 120) + band
    raw[i + 1] = 70 + Math.floor((y / H) * 100) + band
    raw[i + 2] = 120 + Math.floor(((x + y) / (W + H)) * 80) + band
  }
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crcTable = chunk.table ?? (chunk.table = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  }))
  let crc = 0xffffffff
  for (const byte of body) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
  return Buffer.concat([len, body, crcBuf])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(W, 0)
ihdr.writeUInt32BE(H, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 2 // colour type: truecolour
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])
writeFileSync(new URL('./figure.png', import.meta.url), png)
console.log(`figure.png written (${png.length} bytes, ${W}x${H})`)
