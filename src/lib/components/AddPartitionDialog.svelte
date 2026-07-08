<script lang="ts">
  // Add Partition dialog — structured form + live, syntax-highlighted script that
  // runs on the connection (PG/MySQL/MariaDB) or opens as a template (MSSQL/CH).
  // Introspects the table's current partitioning to pick the right inputs.
  import { addPartitionWizard } from '$lib/stores/addpartition.svelte'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import * as ipc from '$lib/ipc'
  import {
    buildAddPartition,
    addPartitionTemplate,
    parsePartitionMethod,
    partitionKeyColumns,
    type PartStrategy,
  } from '$lib/sql/partitions'
  import { highlightSql, sqlTokenColor } from '$lib/format/sql'

  // Effect-mirror the store's open flag (reliable cross-component tracking).
  let dlgOpen = $state(false)
  let loadedFor = ''
  $effect(() => {
    dlgOpen = addPartitionWizard.open
    const cid = addPartitionWizard.connId
    const key = `${cid}:${addPartitionWizard.schema}:${addPartitionWizard.table}`
    if (dlgOpen && cid && key !== loadedFor) {
      loadedFor = key
      void load()
    }
    if (!dlgOpen) loadedFor = ''
  })

  let loading = $state(false)
  let partitioned = $state(false)
  let strategy = $state<PartStrategy>('RANGE')
  let keyCols = $state('')
  let existing = $state<string[]>([])
  let pName = $state('')
  let pFrom = $state('')
  let pTo = $state('')
  let pValue = $state('')
  let busy = $state(false)
  let err = $state<string | null>(null)

  const system = $derived(addPartitionWizard.system)
  const rangePg = $derived(strategy === 'RANGE' && system === 'postgres')
  const canRun = $derived(system === 'postgres' || system === 'mysql' || system === 'mariadb')

  async function load() {
    loading = true
    err = null
    partitioned = false
    existing = []
    pName = ''
    pFrom = ''
    pTo = ''
    pValue = ''
    try {
      const parts = await ipc.listPartitions(addPartitionWizard.connId!, addPartitionWizard.schema, addPartitionWizard.table)
      if (parts.length) {
        partitioned = true
        strategy = parsePartitionMethod(parts[0].method).strategy
        keyCols = partitionKeyColumns(parts[0].key ?? '')
        existing = parts.map((p) => p.name)
        pName = `${addPartitionWizard.table}_p${parts.length}`
      }
    } catch (e) {
      err = String(e)
    } finally {
      loading = false
    }
  }

  const bound = $derived.by(() => {
    if (rangePg) return pFrom.trim() && pTo.trim() ? `FROM (${pFrom.trim()}) TO (${pTo.trim()})` : ''
    return pValue.trim()
  })

  const built = $derived(
    pName.trim() && bound
      ? buildAddPartition(system, addPartitionWizard.schema, addPartitionWizard.table, strategy, { name: pName.trim(), bound })
      : null,
  )
  const sql = $derived(built?.sql ?? '')
  const warning = $derived(built?.warning ?? '')

  async function run() {
    if (!sql || busy) return
    busy = true
    err = null
    try {
      const res = await ipc.execStatement(addPartitionWizard.connId!, sql, 0)
      if (!res.ok) {
        err = res.error?.message ?? 'error'
        return
      }
      toasts.success(`Partition ${pName} added`)
      await explorer
        .refresh(addPartitionWizard.connId!, { kind: 'table', schema: addPartitionWizard.schema, table: addPartitionWizard.table })
        .catch(() => {})
      addPartitionWizard.close()
    } catch (e) {
      err = String(e)
    } finally {
      busy = false
    }
  }

  function openInTab() {
    const query = sql || addPartitionTemplate(system, addPartitionWizard.schema, addPartitionWizard.table)
    const t = tabs.openSqlTab({ connectionId: addPartitionWizard.connId!, title: `Add partition · ${addPartitionWizard.table}`, query })
    if (addPartitionWizard.database) {
      t.state.database = addPartitionWizard.database
      tabs.schedulePersist()
    }
    addPartitionWizard.close()
  }

  const inp =
    'background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-9);color:var(--text);font-size:var(--px-12_5);outline:none'
</script>

{#if dlgOpen}
  <!-- backdrop click does NOT close (avoid losing input); use × / Cancel / Escape -->
  <div onkeydown={(e) => e.key === 'Escape' && !busy && addPartitionWizard.close()} role="presentation" style="position:fixed;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:56">
    <div onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.key === 'Escape' && !busy && addPartitionWizard.close()} role="dialog" aria-modal="true" tabindex="-1" style="width:var(--px-620);max-width:95vw;max-height:90vh;background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);box-shadow:0 var(--px-30) var(--px-70) var(--rgba-0-0-0-_55);overflow:hidden;display:flex;flex-direction:column">
      <div style="flex:none;display:flex;align-items:center;gap:var(--px-10);padding:var(--px-15) var(--px-18);border-bottom:var(--px-1) solid var(--border)">
        <span style="color:var(--hex-56b6c2);font-size:var(--px-15)">▤</span>
        <span style="font-weight:700;font-size:var(--px-15)">Add Partition · {addPartitionWizard.schema}.{addPartitionWizard.table}</span>
        <span onclick={() => !busy && addPartitionWizard.close()} onkeydown={(e) => e.key === 'Enter' && !busy && addPartitionWizard.close()} role="button" tabindex="0" style="margin-left:auto;cursor:pointer;color:var(--muted);font-size:var(--px-20)">×</span>
      </div>

      <div style="flex:1;overflow:auto;min-height:0;padding:var(--px-16) var(--px-18);display:flex;flex-direction:column;gap:var(--px-12)">
        {#if loading}
          <div class="mono" style="font-size:var(--px-12);color:var(--muted)">Loading current partitioning…</div>
        {:else if !partitioned}
          <div class="mono" style="font-size:var(--px-12_5);color:var(--text2);line-height:1.5">
            <b>{addPartitionWizard.table}</b> is not partitioned. To create a partitioned table use
            <b>New Table → Partitioning</b>, then migrate the data. Partitioning an existing table
            requires recreating it on this engine.
          </div>
        {:else}
          <!-- current partitioning (read-only context) -->
          <div class="mono" style="font-size:var(--px-11_5);color:var(--text2);display:flex;flex-wrap:wrap;gap:var(--px-6) var(--px-14)">
            <span>Strategy <b style="color:var(--text)">{strategy}</b></span>
            {#if keyCols}<span>Key <b style="color:var(--text)">{keyCols}</b></span>{/if}
            <span>Existing <b style="color:var(--text)">{existing.length}</b></span>
          </div>

          {#if strategy === 'HASH'}
            <div class="mono" style="font-size:var(--px-12);color:var(--warn);line-height:1.5">
              This table uses HASH partitioning — new partitions are added by increasing the
              partition count, not by name/bound. Use the SQL editor for that.
            </div>
          {:else}
            <!-- form -->
            <label class="mono" style="display:flex;flex-direction:column;gap:var(--px-4);font-size:var(--px-12);color:var(--text2)">
              Partition name
              <input bind:value={pName} placeholder={`${addPartitionWizard.table}_pN`} style={inp} />
            </label>

            {#if rangePg}
              <div style="display:flex;gap:var(--px-12);flex-wrap:wrap">
                <label class="mono" style="display:flex;flex-direction:column;gap:var(--px-4);font-size:var(--px-12);color:var(--text2);flex:1;min-width:var(--px-160)">
                  From (inclusive)
                  <input bind:value={pFrom} placeholder="'2026-01-01'" style={inp} />
                </label>
                <label class="mono" style="display:flex;flex-direction:column;gap:var(--px-4);font-size:var(--px-12);color:var(--text2);flex:1;min-width:var(--px-160)">
                  To (exclusive)
                  <input bind:value={pTo} placeholder="'2027-01-01'" style={inp} />
                </label>
              </div>
            {:else}
              <label class="mono" style="display:flex;flex-direction:column;gap:var(--px-4);font-size:var(--px-12);color:var(--text2)">
                {strategy === 'LIST' ? 'IN values (comma-separated)' : 'Upper bound (VALUES LESS THAN)'}
                <input bind:value={pValue} placeholder={strategy === 'LIST' ? "'north', 'south'" : '2027'} style={inp} />
              </label>
            {/if}

            <!-- live script (UI + script together) -->
            <div style="display:flex;flex-direction:column;gap:var(--px-4)">
              <span class="mono" style="font-size:var(--px-11);text-transform:uppercase;letter-spacing:.06em;color:var(--muted)">Script</span>
              <pre class="mono" style="margin:0;padding:var(--px-10) var(--px-12);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-8);font-size:var(--px-12);line-height:1.55;white-space:pre-wrap;overflow-x:auto;color:var(--text);min-height:var(--px-40)">{#if sql}{#each highlightSql(sql) as tk}<span style="color:{sqlTokenColor(tk.kind)}">{tk.text}</span>{/each}{:else if warning}<span style="color:var(--warn)">-- {warning}</span>{:else}<span style="color:var(--syntax-comment)">-- fill in the name and bound</span>{/if}</pre>
            </div>
            {#if warning}<div class="mono" style="font-size:var(--px-11_5);color:var(--warn)">⚠ {warning}</div>{/if}
          {/if}
        {/if}
        {#if err}<div class="mono" style="font-size:var(--px-12);color:var(--error)">✗ {err}</div>{/if}
      </div>

      <div style="flex:none;display:flex;gap:var(--px-9);padding:var(--px-13) var(--px-18);border-top:var(--px-1) solid var(--border);background:var(--panel)">
        <span onclick={() => !busy && addPartitionWizard.close()} onkeydown={(e) => e.key === 'Enter' && !busy && addPartitionWizard.close()} role="button" tabindex="0" style="font-size:var(--px-12_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-8) var(--px-16);cursor:pointer">Cancel</span>
        {#if partitioned && strategy !== 'HASH'}
          <span onclick={openInTab} onkeydown={(e) => e.key === 'Enter' && openInTab()} role="button" tabindex="0" style="margin-left:auto;font-size:var(--px-12_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-8) var(--px-16);cursor:pointer">Open in SQL tab</span>
          {#if canRun}
            <span onclick={run} onkeydown={(e) => e.key === 'Enter' && run()} role="button" tabindex="0" aria-disabled={!sql || busy} style="font-size:var(--px-12_5);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-8);padding:var(--px-8) var(--px-18);cursor:{sql && !busy ? 'pointer' : 'not-allowed'};opacity:{sql && !busy ? 1 : 0.5};font-weight:600">{busy ? 'Adding…' : 'Add partition'}</span>
          {/if}
        {/if}
      </div>
    </div>
  </div>
{/if}
