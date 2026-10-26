<script lang="ts">
  // Redpanda cluster configuration (SPEC-REDPANDA.md R5): every property from the
  // server's own schema, grouped by purpose, searchable, values in words. Changes are
  // collected first, checked with a dry run (Redpanda validates types and ranges), then
  // applied in one request; properties that need a restart say so before and after.
  import { untrack } from 'svelte'
  import Icon from '$lib/components/Icon.svelte'
  import HelpTip from '../HelpTip.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import {
    CONFIG_GROUPS,
    configDraft,
    configRows,
    configValueText,
    filterConfig,
    parseConfigInput,
    parseConfigStatus,
    parseSchema,
    restartSummary,
    rp,
    type ConfigRow,
    type RpConfigStatus,
  } from '$lib/redpanda/admin'
  import { rpCall, rpMessage, RpError } from '$lib/redpanda/client'
  import '$lib/components/workspace/users/um.css'

  let { connId }: { connId: string } = $props()

  let rows = $state<ConfigRow[]>([])
  let status = $state<RpConfigStatus[]>([])
  let loading = $state(false)
  let error = $state<string | null>(null)
  let text = $state('')
  let onlyChanged = $state(false)
  let advanced = $state(false)
  let collapsed = $state<Set<string>>(new Set())

  /** key → typed draft text (edits not yet saved) */
  let drafts = $state<Record<string, string>>({})
  /** keys to put back to their default */
  let resets = $state<Set<string>>(new Set())
  let editing = $state<string | null>(null)
  let saving = $state(false)
  let saveError = $state<string | null>(null)
  let rowErrors = $state<Record<string, string>>({})

  async function load() {
    loading = true
    error = null
    try {
      const [schema, all, explicit, st] = await Promise.all([
        rpCall(connId, rp.configSchema()),
        rpCall<Record<string, unknown>>(connId, rp.config(true)),
        rpCall<Record<string, unknown>>(connId, rp.config(false)),
        rpCall(connId, rp.configStatus()).catch(() => []),
      ])
      rows = configRows(parseSchema(schema), all ?? {}, explicit ?? {})
      status = parseConfigStatus(st)
    } catch (e) {
      error = rpMessage(e)
    } finally {
      loading = false
    }
  }
  $effect(() => {
    void connId
    untrack(() => void load())
  })

  const shown = $derived(filterConfig(rows, { text, onlyChanged, advanced }))
  const groups = $derived(CONFIG_GROUPS.map((g) => ({ ...g, rows: shown.filter((r) => r.group === g.id) })).filter((g) => g.rows.length))
  const changedCount = $derived(rows.filter((r) => r.isSet).length)
  const hiddenAdvanced = $derived(advanced ? 0 : rows.filter((r) => r.visibility !== 'user' && !r.isSet).length)
  const pendingKeys = $derived([...new Set([...Object.keys(drafts), ...resets])])
  const restartNote = $derived(restartSummary(status))

  // parsed drafts (or their problem), live
  const parsed = $derived(
    Object.fromEntries(
      Object.entries(drafts).map(([k, v]) => {
        const row = rows.find((r) => r.key === k)
        return [k, row ? parseConfigInput(row, v) : ({ error: 'Unknown setting' } as const)]
      }),
    ) as Record<string, { value: unknown } | { error: string }>,
  )
  const draftProblems = $derived(Object.entries(parsed).filter(([, p]) => 'error' in p).map(([k, p]) => [k, (p as { error: string }).error] as const))

  function edit(r: ConfigRow) {
    editing = r.key
    if (!(r.key in drafts)) drafts = { ...drafts, [r.key]: configDraft(r, r.value) }
    const n = new Set(resets)
    n.delete(r.key)
    resets = n
  }
  function setBool(r: ConfigRow, v: boolean) {
    drafts = { ...drafts, [r.key]: String(v) }
    const n = new Set(resets)
    n.delete(r.key)
    resets = n
  }
  function discard(key: string) {
    const d = { ...drafts }
    delete d[key]
    drafts = d
    const n = new Set(resets)
    n.delete(key)
    resets = n
    if (editing === key) editing = null
    const e = { ...rowErrors }
    delete e[key]
    rowErrors = e
  }
  function reset(r: ConfigRow) {
    const d = { ...drafts }
    delete d[r.key]
    drafts = d
    resets = new Set([...resets, r.key])
    if (editing === r.key) editing = null
  }
  function discardAll() {
    drafts = {}
    resets = new Set()
    editing = null
    rowErrors = {}
    saveError = null
  }

  async function save() {
    if (saving || draftProblems.length || pendingKeys.length === 0) return
    const upsert: Record<string, unknown> = {}
    for (const [k, p] of Object.entries(parsed)) if ('value' in p) upsert[k] = p.value
    const remove = [...resets]
    saving = true
    saveError = null
    rowErrors = {}
    try {
      // a dry run first: Redpanda checks types and ranges without changing anything
      await rpCall(connId, rp.setConfig(upsert, remove, true))
      const r = await rpCall<{ config_version?: number }>(connId, rp.setConfig(upsert, remove))
      const restart = pendingKeys.some((k) => rows.find((x) => x.key === k)?.needsRestart)
      toasts.success(`Saved ${pendingKeys.length === 1 ? '1 setting' : `${pendingKeys.length} settings`}${r?.config_version ? ` (version ${r.config_version})` : ''}${restart ? ' — a restart is needed' : ''}`)
      discardAll()
      await load()
    } catch (e) {
      // per-property validation answers come back as { key: "expected type integer" }
      const j = e instanceof RpError ? (e.response.json as Record<string, unknown> | null) : null
      const per = j && !('message' in j) ? Object.entries(j).filter(([, v]) => typeof v === 'string') : []
      if (per.length) rowErrors = Object.fromEntries(per) as Record<string, string>
      saveError = `Redpanda refused the change: ${rpMessage(e)}`
    } finally {
      saving = false
    }
  }

  function toggleGroup(id: string) {
    const n = new Set(collapsed)
    if (n.has(id)) n.delete(id)
    else n.add(id)
    collapsed = n
  }
  const defaultText = (r: ConfigRow) => configValueText(r, r.defaultValue)
</script>

<div class="rc">
  {#if restartNote}
    <div class="um-callout warn" role="status"><Icon name="warning" size={15} /><span><b>Restart needed.</b> {restartNote}</span></div>
  {/if}

  <div class="rc-tools">
    <input class="um-input rc-search" type="search" bind:value={text} placeholder="Search settings by name or description" aria-label="Search settings" />
    <label class="um-checkline"><input type="checkbox" bind:checked={onlyChanged} /> Only changed ({changedCount})</label>
    <label class="um-checkline"><input type="checkbox" bind:checked={advanced} /> Show advanced{hiddenAdvanced ? ` (${hiddenAdvanced} more)` : ''}</label>
    <span class="rc-grow"></span>
    <button type="button" class="eg-btn" onclick={load} disabled={loading}><Icon name="refresh" size={12} /> Refresh</button>
  </div>

  {#if error}
    <div class="um-callout danger" role="alert"><Icon name="warning" size={15} /><span><b>Could not read the cluster configuration.</b> {error}</span></div>
  {:else if loading && rows.length === 0}
    <div class="ds-empty">Reading the configuration…</div>
  {:else if groups.length === 0}
    <div class="ds-empty">{text ? 'No setting matches the search.' : onlyChanged ? 'Every setting has its default value.' : 'No settings.'}</div>
  {:else}
    {#each groups as g (g.id)}
      {@const open = !collapsed.has(g.id) || !!text}
      <section class="rc-group" aria-label={g.title}>
        <button type="button" class="rc-group-head" aria-expanded={open} onclick={() => toggleGroup(g.id)}>
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} />
          <b>{g.title}</b>
          <span class="rc-dim">{g.description}</span>
          <span class="rc-grow"></span>
          <span class="rc-count">{g.rows.length}</span>
        </button>
        {#if open}
          {#each g.rows as r (r.key)}
            {@const pending = r.key in drafts || resets.has(r.key)}
            {@const p = parsed[r.key]}
            <div class="rc-row" class:pending data-key={r.key}>
              <div class="rc-label">
                <span class="rc-name">{r.label} {#if r.description}<HelpTip text={r.description} />{/if}</span>
                <span class="rc-meta">
                  <span class="mono">{r.key}</span>
                  {#if r.needsRestart}<span class="um-badge warn" title="Takes effect after the brokers restart">Restart</span>{/if}
                  {#if r.enterprise}<span class="um-badge info" title="Needs an enterprise license">Enterprise</span>{/if}
                  {#if r.visibility !== 'user'}<span class="um-badge muted" title="An advanced tuning setting">Advanced</span>{/if}
                </span>
              </div>
              <div class="rc-value">
                {#if resets.has(r.key)}
                  <span class="rc-dim">Back to the default ({defaultText(r)}) on save</span>
                  <button type="button" class="rc-link" onclick={() => discard(r.key)}>Undo</button>
                {:else if r.type === 'boolean' && !r.secret}
                  {@const on = r.key in drafts ? drafts[r.key] === 'true' : r.value === true}
                  <label class="rc-switch"><input type="checkbox" class="um-switch" checked={on} onchange={(e) => setBool(r, (e.currentTarget as HTMLInputElement).checked)} aria-label={r.label} /> <span>{on ? 'On' : 'Off'}</span></label>
                  {#if r.key in drafts}<button type="button" class="rc-link" onclick={() => discard(r.key)}>Undo</button>{/if}
                {:else if editing === r.key || r.key in drafts}
                  {#if r.enumValues}
                    <select class="um-select" bind:value={drafts[r.key]} aria-label={r.label}>
                      {#if r.nullable}<option value="">Not set</option>{/if}
                      {#each r.enumValues as v (v)}<option value={v}>{v}</option>{/each}
                    </select>
                  {:else}
                    <input
                      class="um-input mono rc-input"
                      class:invalid={!!p && 'error' in p}
                      type={r.secret ? 'password' : 'text'}
                      bind:value={drafts[r.key]}
                      aria-label={r.label}
                      placeholder={r.nullable ? 'empty = not set' : r.example ?? ''}
                      spellcheck="false"
                    />
                    {#if r.units}<span class="rc-dim">{r.units}</span>{/if}
                  {/if}
                  {#if p && 'value' in p && (r.units || typeof p.value === 'number')}<span class="rc-preview">= {configValueText(r, p.value)}</span>{/if}
                  <button type="button" class="rc-link" onclick={() => discard(r.key)}>Undo</button>
                {:else}
                  <b class="rc-current">{configValueText(r, r.value)}</b>
                  {#if r.isSet}<span class="rc-own" title="Default: {defaultText(r)}">Changed</span>{/if}
                  <button type="button" class="eg-btn" onclick={() => edit(r)} aria-label="Edit {r.label}">Edit</button>
                  {#if r.isSet}<button type="button" class="rc-link" onclick={() => reset(r)}>Use default</button>{/if}
                {/if}
              </div>
              {#if p && 'error' in p}<div class="rc-err">{p.error}</div>{/if}
              {#if rowErrors[r.key]}<div class="rc-err" role="alert">Redpanda: {rowErrors[r.key]}</div>{/if}
            </div>
          {/each}
        {/if}
      </section>
    {/each}
  {/if}
</div>

{#if pendingKeys.length}
  <div class="rc-bar" role="region" aria-label="Unsaved settings">
    <span><b>{pendingKeys.length === 1 ? '1 unsaved change' : `${pendingKeys.length} unsaved changes`}</b>
      {#if pendingKeys.some((k) => rows.find((x) => x.key === k)?.needsRestart)}<span class="rc-dim"> · some need a restart</span>{/if}</span>
    {#if saveError}<span class="rc-err" role="alert">{saveError}</span>{:else if draftProblems.length}<span class="rc-err">{draftProblems[0][1]}</span>{/if}
    <span class="rc-grow"></span>
    <button type="button" class="cfm-btn" onclick={discardAll} disabled={saving}>Discard</button>
    <button type="button" class="cfm-btn primary" onclick={save} disabled={saving || draftProblems.length > 0}>{saving ? 'Checking and saving…' : 'Save changes'}</button>
  </div>
{/if}

<style>
  .rc {
    display: flex;
    flex-direction: column;
    gap: var(--px-10);
    padding: var(--px-14) var(--px-16);
    overflow: auto;
    flex: 1;
    min-height: 0;
  }
  .rc-tools {
    display: flex;
    align-items: center;
    gap: var(--px-12);
    flex-wrap: wrap;
  }
  .rc-search {
    flex: 0 1 var(--px-300);
    min-width: var(--px-240);
  }
  .rc-grow {
    flex: 1;
  }
  .rc-group {
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-10);
    background: var(--surface);
    overflow: hidden;
    flex: none;
  }
  .rc-group-head {
    width: 100%;
    display: flex;
    align-items: center;
    gap: var(--px-8);
    padding: var(--px-10) var(--px-14);
    border: 0;
    border-bottom: var(--px-1) solid var(--border);
    background: var(--header);
    font-family: var(--font-main);
    color: var(--text);
    text-align: left;
    cursor: pointer;
  }
  .rc-group-head b {
    font-size: var(--px-13);
    white-space: nowrap;
  }
  .rc-group-head .rc-dim {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rc-count {
    font-size: var(--px-11_5);
    color: var(--muted);
  }
  .rc-row {
    display: grid;
    grid-template-columns: minmax(var(--px-240), 1fr) minmax(var(--px-240), 1.1fr);
    gap: var(--px-4) var(--px-14);
    align-items: center;
    padding: var(--px-9) var(--px-14);
    border-bottom: var(--px-1) solid var(--border);
  }
  .rc-row:last-child {
    border-bottom: 0;
  }
  .rc-row:hover {
    background: var(--row-hover);
  }
  .rc-row.pending {
    box-shadow: inset var(--px-3) 0 0 var(--primary);
  }
  .rc-label {
    display: flex;
    flex-direction: column;
    gap: var(--px-2);
    min-width: 0;
  }
  .rc-name {
    display: inline-flex;
    align-items: center;
    gap: var(--px-4);
    font-size: var(--px-13);
    color: var(--text);
  }
  .rc-meta {
    display: flex;
    align-items: center;
    gap: var(--px-6);
    flex-wrap: wrap;
    font-size: var(--px-11);
    color: var(--muted);
  }
  .rc-value {
    display: flex;
    align-items: center;
    gap: var(--px-8);
    flex-wrap: wrap;
    min-width: 0;
  }
  .rc-current {
    font-size: var(--px-13);
    font-weight: 600;
    color: var(--text);
    overflow-wrap: anywhere;
  }
  .rc-own {
    font-size: var(--px-11);
    color: var(--primary);
    border: var(--px-1) solid color-mix(in srgb, var(--primary) 40%, var(--border));
    border-radius: var(--px-9);
    padding: 0 var(--px-7);
  }
  .rc-input {
    width: var(--px-200);
  }
  .rc-preview {
    font-size: var(--px-12);
    color: var(--text2);
  }
  .rc-switch {
    display: inline-flex;
    align-items: center;
    gap: var(--px-8);
    font-size: var(--px-12_5);
    color: var(--text2);
  }
  .rc-dim {
    font-size: var(--px-12);
    color: var(--muted);
  }
  .rc-link {
    border: 0;
    background: transparent;
    padding: var(--px-2) var(--px-4);
    font-family: var(--font-main);
    font-size: var(--px-12);
    color: var(--primary);
    cursor: pointer;
  }
  .rc-err {
    grid-column: 1 / -1;
    font-size: var(--px-12);
    color: var(--danger-text);
  }
  .rc-bar {
    display: flex;
    align-items: center;
    gap: var(--px-10);
    padding: var(--px-10) var(--px-16);
    border-top: var(--px-1) solid var(--border);
    background: var(--surface);
    box-shadow: var(--shadow-sm);
    font-size: var(--px-13);
    color: var(--text);
  }
  .rc-bar .rc-err {
    grid-column: auto;
  }
</style>
