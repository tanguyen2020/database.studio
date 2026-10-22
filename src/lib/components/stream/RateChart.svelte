<script lang="ts" module>
  import type { Sample } from '$lib/stream/rates'
  export interface RateSeries {
    label: string
    /** a CSS colour token, e.g. 'var(--primary)' */
    color: string
    samples: Sample[]
    dashed?: boolean
  }
</script>

<script lang="ts">
  // A small line chart for "per second" rates over a recent window (no chart library).
  // The legend shows each series' latest value so the numbers are readable without
  // hovering the lines.
  import { niceMax, polylinePoints } from '$lib/stream/rates'
  import { compactCount } from '$lib/stream/humanize'

  interface Props {
    series: RateSeries[]
    windowMs: number
    now: number
    unit?: string
    ariaLabel: string
  }
  let { series, windowMs, now, unit = '/s', ariaLabel }: Props = $props()

  const W = 600
  const H = 160
  const max = $derived(niceMax(...series.map((s) => s.samples)))
  const last = (s: RateSeries) => (s.samples.length ? s.samples[s.samples.length - 1].v : null)
  const empty = $derived(series.every((s) => s.samples.length < 2))
</script>

<div class="rc">
  <div class="rc-legend">
    {#each series as s (s.label)}
      <span class="rc-key"><span class="rc-swatch" class:dashed={s.dashed} style="background:{s.color}"></span>{s.label} <b>{last(s) == null ? '—' : compactCount(last(s)!) + unit}</b></span>
    {/each}
  </div>
  <div class="rc-plot">
    <div class="rc-axis" aria-hidden="true"><span>{compactCount(max)}</span><span>{compactCount(max / 2)}</span><span>0</span></div>
    <svg viewBox="0 0 {W} {H}" preserveAspectRatio="none" role="img" aria-label={ariaLabel}>
      <path d="M0 0.5H{W}M0 {H / 2}H{W}M0 {H - 0.5}H{W}" class="rc-grid" />
      {#each series as s (s.label)}
        <polyline points={polylinePoints(s.samples, W, H, max, now, windowMs)} fill="none" stroke={s.color} stroke-width="2" stroke-dasharray={s.dashed ? '5 4' : undefined} vector-effect="non-scaling-stroke" />
      {/each}
    </svg>
  </div>
  {#if empty}<div class="rc-wait">Collecting data — the chart fills in over the next minutes.</div>{/if}
</div>

<style>
  .rc {
    display: flex;
    flex-direction: column;
    gap: var(--px-8);
  }
  .rc-legend {
    display: flex;
    flex-wrap: wrap;
    gap: var(--px-14);
    font-size: var(--px-12);
    color: var(--text2);
  }
  .rc-key {
    display: inline-flex;
    align-items: center;
    gap: var(--px-6);
  }
  .rc-key b {
    color: var(--text);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .rc-swatch {
    width: var(--px-12);
    height: var(--px-3);
    border-radius: var(--px-2);
  }
  .rc-plot {
    display: flex;
    gap: var(--px-8);
    height: var(--px-160);
  }
  .rc-plot svg {
    flex: 1;
    height: 100%;
    min-width: 0;
  }
  .rc-axis {
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    width: var(--px-34);
    text-align: right;
    font-size: var(--px-10_5);
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .rc-grid {
    stroke: var(--border);
    stroke-width: 1;
    fill: none;
    vector-effect: non-scaling-stroke;
  }
  .rc-wait {
    font-size: var(--px-12);
    color: var(--muted);
  }
</style>
