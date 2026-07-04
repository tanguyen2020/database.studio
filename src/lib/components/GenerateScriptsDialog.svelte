<script lang="ts">
  // Generate Scripts wizard (Phase 5 · T15). Whole-schema / multi-object script:
  // structure (CREATE + FK) / data (INSERT) / both, in dependency order (parents
  // first, views after base tables, FKs last). Opens the result in a SQL tab.
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import { scriptsWizard } from '$lib/stores/scripts.svelte'
  import { connections } from '$lib/stores/connections.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { genCreate, genForeignKey } from '$lib/sql/ddl'
  import { qualified } from '$lib/sql/dialect'
  import { generateScript, type DbObject, type ScriptMode } from '$lib/sql/scripts'
  import { buildExportSelect } from '$lib/export/query'
  import { toSqlInsert } from '$lib/export/rows'
  import type { TableInfo } from '$lib/types'

  let mode = $state<ScriptMode>('structure')
  let objects = $state<TableInfo[]>([])
  let picked = $state<Set<string>>(new Set())
  let loading = $state(false)
  let running = $state(false)

  const system = $derived(connections.byId(scriptsWizard.connId)?.system ?? 'postgres')

  $effect(() => {
    if (scriptsWizard.open) untrack(() => void load())
  })

  async function load() {
    mode = 'structure'
    running = false
    loading = true
    objects = []
    picked = new Set()
    try {
      if (scriptsWizard.connId) {
        objects = await ipc.listTables(scriptsWizard.connId, scriptsWizard.schema)
        picked = new Set(objects.map((t) => t.name))
      }
    } catch (e) {
      toasts.error(String(e))
    } finally {
      loading = false
    }
  }

  function toggle(name: string) {
    const next = new Set(picked)
    if (next.has(name)) next.delete(name)
    else next.add(name)
    picked = next
  }

  async function fetchViewDef(connId: string, schema: string, view: string): Promise<string | null> {
    if (system === 'sqlite' || system === 'clickhouse' || system === 'cassandra') return null
    try {
      const res = await ipc.execStatement(
        connId,
        `SELECT view_definition FROM information_schema.views WHERE table_schema = '${schema}' AND table_name = '${view}'`,
        0,
      )
      const def = String((res.result?.rows?.[0] as Record<string, unknown>)?.view_definition ?? '').trim()
      if (res.ok && def) return `CREATE VIEW ${qualified(system, schema, view)} AS\n${def}`
    } catch {
      /* fall through to placeholder */
    }
    return null
  }

  async function generate() {
    const connId = scriptsWizard.connId
    if (!connId) return
    const schema = scriptsWizard.schema
    const chosen = objects.filter((t) => picked.has(t.name))
    if (!chosen.length) {
      toasts.error('Chưa chọn object nào')
      return
    }
    running = true
    try {
      const fks = await ipc.listForeignKeys(connId, schema).catch(() => [])
      const tableNames = chosen.filter((t) => t.kind !== 'view').map((t) => t.name)
      const objs: DbObject[] = []
      for (const t of chosen) {
        if (t.kind === 'view') {
          const def = await fetchViewDef(connId, schema, t.name)
          objs.push({
            name: t.name,
            kind: 'view',
            createSql: def ?? `-- VIEW ${t.name}: definition unavailable via introspection`,
            deps: tableNames, // views come after all base tables
          })
          continue
        }
        const cols = await ipc.listColumns(connId, schema, t.name)
        const tableFks = fks.filter((f) => f.from_table === t.name && picked.has(f.to_table))
        let dataSql: string | undefined
        if (mode !== 'structure') {
          const res = await ipc.execStatement(connId, buildExportSelect({ system, schema, table: t.name }), 0)
          if (res.ok && res.result && res.result.rows.length) {
            dataSql = toSqlInsert(
              t.name,
              res.result.cols.map((c) => c[0]),
              res.result.rows as Record<string, unknown>[],
            )
          }
        }
        objs.push({
          name: t.name,
          kind: 'table',
          createSql: genCreate(system, schema, t.name, cols),
          deps: tableFks.map((f) => f.to_table),
          fkAlters: tableFks.map((f) => genForeignKey(system, schema, f)),
          dataSql,
        })
      }
      const script = generateScript(objs, mode)
      const header = `-- Generated scripts for ${schema} (${mode}) — ${chosen.length} objects\n\n`
      tabs.openSqlTab({ connectionId: connId, title: `Scripts · ${schema}`, query: header + script })
      toasts.success(`Generated ${chosen.length} objects (${mode})`)
      scriptsWizard.close()
    } catch (e) {
      toasts.error(`Generate thất bại: ${e}`)
    } finally {
      running = false
    }
  }
</script>

{#if scriptsWizard.open}
  <div onclick={() => !running && scriptsWizard.close()} onkeydown={() => {}} role="presentation" style="position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:56">
    <div onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.key === 'Escape' && !running && scriptsWizard.close()} role="dialog" aria-modal="true" tabindex="-1" style="width:var(--px-560);max-width:95vw;max-height:90vh;background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);box-shadow:0 var(--px-30) var(--px-70) rgba(0,0,0,.55);overflow:hidden;display:flex;flex-direction:column">
      <div style="flex:none;display:flex;align-items:center;gap:var(--px-10);padding:var(--px-15) var(--px-18);border-bottom:var(--px-1) solid var(--border)">
        <span style="font-weight:700;font-size:var(--px-15)">Generate Scripts · {scriptsWizard.schema}</span>
        <span onclick={() => !running && scriptsWizard.close()} onkeydown={(e) => e.key === 'Enter' && !running && scriptsWizard.close()} role="button" tabindex="0" style="margin-left:auto;cursor:pointer;color:var(--muted);font-size:var(--px-20)">×</span>
      </div>
      <div style="flex:1;overflow:auto;min-height:0;padding:var(--px-16) var(--px-18);display:flex;flex-direction:column;gap:var(--px-12)">
        <div style="display:flex;gap:var(--px-16);font-size:var(--px-12);color:var(--text2);align-items:center">
          Mode
          {#each [['structure', 'Structure only'], ['data', 'Data only'], ['both', 'Structure + Data']] as [m, label] (m)}
            <label style="display:flex;align-items:center;gap:var(--px-5);cursor:pointer"><input type="radio" name="scriptmode" checked={mode === m} onchange={() => (mode = m as ScriptMode)} /> {label}</label>
          {/each}
        </div>
        <div style="font-size:var(--px-12);color:var(--text2)">Objects ({picked.size}/{objects.length})</div>
        <div style="border:var(--px-1) solid var(--border);border-radius:var(--px-6);max-height:var(--px-260);overflow:auto;padding:var(--px-8);display:flex;flex-direction:column;gap:var(--px-4)">
          {#if loading}
            <div style="font-size:var(--px-12);color:var(--muted)">Loading objects…</div>
          {:else}
            {#each objects as t (t.name)}
              <label class="mono" style="display:flex;align-items:center;gap:var(--px-8);font-size:var(--px-11_5);color:var(--text2);cursor:pointer">
                <input type="checkbox" checked={picked.has(t.name)} onchange={() => toggle(t.name)} />
                {t.name}
                <span style="font-size:var(--px-9_5);color:var(--muted);border:var(--px-1) solid var(--border);border-radius:var(--px-3);padding:0 var(--px-4)">{t.kind}</span>
              </label>
            {/each}
          {/if}
        </div>
      </div>
      <div style="flex:none;display:flex;gap:var(--px-9);padding:var(--px-13) var(--px-18);border-top:var(--px-1) solid var(--border);background:var(--panel)">
        <span onclick={() => !running && scriptsWizard.close()} onkeydown={(e) => e.key === 'Enter' && !running && scriptsWizard.close()} role="button" tabindex="0" style="font-size:var(--px-12_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-8) var(--px-16);cursor:pointer">Cancel</span>
        <span onclick={() => !running && generate()} onkeydown={(e) => e.key === 'Enter' && !running && generate()} role="button" tabindex="0" style="margin-left:auto;font-size:var(--px-12_5);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-8);padding:var(--px-8) var(--px-18);cursor:{running ? 'not-allowed' : 'pointer'};opacity:{running ? 0.6 : 1};font-weight:600">{running ? 'Generating…' : 'Generate → SQL tab'}</span>
      </div>
    </div>
  </div>
{/if}
