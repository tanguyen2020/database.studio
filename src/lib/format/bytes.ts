// Human-readable byte sizes for the Objects grid (and anywhere a data length is
// shown). Mirrors the "64 KB" / "1.1 MB" style of the reference table list.

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const

/**
 * Format a byte count as a compact, human-readable size.
 * - `null`/`undefined` → '—' (unknown / not reported by the engine).
 * - `0` → '0 B'.
 * - Uses 1024-based units; drops the decimal for whole numbers and for bytes.
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || Number.isNaN(bytes)) return '—'
  if (bytes < 0) return '—'
  if (bytes === 0) return '0 B'
  let n = bytes
  let u = 0
  while (n >= 1024 && u < UNITS.length - 1) {
    n /= 1024
    u++
  }
  // Bytes are always whole; larger units keep one decimal unless it's a round number.
  const rounded = u === 0 ? Math.round(n) : Math.round(n * 10) / 10
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
  return `${text} ${UNITS[u]}`
}
