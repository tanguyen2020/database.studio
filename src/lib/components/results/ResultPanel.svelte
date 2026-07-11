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
  import ResultPlanView from './ResultPlanView.svelte'
  import type { SubResult, TabExecution, ExplainState } from '$lib/stores/results.svelte'
  import { mapErrorToDocument } from '$lib/sql/errors'
  import { toJson, download, csvCell, sqlLiteral } from '$lib/export/rows'
  import { exportWizard } from '$lib/stores/export.svelte'
  import { ui } from '$lib/stores/ui.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import * as ipc from '$lib/ipc'
  import { IS_TAURI } from '$lib/demo'
  import { untrack } from 'svelte'

  type ViewMode = 'grid' | 'json' | 'single' | 'chart'

  interface Props {
    exec?: TabExecution
    /** accent của hệ tab đang chạy — underline sub-tab active (as.accent trong HTML) */
    accent?: string
    /** editable grid khi result đến từ 1 bảng đã biết (Table Viewer) */
    editTarget?: EditTarget
    /** connection id — để Export wizard (custom) biết hệ khi cần */
    connId?: string | null
    /** tab đang active — để nhận shortcut result-view/copy (T21) */
    active?: boolean
    onJump?: (line: number, col: number) => void
    /** Cassandra only — "Load next page" cho result còn paging token. */
    onLoadMore?: (subIndex: number) => void
    /** Query plan shown as a sub-view of this panel (Explain — no new tab). */
    explain?: ExplainState | null
    capability?: import('$lib/ipc').EngineCapability | null
    onExplainActual?: (actual: boolean) => void
    onExplainReExplain?: () => void
    onExplainClose?: () => void
  }

  let {
    exec,
    accent = 'var(--primary)',
    editTarget,
    connId,
    active = false,
    onJump,
    onLoadMore,
    explain,
    capability,
    onExplainActual,
    onExplainReExplain,
    onExplainClose,
  }: Props = $props()

  // Show the plan sub-view. Auto-activates when a fresh Explain arrives (the
  // explain object is replaced on each run → this effect re-fires).
  let planActive = $state(false)
  $effect(() => {
    void explain
    if (explain) untrack(() => (planActive = true))
    else untrack(() => (planActive = false))
  })

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

  // Export progress overlay state — a running bar so you can tell when it's done.
  let exportJob = $state<{ name: string; pct: number; rows: number; done: boolean; error?: string; path?: string } | null>(null)

  const FMT_META: Record<'csv' | 'json' | 'sql' | 'xls', { ext: string; mime: string; label: string }> = {
    csv: { ext: 'csv', mime: 'text/csv', label: 'CSV' },
    json: { ext: 'json', mime: 'application/json', label: 'JSON' },
    sql: { ext: 'sql', mime: 'text/plain', label: 'SQL' },
    xls: { ext: 'xls', mime: 'application/vnd.ms-excel', label: 'Excel' },
  }

  const xmlEsc = (v: unknown) =>
    v == null ? '' : String(typeof v === 'object' ? JSON.stringify(v) : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  // Serialize rows in chunks, reporting progress so the bar animates (and the UI
  // stays responsive on large results). Reuses the pure csvCell/sqlLiteral escapers.
  async function serialize(
    fmt: 'csv' | 'json' | 'sql' | 'xls',
    headers: string[],
    rows: Record<string, unknown>[],
    onProgress: (done: number) => void,
  ): Promise<string> {
    const CHUNK = 1000
    const n = rows.length
    const cols = headers.map((h) => `"${h}"`).join(', ')
    const parts: string[] = []
    for (let i = 0; i < n; i += CHUNK) {
      for (const r of rows.slice(i, i + CHUNK)) {
        if (fmt === 'csv') parts.push(headers.map((h) => csvCell(r[h])).join(','))
        else if (fmt === 'json') parts.push('  ' + JSON.stringify(r))
        else if (fmt === 'sql') parts.push(`INSERT INTO "result" (${cols}) VALUES (${headers.map((h) => sqlLiteral(r[h])).join(', ')});`)
        else parts.push(`<tr>${headers.map((h) => `<td>${xmlEsc(r[h])}</td>`).join('')}</tr>`)
      }
      onProgress(n ? Math.min(1, (i + CHUNK) / n) : 1)
      await new Promise((res) => setTimeout(res, 0)) // yield → bar animates + UI responsive
    }
    onProgress(1)
    if (fmt === 'csv') {
      const head = headers.map(csvCell).join(',')
      return parts.length ? `${head}\n${parts.join('\n')}` : head
    }
    if (fmt === 'json') return `[\n${parts.join(',\n')}\n]`
    if (fmt === 'sql') return parts.join('\n')
    const th = headers.map((h) => `<th>${xmlEsc(h)}</th>`).join('')
    return `<html><head><meta charset="utf-8"></head><body><table border="1"><thead><tr>${th}</tr></thead><tbody>${parts.join('')}</tbody></table></body></html>`
  }

  // Export the current result: pick a destination (native save dialog in the
  // desktop app; browser download otherwise), serialize with a progress bar,
  // write to disk, and report completion.
  async function doExport(fmt: 'csv' | 'json' | 'sql' | 'xls') {
    exportOpen = false
    const r = activeResult?.kind === 'rows' ? activeResult.result : undefined
    if (!r) return
    const headers = r.cols.map((c) => c[0])
    const rows = r.rows as Record<string, unknown>[]
    const meta = FMT_META[fmt]
    const filename = `result.${meta.ext}`

    // Desktop: ask where to save first (a real Save dialog into any folder).
    let savePath: string | null = null
    if (IS_TAURI) {
      try {
        const { save } = await import('@tauri-apps/plugin-dialog')
        savePath = await save({ defaultPath: filename, filters: [{ name: meta.label, extensions: [meta.ext] }] })
      } catch (e) {
        toasts.error(String(e))
        return
      }
      if (!savePath) return // user cancelled
    }

    exportJob = { name: savePath ?? filename, pct: 0, rows: rows.length, done: false }
    try {
      const content = await serialize(fmt, headers, rows, (done) => {
        if (exportJob) exportJob.pct = Math.round(done * 90)
      })
      if (IS_TAURI && savePath) {
        await ipc.writeTextFile(savePath, content)
      } else {
        download(filename, content, meta.mime)
      }
      if (exportJob) {
        exportJob.pct = 100
        exportJob.done = true
        exportJob.path = savePath ?? filename
      }
      toasts.success(`Exported ${rows.length.toLocaleString()} row${rows.length === 1 ? '' : 's'} → ${savePath ?? filename}`)
      // auto-dismiss the overlay shortly after completion
      const job = exportJob
      setTimeout(() => {
        if (exportJob === job) exportJob = null
      }, 1400)
    } catch (e) {
      if (exportJob) exportJob.error = String(e)
      toasts.error(`Export failed: ${e}`)
    }
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
    exec && exec.activeSub >= 0 ? exec.subResults[exec.activeSub] : undefined,
  )

  function stripN(label: string): string {
    return label.replace(/^#\d+\s*/, '')
  }

  function selectSub(idx: number) {
    if (!exec) return
    planActive = false
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
    {#each exec?.subResults ?? [] as sub, idx (sub.index)}
      {@const on = !planActive && exec?.activeSub === idx}
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
    {#if (exec?.subResults.length ?? 0) > 0}
      {@const on = !planActive && exec?.activeSub === MESSAGES}
      <div
        onclick={() => { if (exec) { planActive = false; exec.activeSub = MESSAGES } }}
        onkeydown={(e) => { if (e.key === 'Enter' && exec) { planActive = false; exec.activeSub = MESSAGES } }}
        role="tab"
        aria-selected={on}
        tabindex="0"
        style="display:flex;align-items:center;gap:var(--px-6);padding:var(--px-7) var(--px-13);cursor:pointer;font-size:var(--px-11_5);white-space:nowrap;border-bottom:var(--px-2) solid {on ? accent : 'transparent'};background:{on ? 'var(--surface)' : 'transparent'};color:{on ? 'var(--text)' : 'var(--text2)'}"
      >
        <span style="color:var(--muted)">≣</span>
        <span style="font-weight:{on ? 700 : 500}">Messages</span>
      </div>
    {/if}
    {#if explain}
      <div
        onclick={() => (planActive = true)}
        onkeydown={(e) => e.key === 'Enter' && (planActive = true)}
        role="tab"
        aria-selected={planActive}
        tabindex="0"
        style="display:flex;align-items:center;gap:var(--px-6);padding:var(--px-7) var(--px-13);cursor:pointer;font-size:var(--px-11_5);white-space:nowrap;border-bottom:var(--px-2) solid {planActive ? accent : 'transparent'};background:{planActive ? 'var(--surface)' : 'transparent'};color:{planActive ? 'var(--text)' : 'var(--text2)'}"
      >
        <span style="color:var(--muted)">⚡</span>
        <span style="font-weight:{planActive ? 700 : 500}">Query Plan</span>
      </div>
    {/if}
    {#if exec?.running}
      <span style="display:flex;align-items:center;padding:0 var(--px-13);font-size:var(--px-11);color:var(--text2)">Running…</span>
    {/if}
  </div>

  <!-- result toolbar — dòng 342-349 -->
  {#if !planActive && activeResult?.kind === 'rows' && activeResult.result}
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
      {#if activeResult?.cqlNextPage}
        <span
          onclick={() => exec && onLoadMore?.(exec.activeSub)}
          onkeydown={(e) => e.key === 'Enter' && exec && onLoadMore?.(exec.activeSub)}
          role="button"
          tabindex="0"
          title="Fetch the next page from Cassandra (paging state)"
          style="font-size:var(--px-11);color:var(--text2);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-3) var(--px-10);cursor:pointer"
        >↓ Load next page</span>
      {/if}
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
              <div class="exp-item" onclick={() => doExport(fmt as 'csv' | 'json' | 'sql' | 'xls')} onkeydown={(e) => e.key === 'Enter' && doExport(fmt as 'csv' | 'json' | 'sql' | 'xls')} role="button" tabindex="0" style="padding:var(--px-7) var(--px-12);font-size:var(--px-12);cursor:pointer;color:var(--text2)">{label}</div>
            {/each}
            <div class="exp-item" onclick={openExportWizard} onkeydown={(e) => e.key === 'Enter' && openExportWizard()} role="button" tabindex="0" style="padding:var(--px-7) var(--px-12);font-size:var(--px-12);cursor:pointer;color:var(--text2);border-top:var(--px-1) solid var(--border)">Custom… (columns/limit)</div>
          </div>
        {/if}
      </div>
    </div>
  {/if}

  <!-- content -->
  <div style="min-height:0;flex:1;display:flex;flex-direction:column;background:var(--surface)">
    {#if planActive && explain}
      <ResultPlanView
        {explain}
        {capability}
        onToggleActual={onExplainActual}
        onReExplain={onExplainReExplain}
        onClose={() => {
          planActive = false
          onExplainClose?.()
        }}
      />
    {:else if exec?.activeSub === MESSAGES}
      <div class="selectable" style="flex:1;overflow-y:auto;padding:var(--px-4);font-size:var(--px-12)">
        {#each exec?.messages ?? [] as msg (msg.index)}
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
        {#if (exec?.messages.length ?? 0) === 0}
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

{#if exportJob}
  <!-- export progress overlay — running bar → done ✓ (or error) -->
  <div role="presentation" style="position:fixed;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:80">
    <div role="dialog" aria-modal="true" tabindex="-1" style="width:var(--px-420);max-width:92vw;background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);box-shadow:0 var(--px-24) var(--px-60) var(--rgba-0-0-0-_55);padding:var(--px-18)">
      <div style="display:flex;align-items:center;gap:var(--px-9);margin-bottom:var(--px-10)">
        <span style="font-size:var(--px-15);color:{exportJob.error ? 'var(--error)' : exportJob.done ? 'var(--success)' : 'var(--primary)'}">{exportJob.error ? '✗' : exportJob.done ? '✓' : '⭳'}</span>
        <span style="font-size:var(--px-13_5);font-weight:600;color:var(--text)">{exportJob.error ? 'Export failed' : exportJob.done ? 'Export complete' : 'Exporting…'}</span>
        {#if exportJob.done || exportJob.error}
          <span onclick={() => (exportJob = null)} onkeydown={(e) => e.key === 'Enter' && (exportJob = null)} role="button" tabindex="0" style="margin-left:auto;cursor:pointer;color:var(--muted);font-size:var(--px-18)">×</span>
        {/if}
      </div>
      <div class="mono" style="font-size:var(--px-11_5);color:var(--text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:var(--px-8)">{exportJob.path ?? exportJob.name} · {exportJob.rows.toLocaleString()} rows</div>
      {#if exportJob.error}
        <div class="mono" style="font-size:var(--px-11_5);color:var(--error);white-space:pre-wrap;word-break:break-word">{exportJob.error}</div>
      {:else}
        <div style="height:var(--px-8);border-radius:var(--px-6);background:var(--panel);overflow:hidden;border:var(--px-1) solid var(--border)">
          <div style="height:100%;width:{exportJob.pct}%;background:var(--primary);transition:width .15s ease"></div>
        </div>
        <div class="mono" style="font-size:var(--px-11);color:var(--muted);text-align:right;margin-top:var(--px-5)">{exportJob.pct}%</div>
      {/if}
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
  /* Export menu — blue highlight on hover (DataGrip-style). */
  .exp-item:hover {
    background: var(--primary);
    color: var(--hex-fff) !important;
  }
</style>
