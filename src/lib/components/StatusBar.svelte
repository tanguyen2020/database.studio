<script lang="ts">
  // Status bar — port 1:1 từ Database Studio.dc.html dòng 1501-1507:
  // 27px nền --header, dot 7px màu accent (xám orphan khi disconnected) +
  // connName + icon hệ + object hiện tại (mono) | latency (mono) + rows (mono).
  import SystemIcon from '$lib/components/SystemIcon.svelte'
  import { systemMeta } from '$lib/systems'
  import { connections } from '$lib/stores/connections.svelte'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { results } from '$lib/stores/results.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'

  const tab = $derived(tabs.active)
  const profile = $derived(connections.byId(tab?.connectionId))
  const exec = $derived(tab ? results.get(tab.id) : undefined)
  const currentSchema = $derived.by(() => {
    if (!profile) return null
    const schemas = explorer.cache[profile.id]?.schemas
    return schemas?.find((s) => s.is_default)?.name ?? schemas?.[0]?.name ?? null
  })
  // For MySQL/MariaDB/ClickHouse a "schema" IS a database, so the object qualifier
  // must be the database the statement actually ran against — the DB picked in the
  // editor's dropdown (tab.state.database) or the connection's DB — NOT the cached
  // default schema (which ignores the picked DB / can mis-decode is_default).
  const schemaIsDatabase = $derived(['mysql', 'mariadb', 'clickhouse'].includes(profile?.system ?? ''))
  const runDb = $derived(((tab?.state?.database as string) || profile?.database || '').trim())

  // active.dot (dòng 4649): connected → accent, không thì màu orphan
  const dot = $derived(
    profile?.connected ? systemMeta(profile.system).accent : 'var(--sys-orphan-accent)',
  )
  // statusLatency (dòng 4819)
  const latency = $derived(
    profile ? (profile.connected ? `${profile.latency_ms ?? '–'}ms` : 'disconnected') : '',
  )
  // statusObject/statusRows (dòng 4970, 5204-5206): '—' khi chưa có kết quả;
  // 'schema.table' khi sub-tab select active; 'schema' cho các trường hợp khác
  const activeSub = $derived(
    exec && exec.activeSub >= 0 ? exec.subResults[exec.activeSub] : undefined,
  )
  const statusObject = $derived.by(() => {
    if (!exec || exec.subResults.length === 0) return '—'
    const qualifier = schemaIsDatabase ? runDb || currentSchema || 'database' : currentSchema ?? 'public'
    if (activeSub?.kind === 'rows' && activeSub.table) return `${qualifier}.${activeSub.table}`
    return qualifier
  })
  const statusRows = $derived(
    activeSub?.kind === 'rows' && activeSub.result
      ? `${activeSub.result.total.toLocaleString()} rows`
      : '',
  )
</script>

<div style="flex:none;height:var(--px-27);display:flex;align-items:center;gap:var(--px-14);padding:0 var(--px-14);background:var(--header);border-top:var(--px-1) solid var(--border);font-size:var(--px-11);color:var(--text2)">
  <span style="display:flex;align-items:center;gap:var(--px-6)">
    <span style="width:var(--px-7);height:var(--px-7);border-radius:50%;background:{dot}"></span>
    {profile?.name ?? (tab?.systemType === 'orphan' ? '(deleted)' : 'No connection')}
  </span>
  {#if profile}
    <span style="display:flex;align-items:center"><SystemIcon system={profile.system} size={14} /></span>
  {/if}
  <span class="mono">{statusObject}</span>
  <span class="mono" style="margin-left:auto">
    {#if exec?.running}Đang chạy…{:else}{latency}{/if}
  </span>
  <span class="mono">{statusRows}</span>
</div>
