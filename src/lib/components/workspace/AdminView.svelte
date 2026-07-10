<script lang="ts">
  // Admin views (Phase 5 · T23): Session Monitor (+Kill), Locks, Users & privileges,
  // Extensions. Đọc system view thật qua ipc.adminView; Kill qua ipc.killSession.
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import { toasts } from '$lib/stores/toast.svelte'
  import type { TabState } from '$lib/types'

  interface Props {
    tab: TabState
  }
  let { tab }: Props = $props()

  // Danh sách view theo hệ (T23 + mở rộng CE): MSSQL Agent Jobs/Query Store/AG,
  // Redis Memory — tất cả đọc được trên bản container/CE.
  const VIEWS = $derived.by((): [string, string][] => {
    switch (tab.systemType) {
      case 'redis':
        return [['memory', 'Memory']]
      case 'mssql':
        return [
          ['sessions', 'Session Monitor'],
          ['users', 'Users & Privileges'],
          ['agent_jobs', 'Agent Jobs'],
          ['query_store', 'Query Store'],
          ['availability_groups', 'Availability Groups'],
        ]
      case 'mysql':
      case 'mariadb':
        return [['sessions', 'Session Monitor'], ['users', 'Users & Privileges']]
      case 'postgres':
        return [
          ['sessions', 'Session Monitor'],
          ['locks', 'Locks'],
          ['users', 'Users & Privileges'],
          ['extensions', 'Extensions'],
        ]
      case 'clickhouse':
        return [
          ['sessions', 'Session Monitor'],
          ['mutations', 'Mutations'],
          ['users', 'Users & Privileges'],
        ]
      default:
        return [['sessions', 'Session Monitor']]
    }
  })

  // Kill targets a numeric backend pid — ClickHouse cancels by query_id (string), a
  // different flow, so the per-row Kill action is offered only where pid-kill applies.
  const canKill = $derived(['postgres', 'mysql', 'mariadb', 'mssql'].includes(tab.systemType))

  let view = $state<string>((untrack(() => tab.state) as { view?: string }).view ?? 'sessions')

  // Chuẩn hóa: nếu view không hợp lệ cho hệ (vd 'sessions' trên redis) → dùng view đầu.
  $effect(() => {
    if (!VIEWS.some(([v]) => v === view)) untrack(() => (view = VIEWS[0][0]))
  })
  let cols = $state<[string, string][]>([])
  let rows = $state<Record<string, unknown>[]>([])
  let loading = $state(false)
  let error = $state<string | null>(null)

  async function load() {
    if (!tab.connectionId) return
    loading = true
    error = null
    try {
      const res = await ipc.adminView(tab.connectionId, view)
      cols = res.cols
      rows = res.rows
    } catch (e) {
      error = String(e)
      cols = []
      rows = []
    } finally {
      loading = false
    }
  }

  $effect(() => {
    void view
    void tab.connectionId
    untrack(() => void load())
  })

  // Đồng bộ khi view được đổi từ ngoài (nút Session Monitor/Users mở lại tab) —
  // CHỈ khi view hợp lệ cho hệ, tránh xung đột vòng lặp với normalize ở trên.
  $effect(() => {
    const v = (tab.state as { view?: string }).view
    if (v && v !== view && VIEWS.some(([x]) => x === v)) untrack(() => (view = v))
  })

  function pick(v: string) {
    view = v
    tab.state = { view: v }
  }

  async function kill(pid: unknown) {
    if (!tab.connectionId || pid == null) return
    const n = Number(pid)
    if (!Number.isFinite(n)) return
    try {
      await ipc.killSession(tab.connectionId, n)
      toasts.success(`Killed session ${n}`)
      void load()
    } catch (e) {
      toasts.error(String(e))
    }
  }

  const fmt = (v: unknown) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v))
</script>

<div style="flex:1;display:flex;flex-direction:column;min-height:0">
  <div style="flex:none;display:flex;align-items:center;gap:var(--px-8);padding:var(--px-9) var(--px-14);border-bottom:var(--px-1) solid var(--border);background:var(--surface);flex-wrap:wrap">
    <span style="font-size:var(--px-11_5);font-weight:700">Admin</span>
    <div style="display:flex;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-7);overflow:hidden">
      {#each VIEWS as [v, label], i (v)}
        <span onclick={() => pick(v)} onkeydown={(e) => e.key === 'Enter' && pick(v)} role="button" tabindex="0" style="padding:var(--px-5) var(--px-12);font-size:var(--px-12);font-weight:600;cursor:pointer;background:{view === v ? 'var(--primary)' : 'transparent'};color:{view === v ? 'var(--hex-fff)' : 'var(--text2)'};border-left:{i === 0 ? 'none' : 'var(--px-1) solid var(--border)'}">{label}</span>
      {/each}
    </div>
    <span style="font-size:var(--px-11);color:var(--muted)">{rows.length} rows</span>
    <span onclick={load} onkeydown={(e) => e.key === 'Enter' && load()} role="button" tabindex="0" style="margin-left:auto;font-size:var(--px-11_5);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer">⟳ Refresh</span>
  </div>
  <div style="flex:1;overflow:auto;min-height:0">
    {#if error}
      <div style="padding:var(--px-14);color:var(--error);font-size:var(--px-12)">{error}</div>
    {:else if loading}
      <div style="padding:var(--px-14);color:var(--muted);font-size:var(--px-12)">Loading…</div>
    {:else}
      <table class="mono" style="border-collapse:collapse;width:100%;font-size:var(--px-12)">
        <thead><tr>
          {#each cols as c (c[0])}
            <th style="position:sticky;top:0;background:var(--header);border-bottom:var(--px-1) solid var(--border2);padding:var(--px-6) var(--px-10);text-align:left;color:var(--text2);font-weight:600">{c[0]}</th>
          {/each}
          {#if view === 'sessions' && canKill}<th style="position:sticky;top:0;background:var(--header);border-bottom:var(--px-1) solid var(--border2);padding:var(--px-6) var(--px-10)"></th>{/if}
        </tr></thead>
        <tbody>
          {#each rows as r, ri (ri)}
            <tr>
              {#each cols as c (c[0])}
                <td style="padding:var(--px-4) var(--px-10);border-bottom:var(--px-1) solid var(--border);color:var(--text2);white-space:nowrap;max-width:var(--px-320);overflow:hidden;text-overflow:ellipsis">{fmt(r[c[0]])}</td>
              {/each}
              {#if view === 'sessions' && canKill}
                <td style="padding:var(--px-4) var(--px-10);border-bottom:var(--px-1) solid var(--border)">
                  <span onclick={() => kill(r['pid'])} onkeydown={(e) => e.key === 'Enter' && kill(r['pid'])} role="button" tabindex="0" style="font-size:var(--px-10);font-weight:700;color:var(--hex-fff);background:var(--error);border-radius:var(--px-4);padding:var(--px-1) var(--px-8);cursor:pointer">Kill</span>
                </td>
              {/if}
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>
</div>
