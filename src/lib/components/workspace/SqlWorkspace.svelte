<script lang="ts">
  // SQL editor workspace for one tab: toolbar (connection dropdown + Run/Cancel)
  // + CodeMirror + resizable split + result panel. Run is selection-aware (F5),
  // Ctrl+Enter runs the statement at the cursor.
  import SqlEditor from '$lib/components/editor/SqlEditor.svelte'
  import SqliteFileHeader from './SqliteFileHeader.svelte'
  import ResultPanel from '$lib/components/results/ResultPanel.svelte'
  import SystemBadge from '$lib/components/SystemBadge.svelte'
  import SystemIcon from '$lib/components/SystemIcon.svelte'
  import { systemMeta } from '$lib/systems'
  import { connections } from '$lib/stores/connections.svelte'
  import { results } from '$lib/stores/results.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { settings } from '$lib/stores/settings.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { ui } from '$lib/stores/ui.svelte'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { snippets } from '$lib/stores/snippets.svelte'
  import { formatSql } from '$lib/sql/format'
  import { mapErrorToDocument } from '$lib/sql/errors'
  import { lintSql, schemaLints, toCmDiagnostics } from '$lib/sql/lint-client'
  import { splitStatements, statementAtOffset } from '$lib/sql/statements'
  import type { TabState } from '$lib/types'
  import type { Diagnostic } from '@codemirror/lint'
  import { untrack } from 'svelte'

  interface Props {
    tab: TabState
  }

  let { tab }: Props = $props()

  let editor = $state<SqlEditor | null>(null)
  let connDropOpen = $state(false)
  const exec = $derived(results.get(tab.id))
  const profile = $derived(connections.byId(tab.connectionId))
  const isOrphan = $derived(tab.systemType === 'orphan' || (!!tab.connectionId && !profile))
  const disconnected = $derived(!!profile && !profile.connected)

  // initial buffer from persisted tab state (component remounts per tab via {#key})
  // svelte-ignore state_referenced_locally
  const initialQuery = (tab.state.query as string) ?? ''
  let savedQuery = initialQuery

  // ---- autocomplete schema (phase-2 §1): nạp schema + bảng của connection ----
  // untrack: loadSchemas() ghi explorer.cache đồng bộ (conn()/track()) → nếu để
  // trong vùng track của effect sẽ read+write cùng $state → effect_update_depth.
  $effect(() => {
    const p = profile
    if (p?.connected) {
      untrack(() => {
        void explorer.loadSchemas(p.id).then(() => {
          const schemas = explorer.cache[p.id]?.schemas ?? []
          const def = schemas.find((s) => s.is_default) ?? schemas[0]
          if (def) void explorer.loadSchemaChildren(p.id, def.name)
        })
      })
    }
  })

  /** { table: [cols], schema.table: [cols] } cho lang-sql completion */
  const completionSchema = $derived.by(() => {
    if (!profile) return undefined
    const cache = explorer.cache[profile.id]
    if (!cache) return undefined
    const out: Record<string, string[]> = {}
    for (const [schemaName, sc] of Object.entries(cache.bySchema)) {
      for (const t of sc.tables ?? []) {
        const cols = sc.tableDetails[t.name]?.columns?.map((c) => c.name) ?? []
        out[t.name] = cols
        out[`${schemaName}.${t.name}`] = cols
      }
    }
    return Object.keys(out).length > 0 ? out : undefined
  })

  const defaultSchema = $derived.by(() => {
    if (!profile) return undefined
    const schemas = explorer.cache[profile.id]?.schemas ?? []
    return (schemas.find((s) => s.is_default) ?? schemas[0])?.name
  })

  const knownTables = $derived.by(() => {
    if (!profile) return []
    const cache = explorer.cache[profile.id]
    if (!cache) return []
    return Object.values(cache.bySchema).flatMap((sc) => (sc.tables ?? []).map((t) => t.name))
  })

  // ---- lint tầng 1 (phase-2 §2b): backend parse-only + schema-aware client ----
  async function lintDoc(doc: string): Promise<Diagnostic[]> {
    if (!tab.connectionId || isOrphan) return []
    const backend = await lintSql(tab.systemType, doc)
    return [...toCmDiagnostics(doc, backend), ...schemaLints(doc, knownTables)]
  }

  function onChange(doc: string) {
    tab.state.query = doc
    tabs.setDirty(tab.id, doc !== savedQuery)
    tabs.schedulePersist()
  }

  async function run() {
    if (!editor || !tab.connectionId) {
      if (!tab.connectionId) toasts.error('Tab chưa gắn connection — chọn ở dropdown toolbar')
      return
    }
    editor.clearErrors()
    const doc = editor.getDoc()
    const range = editor.getSelectionRange()
    // Selection → run only the statement(s) overlapping it; else run all.
    // Statements are always split from the full document so error positions
    // stay document-accurate.
    const all = splitStatements(doc)
    const statements =
      range.from === range.to
        ? all
        : all.filter((s) => s.to > range.from && s.from < range.to)
    if (statements.length === 0) {
      toasts.show('Không có statement nào để chạy')
      return
    }
    await results.run(tab.id, tab.connectionId, statements)
    showExecErrors()
  }

  async function runAtCursor() {
    if (!editor || !tab.connectionId) return
    editor.clearErrors()
    const doc = editor.getDoc()
    const stmt = statementAtOffset(doc, editor.getCursorOffset())
    if (!stmt) return
    await results.run(tab.id, tab.connectionId, [stmt])
    showExecErrors()
  }

  function showExecErrors() {
    const e = results.get(tab.id)
    if (!e || !editor) return
    const errs = e.subResults
      .filter((s) => s.kind === 'error' && s.error && s.error.code !== 'CANCELLED')
      .map((s) => {
        const pos = mapErrorToDocument(s.statement, s.error!)
        // statement-level errors highlight the whole statement
        const stmtLines = s.statement.sql.split('\n')
        const endLine = s.statement.startLine + stmtLines.length - 1
        const endCol =
          stmtLines.length === 1
            ? s.statement.startCol + stmtLines[0].length
            : stmtLines[stmtLines.length - 1].length + 1
        return s.error!.position
          ? { line: pos.line, col: pos.col, message: s.error!.message }
          : { line: pos.line, col: pos.col, endLine, endCol, message: s.error!.message }
      })
    if (errs.length > 0) editor.showErrors(errs)
  }

  function cancel() {
    if (tab.connectionId) void results.cancel(tab.id, tab.connectionId)
  }

  // Convert (T12, min §10): chuẩn hóa/format SQL cho dialect hiện tại rồi mở
  // trong tab mới kèm ghi chú (không phải dịch cross-dialect đầy đủ).
  function doConvert() {
    if (!editor) return
    const doc = editor.getDoc().trim()
    if (!doc) return
    const formatted = formatSql(tab.systemType, doc)
    const note = `-- Converted / normalized for ${tab.systemType} (formatting only — review dialect-specific syntax)\n`
    tabs.openSqlTab({ connectionId: tab.connectionId, title: 'Converted', query: note + formatted })
  }

  // Split (T12): mở editor sang pane thứ 2 (dùng cơ chế split có sẵn).
  function doSplit() {
    tabs.moveToSplit(tab.id, 'v')
  }

  // Đồng hồ "running Ns" + cảnh báo query chạy lâu (> ngưỡng Settings) — T11.
  let nowMs = $state(Date.now())
  let longRunWarned = $state(false)
  const runningSecs = $derived(
    exec?.running && exec.startedAt ? Math.max(0, Math.floor((nowMs - exec.startedAt) / 1000)) : 0,
  )
  $effect(() => {
    if (!exec?.running) {
      longRunWarned = false
      return
    }
    const iv = setInterval(() => {
      nowMs = Date.now()
      if (!longRunWarned && exec.startedAt && nowMs - exec.startedAt > settings.value.longRunningWarnMs) {
        longRunWarned = true
        toasts.show(`Query vẫn đang chạy > ${Math.round(settings.value.longRunningWarnMs / 1000)}s — Esc để hủy`)
      }
    }, 500)
    return () => clearInterval(iv)
  })

  // Format SQL (Ctrl+Shift+F) — dialect-aware, giữ 1 transaction để undo
  function doFormat() {
    if (!editor) return
    const doc = editor.getDoc()
    const formatted = formatSql(tab.systemType, doc)
    if (formatted !== doc) editor.setDoc(formatted)
  }

  // Explain (Ctrl+Shift+E) — Phase 5: mở Query Plan Visualizer (cây chuẩn hóa).
  function doExplain() {
    if (!editor || !tab.connectionId) return
    const doc = editor.getDoc()
    const stmt = statementAtOffset(doc, editor.getCursorOffset())
    if (!stmt) return
    tabs.openQueryPlan(tab.connectionId, stmt.sql)
  }

  // Ctrl+S — lưu nội dung editor thành snippet (Saved Queries)
  async function saveSnippet() {
    if (!editor) return
    const sqlText = editor.getDoc().trim()
    if (!sqlText) return
    const name = window.prompt('Tên snippet:', tab.title)
    if (!name) return
    await snippets.save(name, sqlText, tab.systemType === 'orphan' ? null : tab.systemType)
    toasts.success(`Đã lưu snippet "${name}"`)
  }

  function jump(line: number, col: number) {
    editor?.jumpTo(line, col)
  }

  // ---- editor/result resizable split ----
  let container = $state<HTMLDivElement | null>(null)
  let dragging = $state(false)

  function startDrag(e: PointerEvent) {
    dragging = true
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
  }

  function onDrag(e: PointerEvent) {
    if (!dragging || !container) return
    const rect = container.getBoundingClientRect()
    const h = Math.min(Math.max(e.clientY - rect.top, 120), rect.height - 100)
    ui.editorHeight = h
    ui.persistSizes()
  }
</script>

<div style="flex:1;display:flex;flex-direction:column;min-height:0" bind:this={container}>
  {#if isOrphan}
    <!-- orphaned banner — spec phase-1 §3 (badge xám ⚠ + Reassign) -->
    <div style="flex:none;display:flex;align-items:center;gap:var(--px-8);padding:var(--px-6) var(--px-12);border-bottom:var(--px-1) solid var(--border);background:var(--panel);font-size:var(--px-12)">
      <SystemBadge system="orphan" />
      <span style="color:var(--text2)">Connection đã bị xóa · tab ở trạng thái orphaned</span>
      <div style="margin-left:auto">
        <select
          class="wk-select"
          onchange={(e) => {
            const id = e.currentTarget.value
            if (id) tabs.reassign(tab.id, id)
          }}
        >
          <option value="">Reassign connection…</option>
          {#each connections.profiles as p (p.id)}
            <option value={p.id}>{p.name}</option>
          {/each}
        </select>
      </div>
    </div>
  {:else if disconnected}
    <!-- disconnected banner — SPEC_v2 §12 (không chặn nội dung) -->
    <div style="flex:none;display:flex;align-items:center;gap:var(--px-8);padding:var(--px-6) var(--px-12);border-bottom:var(--px-1) solid var(--border);background:var(--panel);font-size:var(--px-12)">
      <span style="width:var(--px-7);height:var(--px-7);border-radius:50%;background:var(--border2)"></span>
      <span style="color:var(--text2)">Disconnected</span>
      <div
        onclick={() => profile && connections.connect(profile.id)}
        onkeydown={(e) => e.key === 'Enter' && profile && connections.connect(profile.id)}
        role="button"
        tabindex="0"
        style="margin-left:auto;color:var(--primary);cursor:pointer"
      >Reconnect</div>
    </div>
  {/if}

  {#if tab.systemType === 'sqlite' && profile?.connected && tab.connectionId}
    <!-- SQLite file header + PRAGMA panel — dòng 197-227 -->
    <SqliteFileHeader
      connId={tab.connectionId}
      onRunSql={(sqlText) => {
        void results.run(tab.id, tab.connectionId!, splitStatements(sqlText))
      }}
    />
  {/if}

  <!-- editor toolbar — port dòng 230-262 -->
  <div style="flex:none;display:flex;align-items:center;gap:var(--px-8);padding:var(--px-7) var(--px-12);border-bottom:var(--px-1) solid var(--border);background:var(--surface)">
    <!-- connection dropdown — dòng 231-250 -->
    <div style="position:relative">
      <div
        onclick={() => (connDropOpen = !connDropOpen)}
        onkeydown={(e) => e.key === 'Enter' && (connDropOpen = !connDropOpen)}
        role="button"
        tabindex="0"
        style="display:flex;align-items:center;gap:var(--px-7);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-7);padding:var(--px-4) var(--px-9);cursor:pointer"
      >
        <span style="display:flex;align-items:center;flex:none"><SystemIcon system={tab.systemType} size={15} /></span>
        <span style="font-size:var(--px-12);font-weight:600">{profile?.name ?? (isOrphan ? '(deleted)' : '— no connection —')}</span>
        <span style="color:var(--muted);font-size:var(--px-9)">▾</span>
      </div>
      {#if connDropOpen}
        <div onclick={() => (connDropOpen = false)} onkeydown={(e) => e.key === 'Escape' && (connDropOpen = false)} role="presentation" style="position:fixed;inset:0;z-index:39"></div>
        <div style="position:absolute;top:var(--px-34);left:0;z-index:40;min-width:var(--px-248);background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-10);box-shadow:0 var(--px-16) var(--px-40) var(--rgba-0-0-0-_45);padding:var(--px-5)">
          <div style="font-size:var(--px-10);font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);padding:var(--px-6) var(--px-9) var(--px-4)">Switch connection</div>
          {#each connections.profiles as p (p.id)}
            <div
              onclick={() => {
                tabs.setConnection(tab.id, p.id)
                connDropOpen = false
              }}
              onkeydown={(e) => e.key === 'Enter' && (tabs.setConnection(tab.id, p.id), (connDropOpen = false))}
              role="button"
              tabindex="0"
              class="wk-drop-row"
              style="display:flex;align-items:center;gap:var(--px-9);padding:var(--px-6) var(--px-9);border-radius:var(--px-7);cursor:pointer;background:{p.id === tab.connectionId ? 'var(--hover)' : 'transparent'}"
            >
              <span style="width:var(--px-7);height:var(--px-7);border-radius:50%;flex:none;background:{p.connected ? systemMeta(p.system).accent : 'var(--sys-orphan-accent)'}"></span>
              <span style="flex:none;display:flex;align-items:center"><SystemIcon system={p.system} size={16} /></span>
              <div style="min-width:0">
                <div style="font-size:var(--px-12_5);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{p.name}</div>
                <div class="mono" style="font-size:var(--px-10);color:var(--muted)">{p.system === 'sqlite' ? p.sqlite_path || ':memory:' : `${p.host}:${p.port}`}</div>
              </div>
              <span style="margin-left:auto;flex:none;color:var(--primary);font-size:var(--px-12)">{p.id === tab.connectionId ? '✓' : ''}</span>
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Run / Cancel — dòng 252-254 -->
    {#if exec?.running}
      <div
        onclick={cancel}
        onkeydown={(e) => e.key === 'Enter' && cancel()}
        role="button"
        tabindex="0"
        title="Cancel (Ctrl+F5 / Esc)"
        style="display:flex;align-items:center;gap:var(--px-7);background:var(--error);color:var(--hex-fff);border-radius:var(--px-7);padding:var(--px-5) var(--px-13);cursor:pointer;font-weight:600;font-size:var(--px-12)"
      >
        <span>■</span><span>Cancel</span><span class="mono" style="opacity:.85;font-size:var(--px-10)">running {runningSecs}s</span>
      </div>
    {:else}
      <div
        onclick={run}
        onkeydown={(e) => e.key === 'Enter' && run()}
        role="button"
        tabindex="0"
        title="Run (F5) — có selection thì chạy selection"
        style="display:flex;align-items:center;gap:var(--px-7);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-7);padding:var(--px-5) var(--px-13);cursor:{isOrphan || !tab.connectionId ? 'not-allowed' : 'pointer'};opacity:{isOrphan || !tab.connectionId ? 0.5 : 1};font-weight:600;font-size:var(--px-12)"
      >
        <span>▶</span><span>Run</span><span class="mono" style="opacity:.7;font-size:var(--px-10)">F5</span>
      </div>
    {/if}

    <!-- Format (Ctrl+Shift+F) + Explain (Ctrl+Shift+E, text — visual plan Phase 5) -->
    <div class="wk-tbtn" onclick={doFormat} onkeydown={(e) => e.key === 'Enter' && doFormat()} role="button" tabindex="0" title="Format SQL (Ctrl+Shift+F)">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><line x1="4" y1="6" x2="20" y2="6"></line><line x1="4" y1="12" x2="14" y2="12"></line><line x1="4" y1="18" x2="18" y2="18"></line></svg>Format
    </div>
    <div class="wk-tbtn" onclick={doExplain} onkeydown={(e) => e.key === 'Enter' && doExplain()} role="button" tabindex="0" title="Explain (Ctrl+Shift+E) — visual plan ở Phase 5">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="20" x2="6" y2="13"></line><line x1="12" y1="20" x2="12" y2="8"></line><line x1="18" y1="20" x2="18" y2="11"></line></svg>Explain
    </div>
    {#if tab.systemType === 'cassandra'}
      <!-- Ring (prototype dòng 257-259) — mở Ring Topology, màu accent Cassandra -->
      <div class="wk-tbtn" style="color:#1287B1" onclick={() => tab.connectionId && tabs.openCassandraRing(tab.connectionId)} onkeydown={(e) => e.key === 'Enter' && tab.connectionId && tabs.openCassandraRing(tab.connectionId)} role="button" tabindex="0" title="Ring Topology">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9" stroke-dasharray="3 3"></circle><circle cx="12" cy="3" r="2" fill="currentColor" stroke="none"></circle><circle cx="20" cy="17" r="2" fill="currentColor" stroke="none"></circle><circle cx="4" cy="17" r="2" fill="currentColor" stroke="none"></circle></svg>Ring
      </div>
    {/if}
    <div class="wk-tbtn" onclick={doConvert} onkeydown={(e) => e.key === 'Enter' && doConvert()} role="button" tabindex="0" title="Convert / normalize SQL (format for current dialect)">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h13l-3-3M20 17H7l3 3"></path></svg>Convert
    </div>
    <div class="wk-tbtn" onclick={doSplit} onkeydown={(e) => e.key === 'Enter' && doSplit()} role="button" tabindex="0" title="Split editor (Split Right)">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="1.5"></rect><line x1="12" y1="4" x2="12" y2="20"></line></svg>Split</div>
    <div style="margin-left:auto">
      {#if exec && !exec.running}
        <span class="mono" style="font-size:var(--px-11);color:var(--muted)">{exec.totalMs} ms</span>
      {/if}
    </div>
  </div>

  <!-- editor -->
  <div style="height:{ui.editorHeight}px;flex:none">
    <SqlEditor
      bind:this={editor}
      value={initialQuery}
      system={tab.systemType}
      schema={completionSchema}
      {defaultSchema}
      lintSource={lintDoc}
      {onChange}
      onRun={run}
      onRunAtCursor={runAtCursor}
      onCancel={cancel}
      onFormat={doFormat}
      onExplain={doExplain}
      onSaveSnippet={saveSnippet}
    />
  </div>

  <!-- split handle editor/result -->
  <div
    style="flex:none;height:var(--px-5);cursor:row-resize;background:var(--border)"
    role="separator"
    aria-orientation="horizontal"
    onpointerdown={startDrag}
    onpointermove={onDrag}
    onpointerup={() => (dragging = false)}
  ></div>

  <!-- results -->
  <div style="min-height:0;flex:1;display:flex;flex-direction:column">
    {#if exec}
      <ResultPanel {exec} accent={systemMeta(tab.systemType).accent} onJump={jump} />
    {:else}
      <div style="flex:1;display:flex;align-items:center;justify-content:center;font-size:var(--px-12);color:var(--muted)">
        Chạy query (F5) để xem kết quả · Ctrl+Enter chạy statement tại cursor
      </div>
    {/if}
  </div>
</div>

<style>
  /* nút toolbar editor — dòng 255 */
  .wk-tbtn {
    display: flex;
    align-items: center;
    gap: var(--px-6);
    color: var(--text2);
    font-size: var(--px-12);
    background: var(--panel);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-7);
    padding: var(--px-5) var(--px-10);
    cursor: pointer;
  }
  .wk-tbtn:hover,
  .wk-drop-row:hover {
    background: var(--hover);
  }
  .wk-select {
    background: var(--surface);
    border: var(--px-1) solid var(--input);
    border-radius: var(--px-5);
    padding: var(--px-2) var(--px-6);
    font-size: var(--px-11_5);
    color: var(--text);
  }
</style>
