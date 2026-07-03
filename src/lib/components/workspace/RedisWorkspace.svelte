<script lang="ts">
  // Redis Key Explorer — port 1:1 từ Database Studio.dc.html dòng 662-678:
  // panel trái 300px (DB selector + SCAN count + cây key theo prefix ':'),
  // panel phải là Key Viewer (T4 — hiện placeholder). Key nạp qua SCAN cursor
  // (không KEYS *); cây prefix dựng bằng buildRedisTree (lib/redis/tree.ts).
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import { connections } from '$lib/stores/connections.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { buildRedisTree, flattenRedisTree, type RedisKeyInfo } from '$lib/redis/tree'
  import type { TabState } from '$lib/types'

  interface Props {
    tab: TabState
  }
  let { tab }: Props = $props()

  const profile = $derived(connections.byId(tab.connectionId))
  const dbIndex = $derived(profile?.database?.trim() || '0')

  let keys = $state<RedisKeyInfo[]>([])
  let dbsize = $state(0)
  let pattern = $state('')
  let loading = $state(false)
  let error = $state<string | null>(null)
  let expanded = $state<Set<string>>(new Set())
  let selected = $state<string | null>(null)
  let selectedValue = $state<ipc.RedisKeyValue | null>(null)
  let valLoading = $state(false)
  let valError = $state<string | null>(null)
  let stringDraft = $state('')

  // màu badge theo type (token đã có trong tokens.css)
  const TYPE_COLOR: Record<string, string> = {
    string: 'var(--hex-5b9bd5)',
    hash: 'var(--hex-e8c547)',
    list: 'var(--hex-56b6c2)',
    set: 'var(--hex-b48ead)',
    zset: 'var(--hex-e06c75)',
    stream: 'var(--hex-e8923a)',
  }
  function typeColor(t: string): string {
    return TYPE_COLOR[t] ?? 'var(--hex-9aa4b8)'
  }
  function typeBadge(t: string): string {
    return (t || '?').slice(0, 1).toUpperCase()
  }
  function ttlLabel(ttl: number): string {
    if (ttl === -1) return '∞'
    if (ttl === -2) return 'expired'
    if (ttl < 60) return `${ttl}s`
    if (ttl < 3600) return `${Math.floor(ttl / 60)}m`
    return `${Math.floor(ttl / 3600)}h`
  }

  const tree = $derived(buildRedisTree(keys))
  const rows = $derived(flattenRedisTree(tree, expanded))

  async function load() {
    if (!tab.connectionId) return
    loading = true
    error = null
    try {
      // gom key qua nhiều vòng SCAN tới cursor 0 (giới hạn an toàn ~5000)
      const collected: RedisKeyInfo[] = []
      let cursor = 0
      let size = 0
      for (let i = 0; i < 50; i++) {
        const res = await ipc.redisScan(tab.connectionId, pattern, cursor, 200)
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

  // nạp lại khi đổi connection hoặc pattern. untrack: load() ghi $state đồng bộ
  // (loading/error) → tránh read+write cùng vùng track gây effect_update_depth.
  $effect(() => {
    void tab.connectionId
    void pattern
    untrack(() => void load())
  })

  function toggle(path: string) {
    const next = new Set(expanded)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    expanded = next
  }

  async function copyKey(name: string) {
    await navigator.clipboard.writeText(name)
    toasts.success(`Đã copy "${name}"`)
  }

  async function selectKey(path: string) {
    if (!tab.connectionId) return
    selected = path
    selectedValue = null
    valError = null
    valLoading = true
    try {
      selectedValue = await ipc.redisGet(tab.connectionId, path)
      if (selectedValue.value.kind === 'string') stringDraft = selectedValue.value.value
    } catch (e) {
      valError = String(e)
    } finally {
      valLoading = false
    }
  }

  async function edit(op: ipc.RedisEditOp, okMsg: string) {
    if (!tab.connectionId || !selected) return
    try {
      await ipc.redisEdit(tab.connectionId, selected, op)
      toasts.success(okMsg)
      await selectKey(selected)
      await load()
    } catch (e) {
      toasts.error(`Sửa thất bại: ${e}`)
    }
  }

  // "+ Add" theo kiểu — dùng prompt gọn (form đầy đủ để Phase sau nếu cần).
  function addItem() {
    const v = selectedValue?.value
    if (!v) return
    if (v.kind === 'hash') {
      const field = window.prompt('Field:')
      if (!field) return
      const value = window.prompt(`Value cho "${field}":`) ?? ''
      void edit({ op: 'hSet', field, value }, `HSET ${field}`)
    } else if (v.kind === 'set') {
      const member = window.prompt('Member:')
      if (member) void edit({ op: 'sAdd', member }, `SADD ${member}`)
    } else if (v.kind === 'zset') {
      const member = window.prompt('Member:')
      if (!member) return
      const score = parseFloat(window.prompt(`Score cho "${member}":`) ?? '0') || 0
      void edit({ op: 'zAdd', member, score }, `ZADD ${member} ${score}`)
    } else if (v.kind === 'list') {
      const value = window.prompt('Value (RPUSH):')
      if (value !== null) void edit({ op: 'rPush', value }, 'RPUSH')
    } else if (v.kind === 'stream') {
      const raw = window.prompt('Fields (dạng f1=v1,f2=v2):')
      if (!raw) return
      const fields = raw.split(',').map((p) => p.split('=') as [string, string]).filter((p) => p[0])
      void edit({ op: 'xAdd', fields }, 'XADD')
    }
  }

  function delItem(kind: string, id: string) {
    if (kind === 'hash') void edit({ op: 'hDel', field: id }, `HDEL ${id}`)
    else if (kind === 'set') void edit({ op: 'sRem', member: id }, `SREM ${id}`)
    else if (kind === 'zset') void edit({ op: 'zRem', member: id }, `ZREM ${id}`)
    else if (kind === 'list') void edit({ op: 'lRem', value: id }, 'LREM')
    else if (kind === 'stream') void edit({ op: 'xDel', id }, `XDEL ${id}`)
  }

  async function delKey() {
    if (!tab.connectionId || !selected) return
    if (!window.confirm(`Xóa key "${selected}"? (DEL)`)) return
    try {
      await ipc.redisDel(tab.connectionId, selected)
      toasts.success(`Đã DEL "${selected}"`)
      selected = null
      selectedValue = null
      await load()
    } catch (e) {
      toasts.error(`DEL thất bại: ${e}`)
    }
  }

  async function editTtl() {
    if (!tab.connectionId || !selected) return
    const cur = selectedValue?.ttl ?? -1
    const input = window.prompt('TTL (giây; 0 hoặc trống = PERSIST bỏ hết hạn):', cur > 0 ? String(cur) : '')
    if (input === null) return
    const secs = parseInt(input, 10) || 0
    try {
      await ipc.redisSetTtl(tab.connectionId, selected, secs)
      toasts.success(secs > 0 ? `EXPIRE ${secs}s` : 'PERSIST')
      await selectKey(selected)
      await load()
    } catch (e) {
      toasts.error(`Set TTL thất bại: ${e}`)
    }
  }
</script>

{#snippet delCell(id: string, del?: (id: string) => void)}
  {#if del}
    <td style="border-bottom:var(--px-1) solid var(--border);text-align:center;width:var(--px-38)">
      <span onclick={() => del(id)} onkeydown={(e) => e.key === 'Enter' && del(id)} role="button" tabindex="0" title="Xóa" style="cursor:pointer;color:var(--muted);font-size:var(--px-13)">×</span>
    </td>
  {/if}
{/snippet}

{#snippet kvTable(h1: string, h2: string, rows: [string, string][], del?: (id: string) => void)}
  <table class="mono" style="border-collapse:collapse;width:100%;font-size:var(--px-12_5)">
    <thead><tr>
      <th style="position:sticky;top:0;background:var(--header);border-bottom:var(--px-1) solid var(--border2);padding:var(--px-7) var(--px-14);text-align:left;color:var(--text2);font-weight:600">{h1}</th>
      <th style="position:sticky;top:0;background:var(--header);border-bottom:var(--px-1) solid var(--border2);padding:var(--px-7) var(--px-14);text-align:left;color:var(--text2);font-weight:600">{h2}</th>
      {#if del}<th style="position:sticky;top:0;background:var(--header);border-bottom:var(--px-1) solid var(--border2);width:var(--px-38)"></th>{/if}
    </tr></thead>
    <tbody>
      {#each rows as row, i (i)}
        <tr><td style="padding:var(--px-7) var(--px-14);border-bottom:var(--px-1) solid var(--border);color:var(--hex-e8c547)">{row[0]}</td><td style="padding:var(--px-7) var(--px-14);border-bottom:var(--px-1) solid var(--border)">{row[1]}</td>{@render delCell(row[0], del)}</tr>
      {/each}
    </tbody>
  </table>
{/snippet}

{#snippet listTable(h1: string, items: string[], del?: (id: string) => void)}
  <table class="mono" style="border-collapse:collapse;width:100%;font-size:var(--px-12_5)">
    <thead><tr>
      <th style="position:sticky;top:0;background:var(--header);border-bottom:var(--px-1) solid var(--border2);padding:var(--px-7) var(--px-14);text-align:left;color:var(--text2);font-weight:600;width:var(--px-40)">{h1}</th>
      <th style="position:sticky;top:0;background:var(--header);border-bottom:var(--px-1) solid var(--border2);padding:var(--px-7) var(--px-14);text-align:left;color:var(--text2);font-weight:600">Value</th>
      {#if del}<th style="position:sticky;top:0;background:var(--header);border-bottom:var(--px-1) solid var(--border2);width:var(--px-38)"></th>{/if}
    </tr></thead>
    <tbody>
      {#each items as item, i (i)}
        <tr><td style="padding:var(--px-7) var(--px-14);border-bottom:var(--px-1) solid var(--border);color:var(--muted)">{i}</td><td style="padding:var(--px-7) var(--px-14);border-bottom:var(--px-1) solid var(--border)">{item}</td>{@render delCell(item, del)}</tr>
      {/each}
    </tbody>
  </table>
{/snippet}

<div style="flex:1;display:flex;min-height:0">
  <!-- panel trái — key explorer (dòng 663-678) -->
  <div style="width:var(--px-300);flex:none;border-right:var(--px-1) solid var(--border);background:var(--surface);display:flex;flex-direction:column;min-height:0">
    <!-- header: DB selector + SCAN count -->
    <div style="flex:none;padding:var(--px-9) var(--px-12);border-bottom:var(--px-1) solid var(--border);display:flex;align-items:center;gap:var(--px-8)">
      <span style="font-size:var(--px-12);color:var(--text2)">DB</span>
      <span class="mono" style="font-size:var(--px-11);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-3) var(--px-9)">db{dbIndex}</span>
      <span class="mono" style="margin-left:auto;font-size:var(--px-11);color:var(--muted)">SCAN · {dbsize} keys</span>
    </div>
    <!-- search pattern -->
    <div style="flex:none;padding:var(--px-6) var(--px-8)">
      <input
        bind:value={pattern}
        placeholder="pattern (vd user:*)"
        class="mono"
        style="width:100%;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-8);font-size:var(--px-11_5);color:var(--text);outline:none"
      />
    </div>
    <!-- cây key -->
    <div style="flex:1;overflow:auto;padding:var(--px-6);min-height:0">
      {#if error}
        <div style="padding:var(--px-10);font-size:var(--px-11_5);color:var(--error)">{error}</div>
      {:else if loading && rows.length === 0}
        <div style="padding:var(--px-10);font-size:var(--px-11_5);color:var(--muted)">Đang SCAN…</div>
      {:else if rows.length === 0}
        <div style="padding:var(--px-10);font-size:var(--px-11_5);color:var(--muted)">Không có key khớp.</div>
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
              onclick={() => selectKey(r.path)}
              ondblclick={() => copyKey(r.path)}
              onkeydown={(e) => e.key === 'Enter' && selectKey(r.path)}
              role="button"
              tabindex="0"
              title={r.path}
              style="display:flex;align-items:center;gap:var(--px-8);padding:var(--px-5) var(--px-8);border-radius:var(--px-6);cursor:pointer;padding-left:calc(var(--px-8) + {r.depth} * var(--px-14));background:{selected === r.path ? 'var(--hover)' : 'transparent'}"
            >
              <span class="mono" style="flex:none;font-size:var(--px-9);font-weight:700;color:{typeColor(kt)};border:var(--px-1) solid {typeColor(kt)};border-radius:var(--px-3);padding:0 var(--px-4)">{typeBadge(kt)}</span>
              <span class="mono" style="font-size:var(--px-12);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{r.segment}</span>
              <span class="mono" style="margin-left:auto;flex:none;font-size:var(--px-10);color:{r.key?.ttl === -2 ? 'var(--error)' : 'var(--muted)'}">{r.key ? ttlLabel(r.key.ttl) : ''}</span>
            </div>
          {/if}
        {/each}
      {/if}
    </div>
  </div>

  <!-- panel phải — Key Viewer (dòng 679-705) -->
  <div style="flex:1;display:flex;flex-direction:column;min-width:0">
    {#if selected}
      {@const v = selectedValue}
      <div style="flex:none;display:flex;align-items:center;gap:var(--px-10);padding:var(--px-10) var(--px-14);border-bottom:var(--px-1) solid var(--border);background:var(--surface)">
        <span style="width:var(--px-3);height:var(--px-20);border-radius:var(--px-2);background:#D82C20"></span>
        <span class="mono" style="font-size:var(--px-13);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{selected}</span>
        {#if v}
          <span class="mono" style="flex:none;font-size:var(--px-10);font-weight:700;color:{typeColor(v.key_type)};border:var(--px-1) solid {typeColor(v.key_type)};border-radius:var(--px-4);padding:var(--px-1) var(--px-6)">{v.key_type}</span>
          <span class="mono" style="font-size:var(--px-11);color:var(--muted)">TTL {ttlLabel(v.ttl)}</span>
        {/if}
        <div style="margin-left:auto;display:flex;gap:var(--px-7)">
          {#if v && v.value.kind !== 'string' && v.value.kind !== 'none'}
            <span onclick={addItem} onkeydown={(e) => e.key === 'Enter' && addItem()} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer">+ Add</span>
          {/if}
          <span onclick={editTtl} onkeydown={(e) => e.key === 'Enter' && editTtl()} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer">Set TTL</span>
          <span onclick={delKey} onkeydown={(e) => e.key === 'Enter' && delKey()} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer;color:var(--error)">Delete</span>
        </div>
      </div>
      <div style="flex:1;overflow:auto;min-height:0">
        {#if valLoading}
          <div style="padding:var(--px-14);font-size:var(--px-12);color:var(--muted)">Đang tải…</div>
        {:else if valError}
          <div style="padding:var(--px-14);font-size:var(--px-12);color:var(--error)">{valError}</div>
        {:else if v?.value.kind === 'string'}
          <div style="padding:var(--px-14);display:flex;flex-direction:column;gap:var(--px-8);height:100%;box-sizing:border-box">
            <textarea
              bind:value={stringDraft}
              class="mono"
              style="flex:1;width:100%;box-sizing:border-box;resize:none;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-10);font-size:var(--px-12_5);color:var(--text);outline:none"
            ></textarea>
            <div style="flex:none;display:flex;justify-content:flex-end">
              <span onclick={() => edit({ op: 'setString', value: stringDraft }, 'SET (đã lưu)')} onkeydown={(e) => e.key === 'Enter' && edit({ op: 'setString', value: stringDraft }, 'SET')} role="button" tabindex="0" style="font-size:var(--px-12);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-7);padding:var(--px-6) var(--px-16);cursor:pointer;font-weight:600">Save</span>
            </div>
          </div>
        {:else if v?.value.kind === 'hash'}
          {@render kvTable('Field', 'Value', v.value.fields.map((f) => [f[0], f[1]]), (id) => delItem('hash', id))}
        {:else if v?.value.kind === 'zset'}
          {@render kvTable('Member', 'Score', v.value.members.map((m) => [m[0], String(m[1])]), (id) => delItem('zset', id))}
        {:else if v?.value.kind === 'list'}
          {@render listTable('#', v.value.items, (id) => delItem('list', id))}
        {:else if v?.value.kind === 'set'}
          {@render listTable('Member', v.value.members, (id) => delItem('set', id))}
        {:else if v?.value.kind === 'stream'}
          <table class="mono" style="border-collapse:collapse;width:100%;font-size:var(--px-12)">
            <thead><tr>
              <th style="position:sticky;top:0;background:var(--header);border-bottom:var(--px-1) solid var(--border2);padding:var(--px-7) var(--px-14);text-align:left;color:var(--text2)">ID</th>
              <th style="position:sticky;top:0;background:var(--header);border-bottom:var(--px-1) solid var(--border2);padding:var(--px-7) var(--px-14);text-align:left;color:var(--text2)">Fields</th>
              <th style="position:sticky;top:0;background:var(--header);border-bottom:var(--px-1) solid var(--border2);width:var(--px-38)"></th>
            </tr></thead>
            <tbody>
              {#each v.value.entries as e (e.id)}
                <tr><td style="padding:var(--px-6) var(--px-14);border-bottom:var(--px-1) solid var(--border);color:var(--hex-e8923a);white-space:nowrap">{e.id}</td><td style="padding:var(--px-6) var(--px-14);border-bottom:var(--px-1) solid var(--border)">{e.fields.map((f) => `${f[0]}=${f[1]}`).join('  ')}</td>{@render delCell(e.id, (id) => delItem('stream', id))}</tr>
              {/each}
            </tbody>
          </table>
        {:else}
          <div style="padding:var(--px-14);font-size:var(--px-12);color:var(--muted)">(empty / key không tồn tại)</div>
        {/if}
      </div>
    {:else}
      <div style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:var(--px-12)">
        Chọn một key để xem giá trị
      </div>
    {/if}
  </div>
</div>
