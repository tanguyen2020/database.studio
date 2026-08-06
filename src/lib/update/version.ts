// Pure helpers for the in-app updater. Kept apart from the Tauri plugin calls so
// the decisions ("is this newer?", "how big is the download?", "may we nag the
// user again?") are unit-testable without a desktop runtime.

/** A semver-ish version, with the pre-release tag we actually ship (0.1.0-beta.11). */
export interface Parsed {
  major: number
  minor: number
  patch: number
  /** dot-separated pre-release identifiers, empty for a final release */
  pre: string[]
}

export function parseVersion(v: string): Parsed | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim())
  if (!m) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? m[4].split('.') : [],
  }
}

/** semver precedence: -1 a<b, 0 equal, 1 a>b. Unparseable versions sort last. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0
  for (const k of ['major', 'minor', 'patch'] as const) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1
  }
  // A version WITH a pre-release tag is older than the same version without one
  // (0.1.0-beta.11 < 0.1.0), which is what makes the first stable release update
  // every beta install.
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0
  if (pa.pre.length === 0) return 1
  if (pb.pre.length === 0) return -1
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i]
    const y = pb.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    // numeric identifiers compare numerically (beta.9 < beta.11 — a string
    // compare would call "9" the newer one and never offer the update)
    if (nx && ny) return Number(x) < Number(y) ? -1 : 1
    if (nx) return -1 // numeric < alphanumeric
    if (ny) return 1
    return x < y ? -1 : 1
  }
  return 0
}

/** Only offer an update that is genuinely newer than what's running. */
export function isNewer(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0
}

/** "12.4 MB" / "980 KB" — download size for the prompt (bytes unknown → ''). */
export function formatBytes(n: number | undefined | null): string {
  if (!n || n <= 0 || !Number.isFinite(n)) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  // One decimal below 100 (an installer reads as "12.4 MB", not "12 MB"), whole
  // numbers above it and for raw bytes. parseFloat drops a trailing ".0".
  const shown = i === 0 || v >= 100 ? Math.round(v) : parseFloat(v.toFixed(1))
  return `${shown} ${units[i]}`
}

/** Download progress 0..100, or null while the total length is unknown. */
export function progressPercent(downloaded: number, total: number | undefined | null): number | null {
  if (!total || total <= 0) return null
  return Math.max(0, Math.min(100, Math.round((downloaded / total) * 100)))
}

/**
 * Whether the start-up check may prompt for `version` again. "Skip this version"
 * silences that exact version forever; "Later" silences every version until the
 * next launch. An explicit "Check for updates" bypasses this entirely.
 */
export function mayPrompt(version: string, skipped: string | null | undefined, dismissedThisRun: boolean): boolean {
  if (dismissedThisRun) return false
  return !skipped || skipped !== version
}
