<script lang="ts">
  // Admin views (Phase 5 · T23): Session Monitor, Locks, Users & privileges,
  // Extensions… — read from the engine's real system views (ipc.adminView).
  // Session Monitor (PG / MySQL / MariaDB / MSSQL / Oracle) is a real monitor:
  // one shape per engine (commands/admin.rs SESSION_COLUMNS), states in plain
  // words, a summary you can filter by, search, durations that flag long queries
  // and open transactions, background processes hidden by default, the full query
  // on demand, and Cancel query vs Terminate session — both confirmed first.
  // Other views render as a readable table (headers, booleans, numbers).
  import { untrack } from 'svelte'
  import Icon from '$lib/components/Icon.svelte'
  import SystemIcon from '$lib/components/SystemIcon.svelte'
  import CodeView from '$lib/components/editor/CodeView.svelte'
  import * as ipc from '$lib/ipc'
  import { toasts } from '$lib/stores/toast.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { connections } from '$lib/stores/connections.svelte'
  import { editorLanguageId } from '$lib/editor/dialect'
  import {
    CAN_CANCEL_QUERY,
    RICH_SESSION_SYSTEMS,
    STATE_LABEL,
    countStates,
    durationLevel,
    fmtDuration,
    humanizeColumn,
    matchesSession,
    rowDuration,
    sessionState,
    waitText,
    type SessionRow,
    type SessionState,
  } from '$lib/admin/sessions'
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
      case 'mongodb':
        return [
          ['sessions', 'Session Monitor'],
          ['server', 'Server Status'],
          ['users', 'Users & Privileges'],
        ]
      case 'oracle':
        return [
          ['sessions', 'Session Monitor'],
          ['locks', 'Locks'],
          ['users', 'Users & Privileges'],
        ]
      default:
        return [['sessions', 'Session Monitor']]
    }
  })

  const system = $derived(tab.systemType)
  const profile = $derived(tab.connectionId ? connections.byId(tab.connectionId) : null)
  // Kill targets a numeric backend pid — ClickHouse cancels by query_id (string), a
  // different flow, so the per-row actions are offered only where pid-kill applies.
  const canKill = $derived(['postgres', 'mysql', 'mariadb', 'mssql', 'mongodb', 'oracle'].includes(system))
  const canCancel = $derived(CAN_CANCEL_QUERY.includes(system))

  let view = $state<string>((untrack(() => tab.state) as { view?: string }).view ?? 'sessions')

  // Chuẩn hóa: nếu view không hợp lệ cho hệ (vd 'sessions' trên redis) → dùng view đầu.
  $effect(() => {
    if (!VIEWS.some(([v]) => v === view)) untrack(() => (view = VIEWS[0][0]))
  })
  let cols = $state<[string, string][]>([])
  let rows = $state<Record<string, unknown>[]>([])
  let loading = $state(false)
  let refreshing = $state(false)
  let error = $state<string | null>(null)
  let loadedAt = $state<Date | null>(null)
  // Row selection (click) — kept across refreshes by pid on the Session Monitor.
  let selectedRow = $state<number | null>(null)
  let selectedPid = $state<string | null>(null)

  async function load(silent = false) {
    if (!tab.connectionId) return
    if (silent) refreshing = true
    else {
      loading = true
      selectedRow = null
      selectedPid = null
    }
    error = null
    try {
      const res = await ipc.adminView(tab.connectionId, view)
      cols = res.cols
      rows = res.rows
      loadedAt = new Date()
    } catch (e) {
      error = String(e)
      if (!silent) {
        cols = []
        rows = []
      }
    } finally {
      loading = false
      refreshing = false
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

  // ---- auto refresh (Session Monitor / Locks): quiet reloads, selection kept
  let every = $state(0)
  $effect(() => {
    if (!every) return
    const t = setInterval(() => {
      if (!loading && !refreshing && !confirmState) void load(true)
    }, every * 1000)
    return () => clearInterval(t)
  })

  // ---- Session Monitor ---------------------------------------------------------
  const rich = $derived(view === 'sessions' && RICH_SESSION_SYSTEMS.includes(system) && cols.some((c) => c[0] === 'query_ms'))
  interface View {
    r: SessionRow
    st: SessionState
    dur: number | null
    level: 'ok' | 'warn' | 'bad'
    wait: string
    self: boolean
  }
  const sessions = $derived.by((): View[] => {
    if (!rich) return []
    return (rows as unknown as SessionRow[]).map((r) => {
      const st = sessionState(system, r)
      const dur = rowDuration(st, r)
      return { r, st, dur, level: durationLevel(st, dur), wait: waitText(system, st, r), self: Number(r.is_self) === 1 || r.is_self === true }
    })
  })
  const counts = $derived(countStates(sessions.map((s) => s.st)))
  let stateFilter = $state<'all' | SessionState>('all')
  let showBackground = $state(false)
  let search = $state('')
  const shown = $derived(
    sessions.filter((s) => {
      if (s.st === 'background' && !showBackground && stateFilter !== 'background') return false
      if (stateFilter !== 'all' && s.st !== stateFilter) return false
      return matchesSession(s.r, search)
    }),
  )
  const SUMMARY: ['all' | SessionState, string][] = [
    ['all', 'Sessions'],
    ['active', 'Active'],
    ['waiting', 'Waiting'],
    ['idle-tx', 'Idle in transaction'],
    ['idle', 'Idle'],
  ]

  // ---- full query viewer
  let queryOf = $state<View | null>(null)
  async function copyQuery(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      toasts.success('Query copied')
    } catch {
      toasts.error('Could not copy to the clipboard')
    }
  }
  function openInEditor(v: View) {
    tabs.openSqlTab({
      connectionId: tab.connectionId,
      title: `Session ${v.r.pid}`,
      query: v.r.query,
      ...(v.r.database && system === 'postgres' ? { database: v.r.database } : {}),
    })
    queryOf = null
  }

  // ---- cancel / terminate (always confirmed)
  let confirmState = $state<{ mode: 'cancel' | 'terminate'; v: View } | null>(null)
  let acting = $state(false)
  async function runAction() {
    if (!confirmState || !tab.connectionId) return
    const { mode, v } = confirmState
    const n = Number(v.r.pid)
    if (!Number.isFinite(n)) return
    acting = true
    try {
      await ipc.killSession(tab.connectionId, n, mode)
      toasts.success(mode === 'cancel' ? `Cancelled the query of session ${n}` : `Terminated session ${n}`)
      confirmState = null
      void load(true)
    } catch (e) {
      toasts.error(String(e))
    } finally {
      acting = false
    }
  }

  // generic tables (Mongo sessions, Locks, Users, Extensions…): pid-kill as before
  async function kill(pid: unknown) {
    if (!tab.connectionId || pid == null) return
    const n = Number(pid)
    if (!Number.isFinite(n)) return
    try {
      await ipc.killSession(tab.connectionId, n)
      toasts.success(`Killed session ${n}`)
      void load(true)
    } catch (e) {
      toasts.error(String(e))
    }
  }

  const fmt = (v: unknown) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v))
  const isNumCol = (type: string) => /int|num|dec|float|double|real|bigint|serial/i.test(type)
  const boolOf = (v: unknown): boolean | null =>
    v === true || v === 't' || v === 'Y' ? true : v === false || v === 'f' || v === 'N' ? false : null
  const isBoolCol = (name: string, type: string) => /bool|bit/i.test(type) || /^(is_|can_|granted$|enabled$|is_done$)/.test(name)
  const timeOf = (d: Date | null) =>
    d ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}` : ''
  const autofocus = (node: HTMLElement) => node.focus()
</script>

<div class="ds-ws">
  <div class="ds-ws-head">
    <span class="ds-ws-icon" aria-hidden="true"><SystemIcon {system} size={20} /></span>
    <div class="ds-ws-titles">
      <span class="ds-ws-title">Server activity</span>
      <span class="ds-ws-sub">{profile?.name ?? 'Connection'}{loadedAt ? ` · updated ${timeOf(loadedAt)}` : ''}</span>
    </div>
    <div class="ds-ws-actions">
      {#if view === 'users' && tab.connectionId}
        <span onclick={() => tab.connectionId && tabs.openUserManager(tab.connectionId)} onkeydown={(e) => e.key === 'Enter' && tab.connectionId && tabs.openUserManager(tab.connectionId)} role="button" tabindex="0" title="Open the full Users & Privileges manager" class="ds-tbtn primary">Manage…</span>
      {/if}
      {#if view === 'sessions' || view === 'locks'}
        <label class="ds-field" title="Reload this view on its own">
          Auto refresh
          <select class="ds-control" bind:value={every} aria-label="Auto refresh">
            <option value={0}>Off</option>
            <option value={5}>Every 5 s</option>
            <option value={10}>Every 10 s</option>
            <option value={30}>Every 30 s</option>
          </select>
        </label>
      {/if}
      <span onclick={() => load(true)} onkeydown={(e) => e.key === 'Enter' && load(true)} role="button" tabindex="0" class="ds-tbtn" aria-busy={refreshing}><span class="adm-spin" class:on={refreshing}><Icon name="refresh" size={13} /></span>Refresh</span>
    </div>
  </div>

  <div class="ds-viewtabs" role="tablist" aria-label="Admin views">
    {#each VIEWS as [v, label] (v)}
      <span role="tab" tabindex="0" aria-selected={view === v} onclick={() => pick(v)} onkeydown={(e) => e.key === 'Enter' && pick(v)}>{label}</span>
    {/each}
  </div>

  {#if rich}
    <!-- summary: what the server is doing, each part a filter -->
    <div class="adm-summary" role="group" aria-label="Session states">
      {#each SUMMARY as [k, label] (k)}
        <span
          role="button"
          tabindex="0"
          class="adm-stat st-{k}"
          aria-pressed={stateFilter === k}
          data-state={k}
          onclick={() => (stateFilter = stateFilter === k && k !== 'all' ? 'all' : k)}
          onkeydown={(e) => e.key === 'Enter' && (stateFilter = stateFilter === k && k !== 'all' ? 'all' : k)}
        >
          <b>{counts[k].toLocaleString('en-US')}</b>{label}
        </span>
      {/each}
    </div>
    <div class="ds-toolbar">
      <span class="ds-search" style="flex:1;max-width:var(--px-420)">
        <Icon name="search" size={13} />
        <input bind:value={search} placeholder="Search user, database, application, client or query…" aria-label="Search sessions" spellcheck="false" />
      </span>
      <label class="adm-check" title="Server processes (autovacuum, WAL writer, checkpointer…) that are not client connections">
        <input type="checkbox" bind:checked={showBackground} />
        Show background processes <span class="ds-count">{counts.background}</span>
      </label>
      <span class="ds-meta" style="margin-left:auto">Showing <b>{shown.length}</b> of {sessions.length}</span>
    </div>
  {:else if view !== 'sessions' || !RICH_SESSION_SYSTEMS.includes(system)}
    <div class="ds-toolbar">
      <span class="ds-meta">{rows.length.toLocaleString('en-US')} {rows.length === 1 ? 'row' : 'rows'}</span>
    </div>
  {/if}

  <div class="adm-body">
    {#if error && !rows.length}
      <div class="ds-empty"><b>Could not read this view</b>{error}</div>
    {:else if loading}
      <div class="ds-empty">Loading…</div>
    {:else if rich}
      {#if !shown.length}
        <div class="ds-empty">
          <b>No sessions here</b>
          {search ? `Nothing matches “${search}”.` : stateFilter !== 'all' ? `No session is ${STATE_LABEL[stateFilter as SessionState].toLowerCase()} right now.` : 'No client session is connected.'}
        </div>
      {:else}
        <table class="ds-table flush adm-table adm-rich">
          <thead><tr>
            <th>PID</th><th>User</th><th>Database</th><th>Client</th><th>State</th><th>Waiting on</th><th class="r">Duration</th><th class="adm-query-h">Query</th>
          </tr></thead>
          <tbody>
            {#each shown as s, i (String(s.r.pid) + ':' + i)}
              {@const key = String(s.r.pid)}
              <tr
                class="adm-row"
                class:sel={selectedPid === key}
                class:bg={s.st === 'background'}
                data-pid={key}
                onclick={() => {
                  selectedPid = key
                  selectedRow = i
                }}
              >
                <td class="ds-num adm-pid">{key}</td>
                <td>
                  <div class="adm-user">{s.r.username || '—'}{#if s.self}<span class="adm-self" title="The session this app uses to read this list">This app</span>{/if}</div>
                  {#if s.r.application}<div class="adm-sub" title={s.r.application}>{s.r.application}</div>{/if}
                </td>
                <td class:adm-muted={!s.r.database}>{s.r.database || '—'}</td>
                <td class="adm-client" class:adm-muted={!s.r.client} title={s.r.client}>{s.r.client || '—'}</td>
                <td><span class="adm-state st-{s.st}" data-state={s.st} title={s.r.state}>{STATE_LABEL[s.st]}</span></td>
                <td class="adm-wait" class:adm-muted={!s.wait} title={s.wait}>{s.wait || '—'}</td>
                <td class="r ds-num"><span class="adm-dur {s.level}" title={s.st === 'idle-tx' ? 'Time this transaction has been open and idle' : s.st === 'idle' ? 'Time idle' : 'Time the current query has run'}>{fmtDuration(s.dur) || '—'}</span></td>
                <td class="adm-query">
                  {#if s.r.query.trim()}
                    <span class="mono" title={s.r.query}>{s.r.query.replace(/\s+/g, ' ')}</span>
                  {:else}<span class="adm-muted">—</span>{/if}
                  <!-- row actions float over the end of the Query cell (no column of their own) -->
                  <span class="adm-act adm-float">
                  {#if s.r.query.trim()}
                    <span role="button" tabindex="0" class="ds-act" title="View the full query" aria-label="View the full query" onclick={(e) => { e.stopPropagation(); queryOf = s }} onkeydown={(e) => e.key === 'Enter' && (queryOf = s)}><Icon name="expand" size={13} /></span>
                  {/if}
                  {#if canKill && !s.self && s.st !== 'background'}
                    {#if canCancel && (s.st === 'active' || s.st === 'waiting')}
                      <span role="button" tabindex="0" class="adm-btn" title="Stop the statement it is running — the session stays connected" onclick={(e) => { e.stopPropagation(); confirmState = { mode: 'cancel', v: s } }} onkeydown={(e) => e.key === 'Enter' && (confirmState = { mode: 'cancel', v: s })}>Cancel query</span>
                    {/if}
                    <span role="button" tabindex="0" class="adm-btn danger" title="Close this connection (its open transaction rolls back)" onclick={(e) => { e.stopPropagation(); confirmState = { mode: 'terminate', v: s } }} onkeydown={(e) => e.key === 'Enter' && (confirmState = { mode: 'terminate', v: s })}>Terminate</span>
                  {/if}
                  </span>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    {:else if !rows.length}
      <div class="ds-empty"><b>Nothing to show</b>This view is empty on this server.</div>
    {:else}
      <table class="ds-table flush adm-table">
        <thead><tr>
          {#each cols as c (c[0])}
            <th class:r={isNumCol(c[1]) && !isBoolCol(c[0], c[1])}>{humanizeColumn(c[0])}</th>
          {/each}
          {#if view === 'sessions' && canKill}<th class="adm-act-h"></th>{/if}
        </tr></thead>
        <tbody>
          {#each rows as r, ri (ri)}
            <tr class="adm-row" class:sel={selectedRow === ri} onclick={() => (selectedRow = ri)}>
              {#each cols as c (c[0])}
                {@const v = r[c[0]]}
                {#if isBoolCol(c[0], c[1]) && boolOf(v) !== null}
                  <td><span class="adm-bool" class:yes={boolOf(v)}>{boolOf(v) ? 'Yes' : 'No'}</span></td>
                {:else if v == null || v === ''}
                  <td class="adm-muted">—</td>
                {:else if isNumCol(c[1])}
                  <td class="r ds-num">{fmt(v)}</td>
                {:else}
                  <td class="adm-text" title={fmt(v)}>{fmt(v)}</td>
                {/if}
              {/each}
              {#if view === 'sessions' && canKill}
                <td class="adm-act">
                  <span onclick={(e) => { e.stopPropagation(); kill(r['pid']) }} onkeydown={(e) => e.key === 'Enter' && kill(r['pid'])} role="button" tabindex="0" class="adm-btn danger">Kill</span>
                </td>
              {/if}
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>

  {#if queryOf}
    {@const q = queryOf}
    <!-- backdrop does NOT close (rule chung); Close / Escape do -->
    <div role="presentation" class="adm-backdrop">
      <div role="dialog" aria-modal="true" aria-label="Session query" tabindex="-1" class="adm-dialog wide" use:autofocus onkeydown={(e) => e.key === 'Escape' && (queryOf = null)}>
        <div class="adm-dlg-head">
          <div>
            <div class="adm-dlg-title">Session {q.r.pid}</div>
            <div class="adm-dlg-sub">{q.r.username || '—'}{q.r.database ? ` @ ${q.r.database}` : ''} · {STATE_LABEL[q.st]}{q.dur != null ? ` · ${fmtDuration(q.dur)}` : ''}</div>
          </div>
          <span role="button" tabindex="0" class="ds-act" style="opacity:1;margin-left:auto" aria-label="Close the query viewer" onclick={() => (queryOf = null)} onkeydown={(e) => e.key === 'Enter' && (queryOf = null)}><Icon name="close" size={14} /></span>
        </div>
        <div class="adm-code">
          <CodeView value={q.r.query} language={editorLanguageId(system)} readOnly height="auto" maxHeight={420} minHeight={120} wrap ariaLabel="Session query" />
        </div>
        <div class="adm-dlg-foot">
          <span class="ds-meta">{q.r.query.length.toLocaleString('en-US')} characters</span>
          <span role="button" tabindex="0" class="cfm-btn" style="margin-left:auto" onclick={() => openInEditor(q)} onkeydown={(e) => e.key === 'Enter' && openInEditor(q)}>Open in SQL tab</span>
          <span role="button" tabindex="0" class="cfm-btn primary" onclick={() => copyQuery(q.r.query)} onkeydown={(e) => e.key === 'Enter' && copyQuery(q.r.query)}>Copy</span>
          <span role="button" tabindex="0" class="cfm-btn" onclick={() => (queryOf = null)} onkeydown={(e) => e.key === 'Enter' && (queryOf = null)}>Close</span>
        </div>
      </div>
    </div>
  {/if}

  {#if confirmState}
    {@const c = confirmState}
    <div role="presentation" class="adm-backdrop">
      <div role="alertdialog" aria-modal="true" aria-label={c.mode === 'cancel' ? 'Cancel query' : 'Terminate session'} tabindex="-1" class="adm-dialog" onkeydown={(e) => e.key === 'Escape' && !acting && (confirmState = null)}>
        <div class="adm-dlg-title">{c.mode === 'cancel' ? `Cancel the query of session ${c.v.r.pid}?` : `Terminate session ${c.v.r.pid}?`}</div>
        <div class="adm-dlg-body">
          <div class="adm-who"><b>{c.v.r.username || '—'}</b>{c.v.r.database ? ` @ ${c.v.r.database}` : ''}{c.v.r.client ? ` · ${c.v.r.client}` : ''}{c.v.r.application ? ` · ${c.v.r.application}` : ''}</div>
          {#if c.mode === 'cancel'}
            Only the statement it is running stops. The session stays connected and its transaction stays open.
          {:else}
            The connection is closed. Anything its open transaction has not committed is rolled back.
          {/if}
          {#if c.v.r.query.trim()}<pre class="mono adm-q">{c.v.r.query.slice(0, 400)}{c.v.r.query.length > 400 ? '…' : ''}</pre>{/if}
        </div>
        <div class="adm-dlg-foot">
          <span use:autofocus role="button" tabindex="0" class="cfm-btn" style="margin-left:auto" onclick={() => !acting && (confirmState = null)} onkeydown={(e) => e.key === 'Enter' && !acting && (confirmState = null)}>Keep it</span>
          <span role="button" tabindex="0" class="cfm-btn danger" aria-busy={acting} onclick={runAction} onkeydown={(e) => e.key === 'Enter' && runAction()}>{acting ? 'Working…' : c.mode === 'cancel' ? 'Cancel query' : 'Terminate session'}</span>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .adm-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    background: var(--surface);
  }
  .adm-spin {
    display: inline-flex;
  }
  .adm-spin.on {
    animation: adm-rot 0.9s linear infinite;
  }
  @keyframes adm-rot {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .adm-spin.on {
      animation: none;
    }
  }

  /* summary strip — each count is a filter */
  .adm-summary {
    flex: none;
    display: flex;
    flex-wrap: wrap;
    gap: var(--px-8);
    padding: var(--px-12) var(--px-18) var(--px-4);
    background: var(--surface);
  }
  .adm-stat {
    display: inline-flex;
    align-items: baseline;
    gap: var(--px-7);
    padding: var(--px-7) var(--px-14);
    border-radius: var(--px-10);
    border: var(--px-1) solid var(--border);
    background: var(--panel);
    font-size: var(--px-12_5);
    color: var(--text2);
    cursor: pointer;
    user-select: none;
    transition: border-color 0.12s, background 0.12s;
  }
  .adm-stat b {
    font-size: var(--px-16);
    font-weight: 700;
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  .adm-stat:hover {
    border-color: color-mix(in srgb, var(--primary) 40%, var(--border2));
  }
  .adm-stat[aria-pressed='true'] {
    border-color: var(--primary);
    background: color-mix(in srgb, var(--primary) 9%, var(--surface));
  }
  .adm-stat.st-active b {
    color: var(--sacc-green);
  }
  .adm-stat.st-waiting b,
  .adm-stat.st-idle-tx b {
    color: var(--sacc-orange);
  }
  .adm-check {
    display: inline-flex;
    align-items: center;
    gap: var(--px-6);
    font-size: var(--px-12_5);
    color: var(--text2);
    cursor: pointer;
  }

  /* the table */
  .adm-table th.r,
  .adm-table td.r {
    text-align: right;
  }
  .adm-row {
    cursor: default;
  }
  .adm-row.bg td {
    color: var(--muted);
  }
  .adm-row:hover:not(.sel) {
    background: color-mix(in srgb, var(--primary) 7%, transparent);
  }
  .adm-row.sel {
    background: color-mix(in srgb, var(--primary) 13%, transparent);
  }
  .adm-pid {
    width: 1%;
    color: var(--text2);
  }
  .adm-user {
    display: flex;
    align-items: center;
    gap: var(--px-6);
    font-weight: 600;
    color: var(--text);
    white-space: nowrap;
  }
  .adm-sub {
    max-width: var(--px-200);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--px-11_5);
    color: var(--muted);
  }
  .adm-self {
    font-size: var(--px-10_5);
    font-weight: 600;
    color: var(--primary);
    padding: 0 var(--px-6);
    border-radius: var(--px-5);
    background: color-mix(in srgb, var(--primary) 12%, transparent);
  }
  .adm-client,
  .adm-wait,
  .adm-text {
    max-width: var(--px-240);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .adm-wait {
    color: var(--text2);
    font-size: var(--px-12);
  }
  .adm-muted {
    color: var(--muted);
  }
  .adm-state {
    display: inline-block;
    padding: var(--px-2) var(--px-9);
    border-radius: var(--px-20);
    font-size: var(--px-11_5);
    font-weight: 600;
    white-space: nowrap;
    color: var(--text2);
    background: var(--panel);
  }
  .adm-state.st-active {
    color: var(--sacc-green);
    background: color-mix(in srgb, var(--sacc-green) 13%, transparent);
  }
  .adm-state.st-waiting,
  .adm-state.st-idle-tx {
    color: var(--sacc-orange);
    background: color-mix(in srgb, var(--sacc-orange) 13%, transparent);
  }
  .adm-state.st-background,
  .adm-state.st-other {
    color: var(--muted);
  }
  .adm-dur {
    white-space: nowrap;
  }
  .adm-dur.warn {
    color: var(--sacc-orange);
    font-weight: 600;
  }
  .adm-dur.bad {
    color: var(--danger-text);
    font-weight: 700;
  }
  /* Query takes whatever width is left (max-width:0 lets the ellipsis work in
     an auto-layout table); every other column sizes to its content. The row
     actions float over the right end of this cell — no column of their own,
     so a long query can never push them off screen. */
  .adm-rich td:not(.adm-query),
  .adm-rich th:not(.adm-query-h) {
    width: 1%;
    white-space: nowrap;
  }
  .adm-query {
    position: relative;
    width: 100%;
    max-width: 0;
  }
  .adm-act.adm-float {
    width: auto;
    position: absolute;
    top: 50%;
    right: var(--px-8);
    transform: translateY(-50%);
    display: inline-flex;
    align-items: center;
    gap: var(--px-2);
    padding-left: var(--px-24);
    background: linear-gradient(90deg, transparent, var(--adm-row-bg) var(--px-20));
  }
  .adm-row {
    --adm-row-bg: var(--surface);
  }
  .adm-row:hover:not(.sel) {
    --adm-row-bg: color-mix(in srgb, var(--primary) 7%, var(--surface));
  }
  .adm-row.sel {
    --adm-row-bg: color-mix(in srgb, var(--primary) 13%, var(--surface));
  }
  .adm-query .mono {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--px-12);
    color: var(--text2);
  }
  .adm-act-h,
  .adm-act {
    width: 1%;
    white-space: nowrap;
    text-align: right;
  }
  .adm-act {
    opacity: 0;
    transition: opacity 0.12s;
  }
  .adm-row:hover .adm-act,
  .adm-row.sel .adm-act,
  .adm-act:focus-within {
    opacity: 1;
  }
  .adm-btn {
    display: inline-flex;
    align-items: center;
    height: var(--px-24);
    margin-left: var(--px-4);
    padding: 0 var(--px-9);
    border-radius: var(--px-6);
    border: var(--px-1) solid var(--border2);
    background: var(--raised);
    font-size: var(--px-12);
    font-weight: 500;
    color: var(--text);
    cursor: pointer;
  }
  .adm-btn:hover {
    border-color: var(--primary);
    color: var(--primary);
  }
  .adm-btn.danger {
    color: var(--danger-text);
  }
  .adm-btn.danger:hover {
    background: var(--danger-soft);
    border-color: color-mix(in srgb, var(--danger-text) 45%, var(--border2));
    color: var(--danger-text);
  }
  .adm-bool {
    display: inline-block;
    padding: 0 var(--px-8);
    border-radius: var(--px-20);
    font-size: var(--px-11_5);
    font-weight: 600;
    color: var(--muted);
    background: var(--panel);
  }
  .adm-bool.yes {
    color: var(--sacc-green);
    background: color-mix(in srgb, var(--sacc-green) 13%, transparent);
  }

  /* dialogs (query viewer, confirm) — backdrop does not close them */
  .adm-backdrop {
    position: absolute;
    inset: 0;
    z-index: 50;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--px-20);
    background: var(--rgba-0-0-0-_5);
  }
  .adm-dialog {
    width: min(var(--px-480), 100%);
    max-height: 100%;
    display: flex;
    flex-direction: column;
    gap: var(--px-12);
    padding: var(--px-18) var(--px-20);
    background: var(--surface);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-14);
    box-shadow: var(--shadow-lg);
    outline: none;
  }
  .adm-dialog.wide {
    width: min(var(--px-840), 100%);
  }
  .adm-dlg-head {
    display: flex;
    align-items: flex-start;
    gap: var(--px-10);
  }
  .adm-dlg-title {
    font-size: var(--px-15);
    font-weight: 650;
    color: var(--text);
  }
  .adm-dlg-sub {
    margin-top: var(--px-2);
    font-size: var(--px-12);
    color: var(--muted);
  }
  .adm-dlg-body {
    font-size: var(--px-13);
    line-height: 1.5;
    color: var(--text2);
  }
  .adm-who {
    margin-bottom: var(--px-6);
    color: var(--text);
  }
  .adm-q {
    margin: var(--px-10) 0 0;
    max-height: var(--px-140);
    overflow: auto;
    padding: var(--px-8) var(--px-10);
    border-radius: var(--px-8);
    border: var(--px-1) solid var(--border);
    background: var(--panel);
    font-size: var(--px-12);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .adm-code {
    min-height: 0;
    border: var(--px-1) solid var(--border2);
    border-radius: var(--px-10);
    overflow: hidden;
    background: var(--raised);
  }
  .adm-dlg-foot {
    display: flex;
    align-items: center;
    gap: var(--px-8);
  }
</style>
