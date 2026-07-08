<script lang="ts">
  // Create ClickHouse Materialized View / Dictionary (T30). Guided form + live
  // DDL preview (validated); runs on the connection then refreshes the Explorer.
  import { chCreateWizard } from '$lib/stores/chcreate.svelte'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import * as ipc from '$lib/ipc'
  import { buildCreateDictionary, buildCreateMaterializedView, type DictColumn, type DictLayout } from '$lib/sql/clickhouse_ddl'

  // Effect-mirror the store's open flag into local $state. A bare {#if store.open}
  // (and even $derived) can miss cross-component tracking here; an $effect always
  // subscribes, so this is reliable (see T28/T31 handoff notes).
  let dlgOpen = $state(false)
  $effect(() => {
    dlgOpen = chCreateWizard.open
  })

  // MV fields
  let mvName = $state('')
  let mvTarget = $state('')
  let mvSelect = $state('')
  // Dictionary fields
  let dName = $state('')
  let dCols = $state<DictColumn[]>([{ name: 'id', type: 'UInt64' }, { name: 'value', type: 'String' }])
  let dPk = $state('id')
  let dSource = $state("HTTP(url 'http://host/data' format 'JSONEachRow')")
  let dLayout = $state<DictLayout>('HASHED')
  let dMin = $state(300)
  let dMax = $state(3600)
  let busy = $state(false)
  let err = $state<string | null>(null)

  const LAYOUTS: DictLayout[] = ['FLAT', 'HASHED', 'COMPLEX_KEY_HASHED', 'CACHE', 'DIRECT']

  const ddl = $derived.by(() => {
    try {
      if (chCreateWizard.mode === 'mv') {
        if (!mvName || !mvSelect) return ''
        return buildCreateMaterializedView({ db: chCreateWizard.db, name: mvName, to: mvTarget || undefined, select: mvSelect })
      }
      return buildCreateDictionary({ db: chCreateWizard.db, name: dName, columns: dCols.filter((c) => c.name && c.type), primaryKey: dPk, source: dSource, layout: dLayout, lifetimeMin: dMin, lifetimeMax: dMax })
    } catch {
      return ''
    }
  })

  function addCol() {
    dCols = [...dCols, { name: '', type: 'String' }]
  }

  async function run() {
    const cid = chCreateWizard.connId
    if (!cid || !ddl || busy) return
    busy = true
    err = null
    try {
      const res = await ipc.execStatement(cid, ddl, 0)
      if (!res.ok) {
        err = res.error?.message ?? 'error'
        return
      }
      toasts.success(chCreateWizard.mode === 'mv' ? `Materialized view ${mvName} created` : `Dictionary ${dName} created`, 'clickhouse')
      await explorer.refresh(cid, { kind: 'schema', schema: chCreateWizard.db }).catch(() => {})
      chCreateWizard.close()
    } catch (e) {
      err = String(e)
    } finally {
      busy = false
    }
  }
</script>

{#if dlgOpen}
  <!-- backdrop click does NOT close (avoid losing input); use × / Cancel / Escape -->
  <div onkeydown={(e) => e.key === 'Escape' && !busy && chCreateWizard.close()} role="presentation" style="position:fixed;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:56">
    <div onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.key === 'Escape' && !busy && chCreateWizard.close()} role="dialog" aria-modal="true" tabindex="-1" style="width:var(--px-640);max-width:95vw;max-height:90vh;background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);box-shadow:0 var(--px-30) var(--px-70) var(--rgba-0-0-0-_55);overflow:hidden;display:flex;flex-direction:column">
      <div style="flex:none;display:flex;align-items:center;gap:var(--px-10);padding:var(--px-15) var(--px-18);border-bottom:var(--px-1) solid var(--border)">
        <span style="font-weight:700;font-size:var(--px-15)">Create {chCreateWizard.mode === 'mv' ? 'Materialized View' : 'Dictionary'} · {chCreateWizard.db}</span>
        <span onclick={() => !busy && chCreateWizard.close()} onkeydown={(e) => e.key === 'Enter' && !busy && chCreateWizard.close()} role="button" tabindex="0" style="margin-left:auto;cursor:pointer;color:var(--muted);font-size:var(--px-20)">×</span>
      </div>
      <div style="flex:1;overflow:auto;min-height:0;padding:var(--px-16) var(--px-18);display:flex;flex-direction:column;gap:var(--px-10)">
        {#if chCreateWizard.mode === 'mv'}
          <label style="font-size:var(--px-12);color:var(--text2)">Name <input bind:value={mvName} class="mono" style="margin-left:var(--px-8);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-8);color:var(--text)" /></label>
          <label style="font-size:var(--px-12);color:var(--text2)">TO target (optional) <input bind:value={mvTarget} placeholder="db.target_table" class="mono" style="margin-left:var(--px-8);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-8);color:var(--text)" /></label>
          <label style="font-size:var(--px-12);color:var(--text2)">SELECT
            <textarea bind:value={mvSelect} placeholder="SELECT event_type, count() AS c FROM src GROUP BY event_type" class="mono" style="display:block;margin-top:var(--px-4);width:100%;height:var(--px-90);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-6) var(--px-8);color:var(--text);font-size:var(--px-12)"></textarea>
          </label>
        {:else}
          <label style="font-size:var(--px-12);color:var(--text2)">Name <input bind:value={dName} class="mono" style="margin-left:var(--px-8);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-8);color:var(--text)" /></label>
          <div style="font-size:var(--px-11);color:var(--muted)">Columns</div>
          {#each dCols as c, i (i)}
            <div style="display:flex;gap:var(--px-6)">
              <input bind:value={c.name} placeholder="name" class="mono" style="flex:1;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-3) var(--px-8);color:var(--text);font-size:var(--px-11_5)" />
              <input bind:value={c.type} placeholder="type" class="mono" style="flex:1;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-3) var(--px-8);color:var(--text);font-size:var(--px-11_5)" />
            </div>
          {/each}
          <span class="eg-btn" role="button" tabindex="0" onclick={addCol} onkeydown={(e) => e.key === 'Enter' && addCol()} style="align-self:flex-start">+ column</span>
          <div style="display:flex;gap:var(--px-10);flex-wrap:wrap">
            <label style="font-size:var(--px-12);color:var(--text2)">PRIMARY KEY <input bind:value={dPk} class="mono" style="width:var(--px-90);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-3) var(--px-8);color:var(--text)" /></label>
            <label style="font-size:var(--px-12);color:var(--text2)">LAYOUT
              <select bind:value={dLayout} class="mono" style="background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-3);color:var(--text)">{#each LAYOUTS as l (l)}<option value={l}>{l}</option>{/each}</select>
            </label>
            <label style="font-size:var(--px-12);color:var(--text2)">LIFETIME min <input type="number" bind:value={dMin} style="width:var(--px-70);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-3);color:var(--text)" /></label>
            <label style="font-size:var(--px-12);color:var(--text2)">max <input type="number" bind:value={dMax} style="width:var(--px-70);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-3);color:var(--text)" /></label>
          </div>
          <label style="font-size:var(--px-12);color:var(--text2)">SOURCE
            <input bind:value={dSource} class="mono" style="display:block;margin-top:var(--px-4);width:100%;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-8);color:var(--text);font-size:var(--px-11_5)" />
          </label>
        {/if}
        <div style="font-size:var(--px-11);color:var(--muted)">DDL preview</div>
        <pre class="mono" style="background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-10);font-size:var(--px-11);margin:0;max-height:var(--px-150);overflow:auto;color:var(--text2)">{ddl || '-- fill in the required fields'}</pre>
        {#if err}<div style="font-size:var(--px-12);color:var(--error)">✗ {err}</div>{/if}
      </div>
      <div style="flex:none;display:flex;gap:var(--px-9);padding:var(--px-13) var(--px-18);border-top:var(--px-1) solid var(--border);background:var(--panel)">
        <span onclick={() => !busy && chCreateWizard.close()} onkeydown={(e) => e.key === 'Enter' && !busy && chCreateWizard.close()} role="button" tabindex="0" style="font-size:var(--px-12_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-8) var(--px-16);cursor:pointer">Cancel</span>
        <span onclick={run} onkeydown={(e) => e.key === 'Enter' && run()} role="button" tabindex="0" aria-disabled={!ddl || busy} style="margin-left:auto;font-size:var(--px-12_5);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-8);padding:var(--px-8) var(--px-18);cursor:{ddl && !busy ? 'pointer' : 'not-allowed'};opacity:{ddl && !busy ? 1 : 0.5};font-weight:600">{busy ? 'Creating…' : 'Create'}</span>
      </div>
    </div>
  </div>
{/if}
