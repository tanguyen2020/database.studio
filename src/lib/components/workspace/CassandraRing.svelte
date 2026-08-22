<script lang="ts">
  // Cassandra Ring Topology (Phase 4b · T6) — port dòng 802-823 + buildRing()
  // dòng 3018-3033 của prototype. Node THẬT từ system.local + system.peers
  // (command cassandra_ring), KHÔNG hardcode 6 node.
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import { connections } from '$lib/stores/connections.svelte'
  import type { TabState } from '$lib/types'

  interface Props {
    tab: TabState
  }
  let { tab }: Props = $props()

  const profile = $derived(connections.byId(tab.connectionId))
  const accent = '#1287B1' // SYS.cassandra.accent

  let nodes = $state<ipc.RingNode[]>([])
  let error = $state<string | null>(null)

  const up = $derived(`${nodes.filter((n) => n.state.startsWith('U')).length}/${nodes.length}`)
  const dcs = $derived.by(() => {
    const m: Record<string, number> = {}
    for (const n of nodes) m[n.dc] = (m[n.dc] ?? 0) + 1
    return Object.keys(m)
      .map((k) => `${k}(${m[k]})`)
      .join(' ')
  })

  // buildRing geometry (dòng 3018-3033): viewBox 420, R=128, node r=15.
  const S = 420
  const c = S / 2
  const R = 128
  const nr = 15
  const placed = $derived.by(() =>
    nodes.map((n, i) => {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(nodes.length, 1)
      const x = c + R * Math.cos(a)
      const y = c + R * Math.sin(a)
      const lx = c + (R + 34) * Math.cos(a)
      const ly = c + (R + 34) * Math.sin(a)
      return { n, x, y, lx, ly }
    }),
  )
  // Center label từ keyspace + replication của connection.
  const ksLabel = $derived(profile?.database || 'keyspace')

  async function load() {
    if (!tab.connectionId) return
    error = null
    try {
      nodes = await ipc.cassandraRing(tab.connectionId)
    } catch (e) {
      error = String(e)
    }
  }

  $effect(() => {
    void tab.connectionId
    untrack(() => void load())
  })
</script>

<div style="flex:1;display:flex;min-height:0">
  <div style="flex:1;min-width:0;display:flex;flex-direction:column;min-height:0">
    <div style="flex:none;display:flex;align-items:center;gap:var(--px-10);padding:var(--px-10) var(--px-14);border-bottom:var(--px-1) solid var(--border);background:var(--surface)">
      <span style="font-weight:700;font-size:var(--px-13)">Ring Topology</span>
      <span style="font-size:var(--px-11_5);color:var(--sacc-green);font-weight:600">● {up} nodes UP</span>
      <span style="font-size:var(--px-11_5);color:var(--muted)">{dcs}</span>
      <span onclick={load} onkeydown={(e) => e.key === 'Enter' && load()} role="button" tabindex="0" style="margin-left:auto;font-size:var(--px-11_5);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-12);cursor:pointer">⟳ Refresh</span>
    </div>
    <div style="flex:1;overflow:auto;display:flex;align-items:center;justify-content:center;padding:var(--px-18);background:var(--bg);background-image:radial-gradient(var(--border) var(--px-1),transparent var(--px-1));background-size:var(--px-24) var(--px-24)">
      {#if error}
        <div style="color:var(--error);font-size:var(--px-12)">{error}</div>
      {:else}
        <svg viewBox="0 0 {S} {S}" style="width:100%;max-width:var(--px-460);height:auto">
          <circle cx={c} cy={c} r={R} fill="none" stroke="var(--border2)" stroke-width="1.5" stroke-dasharray="5 6" />
          {#each placed as p (p.n.host)}
            <circle cx={p.x} cy={p.y} r={nr} fill="#27AE60" stroke="#0f1219" stroke-width="2">
              <title>{p.n.host} · {p.n.dc}/{p.n.rack} · {p.n.load} · {p.n.owns}</title>
            </circle>
            <text x={p.x} y={p.y + 4} text-anchor="middle" font-size="10" font-weight="700" fill="#0f1219">{p.n.state}</text>
            <text x={p.lx} y={p.ly - 4} text-anchor="middle" font-size="11" font-weight="600" fill="var(--text)">{p.n.host}</text>
            <text x={p.lx} y={p.ly + 9} text-anchor="middle" font-size="9.5" fill="var(--muted)">{p.n.dc} · {p.n.owns}</text>
          {/each}
          <text x={c} y={c - 6} text-anchor="middle" font-size="12" font-weight="700" fill={accent}>{ksLabel}</text>
          <text x={c} y={c + 11} text-anchor="middle" font-size="10" fill="var(--muted)">{nodes.length} nodes</text>
        </svg>
      {/if}
    </div>
  </div>
  <div style="width:var(--px-268);flex:none;border-left:var(--px-1) solid var(--border);background:var(--surface);overflow:auto;padding:var(--px-14);display:flex;flex-direction:column;gap:var(--px-10)">
    <div style="font-size:var(--px-10);font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)">Nodes</div>
    {#each nodes as n (n.host)}
      <div style="background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-9);padding:var(--px-10) var(--px-12)">
        <div style="display:flex;align-items:center;gap:var(--px-7)">
          <span style="width:var(--px-8);height:var(--px-8);border-radius:50%;background:#6ee7a0"></span>
          <span class="mono" style="font-size:var(--px-12);font-weight:600">{n.host}</span>
          <span class="mono" style="margin-left:auto;font-size:var(--px-10);font-weight:700;color:var(--sacc-green)">{n.state}</span>
        </div>
        <div class="mono" style="font-size:var(--px-10_5);color:var(--muted);margin-top:var(--px-5);line-height:1.7">{n.dc} · {n.rack}<br />load {n.load} · owns {n.owns}</div>
      </div>
    {/each}
  </div>
</div>
