<script lang="ts">
  // Chart mode — port 1:1 builder rail (dòng 504-530) + buildChart() (dòng
  // 2537-2580). Group by X, agg Y (sum/avg/count/min/max) 12 nhóm đầu; SVG
  // bar/line/pie/area, màu theo accent hệ. Export PNG/SVG stub (Phase 5 Backup/Export).
  import { toasts } from '$lib/stores/toast.svelte'
  import type { QueryResultSet } from '$lib/types'

  interface Props {
    data: QueryResultSet
    accent: string
  }

  let { data, accent }: Props = $props()

  const names = $derived(data.cols.map(([n]) => n))
  const numNames = $derived(
    data.cols
      .filter(([, t]) => /int|float|numeric|decimal|double|real|uint/i.test(t))
      .map(([n]) => n),
  )

  let chartType = $state<'bar' | 'line' | 'pie' | 'area'>('bar')
  let chartX = $state('')
  let chartY = $state('')
  let chartAgg = $state<'sum' | 'avg' | 'count' | 'min' | 'max'>('sum')

  const cx = $derived(chartX && names.includes(chartX) ? chartX : names[0])
  const cy = $derived(
    chartY && names.includes(chartY) ? chartY : numNames[0] || names[1] || names[0],
  )

  // group + aggregate (port dòng 5084-5091)
  const chartData = $derived.by(() => {
    const groups: Record<string, { sum: number; count: number; min: number; max: number }> = {}
    for (const r of data.rows) {
      const rec = r as Record<string, unknown>
      const k = String(rec[cx])
      const yv = parseFloat(String(rec[cy]))
      if (!groups[k]) groups[k] = { sum: 0, count: 0, min: Infinity, max: -Infinity }
      const g = groups[k]
      g.count++
      if (!Number.isNaN(yv)) {
        g.sum += yv
        g.min = Math.min(g.min, yv)
        g.max = Math.max(g.max, yv)
      }
    }
    return Object.keys(groups)
      .map((k) => {
        const g = groups[k]
        let v: number
        if (chartAgg === 'sum') v = g.sum
        else if (chartAgg === 'avg') v = g.count ? g.sum / g.count : 0
        else if (chartAgg === 'count') v = g.count
        else if (chartAgg === 'min') v = g.min === Infinity ? 0 : g.min
        else v = g.max === -Infinity ? 0 : g.max
        return { k, v }
      })
      .slice(0, 12)
  })

  // ---- SVG geometry (port buildChart) ----
  const W = 580,
    H = 360,
    ml = 56,
    mb = 46,
    mt = 18,
    mr = 18
  const pw = W - ml - mr
  const ph = H - mt - mb
  // pie palette — port pal[] (dòng 2569), tham chiếu token sinh từ HTML gốc
  const PALETTE = [
    'var(--hex-5b7cff)', 'var(--hex-27ae60)', 'var(--hex-ffcc00)', 'var(--hex-e8a882)',
    'var(--hex-c678dd)', 'var(--hex-56b6c2)', 'var(--hex-e06c75)', 'var(--hex-61afef)',
    'var(--hex-98c379)', 'var(--hex-d19a66)', 'var(--hex-5cc4e8)', 'var(--hex-f0a020)',
  ]

  function fmt(v: number): string {
    const a = Math.abs(v)
    if (a >= 1e9) return `${(v / 1e9).toFixed(1)}B`
    if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`
    if (a >= 1e3) return `${(v / 1e3).toFixed(1)}k`
    return (Math.round(v * 100) / 100).toString()
  }

  const maxV = $derived(Math.max(...chartData.map((d) => d.v), 0) || 1)
  const gridLines = $derived(
    [0, 1, 2, 3, 4].map((i) => ({ y: mt + ph - (ph * i) / 4, val: (maxV * i) / 4 })),
  )
  const labelEvery = $derived(Math.ceil(chartData.length / 8) || 1)
  const yLabel = $derived(`${chartAgg}(${cy})`)

  const linePts = $derived(
    chartData.map((d, i) => [ml + (pw * (i + 0.5)) / chartData.length, mt + ph - ph * (d.v / maxV)]),
  )
  const areaPoly = $derived.by(() => {
    if (linePts.length === 0) return ''
    return (
      linePts.map((p) => p.join(',')).join(' ') +
      ` ${linePts[linePts.length - 1][0]},${mt + ph} ${linePts[0][0]},${mt + ph}`
    )
  })

  // pie
  const pieSlices = $derived.by(() => {
    const total = chartData.reduce((s, d) => s + Math.max(0, d.v), 0) || 1
    const pcx = ml + pw / 2,
      pcy = mt + ph / 2,
      rad = Math.min(pw, ph) / 2 - 10
    let ang = -Math.PI / 2
    return chartData.map((d, i) => {
      const frac = Math.max(0, d.v) / total
      const a2 = ang + frac * Math.PI * 2
      const x1 = pcx + rad * Math.cos(ang),
        y1 = pcy + rad * Math.sin(ang)
      const x2 = pcx + rad * Math.cos(a2),
        y2 = pcy + rad * Math.sin(a2)
      const large = frac > 0.5 ? 1 : 0
      const path = `M${pcx},${pcy} L${x1},${y1} A${rad},${rad} 0 ${large} 1 ${x2},${y2} Z`
      ang = a2
      return { path, color: PALETTE[i % PALETTE.length], label: d.k, v: d.v, pct: Math.round(frac * 100) }
    })
  })
</script>

<div style="display:flex;height:100%;min-height:0">
  <!-- builder rail — dòng 506-528 -->
  <div style="width:var(--px-228);flex:none;border-right:var(--px-1) solid var(--border);padding:var(--px-14);display:flex;flex-direction:column;gap:var(--px-13);background:var(--surface)">
    <div style="font-size:var(--px-10);font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)">Chart Builder</div>
    <label style="display:flex;flex-direction:column;gap:var(--px-4);font-size:var(--px-11);color:var(--text2)">Chart type
      <select bind:value={chartType} class="ch-sel">
        <option value="bar">Bar</option><option value="line">Line</option><option value="pie">Pie</option><option value="area">Area</option>
      </select>
    </label>
    <label style="display:flex;flex-direction:column;gap:var(--px-4);font-size:var(--px-11);color:var(--text2)">X axis
      <select bind:value={chartX} class="ch-sel">
        {#each names as c (c)}<option value={c}>{c}</option>{/each}
      </select>
    </label>
    <label style="display:flex;flex-direction:column;gap:var(--px-4);font-size:var(--px-11);color:var(--text2)">Y axis
      <select bind:value={chartY} class="ch-sel">
        {#each names as c (c)}<option value={c}>{c}</option>{/each}
      </select>
    </label>
    <label style="display:flex;flex-direction:column;gap:var(--px-4);font-size:var(--px-11);color:var(--text2)">Aggregation
      <select bind:value={chartAgg} class="ch-sel">
        <option value="sum">sum</option><option value="avg">avg</option><option value="count">count</option><option value="min">min</option><option value="max">max</option>
      </select>
    </label>
    <div style="margin-top:auto;display:flex;gap:var(--px-6)">
      <span class="ch-exp" onclick={() => toasts.show('Export PNG — Phase 5')} onkeydown={(e) => e.key === 'Enter' && toasts.show('Export PNG — Phase 5')} role="button" tabindex="0">PNG</span>
      <span class="ch-exp" onclick={() => toasts.show('Export SVG — Phase 5')} onkeydown={(e) => e.key === 'Enter' && toasts.show('Export SVG — Phase 5')} role="button" tabindex="0">SVG</span>
    </div>
  </div>

  <!-- chart area -->
  <div style="flex:1;min-width:0;overflow:auto;padding:var(--px-18);display:flex;align-items:center;justify-content:center">
    {#if chartData.length === 0}
      <div style="color:var(--muted);font-size:var(--px-13)">No data to chart</div>
    {:else}
      <svg viewBox="0 0 {W} {H}" style="width:100%;max-width:var(--px-720);height:auto">
        {#if chartType !== 'pie'}
          <!-- gridlines + y labels -->
          {#each gridLines as g, i (i)}
            <line x1={ml} y1={g.y} x2={W - mr} y2={g.y} stroke="var(--border)" stroke-width="1" />
            <text x={ml - 8} y={g.y + 4} text-anchor="end" font-size="10" fill="var(--muted)">{fmt(g.val)}</text>
          {/each}
          {#if chartType === 'bar'}
            {@const bw = (pw / chartData.length) * 0.62}
            {#each chartData as d, i (i)}
              {@const bh = ph * (d.v / maxV)}
              <rect x={ml + (pw * (i + 0.5)) / chartData.length - bw / 2} y={mt + ph - bh} width={bw} height={Math.max(0, bh)} fill={accent} rx="3" opacity="0.88">
                <title>{d.k}: {fmt(d.v)}</title>
              </rect>
            {/each}
          {:else}
            {#if chartType === 'area'}
              <polygon points={areaPoly} fill={accent} opacity="0.18" />
            {/if}
            <polyline points={linePts.map((p) => p.join(',')).join(' ')} fill="none" stroke={accent} stroke-width="2.2" />
            {#each linePts as p, i (i)}
              <circle cx={p[0]} cy={p[1]} r="3.4" fill={accent}><title>{chartData[i].k}: {fmt(chartData[i].v)}</title></circle>
            {/each}
          {/if}
          <!-- x labels -->
          {#each chartData as d, i (i)}
            {#if i % labelEvery === 0}
              <text x={ml + (pw * (i + 0.5)) / chartData.length} y={H - mb + 16} text-anchor="middle" font-size="10" fill="var(--muted)">
                {String(d.k).length > 9 ? String(d.k).slice(0, 8) + '…' : d.k}
              </text>
            {/if}
          {/each}
          <text x="14" y={mt + ph / 2} font-size="10" fill="var(--text2)" transform="rotate(-90 14 {mt + ph / 2})" text-anchor="middle">{yLabel}</text>
          <text x={ml + pw / 2} y={H - 4} font-size="10" fill="var(--text2)" text-anchor="middle">{cx}</text>
        {:else}
          {#each pieSlices as s, i (i)}
            <path d={s.path} fill={s.color} opacity="0.9"><title>{s.label}: {fmt(s.v)} ({s.pct}%)</title></path>
          {/each}
          {#each chartData.slice(0, 8) as d, i (i)}
            <g transform="translate({W - mr - 110},{mt + i * 18})">
              <rect width="11" height="11" rx="2" fill={PALETTE[i % PALETTE.length]} />
              <text x="16" y="10" font-size="10" fill="var(--text2)">{String(d.k).slice(0, 12)}</text>
            </g>
          {/each}
        {/if}
      </svg>
    {/if}
  </div>
</div>

<style>
  .ch-sel {
    background: var(--panel);
    color: var(--text);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-6);
    padding: var(--px-5) var(--px-8);
    font-size: var(--px-12);
  }
  .ch-exp {
    flex: 1;
    text-align: center;
    font-size: var(--px-11);
    color: var(--text2);
    background: var(--panel);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-6);
    padding: var(--px-5) 0;
    cursor: pointer;
  }
  .ch-exp:hover {
    background: var(--hover);
  }
</style>
