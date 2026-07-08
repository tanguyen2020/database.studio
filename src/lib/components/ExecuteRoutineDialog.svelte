<script lang="ts">
  // Execute a stored procedure / function (T28). Collects argument values by
  // signature (IN/INOUT params), formats each as a literal by type, builds the
  // CALL/SELECT, and opens it in a SQL tab ready to run (result → grid).
  import { untrack } from 'svelte'
  import { execRoutineWizard } from '$lib/stores/execroutine.svelte'
  import { connections } from '$lib/stores/connections.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { buildRoutineExec } from '$lib/sql/routines'

  // effect-mirror the store open flag (reliable cross-component tracking; see T31 note)
  let dlgOpen = $state(false)
  $effect(() => {
    dlgOpen = execRoutineWizard.open
  })
  const system = $derived(connections.byId(execRoutineWizard.connId)?.system ?? 'postgres')
  const allParams = $derived(execRoutineWizard.routine?.params ?? [])
  // IN / INOUT params need a value; pure OUT params are filled by the routine.
  const inParams = $derived(allParams.filter((p) => !/^out$/i.test((p.mode ?? '').trim())))
  let vals = $state<Record<string, string>>({})

  $effect(() => {
    if (execRoutineWizard.open) untrack(() => (vals = {}))
  })

  function runIt() {
    const r = execRoutineWizard.routine
    const connId = execRoutineWizard.connId
    if (!r || !connId) return
    // buildRoutineExec handles OUT/INOUT params (session vars / OUTPUT) so procedures
    // with output params run correctly — a plain literal there is rejected (item 7).
    const sql = buildRoutineExec(system, execRoutineWizard.schema, r.kind, r.name, allParams, vals)
    // Open a SQL tab AND run it immediately so the result grid shows the output.
    // Bind it to the routine's database so the CALL/SELECT runs against the right
    // DB (item 3 — Execute must target the correct database of that connection).
    tabs.openSqlTab({
      connectionId: connId,
      title: `${r.name}()`,
      query: sql,
      autoRun: true,
      database: execRoutineWizard.database,
    })
    execRoutineWizard.close()
  }
</script>

{#if dlgOpen && execRoutineWizard.routine}
  {@const r = execRoutineWizard.routine}
  <!-- backdrop click does NOT close (avoid losing input); use × / Cancel / Escape -->
  <div onkeydown={(e) => e.key === 'Escape' && execRoutineWizard.close()} role="presentation" style="position:fixed;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:56">
    <div onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.key === 'Escape' && execRoutineWizard.close()} role="dialog" aria-modal="true" tabindex="-1" style="width:var(--px-460);max-width:94vw;background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);box-shadow:0 var(--px-30) var(--px-70) var(--rgba-0-0-0-_55);overflow:hidden;display:flex;flex-direction:column">
      <div style="flex:none;display:flex;align-items:center;gap:var(--px-10);padding:var(--px-15) var(--px-18);border-bottom:var(--px-1) solid var(--border)">
        <span style="font-weight:700;font-size:var(--px-15)">Execute {r.kind === 'procedure' ? 'procedure' : 'function'} {r.name}</span>
        <span onclick={() => execRoutineWizard.close()} onkeydown={(e) => e.key === 'Enter' && execRoutineWizard.close()} role="button" tabindex="0" style="margin-left:auto;cursor:pointer;color:var(--muted);font-size:var(--px-20)">×</span>
      </div>
      <div style="padding:var(--px-16) var(--px-18);display:flex;flex-direction:column;gap:var(--px-10);max-height:60vh;overflow:auto">
        {#if inParams.length === 0}
          <div style="font-size:var(--px-12);color:var(--muted)">No input parameters.</div>
        {:else}
          {#each inParams as p (p.name)}
            <label style="font-size:var(--px-12);color:var(--text2);display:flex;align-items:center;gap:var(--px-8)">
              <span class="mono" style="width:var(--px-150)">{p.name} <span style="color:var(--muted)">{p.data_type}</span></span>
              <input bind:value={vals[p.name]} placeholder={p.default ?? 'NULL'} class="mono" style="flex:1;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-8);color:var(--text);font-size:var(--px-12)" />
            </label>
          {/each}
        {/if}
      </div>
      <div style="flex:none;display:flex;gap:var(--px-9);padding:var(--px-13) var(--px-18);border-top:var(--px-1) solid var(--border);background:var(--panel)">
        <span onclick={() => execRoutineWizard.close()} onkeydown={(e) => e.key === 'Enter' && execRoutineWizard.close()} role="button" tabindex="0" style="font-size:var(--px-12_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-8) var(--px-16);cursor:pointer">Cancel</span>
        <span onclick={runIt} onkeydown={(e) => e.key === 'Enter' && runIt()} role="button" tabindex="0" style="margin-left:auto;font-size:var(--px-12_5);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-8);padding:var(--px-8) var(--px-18);cursor:pointer;font-weight:600">Execute</span>
      </div>
    </div>
  </div>
{/if}
