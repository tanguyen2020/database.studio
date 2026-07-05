<script lang="ts">
  // Generate Scripts wizard (T15 + item 3). Whole-schema multi-object script across
  // ALL object types — Tables, Views, Stored Procedures, Functions, Triggers,
  // Sequences — grouped, each group with a check-all. Structure / Data / Both.
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

  type ObjKind = 'table' | 'view' | 'procedure' | 'function' | 'trigger' | 'sequence'
  interface ObjRef {
    kind: ObjKind
    name: string
  }
  const GROUPS: { kind: ObjKind; label: string }[] = [
    { kind: 'table', label: 'Tables' },
    { kind: 'view', label: 'Views' },
    { kind: 'procedure', label: 'Stored Procedures' },
    { kind: 'function', label: 'Functions' },
    { kind: 'trigger', label: 'Triggers' },
    { kind: 'sequence', label: 'Sequences' },
  ]
  const okey = (o: ObjRef) => `${o.kind}:${o.name}`

  let mode = $state<ScriptMode>('structure')
  let objects = $state<ObjRef[]>([])
  let picked = $state<Set<string>>(new Set())
  let loading = $state(false)
  let running = $state(false)

  const system = $derived(connections.byId(scriptsWizard.connId)?.system ?? 'postgres')
  const grouped = $derived(
    GROUPS.map((g) => ({ ...g, items: objects.filter((o) => o.kind === g.kind) })).filter((g) => g.items.length),
  )

  $effect(() => {
    if (scriptsWizard.open) untrack(() => void load())
  })

  async function load() {
    mode = 'structure'
    running = false
    loading = true
    objects = []
    picked = new Set()
    const connId = scriptsWizard.connId
    const schema = scriptsWizard.schema
    if (!connId) return
    try {
      const [tbls, routines, triggers, sequences] = await Promise.all([
        ipc.listTables(connId, schema).catch(() => []),
        ipc.listRoutines(connId, schema).catch(() => []),
        ipc.listTriggers(connId, schema).catch(() => []),
        ipc.listSequences(connId, schema).catch(() => []),
      ])
      objects = [
        ...tbls.filter((t) => t.kind !== 'view').map((t): ObjRef => ({ kind: 'table', name: t.name })),
        ...tbls.filter((t) => t.kind === 'view').map((t): ObjRef => ({ kind: 'view', name: t.name })),
        ...routines.filter((r) => r.kind === 'procedure').map((r): ObjRef => ({ kind: 'procedure', name: r.name })),
        ...routines.filter((r) => r.kind !== 'procedure').map((r): ObjRef => ({ kind: 'function', name: r.name })),
        ...triggers.map((t): ObjRef => ({ kind: 'trigger', name: t.name })),
        ...sequences.map((s): ObjRef => ({ kind: 'sequence', name: s.name })),
      ]
      picked = new Set(objects.map(okey))
    } catch (e) {
      toasts.error(String(e))
    } finally {
      loading = false
    }
  }

  function toggle(o: ObjRef) {
    const next = new Set(picked)
    if (next.has(okey(o))) next.delete(okey(o))
    else next.add(okey(o))
    picked = next
  }
  function groupAllOn(kind: ObjKind): boolean {
    const items = objects.filter((o) => o.kind === kind)
    return items.length > 0 && items.every((o) => picked.has(okey(o)))
  }
  function toggleGroup(kind: ObjKind) {
    const items = objects.filter((o) => o.kind === kind)
    const allOn = groupAllOn(kind)
    const next = new Set(picked)
    for (const o of items) {
      if (allOn) next.delete(okey(o))
      else next.add(okey(o))
    }
    picked = next
  }

  async function generate() {
    const connId = scriptsWizard.connId
    if (!connId) return
    const schema = scriptsWizard.schema
    const chosen = objects.filter((o) => picked.has(okey(o)))
    if (!chosen.length) {
      toasts.error('No objects selected')
      return
    }
    running = true
    try {
      const parts: string[] = []
      // Sequences first (tables may reference them).
      const seqs = chosen.filter((o) => o.kind === 'sequence')
      if (seqs.length && mode !== 'data') {
        parts.push('-- Sequences\n' + seqs.map((s) => `CREATE SEQUENCE ${qualified(system, schema, s.name)};`).join('\n'))
      }
      // Tables + Views → dependency-ordered structure/data (reuse generateScript).
      const tvs = chosen.filter((o) => o.kind === 'table' || o.kind === 'view')
      if (tvs.length) {
        const fks = await ipc.listForeignKeys(connId, schema).catch(() => [])
        const tableNames = tvs.filter((o) => o.kind === 'table').map((o) => o.name)
        const objs: DbObject[] = []
        for (const o of tvs) {
          if (o.kind === 'view') {
            const def = await ipc.objectDefinition(connId, schema, 'view', o.name).catch(() => null)
            objs.push({ name: o.name, kind: 'view', createSql: def ?? `-- VIEW ${o.name}: definition unavailable`, deps: tableNames })
            continue
          }
          const cols = await ipc.listColumns(connId, schema, o.name)
          const tableFks = fks.filter((f) => f.from_table === o.name && picked.has(`table:${f.to_table}`))
          let dataSql: string | undefined
          if (mode !== 'structure') {
            const res = await ipc.execStatement(connId, buildExportSelect({ system, schema, table: o.name }), 0)
            if (res.ok && res.result && res.result.rows.length) {
              dataSql = toSqlInsert(o.name, res.result.cols.map((c) => c[0]), res.result.rows as Record<string, unknown>[])
            }
          }
          objs.push({
            name: o.name,
            kind: 'table',
            createSql: genCreate(system, schema, o.name, cols),
            deps: tableFks.map((f) => f.to_table),
            fkAlters: tableFks.map((f) => genForeignKey(system, schema, f)),
            dataSql,
          })
        }
        parts.push(generateScript(objs, mode))
      }
      // Procedures / Functions / Triggers → real DDL (structure only).
      const routines = chosen.filter((o) => o.kind === 'procedure' || o.kind === 'function' || o.kind === 'trigger')
      if (routines.length && mode !== 'data') {
        const defs: string[] = []
        for (const o of routines) {
          const def = await ipc.objectDefinition(connId, schema, o.kind, o.name).catch(() => null)
          defs.push(`-- ${o.kind}: ${o.name}\n${def ?? `-- definition unavailable`}`)
        }
        parts.push('-- Routines & Triggers\n' + defs.join('\n\n'))
      }
      const header = `-- Generated scripts for ${schema} (${mode}) — ${chosen.length} object(s)\n\n`
      tabs.openSqlTab({ connectionId: connId, title: `Scripts · ${schema}`, query: header + parts.filter(Boolean).join('\n\n') })
      toasts.success(`Generated ${chosen.length} object(s) (${mode})`)
      scriptsWizard.close()
    } catch (e) {
      toasts.error(`Generate failed: ${e}`)
    } finally {
      running = false
    }
  }
</script>

{#if scriptsWizard.open}
  <div onclick={() => !running && scriptsWizard.close()} onkeydown={() => {}} role="presentation" style="position:fixed;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:56">
    <div onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.key === 'Escape' && !running && scriptsWizard.close()} role="dialog" aria-modal="true" aria-label="Generate Scripts" tabindex="-1" style="width:var(--px-560);max-width:95vw;max-height:90vh;background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);box-shadow:0 var(--px-30) var(--px-70) var(--rgba-0-0-0-_55);overflow:hidden;display:flex;flex-direction:column">
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
        <div style="border:var(--px-1) solid var(--border);border-radius:var(--px-6);max-height:var(--px-300);overflow:auto;padding:var(--px-8);display:flex;flex-direction:column;gap:var(--px-6)">
          {#if loading}
            <div style="font-size:var(--px-12);color:var(--muted)">Loading objects…</div>
          {:else if objects.length === 0}
            <div style="font-size:var(--px-12);color:var(--muted)">No objects in this schema.</div>
          {:else}
            {#each grouped as g (g.kind)}
              <label style="display:flex;align-items:center;gap:var(--px-8);font-size:var(--px-11);font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);cursor:pointer;margin-top:var(--px-2)">
                <input type="checkbox" checked={groupAllOn(g.kind)} onchange={() => toggleGroup(g.kind)} />
                {g.label} ({g.items.filter((o) => picked.has(okey(o))).length}/{g.items.length})
              </label>
              {#each g.items as o (okey(o))}
                <label class="mono" style="display:flex;align-items:center;gap:var(--px-8);font-size:var(--px-11_5);color:var(--text2);cursor:pointer;padding-left:var(--px-18)">
                  <input type="checkbox" checked={picked.has(okey(o))} onchange={() => toggle(o)} />
                  {o.name}
                </label>
              {/each}
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
