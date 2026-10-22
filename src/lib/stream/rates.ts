// Rolling time series for the small rate charts (RateChart.svelte): the app samples a
// value every few seconds while a section is visible and keeps a fixed time window.

export interface Sample {
  t: number // ms epoch
  v: number
}

/** Append a sample and drop the ones older than `windowMs` (returns a new array). */
export function pushSample(series: Sample[], sample: Sample, windowMs: number): Sample[] {
  const cutoff = sample.t - windowMs
  const kept = series.filter((s) => s.t >= cutoff && s.t < sample.t)
  kept.push(sample)
  return kept
}

/** Largest value across several series, rounded up to a readable axis maximum. */
export function niceMax(...series: Sample[][]): number {
  let max = 0
  for (const s of series) for (const p of s) if (p.v > max) max = p.v
  if (max <= 0) return 1
  const exp = Math.pow(10, Math.floor(Math.log10(max)))
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (step * exp >= max) return step * exp
  }
  return 10 * exp
}

/**
 * SVG polyline points for a series drawn into a `width × height` box spanning the
 * last `windowMs` ending at `now`. The y axis runs 0..max (top = max).
 */
export function polylinePoints(series: Sample[], width: number, height: number, max: number, now: number, windowMs: number): string {
  if (series.length === 0 || max <= 0) return ''
  const start = now - windowMs
  return series
    .map((s) => {
      const x = ((s.t - start) / windowMs) * width
      const y = height - (Math.max(0, Math.min(max, s.v)) / max) * height
      return `${round(Math.max(0, Math.min(width, x)))},${round(y)}`
    })
    .join(' ')
}

const round = (n: number) => Math.round(n * 10) / 10
