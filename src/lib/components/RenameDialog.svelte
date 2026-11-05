<script lang="ts">
  // The one Rename popup (table · database · schema · function · procedure). The
  // caller describes the object through `renameWizard.open(...)`; this dialog does
  // the rest: new-name field focused with the name selected, checks it before
  // anything is sent (empty, unchanged, already used, too long for the engine),
  // shows the exact statement, runs it, and keeps a server refusal on screen.
  // Backdrop click does NOT close (rule chung for form popups); Escape / Cancel do.
  import { untrack } from 'svelte'
  import Icon from '$lib/components/Icon.svelte'
  import { renameWizard, type RenameRequest } from '$lib/stores/rename.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { highlightSql, sqlTokenColor } from '$lib/format/sql'
  import { dbIcon } from '$lib/explorer/icons'
  import { isRunnable, oracleName } from '$lib/sql/rename'
  import { systemMeta } from '$lib/systems'
  import '$lib/components/workspace/users/um.css'

  let req = $state.raw<RenameRequest | null>(null)
  let to = $state('')
  let running = $state(false)
  let error = $state<string | null>(null)

  // Reset the form whenever a new request comes in (read once, not tracked).
  $effect(() => {
    const r = renameWizard.req
    untrack(() => {
      req = r
      to = r?.name ?? ''
      running = false
      error = null
    })
  })

  const KIND_LABEL: Record<string, string> = {
    table: 'table',
    database: 'database',
    schema: 'schema',
    function: 'function',
    procedure: 'procedure',
  }
  // Identifier length limits that engines enforce (PostgreSQL silently truncates
  // past 63 bytes, which would rename to something the user did not type).
  const MAX_LEN: Record<string, number> = { postgres: 63, mysql: 64, mariadb: 64, mssql: 128, oracle: 128 }

  const label = $derived(req ? KIND_LABEL[req.kind] : '')
  const target = $derived(to.trim())
  const effective = $derived(req?.system === 'oracle' ? oracleName(target) : target)
  const supported = $derived(!!req && isRunnable(req.build(`${req.name}_new`)))
  const sql = $derived(req ? req.build(target || `${req.name}_new`) : '')
  const unchanged = $derived(!!req && effective === req.name)
  const taken = $derived(
    !!req && !!target && !unchanged && (req.taken ?? []).some((n) => n.toLowerCase() === effective.toLowerCase()),
  )
  const limit = $derived(req ? MAX_LEN[req.system] : undefined)
  const tooLong = $derived(!!limit && new TextEncoder().encode(effective).length > limit)
  const canRun = $derived(supported && !!target && !unchanged && !taken && !tooLong && !running)
  const engine = $derived(req ? systemMeta(req.system).label : '')
  /** what the engine says when it cannot rename, without the SQL comment markers */
  const explanation = $derived(
    supported ? '' : (req?.build(`${req.name}_new`) ?? '').split('\n').map((l) => l.replace(/^\s*--\s?/, '')).join(' ').trim(),
  )

  function close() {
    if (!running) renameWizard.close()
  }

  async function run() {
    const r = req
    if (!r || !canRun) return
    running = true
    error = null
    const statement = r.build(target)
    try {
      const err = await r.run(statement, effective)
      if (err) {
        error = err
        running = false
        return
      }
      running = false
      toasts.success(`Renamed ${label} “${r.name}” to “${effective}”`, r.system)
      renameWizard.close()
    } catch (e) {
      error = String(e)
      running = false
    }
  }

  function openInTab() {
    const r = req
    if (!r) return
    // an unchanged name would give "rename X to X" — use the editable placeholder
    r.openInTab(r.build(target && target !== r.name ? target : `${r.name}_new`))
    renameWizard.close()
  }

  async function copySql() {
    try {
      await navigator.clipboard.writeText(sql)
      toasts.success('SQL copied')
    } catch {
      /* clipboard unavailable — the statement is selectable */
    }
  }

  /** focus the field with the name selected, so typing replaces it */
  function focusSelect(node: HTMLInputElement) {
    requestAnimationFrame(() => {
      node.focus()
      node.select()
    })
  }
</script>

{#if req}
  <div onkeydown={(e) => e.key === 'Escape' && close()} role="presentation" class="um-backdrop">
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Rename ${label}`}
      tabindex="-1"
      class="um-dlg"
      style="width:var(--px-520)"
      onkeydown={(e) => e.key === 'Escape' && close()}
    >
      <div class="um-dlg-head">
        <span class="um-dlg-icon">{@html dbIcon(req.kind === 'database' ? 'database' : req.kind, 18) ?? ''}</span>
        <div class="um-dlg-title">
          <b>Rename {label}</b>
          <span title={req.where ?? engine}><span class="mono">{req.name}</span>{req.where ? ` · ${req.where}` : ` · ${engine}`}</span>
        </div>
        <span class="um-dlg-x" onclick={close} onkeydown={(e) => e.key === 'Enter' && close()} role="button" tabindex="0" aria-label="Close" title="Close"><Icon name="close" size={16} /></span>
      </div>

      <div class="um-dlg-body">
        {#if supported}
          <label class="um-field">
            New name
            <input
              id="rn-name"
              use:focusSelect
              bind:value={to}
              disabled={running}
              placeholder={req.name}
              spellcheck="false"
              autocomplete="off"
              class="um-input mono"
              class:invalid={taken || tooLong}
              style="font-size:var(--px-13_5);min-height:var(--px-34)"
              onkeydown={(e) => {
                if (e.key === 'Enter') void run()
              }}
            />
            {#if taken}
              <span class="um-field-err">A {label} named “{effective}” already exists {req.takenScope ?? 'here'}.</span>
            {:else if tooLong}
              <span class="um-field-err">{engine} names are limited to {limit} characters.</span>
            {:else if !target}
              <span class="um-field-err">Type a new name.</span>
            {:else if req.system === 'oracle' && effective !== target}
              <span class="um-field-hint">Oracle stores it as <span class="mono">{effective}</span> (unquoted names are upper case).</span>
            {:else}
              <span class="um-field-hint">Any character is allowed — the name is quoted for you.</span>
            {/if}
          </label>

          {#if req.note}
            <div class="um-callout" style="margin:0"><Icon name="info" size={15} /><span>{req.note}</span></div>
          {/if}

          <div>
            <div class="um-sql-head">
              <Icon name="code" size={13} />SQL that will run
              <span class="um-link" style="margin-left:auto;font-size:var(--px-12)" onclick={copySql} onkeydown={(e) => e.key === 'Enter' && void copySql()} role="button" tabindex="0">Copy</span>
            </div>
            <pre class="um-sql selectable" data-rename-sql>{#each highlightSql(sql) as tk, i (i)}<span style="color:{sqlTokenColor(tk.kind)}">{tk.text}</span>{/each}</pre>
          </div>

          {#if error}
            <div class="um-err" role="alert"><Icon name="warning" size={14} /><span>{error}</span></div>
          {/if}
        {:else}
          <div class="um-callout warn" style="margin:0">
            <Icon name="warning" size={15} />
            <span>{explanation || `${engine} cannot rename this ${label} directly.`}</span>
          </div>
          <span class="um-field-hint">Open it in a SQL tab to see the statement and do it by hand.</span>
        {/if}
      </div>

      <div class="um-dlg-foot">
        <span class="um-dlg-foot-note">{supported ? 'Runs right away.' : ''}</span>
        <span class="um-spacer"></span>
        <span class="cfm-btn" onclick={close} onkeydown={(e) => e.key === 'Enter' && close()} role="button" tabindex="0">Cancel</span>
        <span class="cfm-btn" onclick={openInTab} onkeydown={(e) => e.key === 'Enter' && openInTab()} role="button" tabindex="0" aria-disabled={running}>Open in SQL tab</span>
        {#if supported}
          <span
            class="cfm-btn primary"
            onclick={() => void run()}
            onkeydown={(e) => e.key === 'Enter' && void run()}
            role="button"
            tabindex="0"
            aria-disabled={!canRun}
            aria-busy={running}
          >{running ? 'Renaming…' : 'Rename'}</span>
        {/if}
      </div>
    </div>
  </div>
{/if}
