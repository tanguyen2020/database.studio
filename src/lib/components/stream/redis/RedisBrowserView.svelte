<script lang="ts">
  // stream-workspace:redis — Redis Browser workspace (SPEC-REDIS-BROWSER.md).
  // Browser (keys + the selected key in the side panel, never a tab per key — X1),
  // Workbench (command console), Pub/Sub, Slow commands and Server info, on the
  // shared stream shell. Numbers come from INFO / SCAN / SLOWLOG; nothing invented.
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import type { TabState } from '$lib/types'
  import { connections } from '$lib/stores/connections.svelte'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { backupWizard } from '$lib/stores/backup.svelte'
  import { redisDb } from '$lib/stores/redisDb.svelte'
  import StreamShell, { type ShellSection, type ShellStatus } from '../StreamShell.svelte'
  import StreamTable, { type StreamColumn } from '../StreamTable.svelte'
  import SplitDetail from '../SplitDetail.svelte'
  import StatCards, { type StatCard } from '../StatCards.svelte'
  import HelpTip from '../HelpTip.svelte'
  import AdvancedToggle from '../AdvancedToggle.svelte'
  import Icon from '$lib/components/Icon.svelte'
  import Chevron from '$lib/components/Chevron.svelte'
  import RedisKeyView from '$lib/components/workspace/RedisKeyView.svelte'
  import RedisPubSub from '$lib/components/workspace/RedisPubSub.svelte'
  import RedisWorkbench from './RedisWorkbench.svelte'
  import RedisAddKeyDialog from './RedisAddKeyDialog.svelte'
  import { buildRedisTree, flattenRedisTree, keysUnderPrefix, mergeRedisKeys, type RedisKeyInfo } from '$lib/redis/tree'
  import { REDIS_TYPES, databaseLabel, expiresIn, typeColor, typeHelp, typeLabel } from '$lib/stream/redis-keys'
  import { headerStats, memoryText, redisHealth, serverInfoGroups, slowRows, slowThresholdText, type SlowRow } from '$lib/stream/redis-info'
  import { formatBytes, fullCount, plural } from '$lib/stream/humanize'
  import { autofocus } from '$lib/actions/autofocus'
  import '$lib/components/workspace/users/um.css'

  let { tab }: { tab: TabState } = $props()

  const connId = $derived(tab.connectionId ?? '')
  const profile = $derived(connections.byId(connId))
  const ws = $derived(tab.state as { section?: string; focus?: string; view?: 'list' | 'tree' })
  const section = $derived(ws.section && ws.section !== 'overview' ? ws.section : 'browser')
  const view = $derived(ws.view ?? 'list')
  const focus = $derived(section === 'browser' ? (ws.focus ?? null) : null)
  const db = $derived(redisDb.get(connId))

  function go(next: string, f?: string) {
    tabs.patchState(tab.id, { section: next, focus: f })
  }
  function select(key: string | null) {
    tabs.patchState(tab.id, { focus: key ?? undefined }, false)
  }
  function setView(v: 'list' | 'tree') {
    tabs.patchState(tab.id, { view: v })
  }

  // ---- server facts (INFO) --------------------------------------------------
  let info = $state<ipc.RedisInfo | null>(null)
  let infoError = $state<string | null>(null)
  let loadingInfo = $state(false)
  let dbCount = $state(16)
  const stats = $derived(headerStats(info))
  const health = $derived(redisHealth(info))

  async function loadInfo() {
    if (!connId) return
    loadingInfo = true
    try {
      info = await ipc.redisInfo(connId)
      infoError = null
    } catch (e) {
      infoError = String(e)
    } finally {
      loadingInfo = false
    }
  }

  // ---- keys (capped SCAN walk, same rules as the sidebar) --------------------
  const SCAN_COUNT = 500
  const MAX_KEYS = 5000
  const MAX_ROUNDS = 50
  const TYPE_DEBOUNCE_MS = 250
  let keys = $state<RedisKeyInfo[]>([])
  let dbsize = $state<number | null>(null)
  let pattern = $state('')
  let typeFilter = $state('')
  let loadingKeys = $state(false)
  let loadingMore = $state(false)
  let switching = $state(false)
  let keysError = $state<string | null>(null)
  let nextCursor = $state(0)
  let scanned = $state(0)
  const partial = $derived(nextCursor !== 0)
  let gen = 0

  async function walk(cursor: number, mine: number) {
    const collected: RedisKeyInfo[] = []
    let size = dbsize ?? 0
    let rounds = 0
    for (let i = 0; i < MAX_ROUNDS; i++) {
      const res = await ipc.redisScan(connId, pattern, cursor, SCAN_COUNT)
      if (mine !== gen) return null
      collected.push(...res.keys)
      size = res.dbsize
      cursor = res.cursor
      rounds++
      if (cursor === 0 || collected.length >= MAX_KEYS) break
    }
    return { collected, size, cursor, rounds }
  }

  async function loadKeys() {
    if (!connId) return
    const mine = ++gen
    loadingKeys = true
    keysError = null
    resetMeta()
    try {
      const r = await walk(0, mine)
      if (!r) return
      keys = r.collected
      dbsize = r.size
      nextCursor = r.cursor
      scanned = r.rounds * SCAN_COUNT
    } catch (e) {
      if (mine === gen) keysError = String(e)
    } finally {
      if (mine === gen) loadingKeys = false
    }
  }

  async function scanMore() {
    if (!connId || nextCursor === 0 || loadingMore) return
    const mine = ++gen
    loadingMore = true
    try {
      const r = await walk(nextCursor, mine)
      if (!r) return
      keys = mergeRedisKeys(keys, r.collected)
      dbsize = r.size
      nextCursor = r.cursor
      scanned += r.rounds * SCAN_COUNT
    } catch (e) {
      if (mine === gen) keysError = String(e)
    } finally {
      if (mine === gen) loadingMore = false
    }
  }

  // One reload trigger for keys + INFO: connection, database (switched here, in the
  // sidebar or by SELECT in the Workbench), a keyspace change tick, or the pattern
  // (debounced so typing does not rescan per keystroke).
  let lastPattern = ''
  let debounce: ReturnType<typeof setTimeout> | undefined
  $effect(() => {
    void connId
    void db
    void explorer.redisTick[connId]
    const pat = pattern
    const typing = pat !== lastPattern
    lastPattern = pat
    clearTimeout(debounce)
    if (typing) debounce = setTimeout(() => untrack(() => void loadKeys()), TYPE_DEBOUNCE_MS)
    else
      untrack(() => {
        void loadKeys()
        void loadInfo()
      })
    return () => clearTimeout(debounce)
  })
  $effect(() => {
    const cid = connId
    if (cid) untrack(() => void ipc.redisDatabaseCount(cid).then((n) => (dbCount = n)).catch(() => {}))
  })

  async function switchDb(e: Event) {
    const n = Number((e.currentTarget as HTMLSelectElement).value)
    // a scan in flight would mix the two databases' keys: wait for it
    if (switching || loadingKeys || n === db) return
    switching = true
    try {
      await ipc.redisSelectDb(connId, n)
      select(null)
      redisDb.set(connId, n) // the sidebar list follows (same store)
    } catch (err) {
      toasts.error(`Could not open Database ${n}: ${err}`)
    } finally {
      switching = false
    }
  }

  const shown = $derived(typeFilter ? keys.filter((k) => k.key_type === typeFilter) : keys)
  const busy = $derived(loadingKeys || loadingMore || switching)

  // ---- size + encoding of the keys on screen (one pipeline per batch) --------
  let meta = $state<Record<string, ipc.RedisKeyMeta>>({})
  let metaGen = 0
  const queued = new Set<string>()
  const asked = new Set<string>()
  let metaTimer: ReturnType<typeof setTimeout> | undefined
  function resetMeta() {
    metaGen++
    meta = {}
    queued.clear()
    asked.clear()
  }
  function wantMeta(names: string[]) {
    for (const n of names) if (!asked.has(n)) queued.add(n)
    if (!queued.size) return
    clearTimeout(metaTimer)
    metaTimer = setTimeout(flushMeta, 120)
  }
  async function flushMeta() {
    const batch = [...queued].slice(0, 200)
    batch.forEach((k) => {
      queued.delete(k)
      asked.add(k)
    })
    if (!batch.length || !connId) return
    const mine = metaGen
    try {
      const rows = await ipc.redisKeyMeta(connId, batch)
      if (mine !== metaGen) return
      const next = { ...meta }
      for (const r of rows) next[r.key] = r
      meta = next
    } catch {
      /* sizes are optional: the column stays "—" */
    }
    if (queued.size) metaTimer = setTimeout(flushMeta, 60)
  }

  // ---- tree view --------------------------------------------------------------
  let expanded = $state<Set<string>>(new Set())
  const tree = $derived(buildRedisTree(shown))
  const treeRows = $derived(flattenRedisTree(tree, expanded))
  $effect(() => {
    if (view !== 'tree') return
    const visibleKeys = treeRows.filter((r) => r.key).slice(0, 300).map((r) => r.path)
    untrack(() => wantMeta(visibleKeys))
  })
  function toggleFolder(path: string) {
    const next = new Set(expanded)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    expanded = next
  }

  // ---- slow commands --------------------------------------------------------
  let slow = $state<ipc.RedisSlowlog | null>(null)
  let slowError = $state<string | null>(null)
  let loadingSlow = $state(false)
  let slowCount = $state(50)
  const slowList = $derived(slowRows(slow?.entries ?? []))
  async function loadSlow() {
    if (!connId) return
    loadingSlow = true
    try {
      slow = await ipc.redisSlowlog(connId, slowCount)
      slowError = null
    } catch (e) {
      slowError = String(e)
    } finally {
      loadingSlow = false
    }
  }
  $effect(() => {
    if (section !== 'slowlog') return
    void slowCount
    untrack(() => void loadSlow())
  })

  // Pub/Sub stays mounted once opened, so switching sections does not stop listening.
  let pubsubVisited = $state(false)
  $effect(() => {
    if (section === 'pubsub') pubsubVisited = true
  })

  const loading = $derived(busy || loadingInfo || loadingSlow)
  function refresh() {
    void loadKeys()
    void loadInfo()
    if (section === 'slowlog') void loadSlow()
  }

  // ---- shell ------------------------------------------------------------------
  const keysHere = $derived(dbsize ?? stats.keysByDb[db] ?? null)
  const sections: ShellSection[] = $derived([
    { id: 'browser', label: 'Browser', count: keysHere != null ? fullCount(keysHere) : null },
    { id: 'workbench', label: 'Workbench' },
    { id: 'pubsub', label: 'Pub/Sub' },
    { id: 'slowlog', label: 'Slow commands', count: slow ? slow.entries.length : null },
    { id: 'info', label: 'Server info', badge: health && health.tone !== 'ok' ? (health.tone === 'bad' ? 'Problem' : 'Needs attention') : null },
  ])
  const DESCRIPTIONS: Record<string, string> = {
    browser: 'Keys of the selected database. Pick a key to see and edit its value on the right. Big databases are read in batches, so the list may be partial — “Scan more” continues.',
    workbench: 'Run Redis commands directly, like redis-cli. Commands that delete data or stop the server ask before they run.',
    pubsub: 'Listen to channels in real time and publish messages. Redis does not store these messages — you only see what arrives while listening.',
    slowlog: 'The commands Redis itself recorded as slow. Use it to find what slows your apps down.',
    info: 'How the server is doing: memory, clients, saving to disk and replication.',
  }
  const status: ShellStatus | null = $derived.by(() => {
    if (section !== 'info' && section !== 'browser') return null
    if (infoError) return section === 'info' ? { tone: 'bad', headline: 'Could not read the server status', detail: infoError, actionLabel: 'Try again', onAction: () => void loadInfo() } : null
    if (!health) return null
    if (section === 'browser' && health.tone === 'ok') return null
    return { ...health, ...(section === 'browser' ? { actionLabel: 'Server info', onAction: () => go('info') } : {}) }
  })
  const mem = $derived(memoryText(stats.memoryUsed, stats.maxMemory))
  const cards: StatCard[] = $derived([
    {
      label: 'Keys',
      value: keysHere == null ? '?' : fullCount(keysHere),
      tone: 'num',
      sub: stats.totalKeys != null && stats.totalKeys !== keysHere ? `in Database ${db} · ${fullCount(stats.totalKeys)} in all databases` : `in Database ${db}`,
    },
    {
      label: 'Memory used',
      value: mem.value,
      sub: mem.sub,
      tone: stats.memoryUsed != null && stats.maxMemory ? (stats.memoryUsed / stats.maxMemory >= 0.9 ? 'warn' : null) : null,
      help: 'Memory Redis uses for your data. The limit is the server setting maxmemory.',
    },
    { label: 'Clients', value: stats.clients == null ? '?' : fullCount(stats.clients), sub: 'connected right now', help: 'Apps and tools with an open connection to this server.' },
    { label: 'Commands / second', value: stats.opsPerSec == null ? '?' : fullCount(stats.opsPerSec), tone: 'num', sub: 'right now', help: 'How many commands the server is handling each second.' },
  ])
  const groups = $derived(serverInfoGroups(info))

  // ---- list columns -----------------------------------------------------------
  const keyCols: StreamColumn<RedisKeyInfo>[] = [
    { key: 'type', label: 'Type', width: 'var(--px-110)', sort: (k) => typeLabel(k.key_type), help: 'The kind of value stored in the key.' },
    { key: 'name', label: 'Key', sort: (k) => k.name },
    { key: 'ttl', label: 'Expires in', width: 'var(--px-120)', sort: (k) => (k.ttl < 0 ? Number.MAX_SAFE_INTEGER - (k.ttl === -2 ? 1 : 0) : k.ttl), help: 'When Redis deletes the key automatically. Never = the key stays until deleted.' },
    { key: 'size', label: 'Size', align: 'right', width: 'var(--px-100)', sort: (k) => meta[k.name]?.bytes ?? null, help: 'Memory the key uses on the server. Measured for the keys on screen.' },
  ]
  const slowCols: StreamColumn<SlowRow>[] = [
    { key: 'when', label: 'When', width: 'var(--px-130)', sort: (r) => r.timestamp },
    { key: 'duration', label: 'Took', align: 'right', width: 'var(--px-100)', sort: (r) => r.durationUs, help: 'How long the server spent running the command (network time not included).' },
    { key: 'command', label: 'Command', sort: (r) => r.command },
    { key: 'client', label: 'Client', width: 'var(--px-220)', sort: (r) => r.client, help: 'The app that sent it: its connection name and address.' },
  ]

  const emptyTitle = $derived(pattern ? `No keys match “${pattern}”` : typeFilter ? `No ${typeLabel(typeFilter).toLowerCase()} keys here` : `Database ${db} is empty`)
  const emptyBody = $derived(
    pattern || typeFilter
      ? partial
        ? 'Only part of the database has been read so far. Use “Scan more” to keep looking.'
        : 'Change the pattern or the type to see other keys.'
      : 'Keys appear here as soon as an app writes them. You can also add one yourself.',
  )
  const listNote = $derived(
    typeFilter && keys.length !== shown.length ? `Showing ${typeLabel(typeFilter).toLowerCase()} keys only — ${plural(keys.length - shown.length, 'other key')} hidden.` : null,
  )

  // ---- dialogs ---------------------------------------------------------------
  let addOpen = $state(false)
  let flushOpen = $state(false)
  let flushBusy = $state(false)
  let flushError = $state<string | null>(null)
  async function flush() {
    flushBusy = true
    flushError = null
    try {
      await ipc.redisFlushDb(connId)
      toasts.success(`Deleted every key in Database ${db}`)
      flushOpen = false
      select(null)
      explorer.bumpRedis(connId)
    } catch (e) {
      flushError = String(e)
    } finally {
      flushBusy = false
    }
  }
  // Delete every key under a prefix (a Tree folder) — kept from the old explorer.
  // Only keys this list has read are deleted; a partial scan says so.
  let prefixFor = $state<{ prefix: string; names: string[] } | null>(null)
  let prefixBusy = $state(false)
  let prefixError = $state<string | null>(null)
  function askDeletePrefix(prefix: string) {
    prefixError = null
    prefixFor = { prefix, names: keysUnderPrefix(keys, prefix) }
  }
  async function deletePrefix() {
    if (!prefixFor || prefixBusy) return
    prefixBusy = true
    prefixError = null
    const { prefix, names } = prefixFor
    let done = 0
    try {
      for (const n of names) {
        await ipc.redisDel(connId, n)
        done++
      }
      toasts.success(`Deleted ${plural(done, 'key')} under ${prefix}`)
      prefixFor = null
      if (focus && names.includes(focus)) select(null)
      await loadKeys()
      explorer.bumpRedis(connId)
    } catch (e) {
      prefixError = `${done ? `Deleted ${plural(done, 'key')}, then stopped: ` : ''}${String(e)}`
      void loadKeys()
    } finally {
      prefixBusy = false
    }
  }
  function created(key: string) {
    addOpen = false
    toasts.success(`Created “${key}”`)
    explorer.bumpRedis(connId)
    if (section !== 'browser') go('browser', key)
    else select(key)
  }

  const subtitle = $derived(
    [stats.version ? `Redis ${stats.version}` : null, profile ? `${profile.host}:${profile.port}` : null, stats.role ? (stats.role === 'master' ? 'Primary' : stats.role === 'slave' ? 'Replica' : stats.role) : null]
      .filter(Boolean)
      .join(' · ') || undefined,
  )

  // raw INFO filter (Server info → Raw)
  let rawFilter = $state('')
</script>

<StreamShell
  system="redis"
  title={profile?.name ?? 'Redis'}
  {subtitle}
  {sections}
  active={section}
  onSection={(id) => go(id)}
  {status}
  description={DESCRIPTIONS[section]}
  {loading}
  onRefresh={refresh}
>
  {#snippet actions()}
    {#if section === 'browser'}
      <button type="button" class="cfm-btn primary" onclick={() => (addOpen = true)}>+ Add key</button>
      <button type="button" class="cfm-btn" onclick={() => backupWizard.show(connId, 'redis', { database: String(db) })} title="Back up or restore Database {db}">Backup &amp; Restore…</button>
      <button type="button" class="cfm-btn ds-danger-outline" onclick={() => { flushError = null; flushOpen = true }} disabled={!keysHere}>Delete all keys…</button>
    {/if}
  {/snippet}

  {#if section === 'browser'}
    <div class="rb-stats"><StatCards items={cards} /></div>
    <div class="rb-toolbar">
      <label class="rb-field">
        <span class="rb-label">Database</span>
        <select class="ds-control" value={db} onchange={switchDb} disabled={switching || loadingKeys} aria-label="Database to browse">
          {#each Array.from({ length: dbCount }, (_, i) => i) as n (n)}
            <option value={n}>{databaseLabel(n, stats.keysByDb[n] ?? (info ? 0 : null))}</option>
          {/each}
        </select>
      </label>
      <label class="ds-search rb-pattern">
        <Icon name="search" size={13} />
        <input class="mono" bind:value={pattern} placeholder="Key pattern, e.g. user:*" aria-label="Key pattern" spellcheck="false" />
        {#if pattern}<button type="button" class="rb-clear" onclick={() => (pattern = '')} aria-label="Clear the pattern"><Icon name="close" size={11} /></button>{/if}
      </label>
      <HelpTip text="Redis matches key names: * = any text, ? = one character. Example: user:* finds every key that starts with user:." />
      <label class="rb-field">
        <span class="rb-label">Type</span>
        <select class="ds-control" bind:value={typeFilter} aria-label="Show keys of type">
          <option value="">All types</option>
          {#each REDIS_TYPES as t (t)}<option value={t}>{typeLabel(t)}</option>{/each}
        </select>
      </label>
      <div class="rb-seg" role="group" aria-label="Show keys as">
        <button type="button" class:on={view === 'list'} aria-pressed={view === 'list'} onclick={() => setView('list')}>List</button>
        <button type="button" class:on={view === 'tree'} aria-pressed={view === 'tree'} onclick={() => setView('tree')}>Tree</button>
      </div>
      <span class="rb-scan" aria-live="polite">
        {#if busy}
          <span class="rb-spin" aria-hidden="true"><Icon name="refresh" size={12} /></span>
          Scanning Database {db}…
        {:else if partial}
          <span class="rb-partial" title="Redis returns keys in batches and applies the pattern afterwards, so a narrow pattern on a big database needs several passes. Keys not read yet are not shown.">
            <Icon name="warning" size={12} /> Partial list · read ~{fullCount(scanned)} of {fullCount(dbsize)} keys
          </span>
          <button type="button" class="cfm-btn rb-more" onclick={scanMore} disabled={loadingMore}>Scan more</button>
        {:else}
          <span class="rb-count"><b>{fullCount(shown.length)}</b> {shown.length === 1 ? 'key' : 'keys'}</span>
        {/if}
      </span>
    </div>
    <SplitDetail storeKey="redis-browser" open={!!focus} initial={52}>
      {#snippet list()}
        <div class="rb-list" class:dim={busy && keys.length > 0} aria-busy={busy}>
          {#if view === 'list'}
            <StreamTable
              rows={shown}
              columns={keyCols}
              rowKey={(k) => k.name}
              ariaLabel="Keys"
              selected={focus}
              onSelect={(k) => select(k.name)}
              onOpen={(k) => select(k.name)}
              initialSort={{ key: 'name', dir: 'asc' }}
              loading={loadingKeys}
              error={keysError}
              {emptyTitle}
              {emptyBody}
              emptyActionLabel={pattern || typeFilter ? undefined : '+ Add key'}
              onEmptyAction={pattern || typeFilter ? undefined : () => (addOpen = true)}
              note={listNote}
              onWindow={(rows) => wantMeta(rows.map((r) => r.name))}
            >
              {#snippet cell(k, c)}
                {#if c.key === 'type'}<span class="rb-type" style="--tc:{typeColor(k.key_type)}" title={typeHelp(k.key_type)}>{typeLabel(k.key_type)}</span>
                {:else if c.key === 'name'}<span class="ds-name">{k.name}</span>
                {:else if c.key === 'ttl'}{@const ex = expiresIn(k.ttl)}<span class="rb-ttl {ex.tone}" title={ex.title}>{ex.text}</span>
                {:else if c.key === 'size'}{@const m = meta[k.name]}<span class="ds-num rb-size" title={m?.bytes != null ? `${fullCount(m.bytes)} bytes` : 'Not measured yet'}>{m?.bytes != null ? formatBytes(m.bytes) : '—'}</span>
                {/if}
              {/snippet}
            </StreamTable>
          {:else if keysError}
            <div class="ds-empty" role="alert"><b>Could not read the keys</b>{keysError}</div>
          {:else if loadingKeys && keys.length === 0}
            <div class="ds-empty" aria-busy="true">Loading…</div>
          {:else if treeRows.length === 0}
            <div class="ds-empty"><b>{emptyTitle}</b>{emptyBody}</div>
          {:else}
            <div class="rb-tree" role="tree" aria-label="Keys by prefix">
              {#each treeRows as r (r.path)}
                {#if r.kind === 'folder'}
                  <div
                    class="rb-trow"
                    role="treeitem"
                    aria-expanded={r.expanded}
                    aria-selected="false"
                    tabindex="0"
                    style="padding-left:calc(var(--px-10) + {r.depth} * var(--px-16))"
                    onclick={() => toggleFolder(r.path)}
                    onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggleFolder(r.path))}
                  >
                    <span class="rb-chev"><Chevron open={r.expanded} size={11} /></span>
                    <span class="mono rb-seg-name">{r.segment}</span>
                    <span class="rb-folder-count">{plural(r.count, 'key')}</span>
                    <button
                      type="button"
                      class="rb-folder-del"
                      title="Delete every key under {r.path}"
                      aria-label="Delete keys under {r.path}"
                      onclick={(e) => {
                        e.stopPropagation()
                        askDeletePrefix(r.path)
                      }}
                      onkeydown={(e) => e.stopPropagation()}
                    ><Icon name="trash" size={12} /></button>
                  </div>
                {:else}
                  {@const k = r.key}
                  {@const ex = expiresIn(k?.ttl)}
                  {@const m = meta[r.path]}
                  <div
                    class="rb-trow"
                    class:sel={focus === r.path}
                    role="treeitem"
                    aria-selected={focus === r.path}
                    tabindex="0"
                    title={r.path}
                    style="padding-left:calc(var(--px-10) + {r.depth} * var(--px-16) + var(--px-16))"
                    onclick={() => select(r.path)}
                    onkeydown={(e) => e.key === 'Enter' && select(r.path)}
                  >
                    <span class="rb-type" style="--tc:{typeColor(k?.key_type)}" title={typeHelp(k?.key_type)}>{typeLabel(k?.key_type)}</span>
                    <span class="mono rb-seg-name">{r.segment}</span>
                    <span class="rb-ttl {ex.tone}" title={ex.title}>{ex.text}</span>
                    <span class="ds-num rb-size">{m?.bytes != null ? formatBytes(m.bytes) : '—'}</span>
                  </div>
                {/if}
              {/each}
            </div>
          {/if}
        </div>
      {/snippet}
      {#snippet detail()}
        {#if focus}
          {#key focus}
            <RedisKeyView
              {connId}
              keyName={focus}
              onClose={() => select(null)}
              onDeleted={() => select(null)}
              onRenamed={(_from, to) => select(to)}
            >
              {#snippet extra()}
                {@const m = meta[focus ?? '']}
                <AdvancedToggle>
                  <dl class="rb-adv">
                    <dt>Encoding <HelpTip text="How Redis stores this value internally (e.g. listpack for small collections). Changes automatically as the key grows." /></dt>
                    <dd class="mono">{m?.encoding ?? 'not measured'}</dd>
                    <dt>Memory</dt>
                    <dd class="mono">{m?.bytes != null ? `${fullCount(m.bytes)} bytes` : 'not measured'}</dd>
                    <dt>Key</dt>
                    <dd class="mono">{focus}</dd>
                  </dl>
                </AdvancedToggle>
              {/snippet}
            </RedisKeyView>
          {/key}
        {/if}
      {/snippet}
    </SplitDetail>
  {:else if section === 'workbench'}
    <RedisWorkbench {connId} />
  {:else if section === 'slowlog'}
    <div class="rb-toolbar">
      <span class="rb-threshold"><Icon name="info" size={13} /> {slowThresholdText(slow?.threshold_us)}{#if slow?.max_len != null}{' '}The server keeps the last {fullCount(slow.max_len)}.{/if}</span>
      <label class="rb-field rb-right">
        <span class="rb-label">Show</span>
        <select class="ds-control" bind:value={slowCount} aria-label="How many slow commands to show">
          <option value={25}>Last 25</option>
          <option value={50}>Last 50</option>
          <option value={128}>Last 128</option>
        </select>
      </label>
    </div>
    <StreamTable
      rows={slowList}
      columns={slowCols}
      rowKey={(r) => String(r.id)}
      ariaLabel="Slow commands"
      filterText={(r) => `${r.command} ${r.client}`}
      filterPlaceholder="Filter commands…"
      initialSort={{ key: 'when', dir: 'desc' }}
      loading={loadingSlow}
      error={slowError}
      emptyTitle="No slow commands recorded"
      emptyBody="Redis has not logged any command over its threshold. That is good news."
    >
      {#snippet cell(r, c)}
        {#if c.key === 'when'}<span title={r.whenExact}>{r.when}</span>
        {:else if c.key === 'duration'}<span class="ds-num rb-took">{r.duration}</span>
        {:else if c.key === 'command'}<span class="mono" title={r.command}>{r.command}</span>
        {:else if c.key === 'client'}<span class="rb-dim">{r.client}</span>
        {/if}
      {/snippet}
    </StreamTable>
  {:else if section === 'info'}
    <div class="ds-body rb-info">
      <StatCards items={cards} />
      {#if !info && loadingInfo}
        <div class="ds-empty" aria-busy="true">Reading the server status…</div>
      {:else if info}
        <div class="rb-groups">
          {#each groups as g (g.name)}
            <section class="rb-panel" aria-label={g.name}>
              <div class="rb-panel-head">{g.name}</div>
              <dl class="rb-facts">
                {#each g.facts as f (f.label)}
                  <dt>{f.label}{#if f.help} <HelpTip text={f.help} />{/if}</dt>
                  <dd class={f.tone ?? ''} title={f.title}>{f.value}</dd>
                {/each}
              </dl>
            </section>
          {/each}
        </div>
        <AdvancedToggle label="Raw INFO">
          <div class="rb-raw">
            <label class="ds-search rb-raw-filter">
              <Icon name="search" size={13} />
              <input bind:value={rawFilter} placeholder="Filter metrics…" aria-label="Filter metrics" />
            </label>
            {#each info.sections as s (s.name)}
              {@const rows = rawFilter ? s.entries.filter(([k, v]) => `${k} ${v}`.toLowerCase().includes(rawFilter.toLowerCase())) : s.entries}
              {#if rows.length}
                <div class="ds-section-title">{s.name}</div>
                <table class="ds-table rb-raw-table">
                  <tbody>
                    {#each rows as [k, v] (k)}
                      <tr><td class="mono">{k}</td><td class="mono">{v}</td></tr>
                    {/each}
                  </tbody>
                </table>
              {/if}
            {/each}
          </div>
        </AdvancedToggle>
      {/if}
    </div>
  {/if}

  {#if pubsubVisited}
    <div class="rb-pubsub" class:hidden={section !== 'pubsub'}>
      <RedisPubSub {tab} />
    </div>
  {/if}
</StreamShell>

{#if addOpen}
  <RedisAddKeyDialog {connId} {db} onClose={() => (addOpen = false)} onCreated={created} />
{/if}

{#if prefixFor}
  <div class="um-backdrop" role="presentation">
    <div class="um-dlg sm" role="alertdialog" aria-modal="true" aria-label="Delete keys under a prefix" tabindex="-1" onkeydown={(e) => e.key === 'Escape' && !prefixBusy && (prefixFor = null)}>
      <div class="um-dlg-head">
        <span class="um-dlg-icon danger"><Icon name="trash" size={18} /></span>
        <div class="um-dlg-title"><b>Delete keys under {prefixFor.prefix}</b><span>Database {db}</span></div>
      </div>
      <div class="um-dlg-body">
        <p class="rb-confirm">This deletes <b>{plural(prefixFor.names.length, 'key')}</b> named <span class="mono">{prefixFor.prefix}</span> or starting with <span class="mono">{prefixFor.prefix}:</span>. Apps that use them will find nothing. This cannot be undone.</p>
        {#if partial}<p class="rb-confirm">The key list is partial (read ~{fullCount(scanned)} so far), so only the keys read so far are deleted. Use “Scan more” first to include the rest.</p>{/if}
        {#if prefixError}<div class="rb-error" role="alert">{prefixError}</div>{/if}
      </div>
      <div class="um-dlg-foot">
        <span class="rb-grow"></span>
        <button type="button" class="cfm-btn" use:autofocus onclick={() => (prefixFor = null)} disabled={prefixBusy}>Cancel</button>
        <button type="button" class="cfm-btn danger" onclick={deletePrefix} disabled={prefixBusy || prefixFor.names.length === 0}>{prefixBusy ? 'Deleting…' : `Delete ${plural(prefixFor.names.length, 'key')}`}</button>
      </div>
    </div>
  </div>
{/if}

{#if flushOpen}
  <div class="um-backdrop" role="presentation">
    <div class="um-dlg sm" role="alertdialog" aria-modal="true" aria-label="Delete all keys" tabindex="-1" onkeydown={(e) => e.key === 'Escape' && !flushBusy && (flushOpen = false)}>
      <div class="um-dlg-head">
        <span class="um-dlg-icon danger"><Icon name="trash" size={18} /></span>
        <div class="um-dlg-title"><b>Delete all keys in Database {db}</b><span>{profile?.name ?? ''}</span></div>
      </div>
      <div class="um-dlg-body">
        <p class="rb-confirm">This deletes <b>{plural(keysHere ?? 0, 'key')}</b> in Database {db} (FLUSHDB). Apps that use them will find nothing. Other databases are not touched. This cannot be undone.</p>
        {#if flushError}<div class="rb-error" role="alert">{flushError}</div>{/if}
      </div>
      <div class="um-dlg-foot">
        <span class="rb-grow"></span>
        <button type="button" class="cfm-btn" use:autofocus onclick={() => (flushOpen = false)} disabled={flushBusy}>Cancel</button>
        <button type="button" class="cfm-btn danger" onclick={flush} disabled={flushBusy}>{flushBusy ? 'Deleting…' : `Delete ${plural(keysHere ?? 0, 'key')}`}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .rb-stats {
    flex: none;
    padding: var(--px-14) var(--px-18) var(--px-4);
  }
  .rb-toolbar {
    flex: none;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--px-10);
    padding: var(--px-10) var(--px-18);
  }
  .rb-field {
    display: inline-flex;
    align-items: center;
    gap: var(--px-6);
  }
  .rb-right {
    margin-left: auto;
  }
  .rb-label {
    font-size: var(--px-12);
    font-weight: 500;
    color: var(--text2);
  }
  .rb-pattern {
    flex: 1 1 var(--px-200);
    max-width: var(--px-320);
  }
  .rb-clear {
    border: 0;
    background: transparent;
    color: var(--muted);
    display: inline-flex;
    cursor: pointer;
    padding: var(--px-2);
  }
  .rb-seg {
    display: inline-flex;
    padding: var(--px-2);
    gap: var(--px-2);
    background: var(--panel);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-8);
  }
  .rb-seg button {
    height: var(--px-26);
    padding: 0 var(--px-12);
    border: 0;
    border-radius: var(--px-6);
    background: transparent;
    font-family: var(--font-main);
    font-size: var(--px-12_5);
    font-weight: 500;
    color: var(--text2);
    cursor: pointer;
  }
  .rb-seg button:hover {
    color: var(--text);
  }
  .rb-seg button.on {
    background: var(--surface);
    color: var(--text);
    font-weight: 600;
    box-shadow: var(--shadow-xs);
  }
  .rb-scan {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: var(--px-8);
    font-size: var(--px-12);
    color: var(--text2);
  }
  .rb-spin {
    display: inline-flex;
    color: var(--primary);
    animation: rb-rot 0.9s linear infinite;
  }
  @keyframes rb-rot {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .rb-spin {
      animation: none;
    }
  }
  .rb-partial {
    display: inline-flex;
    align-items: center;
    gap: var(--px-5);
    color: var(--sacc-amber);
    font-weight: 600;
  }
  .rb-more {
    height: var(--px-26);
  }
  .rb-count b {
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  .rb-list {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .rb-list.dim {
    opacity: 0.55;
  }
  .rb-type {
    display: inline-flex;
    align-items: center;
    gap: var(--px-5);
    font-size: var(--px-11_5);
    font-weight: 500;
    color: var(--text2);
    background: var(--panel);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-10);
    padding: var(--px-1) var(--px-8);
    white-space: nowrap;
  }
  .rb-type::before {
    content: '';
    width: var(--px-6);
    height: var(--px-6);
    border-radius: 50%;
    background: var(--tc);
    flex: none;
  }
  .rb-ttl {
    font-size: var(--px-12);
    color: var(--text2);
  }
  .rb-ttl.quiet {
    color: var(--muted);
  }
  .rb-ttl.soon {
    color: var(--sacc-amber);
    font-weight: 600;
  }
  .rb-ttl.gone {
    color: var(--danger-text);
  }
  .rb-size {
    color: var(--tbl-cell);
  }
  .rb-tree {
    flex: 1;
    min-height: 0;
    overflow: auto;
    border-top: var(--px-1) solid var(--border);
    background: var(--surface);
    padding: var(--px-4) 0;
  }
  .rb-trow {
    display: flex;
    align-items: center;
    gap: var(--px-8);
    height: var(--px-32);
    padding-right: var(--px-12);
    cursor: pointer;
    font-size: var(--px-12_5);
    outline: none;
  }
  .rb-trow:hover {
    background: var(--tbl-hover);
  }
  .rb-trow:focus-visible {
    box-shadow: inset 0 0 0 var(--px-2) var(--ring-soft);
  }
  .rb-trow.sel {
    background: color-mix(in srgb, var(--primary) 14%, var(--surface));
    box-shadow: inset var(--px-3) 0 0 var(--primary);
  }
  .rb-chev {
    display: inline-flex;
    color: var(--muted);
    width: var(--px-12);
  }
  .rb-seg-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text);
  }
  .rb-folder-count {
    font-size: var(--px-11_5);
    color: var(--muted);
  }
  .rb-folder-del {
    flex: none;
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--px-24);
    height: var(--px-24);
    border: 0;
    border-radius: var(--px-5);
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    opacity: 0;
  }
  .rb-trow:hover .rb-folder-del,
  .rb-trow:focus-within .rb-folder-del,
  .rb-folder-del:focus-visible {
    opacity: 1;
  }
  .rb-folder-del:hover {
    color: var(--error);
    background: color-mix(in srgb, var(--error) 12%, transparent);
  }
  .rb-trow .rb-ttl {
    width: var(--px-90);
    text-align: right;
  }
  .rb-trow .rb-size {
    width: var(--px-70);
    text-align: right;
  }
  .rb-adv {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: var(--px-4) var(--px-14);
    margin: 0;
    font-size: var(--px-12);
  }
  .rb-adv dt {
    color: var(--text2);
  }
  .rb-adv dd {
    margin: 0;
    color: var(--text);
    overflow-wrap: anywhere;
  }
  .rb-threshold {
    display: inline-flex;
    align-items: center;
    gap: var(--px-6);
    font-size: var(--px-12_5);
    color: var(--text2);
  }
  .rb-took {
    color: var(--sacc-amber);
    font-weight: 600;
  }
  .rb-dim {
    color: var(--muted);
  }
  .rb-info {
    gap: var(--px-18);
  }
  .rb-groups {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(var(--px-320), 1fr));
    gap: var(--px-14);
  }
  .rb-panel {
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-10);
    background: var(--surface);
    box-shadow: var(--shadow-xs);
    overflow: hidden;
  }
  .rb-panel-head {
    padding: var(--px-10) var(--px-14);
    font-size: var(--px-13);
    font-weight: 600;
    color: var(--text);
    border-bottom: var(--px-1) solid var(--border);
  }
  .rb-facts {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: var(--px-8) var(--px-14);
    margin: 0;
    padding: var(--px-12) var(--px-14);
    font-size: var(--px-12_5);
  }
  .rb-facts dt {
    color: var(--text2);
    display: inline-flex;
    align-items: center;
    gap: var(--px-4);
  }
  .rb-facts dd {
    margin: 0;
    text-align: right;
    color: var(--text);
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }
  .rb-facts dd.ok {
    color: var(--sacc-green);
  }
  .rb-facts dd.warn {
    color: var(--sacc-amber);
  }
  .rb-facts dd.bad {
    color: var(--danger-text);
  }
  .rb-raw {
    display: flex;
    flex-direction: column;
    gap: var(--px-8);
  }
  .rb-raw-filter {
    max-width: var(--px-320);
  }
  .rb-raw-table td:first-child {
    width: 40%;
    color: var(--text2);
  }
  .rb-pubsub {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .rb-pubsub.hidden {
    display: none;
  }
  .rb-confirm {
    margin: 0;
    line-height: 1.5;
    color: var(--text2);
  }
  .rb-error {
    padding: var(--px-10) var(--px-12);
    border-radius: var(--px-8);
    background: var(--danger-soft);
    color: var(--danger-text);
    font-size: var(--px-12_5);
  }
  .rb-grow {
    flex: 1;
  }
</style>
