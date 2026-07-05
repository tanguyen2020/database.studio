<script lang="ts">
  // Result panel — port 1:1 từ Database Studio.dc.html:
  //  - sub-tab strip (dòng 332-340 + logic 4967-4987): #N mono bold muted,
  //    icon › khi active / ≣ Messages, underline 2px accent, statusColor ✓/✗
  //  - result toolbar (dòng 342-349): segmented Grid/JSON/Single Row/Chart
  //  - view modes: Grid / JSON / Single Row / Chart (dòng 500-548)
  // Click sub-tab lỗi / dòng Messages → nhảy đúng vị trí (addendum §3).
  import ResultGrid, { type EditTarget } from './ResultGrid.svelte'
  import ResultJsonView from './ResultJsonView.svelte'
  import ResultSingleRow from './ResultSingleRow.svelte'
  import ResultChart from './ResultChart.svelte'
  import type { SubResult, TabExecution } from '$lib/stores/results.svelte'
  import { mapErrorToDocument } from '$lib/sql/errors'
  import { toCsv, toJson, toSqlInsert, toExcelHtml, download } from '$lib/export/rows'
  import { exportWizard } from '$lib/stores/export.svelte'
  import { ui } from '$lib/stores/ui.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { untrack } from 'svelte'

  type ViewMode = 'grid' | 'json' | 'single' | 'chart'

  interface Props {
    exec: TabExecution
    /** accent của hệ tab đang chạy — underline sub-tab active (as.accent trong HTML) */
    accent?: string
    /** editable grid khi result đến từ 1 bảng đã biết (Table Viewer) */
    editTarget?: EditTarget
    /** connection id — để Export wizard (custom) biết hệ khi cần */
    connId?: string | null
    /** tab đang active — để nhận shortcut result-view/copy (T21) */
    active?: boolean
    onJump?: (line: number, col: number) => void
  }

  let { exec, accent = 'var(--primary)', editTarget, connId, active = false, onJump }: Props = $props()

  // T21 — shortcuts Ctrl+Alt+G/J/R (đổi view) + Ctrl+Shift+C (copy JSON) qua ui.
  $effect(() => {
    void ui.resultViewTick
    if (active && ui.resultViewTick > 0) untrack(() => (viewMode = ui.resultView))
  })
  $effect(() => {
    void ui.copyJsonTick
    if (active && ui.copyJsonTick > 0) untrack(() => copyResultJson())
  })
  function copyResultJson() {
    const r = activeResult?.kind === 'rows' ? activeResult.result : undefined
    if (!r) return
    void navigator.clipboard.writeText(toJson(r.rows as Record<string, unknown>[])).then(() => toasts.success('Copied result (JSON)'))
  }

  let grid = $state<ResultGrid | null>(null)
  let rawError = $state<string | null>(null)
  let viewMode = $state<ViewMode>('grid')
  let exportOpen = $state(false)

  // Export result hiện tại (CSV/JSON/SQL/Excel) — dùng util thuần export/rows.ts.
  function doExport(fmt: 'csv' | 'json' | 'sql' | 'xls') {
    exportOpen = false
    const r = activeResult?.kind === 'rows' ? activeResult.result : undefined
    if (!r) return
    const headers = r.cols.map((c) => c[0])
    const rows = r.rows as Record<string, unknown>[]
    if (fmt === 'csv') download('result.csv', toCsv(headers, rows), 'text/csv')
    else if (fmt === 'json') download('result.json', toJson(rows), 'application/json')
    else if (fmt === 'sql') download('result.sql', toSqlInsert('result', headers, rows), 'text/plain')
    else download('result.xls', toExcelHtml(headers, rows), 'application/vnd.ms-excel')
  }

  // Export wizard (T14) — column subset / limit / filename cho result hiện tại.
  function openExportWizard() {
    exportOpen = false
    const r = activeResult?.kind === 'rows' ? activeResult.result : undefined
    if (!r) return
    exportWizard.showResult(connId ?? '', r.cols.map((c) => c[0]), r.rows as Record<string, unknown>[])
  }

  const MESSAGES = -1

  const activeResult = $derived(
    exec.activeSub >= 0 ? exec.subResults[exec.activeSub] : undefined,
  )

  function stripN(label: string): string {
    return label.replace(/^#\d+\s*/, '')
  }

  function selectSub(idx: number) {
    exec.activeSub = idx
    const sub = exec.subResults[idx]
    if (sub?.kind === 'error') {
      jumpToError(sub)
    }
  }

  function jumpToError(sub: SubResult) {
    if (!sub.error) return
    const pos = mapErrorToDocument(sub.statement, sub.error)
    onJump?.(pos.line, pos.col)
  }

  const summary = $derived.by(() => {
    if (!activeResult) return ''
    if (activeResult.kind === 'rows' && activeResult.result) {
      return `${activeResult.result.total.toLocaleString()} rows · ${activeResult.durationMs} ms`
    }
    return ''
  })
</script>

<div style="flex:1;display:flex;flex-direction:column;min-height:0;background:var(--surface)">
  <!-- sub tabs — dòng 332-340 -->
  <div style="flex:none;display:flex;align-items:center;gap:0;border-bottom:var(--px-1) solid var(--border);background:var(--header);overflow-x:auto">
    {#each exec.subResults as sub, idx (sub.index)}
      {@const on = exec.activeSub === idx}
      {@const statusColor = sub.kind === 'error' ? 'var(--hex-e06c75)' : sub.kind === 'affected' || sub.kind === 'ok' ? 'var(--hex-27ae60)' : 'var(--muted)'}
      <div
        onclick={() => selectSub(idx)}
        onkeydown={(e) => e.key === 'Enter' && selectSub(idx)}
        role="tab"
        aria-selected={on}
        tabindex="0"
        style="display:flex;align-items:center;gap:var(--px-6);padding:var(--px-7) var(--px-13);cursor:pointer;font-size:var(--px-11_5);white-space:nowrap;border-bottom:var(--px-2) solid {on ? accent : 'transparent'};background:{on ? 'var(--surface)' : 'transparent'};color:{on ? 'var(--text)' : 'var(--text2)'}"
      >
        <span class="mono" style="font-weight:700;color:var(--muted)">#{sub.index}</span>
        <span style="color:{statusColor}">{on ? '›' : ''}</span>
        <span style="font-weight:{on ? 700 : 500};color:{sub.kind === 'error' ? 'var(--hex-e06c75)' : 'inherit'}">{stripN(sub.label)}</span>
      </div>
    {/each}
    {#if exec.subResults.length > 0}
      {@const on = exec.activeSub === MESSAGES}
      <div
        onclick={() => (exec.activeSub = MESSAGES)}
        onkeydown={(e) => e.key === 'Enter' && (exec.activeSub = MESSAGES)}
        role="tab"
        aria-selected={on}
        tabindex="0"
        style="display:flex;align-items:center;gap:var(--px-6);padding:var(--px-7) var(--px-13);cursor:pointer;font-size:var(--px-11_5);white-space:nowrap;border-bottom:var(--px-2) solid {on ? accent : 'transparent'};background:{on ? 'var(--surface)' : 'transparent'};color:{on ? 'var(--text)' : 'var(--text2)'}"
      >
        <span style="color:var(--muted)">≣</span>
        <span style="font-weight:{on ? 700 : 500}">Messages</span>
      </div>
    {/if}
    {#if exec.running}
      <span style="display:flex;align-items:center;padding:0 var(--px-13);font-size:var(--px-11);color:var(--text2)">Running…</span>
    {/if}
  </div>

  <!-- result toolbar — dòng 342-349 -->
  {#if activeResult?.kind === 'rows' && activeResult.result}
    <div style="flex:none;display:flex;align-items:center;gap:var(--px-10);padding:var(--px-6) var(--px-12);border-bottom:var(--px-1) solid var(--border)">
      <div style="display:flex;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-7);overflow:hidden">
        {#each [['grid', 'Grid'], ['json', 'JSON'], ['single', 'Single Row'], ['chart', 'Chart']] as [mode, label], i (mode)}
          <span
            class="vm-btn"
            style="{i > 0 ? 'border-left:var(--px-1) solid var(--border);' : ''}background:{viewMode === mode ? accent : 'transparent'};color:{viewMode === mode ? 'var(--hex-fff)' : 'var(--text2)'}"
            onclick={() => (viewMode = mode as ViewMode)}
            onkeydown={(e) => e.key === 'Enter' && (viewMode = mode as ViewMode)}
            role="button"
            tabindex="0"
          >{label}</span>
        {/each}
      </div>
      <span style="font-size:var(--px-11_5);color:var(--muted)">{summary}</span>
      <div style="margin-left:auto;position:relative">
        <span
          style="font-size:var(--px-11_5);color:var(--text2);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer"
          onclick={() => (exportOpen = !exportOpen)}
          onkeydown={(e) => e.key === 'Enter' && (exportOpen = !exportOpen)}
          role="button"
          tabindex="0"
        >Export ▾</span>
        {#if exportOpen}
          <div style="position:absolute;right:0;top:calc(100% + var(--px-4));z-index:20;background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-8);box-shadow:0 var(--px-8) var(--px-24) rgba(0,0,0,.4);overflow:hidden;min-width:var(--px-120)">
            {#each [['csv', 'CSV'], ['json', 'JSON'], ['sql', 'SQL INSERT'], ['xls', 'Excel (.xls)']] as [fmt, label] (fmt)}
              <div onclick={() => doExport(fmt as 'csv' | 'json' | 'sql' | 'xls')} onkeydown={(e) => e.key === 'Enter' && doExport(fmt as 'csv' | 'json' | 'sql' | 'xls')} role="button" tabindex="0" style="padding:var(--px-7) var(--px-12);font-size:var(--px-12);cursor:pointer;color:var(--text2)">{label}</div>
            {/each}
            <div onclick={openExportWizard} onkeydown={(e) => e.key === 'Enter' && openExportWizard()} role="button" tabindex="0" style="padding:var(--px-7) var(--px-12);font-size:var(--px-12);cursor:pointer;color:var(--text2);border-top:var(--px-1) solid var(--border)">Custom… (columns/limit)</div>
          </div>
        {/if}
      </div>
    </div>
  {/if}

  <!-- content -->
  <div style="min-height:0;flex:1;display:flex;flex-direction:column;background:var(--surface)">
    {#if exec.activeSub === MESSAGES}
      <div class="selectable" style="flex:1;overflow-y:auto;padding:var(--px-4);font-size:var(--px-12)">
        {#each exec.messages as msg (msg.index)}
          <div
            class="mono msg-row"
            onclick={() => {
              if (msg.error) {
                const pos = mapErrorToDocument(msg.statement, msg.error)
                onJump?.(pos.line, pos.col)
              } else {
                onJump?.(msg.statement.startLine, msg.statement.startCol)
              }
            }}
            onkeydown={(e) => e.key === 'Enter' && onJump?.(msg.statement.startLine, msg.statement.startCol)}
            role="button"
            tabindex="0"
            style="display:flex;align-items:flex-start;gap:var(--px-8);border-radius:var(--px-5);padding:var(--px-4) var(--px-8);cursor:pointer;text-align:left;width:100%"
          >
            <span style="flex:none;color:{msg.ok ? 'var(--hex-27ae60)' : 'var(--hex-e06c75)'}">{msg.ok ? '✓' : '✗'}</span>
            <span style="flex:none;color:var(--muted)">#{msg.index}</span>
            <span style="min-width:0;flex:1;white-space:pre-wrap;word-break:break-word;color:{msg.ok ? 'inherit' : 'var(--hex-e06c75)'}">
              {#if msg.error}
                {msg.error.severity} · {msg.error.code ?? '—'} · {msg.text}
                {#if msg.error.position}
                  {@const pos = mapErrorToDocument(msg.statement, msg.error)}
                  <span style="color:var(--muted)">(line {pos.line}:{pos.col})</span>
                {/if}
                {#if msg.error.hint}
                  <div style="margin-top:var(--px-2);font-size:var(--px-11);color:var(--warn)">💡 {msg.error.hint}</div>
                {/if}
              {:else}
                {msg.text}
              {/if}
            </span>
            <span style="flex:none;font-size:var(--px-10_5);color:var(--muted)">{msg.durationMs} ms</span>
            {#if msg.error}
              <span
                onclick={(e) => {
                  e.stopPropagation()
                  rawError = msg.error?.raw ?? null
                }}
                onkeydown={(e) => {
                  if (e.key === 'Enter') {
                    e.stopPropagation()
                    rawError = msg.error?.raw ?? null
                  }
                }}
                role="button"
                tabindex="0"
                style="flex:none;font-size:var(--px-10);color:var(--text2);border:var(--px-1) solid var(--border);border-radius:var(--px-5);padding:var(--px-1) var(--px-6);cursor:pointer"
              >View raw</span>
            {/if}
          </div>
        {/each}
        {#if exec.messages.length === 0}
          <div style="padding:var(--px-8) var(--px-12);color:var(--muted)">No messages yet</div>
        {/if}
      </div>
    {:else if activeResult}
      {#if activeResult.kind === 'rows' && activeResult.result}
        {#if viewMode === 'grid'}
          <ResultGrid bind:this={grid} data={activeResult.result} {editTarget} />
        {:else if viewMode === 'json'}
          <ResultJsonView data={activeResult.result} />
        {:else if viewMode === 'single'}
          <ResultSingleRow data={activeResult.result} />
        {:else}
          <ResultChart data={activeResult.result} {accent} />
        {/if}
      {:else if activeResult.kind === 'affected'}
        <div style="padding:var(--px-16);font-size:var(--px-13)">
          <span style="color:var(--hex-27ae60)">✓</span>
          {activeResult.affected?.toLocaleString()} rows affected
          <span class="mono" style="margin-left:var(--px-8);font-size:var(--px-11);color:var(--muted)">{activeResult.durationMs} ms</span>
        </div>
      {:else if activeResult.kind === 'ok'}
        <div style="padding:var(--px-16);font-size:var(--px-13)">
          <span style="color:var(--hex-27ae60)">✓</span> OK
          <span class="mono" style="margin-left:var(--px-8);font-size:var(--px-11);color:var(--muted)">{activeResult.durationMs} ms</span>
        </div>
      {:else if activeResult.kind === 'error' && activeResult.error}
        {@const err = activeResult.error}
        <div class="selectable" style="padding:var(--px-16);font-size:var(--px-12_5)">
          <div style="display:flex;align-items:flex-start;gap:var(--px-8)">
            <span style="color:var(--hex-e06c75)">✗</span>
            <div style="min-width:0;flex:1">
              <div style="font-weight:500;color:var(--hex-e06c75)">
                {err.code ? `[${err.code}] ` : ''}{err.message}
              </div>
              {#if err.position}
                {@const pos = mapErrorToDocument(activeResult.statement, err)}
                <div
                  onclick={() => jumpToError(activeResult)}
                  onkeydown={(e) => e.key === 'Enter' && jumpToError(activeResult)}
                  role="button"
                  tabindex="0"
                  style="margin-top:var(--px-4);font-size:var(--px-11_5);color:var(--primary);cursor:pointer;width:fit-content"
                >→ line {pos.line}, col {pos.col}</div>
              {/if}
              {#if err.hint}
                <div style="margin-top:var(--px-6);font-size:var(--px-12);color:var(--warn)">💡 {err.hint}</div>
              {/if}
              <div
                onclick={() => (rawError = err.raw)}
                onkeydown={(e) => e.key === 'Enter' && (rawError = err.raw)}
                role="button"
                tabindex="0"
                style="margin-top:var(--px-8);font-size:var(--px-11);color:var(--text2);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-9);cursor:pointer;width:fit-content"
              >View raw error</div>
            </div>
          </div>
        </div>
      {/if}
    {:else}
      <div style="flex:1;display:flex;align-items:center;justify-content:center;font-size:var(--px-12);color:var(--muted)">
        Run a query (F5) to see results
      </div>
    {/if}
  </div>
</div>

<!-- raw driver error modal — cùng ngôn ngữ modal prototype -->
{#if rawError !== null}
  <div
    onclick={() => (rawError = null)}
    onkeydown={(e) => e.key === 'Escape' && (rawError = null)}
    role="presentation"
    style="position:fixed;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:58"
  >
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
    <div
      onclick={(e) => e.stopPropagation()}
      role="dialog"
      aria-label="Raw driver error"
      tabindex="-1"
      style="width:var(--px-640);max-width:94vw;background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);box-shadow:0 var(--px-30) var(--px-70) var(--rgba-0-0-0-_55);overflow:hidden"
    >
      <div style="padding:var(--px-18) var(--px-20) var(--px-8);display:flex;align-items:center;gap:var(--px-10)">
        <span style="font-weight:700;font-size:var(--px-15)">Raw driver error</span>
      </div>
      <div style="padding:0 var(--px-20) var(--px-14)">
        <pre class="selectable mono" style="max-height:50vh;overflow:auto;border-radius:var(--px-9);background:var(--panel);border:var(--px-1) solid var(--border);padding:var(--px-12);font-size:var(--px-11_5);line-height:1.6;margin:0">{rawError}</pre>
      </div>
      <div style="display:flex;gap:var(--px-9);padding:var(--px-14) var(--px-20);border-top:var(--px-1) solid var(--border);background:var(--panel)">
        <span
          onclick={async () => {
            if (rawError) await navigator.clipboard.writeText(rawError)
          }}
          onkeydown={async (e) => {
            if (e.key === 'Enter' && rawError) await navigator.clipboard.writeText(rawError)
          }}
          role="button"
          tabindex="0"
          style="margin-left:auto;font-size:var(--px-12_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-8) var(--px-14);cursor:pointer"
        >Copy</span>
        <span
          onclick={() => (rawError = null)}
          onkeydown={(e) => e.key === 'Enter' && (rawError = null)}
          role="button"
          tabindex="0"
          style="font-size:var(--px-12_5);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-8);padding:var(--px-8) var(--px-16);cursor:pointer;font-weight:600"
        >Close</span>
      </div>
    </div>
  </div>
{/if}

<style>
  .vm-btn {
    padding: var(--px-4) var(--px-11);
    font-size: var(--px-11_5);
    font-weight: 600;
    cursor: pointer;
  }
  .msg-row:hover {
    background: var(--hover);
  }
</style>
