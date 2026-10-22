<script lang="ts">
  // Topic settings as a short form grouped by purpose (SPEC-KAFKA-WORKSPACE.md §3b):
  // values read in words ("7 days", "No limit"), each setting says where its value
  // comes from, the real key name stays in small print, the full list is behind
  // "Advanced". Saving keeps every other value already set on the topic (backend
  // merge — Kafka's AlterConfigs would otherwise reset them).
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import { toasts } from '$lib/stores/toast.svelte'
  import HelpTip from '../HelpTip.svelte'
  import AdvancedToggle from '../AdvancedToggle.svelte'
  import {
    BYTE_UNITS,
    DURATION_UNITS,
    TOPIC_CONFIG_GROUPS,
    fromDraft,
    readableValue,
    sourceLabel,
    toDraft,
    type ConfigField,
    type FieldDraft,
  } from '$lib/stream/kafka-config'

  let { connId, topic }: { connId: string; topic: string } = $props()

  let entries = $state<ipc.KafkaConfigEntry[]>([])
  let loading = $state(false)
  let error = $state<string | null>(null)
  let editing = $state(false)
  let saving = $state(false)
  let saveError = $state<string | null>(null)
  let drafts = $state<Record<string, FieldDraft>>({})
  let resets = $state<Set<string>>(new Set())

  const byKey = $derived(new Map(entries.map((e) => [e.name, e])))

  async function load() {
    loading = true
    error = null
    try {
      entries = await ipc.kafkaTopicConfigs(connId, topic)
    } catch (e) {
      error = String(e)
    } finally {
      loading = false
    }
  }
  $effect(() => {
    void topic
    untrack(() => {
      editing = false
      void load()
    })
  })

  function startEdit() {
    const d: Record<string, FieldDraft> = {}
    for (const g of TOPIC_CONFIG_GROUPS) for (const f of g.fields) d[f.key] = toDraft(f, byKey.get(f.key)?.value)
    drafts = d
    resets = new Set()
    saveError = null
    editing = true
  }

  function resetField(f: ConfigField) {
    const next = new Set(resets)
    next.add(f.key)
    resets = next
  }

  async function save() {
    const changes: Record<string, string | null> = {}
    for (const g of TOPIC_CONFIG_GROUPS) {
      for (const f of g.fields) {
        if (resets.has(f.key)) {
          if (byKey.get(f.key)?.source === 'topic') changes[f.key] = null
          continue
        }
        const r = fromDraft(f, drafts[f.key])
        if ('error' in r) {
          saveError = r.error
          return
        }
        if (r.value !== (byKey.get(f.key)?.value ?? null)) changes[f.key] = r.value
      }
    }
    if (Object.keys(changes).length === 0) {
      editing = false
      return
    }
    saving = true
    saveError = null
    try {
      await ipc.kafkaAlterTopicConfigs(connId, topic, changes)
      toasts.success(`Saved ${Object.keys(changes).length === 1 ? '1 setting' : `${Object.keys(changes).length} settings`} of ${topic}`)
      editing = false
      await load()
    } catch (e) {
      saveError = `Kafka refused the change: ${e}`
    } finally {
      saving = false
    }
  }
</script>

<div class="tc">
  <div class="tc-head">
    <span class="ds-section-title">Settings</span>
    <span style="flex:1"></span>
    {#if editing}
      <button type="button" class="cfm-btn" onclick={() => (editing = false)} disabled={saving}>Cancel</button>
      <button type="button" class="cfm-btn primary" onclick={save} disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</button>
    {:else}
      <button type="button" class="cfm-btn" onclick={startEdit} disabled={loading || !!error}>Edit settings</button>
    {/if}
  </div>

  {#if error}
    <div class="ds-empty tc-error" role="alert"><b>Could not read the settings</b>{error} <button type="button" class="tc-link" onclick={load}>Try again</button></div>
  {:else if loading && entries.length === 0}
    <div class="ds-empty">Reading settings…</div>
  {:else}
    {#if saveError}<div class="tc-note" role="alert">{saveError}</div>{/if}
    {#each TOPIC_CONFIG_GROUPS as g (g.id)}
      <section class="tc-group" aria-label={g.title}>
        <div class="tc-group-head"><b>{g.title}</b><span>{g.description}</span></div>
        {#each g.fields as f (f.key)}
          {@const e = byKey.get(f.key)}
          <div class="tc-row">
            <div class="tc-label">
              <span class="tc-name">{f.label} <HelpTip text={f.help} /></span>
              <span class="tc-key mono">{f.key}</span>
            </div>
            {#if editing}
              <div class="tc-edit">
                {#if resets.has(f.key)}
                  <span class="tc-dim">Back to the default on save</span>
                  <button type="button" class="tc-link" onclick={() => { const n = new Set(resets); n.delete(f.key); resets = n }}>Undo</button>
                {:else if f.kind === 'choice'}
                  <select class="ds-control" bind:value={drafts[f.key].amount} aria-label={f.label}>
                    {#each f.options ?? [] as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
                  </select>
                {:else}
                  {#if f.unlimited}
                    <label class="tc-check"><input type="checkbox" bind:checked={drafts[f.key].unlimited} /> {f.kind === 'duration' ? 'Forever' : 'No limit'}</label>
                  {/if}
                  {#if !(f.unlimited && drafts[f.key].unlimited)}
                    <input class="ds-control ds-num tc-amount" type="number" min="1" bind:value={drafts[f.key].amount} aria-label={f.label} />
                    {#if f.kind === 'duration'}
                      <select class="ds-control" bind:value={drafts[f.key].unit} aria-label="{f.label} unit">
                        {#each DURATION_UNITS as u (u.value)}<option value={u.value}>{u.label}</option>{/each}
                      </select>
                    {:else if f.kind === 'bytes'}
                      <select class="ds-control" bind:value={drafts[f.key].unit} aria-label="{f.label} unit">
                        {#each BYTE_UNITS as u (u.value)}<option value={u.value}>{u.label}</option>{/each}
                        {#if drafts[f.key].unit === 'B'}<option value="B">bytes</option>{/if}
                      </select>
                    {/if}
                  {/if}
                  {#if e?.source === 'topic'}
                    <button type="button" class="tc-link" onclick={() => resetField(f)}>Use default</button>
                  {/if}
                {/if}
              </div>
            {:else}
              <div class="tc-value">
                <b>{readableValue(f, e?.value)}</b>
                {#if e}<span class="tc-source" class:own={e.source === 'topic'}>{sourceLabel(e.source)}</span>{/if}
              </div>
            {/if}
          </div>
        {/each}
      </section>
    {/each}

    <AdvancedToggle label="Advanced: every setting ({entries.length})">
      <div class="tc-all">
        <table class="ds-table">
          <thead><tr><th>Key</th><th>Value</th><th>Comes from</th></tr></thead>
          <tbody>
            {#each entries as e (e.name)}
              <tr><td class="mono">{e.name}</td><td class="mono">{e.is_sensitive ? '(hidden)' : e.value ?? '—'}</td><td>{sourceLabel(e.source)}</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
    </AdvancedToggle>
  {/if}
</div>

<style>
  .tc {
    display: flex;
    flex-direction: column;
    gap: var(--px-12);
  }
  .tc-head {
    display: flex;
    align-items: center;
    gap: var(--px-8);
  }
  .tc-group {
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-10);
    background: var(--surface);
    overflow: hidden;
  }
  .tc-group-head {
    display: flex;
    flex-direction: column;
    gap: var(--px-2);
    padding: var(--px-10) var(--px-14);
    border-bottom: var(--px-1) solid var(--border);
    background: var(--header);
  }
  .tc-group-head b {
    font-size: var(--px-13);
    color: var(--text);
  }
  .tc-group-head span {
    font-size: var(--px-12);
    color: var(--muted);
  }
  .tc-row {
    display: flex;
    align-items: center;
    gap: var(--px-12);
    padding: var(--px-10) var(--px-14);
    border-bottom: var(--px-1) solid var(--border);
    flex-wrap: wrap;
  }
  .tc-row:last-child {
    border-bottom: 0;
  }
  .tc-label {
    flex: 1 1 var(--px-200);
    display: flex;
    flex-direction: column;
    gap: var(--px-2);
    min-width: 0;
  }
  .tc-name {
    display: inline-flex;
    align-items: center;
    gap: var(--px-4);
    font-size: var(--px-13);
    color: var(--text);
  }
  .tc-key {
    font-size: var(--px-11);
    color: var(--muted);
  }
  .tc-value {
    display: flex;
    align-items: center;
    gap: var(--px-8);
  }
  .tc-value b {
    font-size: var(--px-13);
    font-weight: 600;
    color: var(--text);
  }
  .tc-source {
    font-size: var(--px-11);
    color: var(--muted);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-9);
    padding: 0 var(--px-7);
  }
  .tc-source.own {
    color: var(--primary);
    border-color: color-mix(in srgb, var(--primary) 40%, var(--border));
  }
  .tc-edit {
    display: flex;
    align-items: center;
    gap: var(--px-8);
    flex-wrap: wrap;
  }
  .tc-amount {
    width: var(--px-90);
  }
  .tc-check {
    display: inline-flex;
    align-items: center;
    gap: var(--px-6);
    font-size: var(--px-12_5);
    color: var(--text2);
  }
  .tc-link {
    border: 0;
    background: transparent;
    padding: var(--px-2) var(--px-4);
    font-family: var(--font-main);
    font-size: var(--px-12);
    color: var(--primary);
    cursor: pointer;
  }
  .tc-dim {
    font-size: var(--px-12_5);
    color: var(--muted);
  }
  .tc-note {
    padding: var(--px-10) var(--px-12);
    border-radius: var(--px-8);
    background: var(--danger-soft);
    color: var(--danger-text);
    font-size: var(--px-12_5);
  }
  .tc-error {
    color: var(--danger-text);
  }
  .tc-all {
    max-height: var(--px-300);
    overflow: auto;
  }
</style>
