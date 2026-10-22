// Hex view of a message payload, shared by the payload viewer and the message grids.
// The bytes are the payload exactly as stored: when the broker gave us the raw bytes
// (base64, because they are not valid UTF-8) those are used, otherwise the UTF-8
// encoding of the text — which IS the original bytes whenever the text decoded cleanly.

/** The payload's bytes: the base64 copy when the backend sent one, else the UTF-8 text. */
export function payloadBytes(text: string, base64?: string | null): Uint8Array {
  if (base64) {
    try {
      const bin = atob(base64)
      const out = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
      return out
    } catch {
      /* not base64 — fall back to the text */
    }
  }
  return new TextEncoder().encode(text)
}

const hex2 = (b: number) => b.toString(16).padStart(2, '0')

/** One line for a grid cell: `7b 22 69 64 …` (the first `max` bytes). */
export function hexPreview(bytes: Uint8Array, max = 24): string {
  if (bytes.length === 0) return ''
  const shown = Array.from(bytes.subarray(0, max), hex2).join(' ')
  return bytes.length > max ? `${shown} …` : shown
}

/** Rows of a hex dump never grow past this many bytes (a viewer, not an editor). */
export const HEX_DUMP_LIMIT = 64 * 1024

/**
 * The classic dump: offset, 16 bytes in two groups of 8, then the printable ASCII.
 *   00000000  7b 22 69 64 22 3a 31 30  30 31 7d                 |{"id":1001}|
 */
export function hexDump(bytes: Uint8Array, limit = HEX_DUMP_LIMIT): string {
  const n = Math.min(bytes.length, limit)
  const lines: string[] = []
  for (let off = 0; off < n; off += 16) {
    const row = bytes.subarray(off, Math.min(off + 16, n))
    const cells: string[] = []
    for (let i = 0; i < 16; i++) cells.push(i < row.length ? hex2(row[i]) : '  ')
    const left = cells.slice(0, 8).join(' ')
    const right = cells.slice(8).join(' ')
    const ascii = Array.from(row, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('')
    lines.push(`${off.toString(16).padStart(8, '0')}  ${left}  ${right}  |${ascii}|`)
  }
  if (bytes.length > n) lines.push(`… ${(bytes.length - n).toLocaleString('en-US')} more bytes not shown`)
  return lines.join('\n')
}
