<script lang="ts">
  // Redis Key Explorer — port 1:1 từ Database Studio.dc.html dòng 662-678:
  // panel trái 300px (DB selector + SCAN count + cây key theo prefix ':'),
  // panel phải là Key Viewer (T4 — hiện placeholder). Key nạp qua SCAN cursor
  // (không KEYS *); cây prefix dựng bằng buildRedisTree (lib/redis/tree.ts).
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import { connections } from '$lib/stores/connections.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { buildRedisTree, flattenRedisTree, type RedisKeyInfo } from '$lib/redis/tree'
  import type { TabState } from '$lib/types'

  interface Props {
    tab: TabState
  }
  let { tab }: Props = $props()

  const profile = $derived(connections.byId(tab.connectionId))
  const dbIndex = $derived(profile?.database?.trim() || '0')

  let keys = $state<RedisKeyInfo[]>([])
  let dbsize = $state(0)
  let pattern = $state('')
  let loading = $state(false)
  let error = $state<string | null>(null)
  let expanded = $state<Set<string>>(new Set())
  let selected = $state<string | null>(null)

  // màu badge theo type (token đã có trong tokens.css)
  const TYPE_COLOR: Record<string, string> = {
    string: 'var(--hex-5b9bd5)',
    hash: 'var(--hex-e8c547)',
    list: 'var(--hex-56b6c2)',
    set: 'var(--hex-b48ead)',
    zset: 'var(--hex-e06c75)',
    stream: 'var(--hex-e8923a)',
  }
  function typeColor(t: string): string {
    return TYPE_COLOR[t] ?? 'var(--hex-9aa4b8)'
  }
  function typeBadge(t: string): string {
    return (t || '?').slice(0, 1).toUpperCase()
  }
  function ttlLabel(ttl: number): string {
    if (ttl === -1) return '∞'
    if (ttl === -2) return 'expired'
    if (ttl < 60) return `${ttl}s`
    if (ttl < 3600) return `${Math.floor(ttl / 60)}m`
    return `${Math.floor(ttl / 3600)}h`
  }

  const tree = $derived(buildRedisTree(keys))
  const rows = $derived(flattenRedisTree(tree, expanded))

  async function load() {
    if (!tab.connectionId) return
    loading = true
    error = null
    try {
      // gom key qua nhiều vòng SCAN tới cursor 0 (giới hạn an toàn ~5000)
      const collected: RedisKeyInfo[] = []
      let cursor = 0
      let size = 0
      for (let i = 0; i < 50; i++) {
        const res = await ipc.redisScan(tab.connectionId, pattern, cursor, 200)
        collected.push(...res.keys)
        size = res.dbsize
        cursor = res.cursor
        if (cursor === 0 || collected.length >= 5000) break
      }
      keys = collected
      dbsize = size
    } catch (e) {
      error = String(e)
    } finally {
      loading = false
    }
  }

  // nạp lại khi đổi connection hoặc pattern. untrack: load() ghi $state đồng bộ
  // (loading/error) → tránh read+write cùng vùng track gây effect_update_depth.
  $effect(() => {
    void tab.connectionId
    void pattern
    untrack(() => void load())
  })

  function toggle(path: string) {
    const next = new Set(expanded)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    expanded = next
  }

  async function copyKey(name: string) {
    await navigator.clipboard.writeText(name)
    toasts.success(`Đã copy "${name}"`)
  }
</script>

<div style="flex:1;display:flex;min-height:0">
  <!-- panel trái — key explorer (dòng 663-678) -->
  <div style="width:var(--px-300);flex:none;border-right:var(--px-1) solid var(--border);background:var(--surface);display:flex;flex-direction:column;min-height:0">
    <!-- header: DB selector + SCAN count -->
    <div style="flex:none;padding:var(--px-9) var(--px-12);border-bottom:var(--px-1) solid var(--border);display:flex;align-items:center;gap:var(--px-8)">
      <span style="font-size:var(--px-12);color:var(--text2)">DB</span>
      <span class="mono" style="font-size:var(--px-11);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-3) var(--px-9)">db{dbIndex}</span>
      <span class="mono" style="margin-left:auto;font-size:var(--px-11);color:var(--muted)">SCAN · {dbsize} keys</span>
    </div>
    <!-- search pattern -->
    <div style="flex:none;padding:var(--px-6) var(--px-8)">
      <input
        bind:value={pattern}
        placeholder="pattern (vd user:*)"
        class="mono"
        style="width:100%;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-8);font-size:var(--px-11_5);color:var(--text);outline:none"
      />
    </div>
    <!-- cây key -->
    <div style="flex:1;overflow:auto;padding:var(--px-6);min-height:0">
      {#if error}
        <div style="padding:var(--px-10);font-size:var(--px-11_5);color:var(--error)">{error}</div>
      {:else if loading && rows.length === 0}
        <div style="padding:var(--px-10);font-size:var(--px-11_5);color:var(--muted)">Đang SCAN…</div>
      {:else if rows.length === 0}
        <div style="padding:var(--px-10);font-size:var(--px-11_5);color:var(--muted)">Không có key khớp.</div>
      {:else}
        {#each rows as r (r.path)}
          {#if r.kind === 'folder'}
            <div
              onclick={() => toggle(r.path)}
              onkeydown={(e) => e.key === 'Enter' && toggle(r.path)}
              role="button"
              tabindex="0"
              style="display:flex;align-items:center;gap:var(--px-8);padding:var(--px-5) var(--px-8);border-radius:var(--px-6);cursor:pointer;padding-left:calc(var(--px-8) + {r.depth} * var(--px-14))"
            >
              <span class="mono" style="flex:none;width:var(--px-10);text-align:center;font-size:var(--px-9);color:var(--muted)">{r.expanded ? '▾' : '▸'}</span>
              <span class="mono" style="font-size:var(--px-12);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text2)">{r.segment}</span>
              <span class="mono" style="margin-left:auto;flex:none;font-size:var(--px-10);color:var(--muted)">{r.count}</span>
            </div>
          {:else}
            {@const kt = r.key?.key_type ?? 'string'}
            <div
              onclick={() => (selected = r.path)}
              ondblclick={() => copyKey(r.path)}
              onkeydown={(e) => e.key === 'Enter' && (selected = r.path)}
              role="button"
              tabindex="0"
              title={r.path}
              style="display:flex;align-items:center;gap:var(--px-8);padding:var(--px-5) var(--px-8);border-radius:var(--px-6);cursor:pointer;padding-left:calc(var(--px-8) + {r.depth} * var(--px-14));background:{selected === r.path ? 'var(--hover)' : 'transparent'}"
            >
              <span class="mono" style="flex:none;font-size:var(--px-9);font-weight:700;color:{typeColor(kt)};border:var(--px-1) solid {typeColor(kt)};border-radius:var(--px-3);padding:0 var(--px-4)">{typeBadge(kt)}</span>
              <span class="mono" style="font-size:var(--px-12);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{r.segment}</span>
              <span class="mono" style="margin-left:auto;flex:none;font-size:var(--px-10);color:{r.key?.ttl === -2 ? 'var(--error)' : 'var(--muted)'}">{r.key ? ttlLabel(r.key.ttl) : ''}</span>
            </div>
          {/if}
        {/each}
      {/if}
    </div>
  </div>

  <!-- panel phải — Key Viewer (T4). Tạm placeholder. -->
  <div style="flex:1;display:flex;flex-direction:column;min-width:0">
    {#if selected}
      <div style="flex:none;display:flex;align-items:center;gap:var(--px-10);padding:var(--px-10) var(--px-14);border-bottom:var(--px-1) solid var(--border);background:var(--surface)">
        <span style="width:var(--px-3);height:var(--px-20);border-radius:var(--px-2);background:#D82C20"></span>
        <span class="mono" style="font-size:var(--px-13);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{selected}</span>
      </div>
      <div style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:var(--px-12)">
        Key Viewer/Editor — Phase 3 (T4)
      </div>
    {:else}
      <div style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:var(--px-12)">
        Chọn một key để xem giá trị
      </div>
    {/if}
  </div>
</div>
