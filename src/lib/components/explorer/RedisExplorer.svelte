<script lang="ts">
  // Redis key browser embedded in the ObjectExplorer sidebar (moved here from the
  // standalone workspace tab): DB selector + SCAN count + Pub/Sub + Flush + Add key,
  // a pattern filter, and the prefix key tree. Clicking a key opens a per-key viewer
  // tab (redis-key). No workspace tab is opened when the connection connects.
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { buildRedisTree, flattenRedisTree, type RedisKeyInfo } from '$lib/redis/tree'

  interface Props {
    connId: string
  }
  let { connId }: Props = $props()

  let curDb = $state(0)
  let dbCount = $state(16)
  let keys = $state<RedisKeyInfo[]>([])
  let dbsize = $state(0)
  let pattern = $state('')
  let loading = $state(false)
  let error = $state<string | null>(null)
  let expanded = $state<Set<string>>(new Set())

  const TYPE_COLOR: Record<string, string> = {
    string: 'var(--hex-5b9bd5)',
    hash: 'var(--hex-e8c547)',
    list: 'var(--hex-56b6c2)',
    set: 'var(--hex-b48ead)',
    zset: 'var(--hex-e06c75)',
    stream: 'var(--hex-e8923a)',
  }
  const typeColor = (t: string) => TYPE_COLOR[t] ?? 'var(--hex-9aa4b8)'
  const typeBadge = (t: string) => (t || '?').slice(0, 1).toUpperCase()
  function ttlLabel(ttl: number): string {
    if (ttl === -1) return '∞'
    if (ttl === -2) return 'expired'
    if (ttl < 60) return `${ttl}s`
    if (ttl < 3600) return `${Math.floor(ttl / 60)}m`
    return `${Math.floor(ttl / 3600)}h`
  }

  const tree = $derived(buildRedisTree(keys))
  const rows = $derived(flattenRedisTree(tree, expanded))
  // Highlight the key whose viewer tab is currently active (this connection).
  const activeKey = $derived(
    tabs.active?.contentType === 'redis-key' && tabs.active?.connectionId === connId
      ? ((tabs.active.state as { key?: string }).key ?? null)
      : null,
  )

  async function load() {
    if (!connId) return
    loading = true
    error = null
    try {
      const collected: RedisKeyInfo[] = []
      let cursor = 0
      let size = 0
      for (let i = 0; i < 50; i++) {
        const res = await ipc.redisScan(connId, pattern, cursor, 200)
        collected.push(...res.keys)
        size = res.dbsize
        cursor = res.cursor
        if (cursor === 0 || collected.length >= 5000) break
      }
      keys = collected
      dbsize = size
    } catch (e) {
      error = String(e)
    } finally {
      loading = false
    }
  }

  // reload when connection or pattern changes (untrack: load writes state synchronously)
  $effect(() => {
    void connId
    void pattern
    untrack(() => void load())
  })
  $effect(() => {
    const cid = connId
    if (cid) untrack(() => void ipc.redisDatabaseCount(cid).then((n) => (dbCount = n)).catch(() => {}))
  })
  // reload the key list when a key-viewer tab mutates the keyspace (delete/add/TTL)
  $effect(() => {
    void explorer.redisTick[connId]
    untrack(() => void load())
  })

  async function switchDb(e: Event) {
    const n = Number((e.currentTarget as HTMLSelectElement).value)
    curDb = n
    try {
      await ipc.redisSelectDb(connId, n)
      await load()
    } catch (err) {
      error = String(err)
    }
  }

  function toggle(path: string) {
    const next = new Set(expanded)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    expanded = next
  }

  async function flushDb() {
    const ans = window.prompt(`FLUSHDB will DELETE ALL of db${curDb}. Type "db${curDb}" to confirm:`)
    if (ans !== `db${curDb}`) return
    try {
      await ipc.redisFlushDb(connId)
      toasts.success('FLUSHDB — entire DB cleared')
      await load()
    } catch (e) {
      toasts.error(`FLUSHDB failed: ${e}`)
    }
  }

  // ---- Add key dialog ------------------------------------------------------
  let addOpen = $state(false)
  let addType = $state<'string' | 'hash' | 'list' | 'set' | 'zset'>('string')
  let addName = $state('')
  let addData = $state('')
  let addTtl = $state('')
  let addBusy = $state(false)
  const addHint = $derived(
    addType === 'string' ? 'The string value.'
    : addType === 'hash' ? 'One field per line as field=value.'
    : addType === 'zset' ? 'One member per line as member=score.'
    : 'One value per line.',
  )
  function openAdd() {
    addType = 'string'
    addName = ''
    addData = ''
    addTtl = ''
    addOpen = true
  }
  async function createKey() {
    const name = addName.trim()
    if (!name) {
      toasts.error('Key name is required')
      return
    }
    addBusy = true
    try {
      if (addType === 'string') {
        await ipc.redisEdit(connId, name, { op: 'setString', value: addData })
      } else if (addType === 'hash') {
        const pairs = addData.split('\n').map((l) => l.trim()).filter(Boolean)
        for (const p of pairs) {
          const i = p.indexOf('=')
          const field = i >= 0 ? p.slice(0, i) : p
          const value = i >= 0 ? p.slice(i + 1) : ''
          await ipc.redisEdit(connId, name, { op: 'hSet', field, value })
        }
      } else if (addType === 'list') {
        for (const v of addData.split('\n').filter((l) => l.length)) {
          await ipc.redisEdit(connId, name, { op: 'rPush', value: v })
        }
      } else if (addType === 'set') {
        for (const m of addData.split('\n').map((l) => l.trim()).filter(Boolean)) {
          await ipc.redisEdit(connId, name, { op: 'sAdd', member: m })
        }
      } else if (addType === 'zset') {
        for (const p of addData.split('\n').map((l) => l.trim()).filter(Boolean)) {
          const i = p.indexOf('=')
          const member = i >= 0 ? p.slice(0, i) : p
          const score = i >= 0 ? parseFloat(p.slice(i + 1)) || 0 : 0
          await ipc.redisEdit(connId, name, { op: 'zAdd', member, score })
        }
      }
      const secs = parseInt(addTtl, 10)
      if (Number.isFinite(secs) && secs > 0) await ipc.redisSetTtl(connId, name, secs)
      toasts.success(`Created "${name}"`)
      addOpen = false
      await load()
      tabs.openRedisKey(connId, name)
    } catch (e) {
      toasts.error(`Create failed: ${e}`)
    } finally {
      addBusy = false
    }
  }
</script>

<div style="display:flex;flex-direction:column;min-height:0">
  <!-- sticky header: DB selector + SCAN count + actions -->
  <div style="position:sticky;top:0;z-index:2;background:var(--surface);flex:none;padding:var(--px-8) var(--px-8) var(--px-6);border-bottom:var(--px-1) solid var(--border);display:flex;align-items:center;gap:var(--px-8);flex-wrap:wrap">
    <span style="font-size:var(--px-12);color:var(--text2)">DB</span>
    <select value={curDb} onchange={switchDb} class="mono" title="Select logical database" aria-label="Redis database" style="font-size:var(--px-11);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-3) var(--px-6);color:var(--text);cursor:pointer;outline:none">
      {#each Array.from({ length: dbCount }, (_, i) => i) as n (n)}<option value={n}>db{n}</option>{/each}
    </select>
    <span class="mono" style="font-size:var(--px-10_5);color:var(--muted)">SCAN · {dbsize} keys</span>
    <span style="margin-left:auto;display:flex;gap:var(--px-8);align-items:center">
      <span onclick={openAdd} onkeydown={(e) => e.key === 'Enter' && openAdd()} role="button" tabindex="0" title="Add a new key" style="font-size:var(--px-10_5);color:var(--primary);cursor:pointer">＋ Key</span>
      <span onclick={() => tabs.openRedisPubSubTab(connId)} onkeydown={(e) => e.key === 'Enter' && tabs.openRedisPubSubTab(connId)} role="button" tabindex="0" title="Pub/Sub Monitor" style="font-size:var(--px-10_5);color:var(--primary);cursor:pointer">Pub/Sub ▸</span>
      <span onclick={flushDb} onkeydown={(e) => e.key === 'Enter' && flushDb()} role="button" tabindex="0" title="FLUSHDB (clear entire DB)" style="font-size:var(--px-10_5);color:var(--error);cursor:pointer">Flush</span>
    </span>
    <input
      bind:value={pattern}
      placeholder="pattern (e.g. user:*)"
      class="mono"
      style="width:100%;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-8);font-size:var(--px-11_5);color:var(--text);outline:none"
    />
  </div>

  <!-- key tree -->
  {#if error}
    <div style="padding:var(--px-10);font-size:var(--px-11_5);color:var(--error)">{error}</div>
  {:else if loading && rows.length === 0}
    <div style="padding:var(--px-10);font-size:var(--px-11_5);color:var(--muted)">Scanning…</div>
  {:else if rows.length === 0}
    <div style="padding:var(--px-10);font-size:var(--px-11_5);color:var(--muted)">No matching keys.</div>
  {:else}
    {#each rows as r (r.path)}
      {#if r.kind === 'folder'}
        <div
          onclick={() => toggle(r.path)}
          onkeydown={(e) => e.key === 'Enter' && toggle(r.path)}
          role="button"
          tabindex="0"
          style="display:flex;align-items:center;gap:var(--px-8);padding:var(--px-5) var(--px-8);border-radius:var(--px-6);cursor:pointer;padding-left:calc(var(--px-8) + {r.depth} * var(--px-14))"
        >
          <span class="mono" style="flex:none;width:var(--px-10);text-align:center;font-size:var(--px-9);color:var(--muted)">{r.expanded ? '▾' : '▸'}</span>
          <span class="mono" style="font-size:var(--px-12);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text2)">{r.segment}</span>
          <span class="mono" style="margin-left:auto;flex:none;font-size:var(--px-10);color:var(--muted)">{r.count}</span>
        </div>
      {:else}
        {@const kt = r.key?.key_type ?? 'string'}
        <div
          onclick={() => tabs.openRedisKey(connId, r.path)}
          onkeydown={(e) => e.key === 'Enter' && tabs.openRedisKey(connId, r.path)}
          role="button"
          tabindex="0"
          title={r.path}
          style="display:flex;align-items:center;gap:var(--px-8);padding:var(--px-5) var(--px-8);border-radius:var(--px-6);cursor:pointer;padding-left:calc(var(--px-8) + {r.depth} * var(--px-14));background:{activeKey === r.path ? 'color-mix(in srgb, var(--primary) 26%, transparent)' : 'transparent'}"
        >
          <span class="mono" style="flex:none;font-size:var(--px-9);font-weight:700;color:{typeColor(kt)};border:var(--px-1) solid {typeColor(kt)};border-radius:var(--px-3);padding:0 var(--px-4)">{typeBadge(kt)}</span>
          <span class="mono" style="font-size:var(--px-12);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{r.segment}</span>
          <span class="mono" style="margin-left:auto;flex:none;font-size:var(--px-10);color:{r.key?.ttl === -2 ? 'var(--error)' : 'var(--muted)'}">{r.key ? ttlLabel(r.key.ttl) : ''}</span>
        </div>
      {/if}
    {/each}
  {/if}
</div>

{#if addOpen}
  <div
    role="presentation"
    style="position:fixed;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:90"
  >
    <div
      role="dialog"
      aria-modal="true"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.key === 'Escape' && (addOpen = false)}
      tabindex="-1"
      style="background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);padding:var(--px-18);width:min(var(--px-460), 92vw);box-shadow:0 var(--px-24) var(--px-60) var(--rgba-0-0-0-_55);display:flex;flex-direction:column;gap:var(--px-10)"
    >
      <div style="font-size:var(--px-14);font-weight:600;color:var(--text)">Add key</div>
      <div style="display:flex;gap:var(--px-8);align-items:center">
        <select bind:value={addType} class="mono" aria-label="Key type" style="font-size:var(--px-12);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-8);color:var(--text);outline:none">
          <option value="string">string</option>
          <option value="hash">hash</option>
          <option value="list">list</option>
          <option value="set">set</option>
          <option value="zset">zset</option>
        </select>
        <input
          bind:value={addName}
          placeholder="key name (e.g. user:42)"
          class="mono"
          style="flex:1;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-8);font-size:var(--px-12);color:var(--text);outline:none"
        />
      </div>
      <div style="font-size:var(--px-11);color:var(--muted)">{addHint}</div>
      <textarea
        bind:value={addData}
        class="mono"
        placeholder={addType === 'string' ? 'value' : addType === 'hash' ? 'name=Ada\nrole=admin' : addType === 'zset' ? 'alice=1\nbob=2' : 'one\ntwo'}
        style="min-height:var(--px-120);resize:vertical;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-10);font-size:var(--px-12);color:var(--text);outline:none"
      ></textarea>
      <div style="display:flex;gap:var(--px-8);align-items:center">
        <span style="font-size:var(--px-12);color:var(--text2)">TTL (seconds)</span>
        <input
          bind:value={addTtl}
          placeholder="empty = no expiry"
          inputmode="numeric"
          class="mono"
          style="width:var(--px-160);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-8);font-size:var(--px-12);color:var(--text);outline:none"
        />
      </div>
      <div style="display:flex;gap:var(--px-8);justify-content:flex-end;margin-top:var(--px-4)">
        <span onclick={() => (addOpen = false)} onkeydown={(e) => e.key === 'Enter' && (addOpen = false)} role="button" tabindex="0" class="eg-btn">Cancel</span>
        <span onclick={createKey} onkeydown={(e) => e.key === 'Enter' && createKey()} role="button" tabindex="0" class="eg-btn primary" style={addBusy ? 'opacity:.6;pointer-events:none' : ''}>Create</span>
      </div>
    </div>
  </div>
{/if}

<style>
  .eg-btn {
    font-size: var(--px-12);
    color: var(--text2);
    background: var(--panel);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-6);
    padding: var(--px-5) var(--px-14);
    cursor: pointer;
  }
  .eg-btn:hover {
    background: var(--hover);
  }
  .eg-btn.primary {
    color: var(--hex-fff);
    background: var(--primary);
    border-color: var(--primary);
    font-weight: 600;
  }
</style>
