<script lang="ts">
  // SQL editor workspace for one tab: toolbar (connection dropdown + Run/Cancel)
  // + CodeMirror + resizable split + result panel. Run is selection-aware (F5),
  // Ctrl+Enter runs the statement at the cursor.
  import SqlEditor from '$lib/components/editor/SqlEditor.svelte'
  import ResultPanel from '$lib/components/results/ResultPanel.svelte'
  import SystemBadge from '$lib/components/SystemBadge.svelte'
  import SystemIcon from '$lib/components/SystemIcon.svelte'
  import { systemMeta } from '$lib/systems'
  import { connections } from '$lib/stores/connections.svelte'
  import { results } from '$lib/stores/results.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { ui } from '$lib/stores/ui.svelte'
  import { mapErrorToDocument } from '$lib/sql/errors'
  import { splitStatements, statementAtOffset } from '$lib/sql/statements'
  import type { TabState } from '$lib/types'

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
        <span>■</span><span>Cancel</span><span class="mono" style="opacity:.7;font-size:var(--px-10)">Esc</span>
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

    <!-- Format / Explain / Convert / Split — visual theo HTML, chức năng phase sau -->
    <div class="wk-tbtn" onclick={() => toasts.show('Format — Phase 2')} onkeydown={(e) => e.key === 'Enter' && toasts.show('Format — Phase 2')} role="button" tabindex="0">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><line x1="4" y1="6" x2="20" y2="6"></line><line x1="4" y1="12" x2="14" y2="12"></line><line x1="4" y1="18" x2="18" y2="18"></line></svg>Format
    </div>
    <div class="wk-tbtn" onclick={() => toasts.show('Explain — Phase 2 (visual plan Phase 5)')} onkeydown={(e) => e.key === 'Enter' && toasts.show('Explain — Phase 2 (visual plan Phase 5)')} role="button" tabindex="0">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="20" x2="6" y2="13"></line><line x1="12" y1="20" x2="12" y2="8"></line><line x1="18" y1="20" x2="18" y2="11"></line></svg>Explain
    </div>
    <div class="wk-tbtn" onclick={() => toasts.show('Convert dialect — Phase 2')} onkeydown={(e) => e.key === 'Enter' && toasts.show('Convert dialect — Phase 2')} role="button" tabindex="0" title="Convert SQL dialect">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h13l-3-3M20 17H7l3 3"></path></svg>Convert
    </div>
    <div class="wk-tbtn" onclick={() => toasts.show('Split editor — Phase 3')} onkeydown={(e) => e.key === 'Enter' && toasts.show('Split editor — Phase 3')} role="button" tabindex="0" title="Split editor">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="1.5"></rect><line x1="12" y1="4" x2="12" y2="20"></line></svg>Split ▾
    </div>
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
      {onChange}
      onRun={run}
      onRunAtCursor={runAtCursor}
      onCancel={cancel}
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
      <ResultPanel {exec} onJump={jump} />
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
