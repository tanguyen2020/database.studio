<script lang="ts">
  // Design Document (MongoDB) — edit a collection's field structure. Loads the
  // sampled fields, lets you rename / drop existing fields and add new ones (with a
  // default), previews the generated updateMany statements, and applies them via
  // mongo_exec. MongoDB is schemaless, so these are bulk field ops across all docs.
  import * as ipc from '$lib/ipc'
  import type { ColumnInfo } from '$lib/types'
  import { designDocWizard } from '$lib/stores/designdoc.svelte'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { buildFieldOps, type MongoFieldOp } from '$lib/mongo/design'
  import { untrack } from 'svelte'

  // Reliable open gate for a class-$state singleton toggled from another component.
  let dlgOpen = $state(false)
  $effect(() => {
    dlgOpen = designDocWizard.open
  })

  let fields = $state<ColumnInfo[]>([])
  let loading = $state(false)
  let busy = $state(false)
  // Edits keyed by original field name.
  let renames = $state<Record<string, string>>({})
  let drops = $state<Set<string>>(new Set())
  // New fields: name + default value (JSON literal, e.g. 0 / "" / null / {}).
  let adds = $state<{ field: string; value: string }[]>([])

  $effect(() => {
    if (!designDocWizard.open) return
    untrack(() => void loadFields())
  })

  async function loadFields() {
    const cid = designDocWizard.connId
    if (!cid) return
    loading = true
    renames = {}
    drops = new Set()
    adds = []
    try {
      fields = await ipc.listColumns(cid, designDocWizard.database, designDocWizard.collection)
    } catch (e) {
      toasts.error(String(e))
      fields = []
    } finally {
      loading = false
    }
  }

  function toggleDrop(name: string) {
    const next = new Set(drops)
    if (next.has(name)) next.delete(name)
    else next.add(name)
    drops = next
  }

  function addRow() {
    adds = [...adds, { field: '', value: '""' }]
  }
  function removeAdd(i: number) {
    adds = adds.filter((_, j) => j !== i)
  }

  /** Parse an add-value as a JSON literal; fall back to the raw string. */
  function parseVal(raw: string): unknown {
    const t = raw.trim()
    if (t === '') return ''
    try {
      return JSON.parse(t)
    } catch {
      return raw
    }
  }

  const ops = $derived.by((): MongoFieldOp[] => {
    const out: MongoFieldOp[] = []
    for (const f of fields) {
      const to = (renames[f.name] ?? '').trim()
      if (to && to !== f.name) out.push({ kind: 'rename', from: f.name, to })
      if (drops.has(f.name)) out.push({ kind: 'drop', field: f.name })
    }
    for (const a of adds) if (a.field.trim()) out.push({ kind: 'add', field: a.field.trim(), value: parseVal(a.value) })
    return out
  })
  const commands = $derived(buildFieldOps(designDocWizard.collection, ops))

  async function apply() {
    const cid = designDocWizard.connId
    if (!cid || commands.length === 0 || busy) return
    busy = true
    try {
      for (const cmd of commands) {
        const res = await ipc.mongoExec(cid, cmd, designDocWizard.database)
        if (!res.ok) {
          toasts.error(res.error?.message ?? 'Field operation failed')
          busy = false
          return
        }
      }
      toasts.success(`Applied ${commands.length} field change${commands.length === 1 ? '' : 's'}`, 'mongodb')
      // refresh the collection's sampled fields in the tree + reload the dialog
      await explorer.loadTableDetail(cid, designDocWizard.database, designDocWizard.collection, true).catch(() => {})
      designDocWizard.close()
    } catch (e) {
      toasts.error(String(e))
    } finally {
      busy = false
    }
  }
</script>

{#if dlgOpen}
  <!-- backdrop click does NOT close (avoid losing edits); use × / Cancel / Escape -->
  <div
    onkeydown={(e) => e.key === 'Escape' && !busy && designDocWizard.close()}
    role="presentation"
    style="position:fixed;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:56"
  >
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
    <div
      onclick={(e) => e.stopPropagation()}
      role="dialog"
      aria-modal="true"
      aria-label="Design Document"
      tabindex="-1"
      style="width:var(--px-560);max-width:94vw;max-height:90vh;background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);box-shadow:0 var(--px-30) var(--px-70) var(--rgba-0-0-0-_55);overflow:hidden;display:flex;flex-direction:column"
    >
      <div style="flex:none;display:flex;align-items:center;gap:var(--px-10);padding:var(--px-15) var(--px-18);border-bottom:var(--px-1) solid var(--border)">
        <span style="font-weight:700;font-size:var(--px-15)">Design Document</span>
        <span class="mono" style="font-size:var(--px-11_5);color:var(--muted)">{designDocWizard.database}.{designDocWizard.collection}</span>
        <span onclick={() => !busy && designDocWizard.close()} onkeydown={(e) => e.key === 'Enter' && designDocWizard.close()} role="button" tabindex="0" style="margin-left:auto;cursor:pointer;color:var(--muted);font-size:var(--px-20)">×</span>
      </div>

      <div style="flex:1;overflow:auto;padding:var(--px-14) var(--px-18);display:flex;flex-direction:column;gap:var(--px-12);min-height:0">
        {#if loading}
          <div style="font-size:var(--px-12);color:var(--muted)">Loading fields…</div>
        {:else}
          <div style="font-size:var(--px-11);font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)">Fields ({fields.length})</div>
          {#if fields.length === 0}
            <div style="font-size:var(--px-12);color:var(--muted)">No sampled fields (empty collection).</div>
          {/if}
          {#each fields as f (f.name)}
            {@const dropped = drops.has(f.name)}
            <div style="display:flex;align-items:center;gap:var(--px-8);{dropped ? 'opacity:.55' : ''}">
              <span class="mono" style="flex:none;width:var(--px-140);font-size:var(--px-12);color:{f.is_pk ? 'var(--sacc-mongo)' : 'var(--text)'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title={f.name}>{f.name}</span>
              <span class="mono" style="flex:none;width:var(--px-64);font-size:var(--px-10_5);color:var(--muted)">{f.data_type}</span>
              <input
                value={renames[f.name] ?? ''}
                oninput={(e) => (renames = { ...renames, [f.name]: e.currentTarget.value })}
                placeholder="rename to…"
                class="mono"
                disabled={dropped || f.name === '_id'}
                style="flex:1;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-8);color:var(--text);font-size:var(--px-11_5);outline:none"
              />
              {#if f.name !== '_id'}
                <label style="flex:none;display:flex;align-items:center;gap:var(--px-4);font-size:var(--px-11);color:var(--text2);cursor:pointer">
                  <input type="checkbox" checked={dropped} onchange={() => toggleDrop(f.name)} /> drop
                </label>
              {/if}
            </div>
          {/each}

          <div style="display:flex;align-items:center;gap:var(--px-8);margin-top:var(--px-4)">
            <span style="font-size:var(--px-11);font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)">Add fields</span>
            <span class="dd-btn" onclick={addRow} onkeydown={(e) => e.key === 'Enter' && addRow()} role="button" tabindex="0">+ Add field</span>
          </div>
          {#each adds as a, i (i)}
            <div style="display:flex;align-items:center;gap:var(--px-8)">
              <input bind:value={a.field} placeholder="field name" class="mono" style="flex:1;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-8);color:var(--text);font-size:var(--px-11_5);outline:none" />
              <input bind:value={a.value} placeholder='default (JSON), e.g. 0 / "" / null' class="mono" style="flex:1;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-8);color:var(--text);font-size:var(--px-11_5);outline:none" />
              <span class="dd-btn" onclick={() => removeAdd(i)} onkeydown={(e) => e.key === 'Enter' && removeAdd(i)} role="button" tabindex="0" title="Remove">×</span>
            </div>
          {/each}

          {#if commands.length > 0}
            <div style="font-size:var(--px-11);font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-top:var(--px-4)">Preview ({commands.length})</div>
            <pre class="mono selectable" style="margin:0;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-8) var(--px-10);font-size:var(--px-11);color:var(--text2);white-space:pre-wrap;max-height:var(--px-160);overflow:auto">{commands.join('\n')}</pre>
          {/if}
        {/if}
      </div>

      <div style="flex:none;display:flex;gap:var(--px-9);padding:var(--px-14) var(--px-18);border-top:var(--px-1) solid var(--border);background:var(--panel)">
        <span onclick={() => !busy && designDocWizard.close()} onkeydown={(e) => e.key === 'Enter' && !busy && designDocWizard.close()} role="button" tabindex="0" style="margin-left:auto;font-size:var(--px-12_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-8) var(--px-16);cursor:pointer">Cancel</span>
        <span onclick={() => void apply()} onkeydown={(e) => e.key === 'Enter' && void apply()} role="button" tabindex="0" style="font-size:var(--px-12_5);font-weight:600;background:var(--primary);color:var(--hex-fff);border-radius:var(--px-8);padding:var(--px-8) var(--px-18);cursor:{commands.length && !busy ? 'pointer' : 'not-allowed'};opacity:{commands.length && !busy ? 1 : 0.5}">{busy ? 'Applying…' : 'Apply'}</span>
      </div>
    </div>
  </div>
{/if}

<style>
  .dd-btn {
    font-size: var(--px-11);
    color: var(--text2);
    background: var(--panel);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-6);
    padding: var(--px-3) var(--px-9);
    cursor: pointer;
  }
  .dd-btn:hover {
    background: var(--hover);
  }
</style>
