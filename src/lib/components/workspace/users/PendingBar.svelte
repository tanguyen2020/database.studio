<script lang="ts">
  // "Pending changes" bar shared by the User Managers. Changes are queued, shown as
  // the exact SQL that will run, and only applied on Apply (Execute) — nothing
  // touches the server before that.
  import { highlightSql, sqlTokenColor } from '$lib/format/sql'
  import CodeView from '$lib/components/editor/CodeView.svelte'

  interface Props {
    /** number of queued statements */
    count: number
    /** the SQL to show, already joined (one statement per line) */
    sql: string
    executing?: boolean
    /** extra context after the count, e.g. "server scope" */
    scope?: string
    onExecute: () => void
    onDiscard: () => void
    /** editor language id → render the SQL in a read-only editor (else highlighted text) */
    language?: string
  }
  let { count, sql, executing = false, scope = '', onExecute, onDiscard, language }: Props = $props()
  let open = $state(true)
</script>

<div class="um-pending" role="region" aria-label="Pending changes">
  <div class="um-pending-head">
    <span class="um-pending-dot" aria-hidden="true"></span>
    <b>Pending changes ({count}){scope ? ` · ${scope}` : ''}</b>
    <span>Nothing is applied until you click Execute.</span>
    <span class="um-spacer"></span>
    <span class="um-link" onclick={() => (open = !open)} onkeydown={(e) => e.key === 'Enter' && (open = !open)} role="button" tabindex="0" style="font-size:var(--px-12)">{open ? 'Hide SQL' : 'Show SQL'}</span>
    <span class="eg-btn" onclick={onDiscard} onkeydown={(e) => e.key === 'Enter' && onDiscard()} role="button" tabindex="0" aria-disabled={executing}>Discard</span>
    <span class="eg-btn primary" onclick={() => !executing && onExecute()} onkeydown={(e) => e.key === 'Enter' && !executing && onExecute()} role="button" tabindex="0" aria-disabled={executing}>{executing ? 'Executing…' : 'Execute'}</span>
  </div>
  {#if open && language}
    <div style="margin:0 var(--px-16) var(--px-12)"><CodeView value={sql} {language} readOnly height="auto" maxHeight={200} ariaLabel="Pending SQL" /></div>
  {:else if open}
    <pre class="um-pending-sql selectable">{#each highlightSql(sql) as tk, i (i)}<span style="color:{sqlTokenColor(tk.kind)}">{tk.text}</span>{/each}</pre>
  {/if}
</div>
