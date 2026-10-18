<script lang="ts">
  // Messages view of the Result panel — the outcome of EVERY statement of the last
  // run in one list: INSERT/UPDATE/DELETE counts, DDL "completed", result sets
  // (with a link to their tab) and errors. Statements that don't return rows have
  // no result tab of their own; they live here.
  //
  // A failure has to answer three questions without opening anything else: WHAT
  // went wrong (a plain title — "Table or view not found" — plus the server's own
  // words and code), WHERE (the statement lines with the reported position marked),
  // and HOW to fix it (the driver's hint or a generic one). Statements the run never
  // reached because of the failure are counted, not silently missing.
  import type { TabExecution } from '$lib/stores/results.svelte'
  import { mapErrorToDocument } from '$lib/sql/errors'
  import { errorExcerpt, explainQueryError } from '$lib/sql/error-explain'
  import { statementPreview, statementVerb } from '$lib/sql/statement-verb'
  import { countRun, outcomeFacts, plural } from '$lib/results/run-summary'
  import { toasts } from '$lib/stores/toast.svelte'
  import type { QueryError } from '$lib/types'

  interface Props {
    exec: TabExecution
    onJump?: (line: number, col: number) => void
    /** open the result tab of statement #index */
    onShowResult?: (index: number) => void
    onRawError?: (raw: string) => void
  }
  let { exec, onJump, onShowResult, onRawError }: Props = $props()

  const c = $derived(countRun(exec.messages, exec.total))
  const failedMsg = $derived(exec.messages.find((m) => !m.ok && m.kind !== 'warning'))
  const cancelled = $derived(exec.cancelled || failedMsg?.error?.code === 'CANCELLED')
  const tone = $derived(exec.running ? 'run' : cancelled ? 'warn' : c.failed ? 'err' : 'ok')
  const facts = $derived(outcomeFacts(c))

  // Internal codes the app itself sets are not server error codes — no chip.
  const INTERNAL = new Set(['CANCELLED', 'CONNECTION_LOST'])
  function codeLabel(err: QueryError): string | null {
    const code = err.code?.trim()
    if (!code || INTERNAL.has(code)) return null
    if (/^ORA-/i.test(code)) return code.toUpperCase()
    if (err.system === 'mssql') return `Error ${code}`
    if (/^[0-9A-Z]{5}$/.test(code) && ['postgres', 'mysql', 'mariadb', 'duckdb'].includes(err.system)) return `SQLSTATE ${code}`
    return `Code ${code}`
  }

  function jump(m: (typeof exec.messages)[number]) {
    if (m.error) {
      const pos = mapErrorToDocument(m.statement, m.error)
      onJump?.(pos.line, pos.col)
    } else {
      onJump?.(m.statement.startLine, m.statement.startCol)
    }
  }

  async function copyError(m: (typeof exec.messages)[number]) {
    if (!m.error) return
    const ex = explainQueryError(m.error)
    const code = codeLabel(m.error)
    const text = [`${ex.title}${code ? ` (${code})` : ''}`, ex.message, '', `Statement #${m.index}:`, m.statement.sql.trim()].join('\n')
    try {
      await navigator.clipboard.writeText(text)
      toasts.success('Error copied')
    } catch {
      toasts.error('Could not copy to the clipboard')
    }
  }
</script>

<div class="rm selectable">
  <div class="rm-summary t-{tone}">
    <span class="rm-dot" aria-hidden="true"></span>
    <span class="rm-headline">
      {#if exec.running}
        Running{exec.total && exec.total > 1 ? ` statement ${Math.min(c.done + 1, exec.total).toLocaleString('en-US')} of ${exec.total.toLocaleString('en-US')}` : ''}…
      {:else if cancelled}
        Cancelled at statement #{failedMsg?.index ?? c.done}
      {:else if c.failed}
        {plural(c.succeeded, 'statement')} succeeded, {c.failed} failed
      {:else}
        {plural(c.succeeded, 'statement')} succeeded
      {/if}
    </span>
    {#each facts as f (f)}<span class="rm-fact">{f}</span>{/each}
    {#if !exec.running && c.notRun}<span class="rm-fact rm-notrun">{plural(c.notRun, 'statement')} not run</span>{/if}
    <span class="rm-time">{exec.totalMs.toLocaleString('en-US')} ms</span>
  </div>

  {#if exec.messages.length === 0}
    <div class="rm-empty">{exec.running ? 'Waiting for the first statement to finish…' : 'No messages yet'}</div>
  {/if}

  <div class="rm-list" role="list">
    {#each exec.messages as m, i (i)}
      {#if m.kind === 'warning'}
        <div class="rm-warn" role="listitem"><span class="rm-warn-label">Warning</span> {m.text.replace(/^⚠\s*/, '')}</div>
      {:else}
        <div class="rm-row msg-row" class:bad={!m.ok} role="listitem">
          <button class="rm-main" onclick={() => jump(m)} title="Show this statement in the editor">
            <span class="rm-status" class:bad={!m.ok} aria-label={m.ok ? 'Succeeded' : 'Failed'}>{m.ok ? '✓' : '✗'}</span>
            <span class="rm-num">#{m.index}</span>
            <span class="rm-verb">{statementVerb(m.statement.sql)}</span>
            <span class="rm-sql mono" title={m.statement.sql}>{statementPreview(m.statement.sql)}</span>
          </button>
          <span class="rm-outcome">
            {#if m.kind === 'rows'}
              <button class="rm-link" onclick={() => onShowResult?.(m.index)} title="Open this result">{m.text} ›</button>
            {:else if m.ok}
              {m.text}
            {:else if m.error?.code === 'CANCELLED'}
              Cancelled
            {:else}
              Failed
            {/if}
          </span>
          <span class="rm-ms">{m.durationMs.toLocaleString('en-US')} ms</span>
        </div>
        {#if m.error}
          {@const ex = explainQueryError(m.error)}
          {@const code = codeLabel(m.error)}
          {@const pos = m.error.position ? mapErrorToDocument(m.statement, m.error) : null}
          {@const excerpt = errorExcerpt(m.statement, m.error)}
          <div class="rm-error" class:soft={ex.category === 'cancelled'} role="listitem" aria-label="Error details">
            <div class="rm-error-head">
              <span class="rm-error-title">{ex.title}</span>
              {#if code}<span class="rm-code mono">{code}</span>{/if}
              {#if pos}<span class="rm-where">line {pos.line}{excerpt?.some((l) => l.caret) ? `, col ${pos.col}` : ''}</span>{/if}
            </div>
            <div class="rm-error-sum">{ex.summary}</div>
            <div class="rm-error-msg mono" aria-label="Server message">{ex.message}</div>
            {#if excerpt}
              <div class="rm-excerpt mono" aria-label="Where the error is">
                {#each excerpt as l (l.line)}
                  <div class="rm-xl" class:hit={l.error}>
                    <span class="rm-xn">{l.line}</span>
                    <span class="rm-xt">{l.text || ' '}{#if l.caret}<span class="rm-caret" aria-hidden="true">{' '.repeat(l.caret - 1)}^</span>{/if}</span>
                  </div>
                {/each}
              </div>
            {/if}
            {#if ex.hint}
              <div class="rm-hint"><span class="rm-hint-label">How to fix</span>{ex.hint}</div>
            {/if}
            <div class="rm-error-actions">
              <button class="rm-link" onclick={() => jump(m)}>{pos ? `Go to line ${pos.line}` : 'Show statement'}</button>
              <button class="rm-link muted" onclick={() => copyError(m)}>Copy error</button>
              <button class="rm-link muted" onclick={() => onRawError?.(m.error?.raw ?? '')}>View raw error</button>
            </div>
          </div>
        {/if}
      {/if}
    {/each}
    {#if !exec.running && c.notRun && (c.failed || cancelled)}
      <div class="rm-skipped" role="listitem">
        {plural(c.notRun, 'statement')} after #{failedMsg?.index ?? c.done} {c.notRun === 1 ? 'was' : 'were'} not run —
        {cancelled ? 'the run was cancelled.' : 'execution stops at the first error. Fix it and run again.'}
      </div>
    {/if}
  </div>
</div>

<style>
  .rm { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; font-size: var(--px-12_5); }
  .rm-summary {
    --tone: var(--sacc-green);
    position: sticky; top: 0; z-index: 1;
    display: flex; align-items: center; gap: var(--px-12); flex-wrap: wrap;
    padding: var(--px-8) var(--px-14);
    background: var(--surface);
    border-bottom: var(--px-1) solid var(--border);
  }
  .rm-summary.t-err { --tone: var(--error); }
  .rm-summary.t-warn { --tone: var(--sacc-amber); }
  .rm-summary.t-run { --tone: var(--primary); }
  .rm-dot { width: var(--px-8); height: var(--px-8); border-radius: 50%; background: var(--tone); flex: none; }
  .rm-headline { font-weight: 600; color: var(--text); }
  .t-err .rm-headline { color: var(--error); }
  .rm-fact { color: var(--text2); }
  .rm-fact::before { content: '·'; margin-right: var(--px-12); color: var(--muted); }
  .rm-notrun { color: var(--sacc-amber); }
  .rm-time { margin-left: auto; color: var(--muted); font-variant-numeric: tabular-nums; }
  .rm-empty { padding: var(--px-14); color: var(--muted); }
  .rm-list { padding: var(--px-4) 0 var(--px-10); }
  .rm-row {
    display: flex; align-items: center; gap: var(--px-12);
    padding: 0 var(--px-14) 0 var(--px-6);
    border-bottom: var(--px-1) solid var(--border);
  }
  .rm-row:hover { background: color-mix(in srgb, var(--primary) 6%, transparent); }
  .rm-row.bad { background: color-mix(in srgb, var(--error) 5%, transparent); }
  .rm-main {
    flex: 1; min-width: 0; display: flex; align-items: center; gap: var(--px-10);
    padding: var(--px-6) var(--px-8); border: none; background: transparent; font: inherit;
    color: inherit; text-align: left; cursor: pointer;
  }
  .rm-status { flex: none; width: var(--px-14); color: var(--sacc-green); font-weight: 700; }
  .rm-status.bad { color: var(--error); }
  .rm-num { flex: none; width: var(--px-28); color: var(--muted); font-variant-numeric: tabular-nums; }
  .rm-verb {
    flex: none; font-size: var(--px-10_5); font-weight: 600; letter-spacing: 0.02em; color: var(--text2);
    background: var(--panel); border: var(--px-1) solid var(--border); border-radius: var(--px-5);
    padding: var(--px-1) var(--px-6);
  }
  .rm-sql { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text2); font-size: var(--px-12); }
  .rm-outcome { flex: none; color: var(--text); white-space: nowrap; }
  .rm-row.bad .rm-outcome { color: var(--error); font-weight: 600; }
  .rm-ms { flex: none; width: var(--px-60); text-align: right; color: var(--muted); font-size: var(--px-11_5); font-variant-numeric: tabular-nums; }
  .rm-link { border: none; background: transparent; padding: 0; font: inherit; color: var(--primary); cursor: pointer; }
  .rm-link:hover { text-decoration: underline; }
  .rm-link.muted { color: var(--text2); }

  .rm-error {
    margin: var(--px-6) var(--px-14) var(--px-8) var(--px-60);
    padding: var(--px-10) var(--px-14) var(--px-10);
    border: var(--px-1) solid color-mix(in srgb, var(--error) 28%, var(--border));
    border-left: var(--px-3) solid var(--error);
    background: color-mix(in srgb, var(--error) 5%, var(--surface));
    border-radius: var(--px-6);
    display: flex; flex-direction: column; gap: var(--px-6);
  }
  .rm-error.soft { border-color: var(--border); border-left-color: var(--sacc-amber); background: var(--surface); }
  .rm-error-head { display: flex; align-items: center; gap: var(--px-8); flex-wrap: wrap; }
  .rm-error-title { font-weight: 700; font-size: var(--px-13); color: var(--error); }
  .rm-error.soft .rm-error-title { color: var(--sacc-amber); }
  .rm-code {
    font-size: var(--px-11); color: var(--text2);
    background: var(--panel); border: var(--px-1) solid var(--border); border-radius: var(--px-5);
    padding: 0 var(--px-6);
  }
  .rm-where { font-size: var(--px-11_5); color: var(--muted); }
  .rm-error-sum { color: var(--text2); font-size: var(--px-12); }
  .rm-error-msg {
    color: var(--text); font-size: var(--px-12); white-space: pre-wrap; word-break: break-word;
    background: var(--raised); border: var(--px-1) solid var(--border); border-radius: var(--px-5);
    padding: var(--px-6) var(--px-10);
  }
  .rm-excerpt {
    font-size: var(--px-12); line-height: 1.55;
    background: var(--panel); border: var(--px-1) solid var(--border); border-radius: var(--px-5);
    padding: var(--px-4) 0; overflow-x: auto;
  }
  .rm-xl { display: flex; white-space: pre; padding-right: var(--px-10); }
  .rm-xl.hit { background: color-mix(in srgb, var(--error) 10%, transparent); }
  .rm-xn {
    flex: none; width: var(--px-40); padding-right: var(--px-10); text-align: right;
    color: var(--muted); user-select: none; font-variant-numeric: tabular-nums;
  }
  .rm-xl.hit .rm-xn { color: var(--error); font-weight: 700; }
  .rm-xt { position: relative; color: var(--text); }
  /* the caret sits on its own line under the error column, in the same mono grid */
  .rm-caret { display: block; color: var(--error); font-weight: 700; }
  .rm-hint { color: var(--text2); font-size: var(--px-12); }
  .rm-hint-label { font-weight: 600; color: var(--text); margin-right: var(--px-6); }
  .rm-hint-label::after { content: ':'; }
  .rm-error-actions { display: flex; gap: var(--px-14); font-size: var(--px-12); }
  .rm-skipped {
    margin: var(--px-2) var(--px-14) var(--px-6) var(--px-60);
    color: var(--sacc-amber); font-size: var(--px-12);
  }
  .rm-warn {
    margin: var(--px-4) var(--px-14);
    padding: var(--px-6) var(--px-10);
    color: var(--text);
    background: color-mix(in srgb, var(--sacc-amber) 9%, transparent);
    border-left: var(--px-3) solid var(--sacc-amber);
    border-radius: var(--px-6);
    font-size: var(--px-12);
  }
  .rm-warn-label { font-weight: 700; color: var(--sacc-amber); margin-right: var(--px-6); }
</style>
