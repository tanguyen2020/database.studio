<script lang="ts">
  // Schema Compare — compares the STRUCTURE of two databases of the same engine
  // (tables, columns, indexes, views, routines, triggers, sequences; never data) and
  // builds the script that makes the TARGET look like the SOURCE.
  //
  // Layout (master–detail, like commercial compare tools):
  //   setup bar   — Source ⇄ Target pickers + Compare again
  //   summary     — New / Changed / Extra / Same cards (each one is a filter)
  //   list        — objects grouped by type, check box = "include in the script"
  //   detail      — what differs for the selected object (columns side by side,
  //                 indexes/triggers, or the two definitions) + its own script
  //   Sync script — the whole migration; Apply to target runs it after a confirm.
  // Diff rules live in compare/diff.ts, the reading of each side in
  // compare/snapshot.ts, the words/grouping in compare/view.ts.
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import Icon from '$lib/components/Icon.svelte'
  import Chevron from '$lib/components/Chevron.svelte'
  import SystemIcon from '$lib/components/SystemIcon.svelte'
  import SearchSelect from '$lib/components/SearchSelect.svelte'
  import CodeView from '$lib/components/editor/CodeView.svelte'
  import { editorLanguageId } from '$lib/editor/dialect'
  import { dbIcon } from '$lib/explorer/icons'
  import { connections } from '$lib/stores/connections.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { splitStatements } from '$lib/sql/statements'
  import { compareSchemas, columnKey, genMigration, lineDiff, objectKey, type DiffStatus, type ObjectDiff, type ObjectKind } from '$lib/compare/diff'
  import { takeSnapshot, type SnapshotProgress } from '$lib/compare/snapshot'
  import {
    KIND_LABEL,
    LIST_KINDS,
    STATUS,
    changeSummary,
    childrenOf,
    destructiveCount,
    keysOf,
    listed,
    objectScript,
    statusCounts,
    type Children,
    type StatusFilter,
  } from '$lib/compare/view'
  import type { TabState } from '$lib/types'

  interface Props {
    tab: TabState
  }
  let { tab }: Props = $props()

  // Every relational connection is selectable — not only already-open ones; a
  // picked-but-closed connection is opened on demand in compare().
  const RELATIONAL = ['postgres', 'mysql', 'mariadb', 'mssql', 'sqlite', 'clickhouse', 'oracle', 'duckdb']
  const options = $derived(connections.profiles.filter((p) => RELATIONAL.includes(p.system)))
  type CmpState = { srcConn?: string | null; tgtConn?: string | null; srcDb?: string | null; tgtDb?: string | null; presetTick?: number }
  const st0 = untrack(() => tab.state) as CmpState
  let srcConn = $state<string | null>(st0.srcConn ?? null)
  let tgtConn = $state<string | null>(st0.tgtConn ?? null)
  let srcDb = $state<string | null>(st0.srcDb ?? null)
  let tgtDb = $state<string | null>(st0.tgtDb ?? null)
  let srcDbs = $state<string[]>([])
  let tgtDbs = $state<string[]>([])
  const srcProfile = $derived(connections.byId(srcConn))
  const tgtProfile = $derived(connections.byId(tgtConn))
  const system = $derived(srcProfile?.system ?? 'postgres')

  let mode = $state<'diff' | 'sync'>('diff')
  let filter = $state<StatusFilter>('changes')
  let query = $state('')
  let diffs = $state<ObjectDiff[]>([])
  let selected = $state<Set<string>>(new Set())
  let warn = $state<string | null>(null)
  let loading = $state(false)
  let compared = $state(false)
  let srcProg = $state<SnapshotProgress | null>(null)
  let tgtProg = $state<SnapshotProgress | null>(null)
  let elapsedMs = $state(0)

  const connOptions = $derived([
    { value: null as string | null, label: '—' },
    ...options.map((o) => ({ value: o.id as string | null, label: `${o.name} (${o.system})` })),
  ])
  const srcDbOptions = $derived([
    { value: null as string | null, label: srcProfile?.database || '(current)' },
    ...srcDbs.map((d) => ({ value: d as string | null, label: d })),
  ])
  const tgtDbOptions = $derived([
    { value: null as string | null, label: tgtProfile?.database || '(current)' },
    ...tgtDbs.map((d) => ({ value: d as string | null, label: d })),
  ])

  // Re-apply a new preset when the singleton tab is reopened (openSchemaCompare
  // bumps presetTick) — e.g. "Compare Databases…" from a database node.
  let lastTick = st0.presetTick ?? 0
  $effect(() => {
    const s = tab.state as CmpState
    if ((s.presetTick ?? 0) !== lastTick) {
      lastTick = s.presetTick ?? 0
      untrack(() => {
        srcConn = s.srcConn ?? null
        tgtConn = s.tgtConn ?? null
        srcDb = s.srcDb ?? null
        tgtDb = s.tgtDb ?? null
      })
    }
  })

  async function loadDbs(connId: string, sys: string): Promise<string[]> {
    try {
      if (sys === 'postgres' || sys === 'mssql') return (await ipc.listDatabases(connId)).map((d) => d.name)
      if (sys === 'mysql' || sys === 'mariadb' || sys === 'clickhouse' || sys === 'oracle') return (await ipc.listSchemas(connId)).map((s) => s.name)
      return []
    } catch {
      return []
    }
  }
  $effect(() => {
    const c = srcConn
    const sys = srcProfile?.system
    if (c && sys) untrack(() => void loadDbs(c, sys).then((d) => (srcDbs = d)))
    else srcDbs = []
  })
  $effect(() => {
    const c = tgtConn
    const sys = tgtProfile?.system
    if (c && sys) untrack(() => void loadDbs(c, sys).then((d) => (tgtDbs = d)))
    else tgtDbs = []
  })

  async function resolveId(connId: string, db: string | null): Promise<string> {
    return db ? await ipc.attachDatabase(connId, db) : connId
  }
  async function ensureConnected(id: string): Promise<boolean> {
    const p = connections.byId(id)
    if (!p) return false
    if (p.connected) return true
    return await connections.connect(id)
  }

  // Each run gets a generation number: picking another database while a compare is
  // still reading must never let the older, slower result overwrite the newer one.
  let gen = 0
  async function compare() {
    const my = ++gen
    warn = null
    if (!srcConn || !tgtConn) {
      diffs = []
      compared = false
      return
    }
    if (srcProfile?.system !== tgtProfile?.system) {
      warn = `Both sides must be the same engine — the source is ${srcProfile?.system} and the target is ${tgtProfile?.system}.`
      return
    }
    if (srcConn === tgtConn && (srcDb ?? '') === (tgtDb ?? '')) {
      warn = 'Source and target are the same database — pick two different databases (or connections).'
      return
    }
    loading = true
    srcProg = tgtProg = null
    const t0 = performance.now()
    try {
      if (!(await ensureConnected(srcConn)) || !(await ensureConnected(tgtConn))) {
        if (my === gen) warn = 'Could not connect to the selected source/target connection.'
        return
      }
      const [srcId, tgtId] = await Promise.all([resolveId(srcConn, srcDb), resolveId(tgtConn, tgtDb)])
      const sys = srcProfile?.system ?? 'postgres'
      const [s, t] = await Promise.all([
        takeSnapshot(srcId, sys, { onProgress: (p) => my === gen && (srcProg = p) }),
        takeSnapshot(tgtId, sys, { onProgress: (p) => my === gen && (tgtProg = p) }),
      ])
      if (my !== gen) return
      const next = compareSchemas(s, t)
      // pre-select every non-identical object AND every changed column
      const keys: string[] = []
      for (const d of next) {
        if (d.status !== 'identical') keys.push(objectKey(d))
        for (const c of d.columns) if (c.status !== 'identical') keys.push(columnKey(d.name, c.name))
      }
      diffs = next
      selected = new Set(keys)
      compared = true
      elapsedMs = performance.now() - t0
      // keep the selected object if it still exists, otherwise focus the first change
      if (!next.some((d) => objectKey(d) === selRow)) selRow = null
    } catch (e) {
      if (my === gen) warn = String(e)
    } finally {
      if (my === gen) loading = false
    }
  }

  // Picks settle (connection → its database list → a database) in quick bursts;
  // wait for the burst to end instead of reading both schemas once per click.
  let timer: ReturnType<typeof setTimeout> | undefined
  $effect(() => {
    void srcConn
    void tgtConn
    void srcDb
    void tgtDb
    untrack(() => {
      clearTimeout(timer)
      timer = setTimeout(() => void compare(), 250)
    })
    return () => clearTimeout(timer)
  })

  function swap() {
    ;[srcConn, tgtConn] = [tgtConn, srcConn]
    ;[srcDb, tgtDb] = [tgtDb, srcDb]
  }

  // ---- list ------------------------------------------------------------------
  const counts = $derived(statusCounts(diffs))
  const changeCount = $derived(counts.src_only + counts.different + counts.tgt_only)
  const kidsMap = $derived.by(() => {
    const m = new Map<string, Children>()
    for (const d of diffs) if (d.kind === 'table') m.set(d.name, childrenOf(diffs, d.name))
    return m
  })
  const NO_KIDS: Children = { indexes: [], triggers: [] }
  const kidsOf = (d: ObjectDiff): Children => (d.kind === 'table' ? (kidsMap.get(d.name) ?? NO_KIDS) : NO_KIDS)
  const groups = $derived(
    LIST_KINDS.map((kind) => ({
      kind,
      items: diffs.filter((d) => d.kind === kind && listed(d, kidsOf(d), filter, query)),
    })).filter((g) => g.items.length > 0),
  )
  let collapsedGroups = $state<Set<ObjectKind>>(new Set())
  function toggleGroup(kind: ObjectKind) {
    const next = new Set(collapsedGroups)
    if (next.has(kind)) next.delete(kind)
    else next.add(kind)
    collapsedGroups = next
  }
  const flatRows = $derived(groups.flatMap((g) => (collapsedGroups.has(g.kind) ? [] : g.items)))

  // ---- selection (check boxes) -----------------------------------------------
  function isChecked(d: ObjectDiff): boolean {
    return selected.has(objectKey(d))
  }
  function setKeys(keys: string[], on: boolean) {
    const next = new Set(selected)
    for (const k of keys) {
      if (on) next.add(k)
      else next.delete(k)
    }
    selected = next
  }
  function toggleObject(d: ObjectDiff) {
    setKeys(keysOf(d, kidsOf(d)), !isChecked(d))
  }
  function toggleKey(k: string) {
    setKeys([k], !selected.has(k))
  }
  const actionable = (list: ObjectDiff[]) => list.filter((d) => d.status !== 'identical')
  function groupState(items: ObjectDiff[]): 'all' | 'some' | 'none' {
    const a = actionable(items)
    if (!a.length) return 'none'
    const n = a.filter(isChecked).length
    return n === a.length ? 'all' : n ? 'some' : 'none'
  }
  function toggleGroupChecks(items: ObjectDiff[]) {
    const on = groupState(items) !== 'all'
    setKeys(actionable(items).flatMap((d) => keysOf(d, kidsOf(d))), on)
  }
  const migration = $derived(srcProfile ? genMigration(diffs, srcProfile.system, selected) : '')
  const hasSql = (s: string) => s.split('\n').some((l) => l.trim() && !l.trim().startsWith('--'))
  const statements = $derived(splitStatements(migration, srcProfile?.system).map((s) => s.sql).filter(hasSql))

  // ---- detail ----------------------------------------------------------------
  let selRow = $state<string | null>(null)
  const detail = $derived(selRow ? (diffs.find((d) => objectKey(d) === selRow) ?? null) : null)
  const detailKids = $derived(detail ? kidsOf(detail) : NO_KIDS)
  const detailScript = $derived(detail ? objectScript(detail, detailKids, system) : '')
  const detailDdl = $derived(detail && (detail.srcDdl != null || detail.tgtDdl != null) ? lineDiff(detail.tgtDdl ?? '', detail.srcDdl ?? '') : [])
  let showSameCols = $state(false)
  const detailCols = $derived(detail ? (showSameCols ? detail.columns : detail.columns.filter((c) => c.status !== 'identical')) : [])
  const sameColCount = $derived(detail ? detail.columns.filter((c) => c.status === 'identical').length : 0)

  function select(d: ObjectDiff) {
    selRow = objectKey(d)
  }
  function step(delta: number) {
    if (!flatRows.length) return
    const i = flatRows.findIndex((d) => objectKey(d) === selRow)
    const next = i < 0 ? 0 : Math.max(0, Math.min(flatRows.length - 1, i + delta))
    select(flatRows[next])
    queueMicrotask(() => document.querySelector(`[data-key="${CSS.escape(objectKey(flatRows[next]))}"]`)?.scrollIntoView({ block: 'nearest' }))
  }
  function onListKey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      step(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      step(-1)
    } else if (e.key === ' ' && detail) {
      e.preventDefault()
      toggleObject(detail)
    }
  }

  // ---- script actions ----------------------------------------------------------
  function openMigration() {
    if (!tgtConn) return
    const t = tabs.openSqlTab({ connectionId: tgtConn, title: 'Migration', query: migration })
    if (tgtDb) {
      t.state.database = tgtDb
      tabs.schedulePersist()
    }
  }
  async function copyScript(sql: string) {
    try {
      await navigator.clipboard.writeText(sql)
      toasts.success('Script copied')
    } catch {
      toasts.error('Copy failed')
    }
  }

  // Apply = run the selected migration on the TARGET, statement by statement,
  // stopping at the first error. Always behind an in-app confirm that names the
  // target and calls out destructive statements.
  let confirmApply = $state(false)
  let applying = $state<{ done: number; total: number } | null>(null)
  let applyError = $state<{ sql: string; message: string } | null>(null)
  const destructive = $derived(destructiveCount(statements))
  const targetLabel = $derived(`${tgtProfile?.name ?? ''}${tgtDb ? ` · ${tgtDb}` : ''}`)

  function askApply() {
    if (!statements.length) {
      toasts.error('Nothing to apply — select at least one change')
      return
    }
    applyError = null
    confirmApply = true
  }
  async function runApply() {
    if (!tgtConn) return
    applyError = null
    applying = { done: 0, total: statements.length }
    try {
      const tid = await resolveId(tgtConn, tgtDb)
      for (const sql of statements) {
        const res = await ipc.execStatement(tid, sql, 0)
        if (!res.ok) {
          applyError = { sql, message: res.error?.message ?? 'Statement failed' }
          break
        }
        applying = { done: applying.done + 1, total: applying.total }
      }
      const done = applying.done
      if (!applyError) {
        confirmApply = false
        toasts.success(`Applied ${done} of ${statements.length} statement(s) to ${targetLabel}`, tgtProfile?.system)
      } else {
        toasts.error(`Stopped after ${done} of ${statements.length} statement(s)`, tgtProfile?.system)
      }
      await compare() // re-read: the list shows what is still different
    } catch (e) {
      applyError = { sql: '', message: String(e) }
    } finally {
      applying = null
    }
  }

  const kindIcon = (k: string) => dbIcon(k === 'procedure' ? 'procedure' : k, 14) ?? ''
  const pct = (p: SnapshotProgress | null) => (p && p.total ? Math.round((p.done / p.total) * 100) : 0)
  const FILTERS: { id: StatusFilter; status?: DiffStatus; label: string; desc: string; hint: string }[] = [
    { id: 'src_only', status: 'src_only', label: 'New', desc: 'in source only · will be created', hint: 'Only in the source — will be created in the target' },
    { id: 'different', status: 'different', label: 'Changed', desc: 'different · will be altered', hint: 'Different on each side — the target will be altered' },
    { id: 'tgt_only', status: 'tgt_only', label: 'Extra', desc: 'in target only · will be dropped', hint: 'Only in the target — will be dropped' },
    { id: 'identical', status: 'identical', label: 'Same', desc: 'identical · nothing to do', hint: 'Identical on both sides' },
  ]
  function pickFilter(id: StatusFilter) {
    filter = filter === id ? 'changes' : id
  }
</script>

<div class="sc">
  <!-- setup -->
  <header class="sc-setup">
    <div class="sc-side">
      <span class="sc-side-label"><span class="sc-badge src">1</span> Source <span class="sc-side-note">— the reference: what it should look like</span></span>
      <div class="sc-side-pick">
        {#if srcProfile}<SystemIcon system={srcProfile.system} size={16} />{/if}
        <SearchSelect bind:value={srcConn} options={connOptions} title="Source connection" placeholder="Pick a connection…" onChange={() => (srcDb = null)} />
        {#if srcDbs.length}<SearchSelect bind:value={srcDb} options={srcDbOptions} title="Source database" />{/if}
      </div>
    </div>
    <button class="sc-swap" onclick={swap} title="Swap source and target" aria-label="Swap source and target">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h14l-4-4"/><path d="M20 16H6l4 4"/></svg>
    </button>
    <div class="sc-side">
      <span class="sc-side-label"><span class="sc-badge tgt">2</span> Target <span class="sc-side-note">— the database that will be changed to match</span></span>
      <div class="sc-side-pick">
        {#if tgtProfile}<SystemIcon system={tgtProfile.system} size={16} />{/if}
        <SearchSelect bind:value={tgtConn} options={connOptions} title="Target connection" placeholder="Pick a connection…" onChange={() => (tgtDb = null)} />
        {#if tgtDbs.length}<SearchSelect bind:value={tgtDb} options={tgtDbOptions} title="Target database" />{/if}
      </div>
    </div>
    <div class="sc-setup-actions">
      <button class="eg-btn" onclick={() => compare()} disabled={loading || !srcConn || !tgtConn} title="Read both schemas again"><Icon name="refresh" size={12} /> Refresh</button>
    </div>
  </header>

  {#if warn}
    <div class="sc-empty">
      <div class="sc-empty-icon warn">!</div>
      <div class="sc-empty-title">Can't compare these two</div>
      <div class="sc-empty-text">{warn}</div>
    </div>
  {:else if !srcConn || !tgtConn}
    <div class="sc-empty">
      <div class="sc-empty-icon">{@html dbIcon('database', 22)}</div>
      <div class="sc-empty-title">Compare two database structures</div>
      <div class="sc-empty-text">Find what is different between two databases of the same engine — for example <b>dev</b> and <b>production</b> — and update one so it matches the other. Only the structure is compared (tables, columns, indexes, views, routines); <b>data is never compared or copied</b>.</div>
      <ol class="sc-steps">
        <li><span class="sc-badge src">1</span><span><b>Source</b> — the database that is already right (your reference).</span></li>
        <li><span class="sc-badge tgt">2</span><span><b>Target</b> — the database you want to bring in line. Only this one can change.</span></li>
        <li><span class="sc-badge">3</span><span>Review the differences, untick what you want to keep as it is, then <b>Apply to target</b> — or open the script and run it yourself.</span></li>
      </ol>
    </div>
  {:else if loading}
    <div class="sc-empty" aria-busy="true">
      <div class="sc-empty-title">Reading both schemas…</div>
      <div class="sc-progress">
        {#each [['Source', srcProfile?.name, srcProg], ['Target', tgtProfile?.name, tgtProg]] as [side, name, p] (side)}
          {@const prog = p as SnapshotProgress | null}
          <div class="sc-prog-row">
            <span class="sc-prog-side">{side}</span>
            <span class="sc-prog-name">{name}</span>
            <div class="sc-prog-bar"><span style="width:{pct(prog)}%"></span></div>
            <span class="sc-prog-num">{prog && prog.total ? `${prog.done}/${prog.total}` : '…'}</span>
          </div>
        {/each}
      </div>
    </div>
  {:else if compared}
    <!-- summary -->
    <div class="sc-summary">
      {#each FILTERS as f (f.id)}
        <button class="sc-card t-{STATUS[f.status!].tone}" aria-pressed={filter === f.id} title={f.hint} onclick={() => pickFilter(f.id)}>
          <span class="sc-card-num">{counts[f.status!]}</span>
          <span class="sc-card-text"><span class="sc-card-label">{f.label}</span><span class="sc-card-desc" aria-hidden="true">{f.desc}</span></span>
        </button>
      {/each}
      <div class="sc-summary-note">
        {#if changeCount === 0}
          <span class="sc-ok">✓ The structures are identical</span>
        {:else}
          {changeCount} {changeCount === 1 ? 'difference' : 'differences'} · compared in {(elapsedMs / 1000).toFixed(1)} s
        {/if}
      </div>
    </div>

    <!-- view switch + actions -->
    <div class="sc-bar">
      <div class="sc-seg" role="group" aria-label="View">
        <button aria-pressed={mode === 'diff'} onclick={() => (mode = 'diff')}>Differences</button>
        <button aria-pressed={mode === 'sync'} onclick={() => (mode = 'sync')}>Sync script</button>
      </div>
      <span class="sc-bar-note" title="Ticked changes go into the script. Nothing is changed on the target until you click Apply to target.">{statements.length} {statements.length === 1 ? 'statement' : 'statements'} from {selected.size} selected {selected.size === 1 ? 'change' : 'changes'} · <span class="sc-bar-hint">nothing changes until you click Apply</span></span>
      <div class="sc-bar-actions">
        <button class="eg-btn" onclick={openMigration} disabled={!statements.length} title="Open the script in a SQL editor tab on the target">Open script</button>
        <button class="eg-btn primary" onclick={askApply} disabled={!statements.length || !!applying} title="Run the selected changes on {targetLabel}">Apply to target</button>
      </div>
    </div>

    {#if mode === 'diff'}
      <div class="sc-main">
        <!-- list -->
        <section class="sc-list" aria-label="Objects">
          <div class="sc-list-tools">
            <span class="sc-search"><Icon name="search" size={12} /><input bind:value={query} placeholder="Filter objects…" aria-label="Filter objects" /></span>
            <label class="sc-check-label"><input type="checkbox" checked={filter === 'all'} onchange={(e) => (filter = (e.currentTarget as HTMLInputElement).checked ? 'all' : 'changes')} /> Show identical</label>
          </div>
          <div class="sc-list-body" role="listbox" tabindex="0" aria-label="Compared objects" onkeydown={onListKey}>
            {#if groups.length === 0}
              <div class="sc-list-empty">{changeCount === 0 && filter === 'changes' ? 'Nothing to sync — turn on “Show identical” to browse every object.' : 'No object matches this filter.'}</div>
            {/if}
            {#each groups as g (g.kind)}
              {@const open = !collapsedGroups.has(g.kind)}
              {@const gs = groupState(g.items)}
              <div class="sc-group">
                <button class="sc-group-chev" onclick={() => toggleGroup(g.kind)} aria-label={open ? 'Collapse' : 'Expand'}><Chevron {open} size={11} /></button>
                <input type="checkbox" title="Select all {KIND_LABEL[g.kind].many}" checked={gs === 'all'} indeterminate={gs === 'some'} disabled={!actionable(g.items).length} onchange={() => toggleGroupChecks(g.items)} />
                <span class="sc-kind k-{g.kind}">{@html kindIcon(g.kind)}</span>
                <span class="sc-group-label">{KIND_LABEL[g.kind].many}</span>
                <span class="sc-group-count">{g.items.length}</span>
              </div>
              {#if open}
                {#each g.items as d (objectKey(d))}
                  {@const key = objectKey(d)}
                  {@const sm = STATUS[d.status]}
                  {@const summary = changeSummary(d, kidsOf(d))}
                  <div
                    class="cmp-row t-{sm.tone}"
                    class:sel={selRow === key}
                    data-key={key}
                    role="option"
                    aria-selected={selRow === key}
                    tabindex="-1"
                    onclick={() => select(d)}
                    onkeydown={() => {}}
                  >
                    <input type="checkbox" checked={isChecked(d)} disabled={d.status === 'identical' && !summary} title="Include in the script" onclick={(e) => e.stopPropagation()} onchange={() => toggleObject(d)} />
                    <span class="sc-kind k-{d.kind}">{@html kindIcon(d.kind)}</span>
                    <span class="sc-row-text">
                      <span class="sc-row-name">{d.name}</span>
                      {#if summary}<span class="sc-row-sub">{summary}</span>{/if}
                    </span>
                    <span class="sc-pill t-{sm.tone}">{sm.label}</span>
                  </div>
                {/each}
              {/if}
            {/each}
          </div>
        </section>

        <!-- detail -->
        <section class="sc-detail" aria-label="Details">
          {#if !detail}
            <div class="sc-detail-empty">
              <div class="sc-empty-title">Select an object</div>
              <div class="sc-empty-text">Its differences and the exact script it needs show here. Use ↑ ↓ to move through the list and Space to include or exclude it.</div>
            </div>
          {:else}
            {@const sm = STATUS[detail.status]}
            <div class="sc-detail-head">
              <span class="sc-kind k-{detail.kind}">{@html kindIcon(detail.kind)}</span>
              <span class="sc-detail-kind">{KIND_LABEL[detail.kind].one}</span>
              <span class="sc-detail-name">{detail.name}</span>
              <span class="sc-pill t-{sm.tone}">{sm.label}</span>
              <span class="sc-detail-nav">
                <button class="sc-icon-btn" onclick={() => step(-1)} title="Previous object (↑)" aria-label="Previous object">◀ Prev</button>
                <button class="sc-icon-btn" onclick={() => step(1)} title="Next object (↓)" aria-label="Next object">Next ▶</button>
              </span>
            </div>
            <div class="sc-detail-action t-{sm.tone}">{sm.action}</div>

            {#if detail.columns.length}
              <div class="sc-sec-head">
                <span>Columns</span>
                {#if sameColCount}<label class="sc-check-label"><input type="checkbox" bind:checked={showSameCols} /> Show {sameColCount} unchanged</label>{/if}
              </div>
              <table class="sc-table">
                <thead><tr><th class="c-chk"></th><th>Column</th><th>Source · {srcProfile?.name}</th><th>Target · {tgtProfile?.name}</th><th class="c-st"></th></tr></thead>
                <tbody>
                  {#each detailCols as c (c.name)}
                    {@const csm = STATUS[c.status]}
                    {@const ck = columnKey(detail.name, c.name)}
                    <tr class="t-{csm.tone}">
                      <td class="c-chk"><input type="checkbox" title="Include this column change" checked={c.status === 'identical' ? false : detail.status === 'different' ? selected.has(ck) : isChecked(detail)} disabled={c.status === 'identical' || detail.status !== 'different'} onchange={() => toggleKey(ck)} /></td>
                      <td class="mono">{c.name}</td>
                      <td class="mono">{c.srcType ?? '—'}</td>
                      <td class="mono">{c.tgtType ?? '—'}</td>
                      <td class="c-st"><span class="sc-pill t-{csm.tone}">{csm.label}</span></td>
                    </tr>
                  {/each}
                  {#if detailCols.length === 0}
                    <tr><td colspan="5" class="sc-muted">All {detail.columns.length} columns are the same.</td></tr>
                  {/if}
                </tbody>
              </table>
            {/if}

            {#each [['Indexes', detailKids.indexes], ['Triggers', detailKids.triggers]] as [label, list] (label)}
              {@const items = list as ObjectDiff[]}
              {#if items.length}
                <div class="sc-sec-head"><span>{label}</span></div>
                <table class="sc-table">
                  <tbody>
                    {#each items as k (objectKey(k))}
                      {@const ksm = STATUS[k.status]}
                      <tr class="t-{ksm.tone}" class:click={k.kind === 'trigger'} onclick={() => k.kind === 'trigger' && select(k)}>
                        <td class="c-chk"><input type="checkbox" title="Include in the script" checked={selected.has(objectKey(k))} disabled={k.status === 'identical'} onclick={(e) => e.stopPropagation()} onchange={() => toggleKey(objectKey(k))} /></td>
                        <td class="mono">{k.name}</td>
                        <td class="sc-muted">{k.kind === 'index' ? `${k.idxUnique ? 'unique · ' : ''}(${(k.idxColumns ?? []).join(', ')})` : 'View definition ›'}</td>
                        <td class="c-st"><span class="sc-pill t-{ksm.tone}">{ksm.label}</span></td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              {/if}
            {/each}

            {#if detailDdl.length}
              <div class="sc-sec-head"><span>Definition</span><span class="sc-muted">removed lines are red, added lines are green</span></div>
              <div class="sc-ddl">
                <div class="sc-ddl-head"><span>Target · {tgtProfile?.name}</span><span>Source · {srcProfile?.name}</span></div>
                {#each detailDdl as l, i (i)}
                  <div class="sc-ddl-line">
                    <div class="mono" class:del={l.type === 'del'}>{l.type !== 'add' ? l.text : ''}</div>
                    <div class="mono" class:add={l.type === 'add'}>{l.type !== 'del' ? l.text : ''}</div>
                  </div>
                {/each}
              </div>
            {/if}

            <div class="sc-sec-head">
              <span>Script for this object</span>
              {#if detailScript}<button class="sc-link" onclick={() => copyScript(detailScript)}><Icon name="copy" size={11} /> Copy</button>{/if}
            </div>
            {#if detailScript}
              <CodeView value={detailScript} language={editorLanguageId(system)} readOnly height="auto" maxHeight={260} minHeight={40} ariaLabel="Object script" />
            {:else}
              <div class="sc-muted sc-pad">Nothing to run — this object already matches.</div>
            {/if}
          {/if}
        </section>
      </div>
    {:else}
      <div class="sc-script">
        <CodeView value={migration} language={editorLanguageId(system)} readOnly height="100%" ariaLabel="Migration script" />
      </div>
    {/if}
  {/if}
</div>

{#if confirmApply}
  <!-- in-app confirm — backdrop does not close it (form dialog rule) -->
  <div class="sc-modal-bg" role="presentation" onkeydown={(e) => e.key === 'Escape' && !applying && (confirmApply = false)}>
    <div class="sc-modal" role="dialog" aria-modal="true" aria-label="Apply changes to the target">
      <div class="sc-modal-title">Apply {statements.length} {statements.length === 1 ? 'statement' : 'statements'} to {targetLabel}?</div>
      <div class="sc-modal-text">The selected changes run on the <b>target</b> in order and stop at the first error. Review the Sync script first if you are unsure.</div>
      {#if destructive}
        <div class="sc-modal-warn">⚠ {destructive} {destructive === 1 ? 'statement drops' : 'statements drop'} a table or column — the data in it is lost.</div>
      {/if}
      {#if applying}
        <div class="sc-prog-row">
          <span class="sc-prog-side">Applying</span>
          <div class="sc-prog-bar"><span style="width:{Math.round((applying.done / applying.total) * 100)}%"></span></div>
          <span class="sc-prog-num">{applying.done}/{applying.total}</span>
        </div>
      {/if}
      {#if applyError}
        <div class="sc-modal-error">
          <div><b>Failed:</b> {applyError.message}</div>
          {#if applyError.sql}<pre class="mono selectable">{applyError.sql}</pre>{/if}
        </div>
      {/if}
      <div class="sc-modal-actions">
        <button class="eg-btn" onclick={() => (confirmApply = false)} disabled={!!applying}>{applyError ? 'Close' : 'Cancel'}</button>
        <button class="eg-btn primary" onclick={runApply} disabled={!!applying}>{applying ? 'Applying…' : applyError ? 'Retry' : 'Apply'}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .sc {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--bg);
  }
  .t-new { --tone: var(--sacc-green); }
  .t-changed { --tone: var(--sacc-amber); }
  .t-extra { --tone: var(--sacc-red); }
  .t-same { --tone: var(--muted); }

  /* setup */
  .sc-setup {
    flex: none;
    display: flex;
    align-items: flex-end;
    gap: var(--px-12);
    padding: var(--px-12) var(--px-16);
    background: var(--surface);
    border-bottom: var(--px-1) solid var(--border);
    flex-wrap: wrap;
  }
  .sc-side { display: flex; flex-direction: column; gap: var(--px-5); min-width: 0; }
  .sc-side-label { display: inline-flex; align-items: center; gap: var(--px-6); font-size: var(--px-12); font-weight: 600; color: var(--text); }
  .sc-side-note { font-weight: 400; color: var(--muted); }
  .sc-side-pick { display: flex; align-items: center; gap: var(--px-8); }
  .sc-swap {
    display: inline-flex; align-items: center; justify-content: center;
    width: var(--px-30); height: var(--px-30); margin-bottom: var(--px-1);
    border: var(--px-1) solid var(--border2); border-radius: 50%;
    background: var(--raised); color: var(--text2); cursor: pointer;
  }
  .sc-swap:hover { color: var(--primary); border-color: var(--primary); }
  .sc-setup-actions { margin-left: auto; display: flex; gap: var(--px-8); }

  /* empty / loading */
  .sc-empty {
    flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: var(--px-8); padding: var(--px-30); text-align: center;
  }
  .sc-empty-icon {
    display: inline-flex; align-items: center; justify-content: center;
    width: var(--px-44); height: var(--px-44); border-radius: 50%;
    color: var(--primary); background: color-mix(in srgb, var(--primary) 12%, transparent);
    font-weight: 700; font-size: var(--px-20);
  }
  .sc-empty-icon.warn { color: var(--sacc-amber); background: color-mix(in srgb, var(--sacc-amber) 14%, transparent); }
  .sc-empty-title { font-size: var(--px-15); font-weight: 600; color: var(--text); }
  .sc-empty-text { max-width: var(--px-520); font-size: var(--px-12_5); color: var(--text2); line-height: 1.55; }
  .sc-progress { display: flex; flex-direction: column; gap: var(--px-8); width: min(100%, var(--px-520)); margin-top: var(--px-6); }
  .sc-prog-row { display: flex; align-items: center; gap: var(--px-10); font-size: var(--px-12); }
  .sc-prog-side { flex: none; width: var(--px-54); text-align: left; font-weight: 600; color: var(--text2); }
  .sc-prog-name { flex: none; width: var(--px-140); text-align: left; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sc-prog-bar { flex: 1; height: var(--px-6); border-radius: var(--px-3); background: var(--panel); overflow: hidden; }
  .sc-prog-bar > span { display: block; height: 100%; background: var(--primary); border-radius: var(--px-3); transition: width 0.2s ease; }
  .sc-prog-num { flex: none; width: var(--px-60); text-align: right; color: var(--muted); font-variant-numeric: tabular-nums; }

  /* summary */
  .sc-summary {
    flex: none; display: flex; align-items: center; gap: var(--px-10);
    padding: var(--px-12) var(--px-16) var(--px-4);
  }
  .sc-card {
    display: flex; align-items: center; gap: var(--px-10);
    min-width: var(--px-110); padding: var(--px-8) var(--px-14);
    border: var(--px-1) solid var(--border); border-left: var(--px-3) solid var(--tone);
    border-radius: var(--px-8); background: var(--raised); cursor: pointer;
    box-shadow: var(--shadow-xs); font: inherit; text-align: left;
  }
  .sc-card:hover { border-color: color-mix(in srgb, var(--tone) 50%, var(--border)); border-left-color: var(--tone); }
  .sc-card[aria-pressed='true'] { background: color-mix(in srgb, var(--tone) 10%, var(--raised)); border-color: var(--tone); }
  .sc-card-num { font-size: var(--px-20); font-weight: 600; color: var(--text); font-variant-numeric: tabular-nums; }
  .sc-card-label { font-size: var(--px-12); font-weight: 600; color: var(--tone); }
  .sc-summary-note { margin-left: auto; font-size: var(--px-12); color: var(--muted); }
  .sc-ok { color: var(--sacc-green); font-weight: 600; }

  .sc-bar {
    flex: none; display: flex; align-items: center; gap: var(--px-12);
    padding: var(--px-8) var(--px-16); border-bottom: var(--px-1) solid var(--border);
  }
  .sc-seg { display: inline-flex; padding: var(--px-2); border-radius: var(--px-7); background: var(--panel); border: var(--px-1) solid var(--border); }
  .sc-seg button {
    border: none; background: transparent; color: var(--text2); font: inherit; font-size: var(--px-12);
    font-weight: 500; padding: var(--px-4) var(--px-12); border-radius: var(--px-5); cursor: pointer;
  }
  .sc-seg button[aria-pressed='true'] { background: var(--raised); color: var(--text); font-weight: 600; box-shadow: var(--shadow-xs); }
  .sc-bar-note { font-size: var(--px-12); color: var(--muted); }
  .sc-bar-hint { color: var(--text2); }
  .sc-card-text { display: flex; flex-direction: column; gap: var(--px-1); }
  .sc-card-desc { font-size: var(--px-11); color: var(--muted); white-space: nowrap; }
  .sc-badge {
    display: inline-flex; align-items: center; justify-content: center; flex: none;
    width: var(--px-17); height: var(--px-17); border-radius: 50%;
    font-size: var(--px-10_5); font-weight: 700; color: var(--hex-fff); background: var(--muted);
  }
  .sc-badge.src { background: var(--primary); }
  .sc-badge.tgt { background: var(--sacc-amber); }
  .sc-steps { list-style: none; margin: var(--px-10) 0 0; padding: 0; display: flex; flex-direction: column; gap: var(--px-10); text-align: left; max-width: var(--px-520); }
  .sc-steps li { display: flex; gap: var(--px-10); align-items: flex-start; font-size: var(--px-12_5); color: var(--text2); line-height: 1.5; }
  .sc-steps .sc-badge { margin-top: var(--px-2); }
  .sc-bar-actions { margin-left: auto; display: flex; gap: var(--px-8); }

  /* list + detail */
  .sc-main { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(var(--px-300), 42%) minmax(0, 1fr); }
  .sc-list { display: flex; flex-direction: column; min-height: 0; border-right: var(--px-1) solid var(--border); background: var(--surface); }
  .sc-list-tools { flex: none; display: flex; align-items: center; gap: var(--px-10); padding: var(--px-8) var(--px-12); border-bottom: var(--px-1) solid var(--border); }
  .sc-search {
    flex: 1; display: flex; align-items: center; gap: var(--px-6); min-width: 0;
    padding: var(--px-4) var(--px-8); border: var(--px-1) solid var(--border2); border-radius: var(--px-6);
    background: var(--raised); color: var(--muted);
  }
  .sc-search input { flex: 1; min-width: 0; border: none; outline: none; background: transparent; color: var(--text); font: inherit; font-size: var(--px-12); }
  .sc-check-label { display: inline-flex; align-items: center; gap: var(--px-5); font-size: var(--px-11_5); font-weight: 400; color: var(--text2); cursor: pointer; white-space: nowrap; }
  .sc-list-body { flex: 1; min-height: 0; overflow: auto; outline: none; padding-bottom: var(--px-10); }
  .sc-list-empty { padding: var(--px-20) var(--px-16); font-size: var(--px-12); color: var(--muted); }
  .sc-group {
    position: sticky; top: 0; z-index: 1;
    display: flex; align-items: center; gap: var(--px-7);
    padding: var(--px-6) var(--px-12); background: var(--header);
    border-bottom: var(--px-1) solid var(--border);
  }
  .sc-group-chev { display: inline-flex; border: none; background: transparent; color: var(--muted); cursor: pointer; padding: 0; }
  .sc-group-label { font-size: var(--px-12); font-weight: 600; color: var(--text); }
  .sc-group-count { font-size: var(--px-11); color: var(--muted); font-variant-numeric: tabular-nums; }
  .sc-kind { flex: none; display: inline-flex; }
  .k-table { color: var(--sacc-blue); }
  .k-view { color: var(--sacc-purple); }
  .k-procedure { color: var(--sacc-orange); }
  .k-function { color: var(--sacc-yellow); }
  .k-trigger { color: var(--sacc-red); }
  .k-sequence { color: var(--sacc-cyan); }
  .k-index { color: var(--sacc-green); }
  .cmp-row {
    display: flex; align-items: center; gap: var(--px-8);
    padding: var(--px-6) var(--px-12) var(--px-6) var(--px-30);
    border-left: var(--px-3) solid transparent; cursor: pointer;
  }
  .cmp-row:not(.t-same) { border-left-color: color-mix(in srgb, var(--tone) 70%, transparent); }
  .cmp-row:not(.sel):hover { background: color-mix(in srgb, var(--primary) 8%, transparent); }
  .cmp-row.sel { background: color-mix(in srgb, var(--primary) 16%, transparent); }
  .sc-row-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .sc-row-name { font-size: var(--px-12_5); font-weight: 500; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .t-same .sc-row-name { color: var(--text2); font-weight: 400; }
  .sc-row-sub { font-size: var(--px-11); color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sc-pill {
    flex: none; font-size: var(--px-10_5); font-weight: 600; color: var(--tone);
    background: color-mix(in srgb, var(--tone) 13%, transparent);
    border-radius: var(--px-10); padding: var(--px-1) var(--px-8);
  }

  .sc-detail { min-width: 0; min-height: 0; overflow: auto; padding: var(--px-14) var(--px-18) var(--px-20); }
  .sc-detail-empty { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--px-6); text-align: center; }
  .sc-detail-head { display: flex; align-items: center; gap: var(--px-8); }
  .sc-detail-kind { font-size: var(--px-11_5); color: var(--muted); }
  .sc-detail-name { font-size: var(--px-15); font-weight: 600; color: var(--text); overflow-wrap: anywhere; }
  .sc-detail-nav { margin-left: auto; display: flex; gap: var(--px-4); }
  .sc-icon-btn {
    border: var(--px-1) solid var(--border); background: var(--raised); color: var(--text2);
    font: inherit; font-size: var(--px-11_5); border-radius: var(--px-6); padding: var(--px-3) var(--px-9); cursor: pointer;
  }
  .sc-icon-btn:hover { color: var(--text); border-color: var(--border2); }
  .sc-detail-action {
    margin-top: var(--px-8); padding: var(--px-7) var(--px-12); border-radius: var(--px-7);
    font-size: var(--px-12); color: var(--text);
    background: color-mix(in srgb, var(--tone) 9%, var(--raised));
    border: var(--px-1) solid color-mix(in srgb, var(--tone) 28%, var(--border));
  }
  .sc-sec-head {
    display: flex; align-items: center; justify-content: space-between; gap: var(--px-10);
    margin: var(--px-16) 0 var(--px-6); font-size: var(--px-12_5); font-weight: 600; color: var(--text);
  }
  .sc-table { width: 100%; border-collapse: collapse; font-size: var(--px-12); background: var(--raised); border: var(--px-1) solid var(--border); border-radius: var(--px-8); overflow: hidden; }
  .sc-table th { text-align: left; font-weight: 500; font-size: var(--px-11); color: var(--muted); padding: var(--px-6) var(--px-10); background: var(--header); border-bottom: var(--px-1) solid var(--border); }
  .sc-table td { padding: var(--px-5) var(--px-10); border-bottom: var(--px-1) solid var(--border); color: var(--text); }
  .sc-table tr:last-child td { border-bottom: none; }
  .sc-table tr.click { cursor: pointer; }
  .sc-table tr.click:hover td { background: color-mix(in srgb, var(--primary) 7%, transparent); }
  .sc-table tr.t-same td { color: var(--text2); }
  .c-chk { width: var(--px-28); }
  .c-st { width: var(--px-80); text-align: right; }
  .sc-muted { color: var(--muted); font-size: var(--px-11_5); font-weight: 400; }
  .sc-pad { padding: var(--px-6) 0; }
  .sc-link { display: inline-flex; align-items: center; gap: var(--px-4); border: none; background: transparent; color: var(--primary); font: inherit; font-size: var(--px-11_5); cursor: pointer; }
  .sc-ddl { border: var(--px-1) solid var(--border); border-radius: var(--px-8); overflow: hidden; background: var(--raised); font-size: var(--px-12); line-height: 1.55; }
  .sc-ddl-head { display: grid; grid-template-columns: 1fr 1fr; font-size: var(--px-11); color: var(--muted); background: var(--header); border-bottom: var(--px-1) solid var(--border); }
  .sc-ddl-head span { padding: var(--px-5) var(--px-10); }
  .sc-ddl-head span + span { border-left: var(--px-1) solid var(--border); }
  .sc-ddl-line { display: grid; grid-template-columns: 1fr 1fr; }
  .sc-ddl-line > div { padding: 0 var(--px-10); white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text2); }
  .sc-ddl-line > div + div { border-left: var(--px-1) solid var(--border); }
  .sc-ddl-line .del { background: color-mix(in srgb, var(--sacc-red) 12%, transparent); color: var(--sacc-red); }
  .sc-ddl-line .add { background: color-mix(in srgb, var(--sacc-green) 12%, transparent); color: var(--sacc-green); }
  .sc-script { flex: 1; min-height: 0; overflow: auto; background: var(--bg); }

  /* confirm */
  .sc-modal-bg { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; background: color-mix(in srgb, var(--bg) 40%, transparent); }
  .sc-modal {
    width: min(92vw, var(--px-520)); padding: var(--px-18) var(--px-20);
    background: var(--surface); border: var(--px-1) solid var(--border2); border-radius: var(--px-12);
    box-shadow: var(--shadow-lg); display: flex; flex-direction: column; gap: var(--px-10);
  }
  .sc-modal-title { font-size: var(--px-15); font-weight: 600; color: var(--text); }
  .sc-modal-text { font-size: var(--px-12_5); color: var(--text2); line-height: 1.5; }
  .sc-modal-warn { font-size: var(--px-12); color: var(--sacc-amber); background: color-mix(in srgb, var(--sacc-amber) 10%, transparent); border-radius: var(--px-7); padding: var(--px-7) var(--px-10); }
  .sc-modal-error { font-size: var(--px-12); color: var(--error); background: color-mix(in srgb, var(--error) 8%, transparent); border-radius: var(--px-7); padding: var(--px-7) var(--px-10); }
  .sc-modal-error pre { margin: var(--px-6) 0 0; white-space: pre-wrap; color: var(--text); font-size: var(--px-11_5); max-height: var(--px-120); overflow: auto; }
  .sc-modal-actions { display: flex; justify-content: flex-end; gap: var(--px-8); margin-top: var(--px-4); }
</style>
