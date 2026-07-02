<script lang="ts">
  // SQL editor workspace for one tab: toolbar (connection dropdown + Run/Cancel)
  // + CodeMirror + resizable split + result panel. Run is selection-aware (F5),
  // Ctrl+Enter runs the statement at the cursor.
  import SqlEditor from '$lib/components/editor/SqlEditor.svelte'
  import ResultPanel from '$lib/components/results/ResultPanel.svelte'
  import SystemBadge from '$lib/components/SystemBadge.svelte'
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

<div class="flex h-full min-h-0 flex-col" bind:this={container}>
  {#if isOrphan}
    <!-- orphaned: connection deleted, content kept, cannot run -->
    <div class="flex items-center gap-2 border-b border-border bg-panel px-3 py-1.5 text-[12px]">
      <SystemBadge system="orphan" />
      <span class="text-text2">Connection đã bị xóa · tab ở trạng thái orphaned</span>
      <div class="grow"></div>
      <select
        class="rounded border border-input bg-surface px-1.5 py-0.5 text-[11.5px]"
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
  {:else if disconnected}
    <div class="flex items-center gap-2 border-b border-border bg-panel px-3 py-1.5 text-[12px]">
      <span class="h-[7px] w-[7px] rounded-full bg-border2"></span>
      <span class="text-text2">Disconnected</span>
      <div class="grow"></div>
      <button
        class="text-primary hover:underline"
        onclick={() => profile && connections.connect(profile.id)}
      >
        Reconnect
      </button>
    </div>
  {/if}

  <!-- toolbar -->
  <div class="flex h-[34px] shrink-0 items-center gap-2 border-b border-border bg-header px-2">
    <select
      class="max-w-[220px] rounded border border-input bg-surface px-1.5 py-0.5 text-[12px]"
      value={tab.connectionId ?? ''}
      onchange={(e) => {
        const id = e.currentTarget.value || null
        tabs.setConnection(tab.id, id)
        // schema cache reload happens on next explorer access / autocomplete (P2)
      }}
    >
      <option value="">— no connection —</option>
      {#each connections.profiles as p (p.id)}
        <option value={p.id}>{p.name}</option>
      {/each}
    </select>
    {#if profile}
      <SystemBadge system={profile.system} />
    {/if}

    {#if exec?.running}
      <button
        class="flex items-center gap-1 rounded bg-error/15 px-2.5 py-1 text-[12px] font-medium text-error hover:bg-error/25"
        onclick={cancel}
        title="Cancel (Ctrl+F5 / Esc)"
      >
        ■ Cancel
      </button>
    {:else}
      <button
        class="flex items-center gap-1 rounded bg-success/15 px-2.5 py-1 text-[12px] font-medium text-success hover:bg-success/25 disabled:opacity-40"
        onclick={run}
        disabled={isOrphan || !tab.connectionId}
        title="Run (F5) — có selection thì chạy selection"
      >
        ▶ Run
      </button>
    {/if}
    <div class="grow"></div>
    {#if exec && !exec.running}
      <span class="text-[11px] text-mutedfg">{exec.totalMs} ms</span>
    {/if}
  </div>

  <!-- editor -->
  <div style="height: {ui.editorHeight}px;" class="shrink-0">
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

  <!-- split handle -->
  <div
    class="h-[5px] shrink-0 cursor-row-resize border-y border-border bg-header hover:bg-primary/40"
    role="separator"
    aria-orientation="horizontal"
    onpointerdown={startDrag}
    onpointermove={onDrag}
    onpointerup={() => (dragging = false)}
  ></div>

  <!-- results -->
  <div class="min-h-0 grow">
    {#if exec}
      <ResultPanel {exec} onJump={jump} />
    {:else}
      <div class="flex h-full items-center justify-center text-[12px] text-mutedfg">
        Chạy query (F5) để xem kết quả · Ctrl+Enter chạy statement tại cursor
      </div>
    {/if}
  </div>
</div>
