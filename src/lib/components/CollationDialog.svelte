<script lang="ts">
  // Unify Collation… (MySQL/MariaDB). Data-driven: audits information_schema for
  // base tables/columns whose collation differs from a chosen target, then runs
  // ALTER DATABASE + per-table CONVERT TO CHARACTER SET … COLLATE …, wrapped in
  // SET FOREIGN_KEY_CHECKS = 0/1. Stored procedures/functions/views/triggers are
  // NOT modified. Either open the script in a SQL tab to review, or run it here
  // with progress + cancel.
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import { collationWizard } from '$lib/stores/collation.svelte'
  import { connections } from '$lib/stores/connections.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import {
    buildAuditQuery,
    buildCollationsQuery,
    buildDefaultCollationQuery,
    buildUnifySql,
    buildUnifyStatements,
    charsetOf,
    distinctCollations,
    tablesToConvert,
    type TableCollationRow,
  } from '$lib/sql/collation'

  let dlgOpen = $state(false)
  $effect(() => {
    dlgOpen = collationWizard.open
  })

  const system = $derived(connections.byId(collationWizard.connId)?.system ?? 'mysql')

  let target = $state('utf8mb4_0900_ai_ci')
  let collations = $state<string[]>([])
  let auditRows = $state<TableCollationRow[]>([])
  let loading = $state(false)
  let running = $state(false)
  let cancelFlag = $state(false)
  let progress = $state(0)
  let result = $state<string | null>(null)

  const affected = $derived(tablesToConvert(auditRows, target))
  const present = $derived(distinctCollations(auditRows))
  const sql = $derived(buildUnifySql(system, collationWizard.database, target, affected))

  $effect(() => {
    if (collationWizard.open) untrack(() => void init())
  })

  async function rows(query: string): Promise<Record<string, unknown>[]> {
    if (!collationWizard.connId) return []
    const res = await ipc.execStatement(collationWizard.connId, query, 0).catch(() => null)
    return res?.ok ? ((res.result?.rows ?? []) as Record<string, unknown>[]) : []
  }

  async function init() {
    running = false
    cancelFlag = false
    progress = 0
    result = null
    loading = true
    auditRows = []
    collations = []
    const db = collationWizard.database
    try {
      // 1. Database default → seeds the target + the charset we list collations for.
      const def = (await rows(buildDefaultCollationQuery(db)))[0]
      const defColl = String(def?.collation ?? '') || 'utf8mb4_0900_ai_ci'
      target = defColl
      const charset = charsetOf(defColl) || 'utf8mb4'
      // 2. Available collations for that charset (dropdown).
      const coll = await rows(buildCollationsQuery(charset))
      collations = coll.map((r) => String(r.name)).filter(Boolean)
      if (!collations.includes(target)) collations = [target, ...collations]
      // 3. Audit every base table.
      auditRows = (await rows(buildAuditQuery(db))).map((r) => ({
        table_name: String(r.table_name ?? ''),
        table_collation: String(r.table_collation ?? ''),
        column_collations: r.column_collations == null ? null : String(r.column_collations),
      }))
    } finally {
      loading = false
    }
  }

  function openInTab() {
    tabs.openSqlTab({
      connectionId: collationWizard.connId,
      title: `Unify collation · ${collationWizard.database}`,
      query: sql,
      database: collationWizard.database,
      activate: true,
    })
    collationWizard.close()
  }

  async function run() {
    const connId = collationWizard.connId
    if (!connId) return
    const stmts = buildUnifyStatements(system, collationWizard.database, target, affected)
    if (!stmts.length) return
    running = true
    cancelFlag = false
    progress = 0
    result = null
    try {
      for (const stmt of stmts) {
        if (cancelFlag) {
          result = `✗ cancelled after ${progress}/${stmts.length} statement(s) — SET FOREIGN_KEY_CHECKS may still be 0; re-run or re-enable manually`
          return
        }
        const res = await ipc.execStatement(connId, stmt, 0)
        if (!res.ok) {
          result = `✗ failed at statement ${progress + 1}: ${res.error?.message ?? 'error'}\n${stmt}`
          return
        }
        progress++
      }
      result = `✓ unified ${collationWizard.database} → ${target} (${affected.length} table(s) converted)`
      toasts.success(result)
      await init() // re-audit so the dialog reflects the new state
    } catch (e) {
      result = `✗ ${e}`
    } finally {
      running = false
    }
  }
</script>

{#if dlgOpen}
  <!-- backdrop click does NOT close (avoid losing input); use × / Close / Escape -->
  <div onkeydown={(e) => e.key === 'Escape' && !running && collationWizard.close()} role="presentation" style="position:fixed;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:56">
    <div onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.key === 'Escape' && !running && collationWizard.close()} role="dialog" aria-modal="true" tabindex="-1" style="width:var(--px-680);max-width:95vw;max-height:90vh;background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);box-shadow:0 var(--px-30) var(--px-70) var(--rgba-0-0-0-_55);overflow:hidden;display:flex;flex-direction:column">
      <div style="flex:none;display:flex;align-items:center;gap:var(--px-10);padding:var(--px-15) var(--px-18);border-bottom:var(--px-1) solid var(--border)">
        <span style="font-weight:700;font-size:var(--px-15)">Unify collation · {collationWizard.database}</span>
        <span onclick={() => !running && collationWizard.close()} onkeydown={(e) => e.key === 'Enter' && !running && collationWizard.close()} role="button" tabindex="0" style="margin-left:auto;cursor:pointer;color:var(--muted);font-size:var(--px-20)">×</span>
      </div>
      <div style="flex:1;overflow:auto;min-height:0;padding:var(--px-16) var(--px-18);display:flex;flex-direction:column;gap:var(--px-12)">
        <div style="display:flex;gap:var(--px-12);flex-wrap:wrap;align-items:flex-end">
          <label style="font-size:var(--px-12);color:var(--text2);flex:1;min-width:var(--px-260)">Target collation
            <select bind:value={target} class="mono" style="display:block;margin-top:var(--px-5);width:100%;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-8);color:var(--text);font-size:var(--px-12)">
              {#each collations as c (c)}<option value={c}>{c}</option>{/each}
            </select>
          </label>
        </div>
        {#if loading}
          <div style="font-size:var(--px-12);color:var(--text2)">Auditing information_schema…</div>
        {:else}
          <div style="font-size:var(--px-12);color:var(--text2)">
            Collations present: <span class="mono">{present.length ? present.join(', ') : '—'}</span>
          </div>
          <div style="font-size:var(--px-12);color:var(--text2)">
            {#if affected.length}
              <b>{affected.length}</b> table(s) will be converted: <span class="mono">{affected.join(', ')}</span>
            {:else}
              Nothing to convert — every base table already uses <span class="mono">{target}</span>. (ALTER DATABASE still runs to set the default.)
            {/if}
          </div>
        {/if}
        <div style="font-size:var(--px-12);color:var(--text2)">Migration preview (tables/columns only — procedures/views/triggers untouched)</div>
        <pre class="selectable mono" style="max-height:var(--px-240);overflow:auto;border-radius:var(--px-8);background:var(--panel);border:var(--px-1) solid var(--border);padding:var(--px-12);font-size:var(--px-11_5);line-height:1.5;margin:0">{sql}</pre>
        {#if running}
          <div style="font-size:var(--px-12);color:var(--text2)">Running… statement {progress}</div>
        {/if}
        {#if result !== null}
          <pre class="selectable mono" style="font-size:var(--px-12);color:{result.startsWith('✓') ? 'var(--success)' : 'var(--error)'};padding:var(--px-8);white-space:pre-wrap;margin:0">{result}</pre>
        {/if}
      </div>
      <div style="flex:none;display:flex;gap:var(--px-9);padding:var(--px-13) var(--px-18);border-top:var(--px-1) solid var(--border);background:var(--panel)">
        <span onclick={() => !running && collationWizard.close()} onkeydown={(e) => e.key === 'Enter' && !running && collationWizard.close()} role="button" tabindex="0" style="font-size:var(--px-12_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-8) var(--px-16);cursor:pointer">Close</span>
        {#if running}
          <span onclick={() => (cancelFlag = true)} onkeydown={(e) => e.key === 'Enter' && (cancelFlag = true)} role="button" tabindex="0" style="margin-left:auto;font-size:var(--px-12_5);background:var(--error);color:var(--hex-fff);border-radius:var(--px-8);padding:var(--px-8) var(--px-18);cursor:pointer;font-weight:600">Cancel</span>
        {:else}
          <span onclick={openInTab} onkeydown={(e) => e.key === 'Enter' && openInTab()} role="button" tabindex="0" style="margin-left:auto;font-size:var(--px-12_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-8) var(--px-16);cursor:pointer">Open in SQL tab</span>
          <span onclick={run} onkeydown={(e) => e.key === 'Enter' && run()} role="button" tabindex="0" style="font-size:var(--px-12_5);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-8);padding:var(--px-8) var(--px-18);cursor:pointer;font-weight:600">Run now</span>
        {/if}
      </div>
    </div>
  </div>
{/if}
