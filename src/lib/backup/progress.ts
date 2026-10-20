// What the Backup & Restore dialog says while a job runs: percent, "N of M
// tables · public.orders", throughput and time left. Pure — the dialog feeds
// it the progress events (commands/backup.rs BackupProgress) as they arrive.
import type { BackupProgress } from '$lib/ipc'

export interface Sample {
  at: number
  done: number
}

export interface ProgressView {
  /** 0–100, or null when the total is unknown (indeterminate bar). */
  percent: number | null
  /** "Backing up" · "Restoring" … */
  stage: string
  /** "1,240 of 3,000 tables" · "48.2 MB of 120 MB" · "42%" · "1,240 keys" · "" */
  amount: string
  /** The object being worked on, if the engine reports one. */
  current: string | null
  /** "120 tables/s" · "8.4 MB/s" · null */
  rate: string | null
  /** "about 2 min left" · "less than a minute left" · null */
  eta: string | null
}

const nf = new Intl.NumberFormat('en-US')

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`
}

function amountOf(p: BackupProgress): string {
  if (p.unit === '%') return `${Math.min(100, p.done)}%`
  if (p.unit === 'bytes') {
    return p.total ? `${formatBytes(p.done)} of ${formatBytes(p.total)}` : p.done > 0 ? formatBytes(p.done) : ''
  }
  if (!p.unit) return ''
  // a total of 0 is unknown, not "0 of 0" (the count may run on another database)
  if (p.total) return `${nf.format(p.done)} of ${nf.format(p.total)} ${p.unit}`
  return p.done > 0 ? `${nf.format(p.done)} ${p.unit}` : ''
}

/** The object / step being worked on, without repeating the stage: pg_dump's
 *  "reading schemas" under "Reading the catalog" reads as "schemas". */
function currentOf(p: BackupProgress): string | null {
  const c = p.current
  if (!c) return null
  const verb = (p.stage || '').split(' ')[0].toLowerCase()
  return verb && c.toLowerCase().startsWith(verb + ' ') ? c.slice(verb.length + 1) : c
}

/** Keep the samples of the last `windowMs` (rate is measured over them). */
export function pushSample(samples: Sample[], s: Sample, windowMs = 6000): Sample[] {
  const last = samples[samples.length - 1]
  // a new stage restarts the counter — so does the rate
  const out = last && s.done < last.done ? [] : samples.slice()
  out.push(s)
  while (out.length > 2 && s.at - out[0].at > windowMs) out.shift()
  return out
}

function perSecond(samples: Sample[]): number | null {
  if (samples.length < 2) return null
  const a = samples[0]
  const b = samples[samples.length - 1]
  const dt = (b.at - a.at) / 1000
  if (dt < 0.8) return null
  return (b.done - a.done) / dt
}

export function etaText(seconds: number): string {
  if (seconds < 60) return 'less than a minute left'
  const m = Math.round(seconds / 60)
  if (m < 60) return `about ${m} min left`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return rm ? `about ${h} h ${rm} min left` : `about ${h} h left`
}

export function progressView(p: BackupProgress | null, samples: Sample[]): ProgressView {
  if (!p) return { percent: null, stage: 'Preparing', amount: '', current: null, rate: null, eta: null }
  const percent =
    p.unit === '%' ? Math.min(100, Math.max(0, p.done)) : p.total && p.total > 0 ? Math.min(100, (p.done / p.total) * 100) : null
  const r = perSecond(samples)
  let rate: string | null = null
  if (r != null && r > 0 && p.unit && p.unit !== '%') {
    rate = p.unit === 'bytes' ? `${formatBytes(Math.round(r))}/s` : `${r >= 10 ? nf.format(Math.round(r)) : r.toFixed(1)} ${p.unit}/s`
  }
  let eta: string | null = null
  if (r != null && r > 0 && percent != null && percent < 100) {
    const remaining = p.unit === '%' ? 100 - p.done : (p.total ?? 0) - p.done
    if (remaining > 0) eta = etaText(remaining / r)
  }
  return { percent, stage: p.stage || 'Working', amount: amountOf(p), current: currentOf(p), rate, eta }
}
