<script lang="ts">
  // Command Palette (Phase 5 · T6) — port modal dòng 1558-1577. Ctrl+P mở;
  // fuzzy search mọi action (connections/tabs/open tabs/explorer/settings);
  // điều hướng ↑↓ Enter, Esc đóng, nhóm theo category, gợi ý gần đây.
  import { palette, fuzzyScore } from '$lib/stores/palette.svelte'
  import { connections } from '$lib/stores/connections.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { ui } from '$lib/stores/ui.svelte'
  import { settings } from '$lib/stores/settings.svelte'

  interface Action {
    id: string
    icon: string
    iconColor: string
    label: string
    hint: string
    category: string
    run: () => void
  }

  let inputEl = $state<HTMLInputElement | null>(null)

  // focus input mỗi khi mở
  $effect(() => {
    if (palette.open && inputEl) inputEl.focus()
  })

  function openConn(id: string, system: string) {
    connections.selectedId = id
    void connections.connect(id).then(() => {
      if (system === 'redis') tabs.openRedisTab(id)
      else if (system === 'nats') tabs.openNatsTab(id)
      else if (system === 'kafka') tabs.openKafkaTab(id)
      else if (system === 'cassandra') tabs.openSqlTab({ connectionId: id, title: 'Untitled CQL' })
      else tabs.openSqlTab({ connectionId: id, title: 'Untitled query' })
    })
  }

  // Tập action dựng từ state hiện tại (tính lại khi mở / state đổi).
  const actions = $derived.by<Action[]>(() => {
    if (!palette.open) return []
    const out: Action[] = []
    // Connections
    for (const p of connections.profiles) {
      out.push({
        id: `conn:${p.id}`,
        icon: p.connected ? '⚡' : '⚙',
        iconColor: p.connected ? '#27AE60' : '#e8923a',
        label: `${p.connected ? 'Open' : 'Connect to'}: ${p.name}`,
        hint: p.system,
        category: 'Connections',
        run: () => openConn(p.id, p.system),
      })
    }
    // Tab actions
    out.push({ id: 'tab:new', icon: '+', iconColor: '#5b7cff', label: 'New SQL Editor tab', hint: 'Ctrl+T', category: 'Tabs', run: () => tabs.openSqlTab({}) })
    out.push({ id: 'tab:close', icon: '×', iconColor: '#e06c75', label: 'Close current tab', hint: 'Ctrl+W', category: 'Tabs', run: () => tabs.closeActive() })
    out.push({ id: 'tab:history', icon: '⟲', iconColor: '#56b6c2', label: 'Open Query History', hint: 'Ctrl+H', category: 'Tabs', run: () => tabs.openUtilityTab('history', 'Query History') })
    out.push({ id: 'tab:saved', icon: '★', iconColor: '#e8c547', label: 'Open Saved Queries', hint: '', category: 'Tabs', run: () => tabs.openUtilityTab('saved', 'Saved Queries') })
    // Open tabs → jump
    for (const t of tabs.tabs) {
      out.push({
        id: `goto:${t.id}`,
        icon: '▦',
        iconColor: '#5b9bd5',
        label: `Go to: ${t.title}`,
        hint: t.connectionName,
        category: 'Open tabs',
        run: () => (tabs.activeTabId = t.id),
      })
    }
    // Explorer tables của connection đang chọn
    const sel = connections.selected
    if (sel) {
      const cache = explorer.cache[sel.id]
      for (const schema of cache?.schemas ?? []) {
        const sc = cache?.bySchema[schema.name]
        for (const tbl of sc?.tables ?? []) {
          out.push({
            id: `open:${schema.name}.${tbl.name}`,
            icon: '⌗',
            iconColor: '#9aa4b8',
            label: `Open table: ${schema.name}.${tbl.name}`,
            hint: sel.name,
            category: 'Explorer',
            run: () => tabs.openTableViewer(sel.id, schema.name, tbl.name),
          })
        }
      }
    }
    // Tools
    out.push({ id: 'tool:compare', icon: '⇄', iconColor: '#56b6c2', label: 'Compare schemas…', hint: '', category: 'Tools', run: () => tabs.openSchemaCompare(connections.selectedId) })
    // Settings
    out.push({ id: 'set:theme', icon: '☾', iconColor: '#e8c547', label: 'Toggle theme (dark / light)', hint: '', category: 'Settings', run: () => ui.toggleTheme() })
    out.push({ id: 'set:open', icon: '⚙', iconColor: '#e8923a', label: 'Open Settings', hint: 'Ctrl+,', category: 'Settings', run: () => settings.show() })
    return out
  })

  const filtered = $derived.by(() => {
    const q = palette.query
    const scored = actions
      .map((a) => ({ a, score: fuzzyScore(q, a.label) }))
      .filter((x): x is { a: Action; score: number } => x.score !== null)
    scored.sort((x, y) => y.score - x.score)
    return scored.map((x) => x.a)
  })

  // clamp selected khi list đổi
  $effect(() => {
    if (palette.selected >= filtered.length) palette.selected = Math.max(0, filtered.length - 1)
  })

  function runAt(i: number) {
    const a = filtered[i]
    if (!a) return
    palette.remember(palette.query)
    palette.close()
    a.run()
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      palette.selected = Math.min(palette.selected + 1, filtered.length - 1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      palette.selected = Math.max(palette.selected - 1, 0)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      runAt(palette.selected)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      palette.close()
    }
  }
</script>

{#if palette.open}
  <div
    onclick={() => palette.close()}
    onkeydown={() => {}}
    role="presentation"
    style="position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;justify-content:center;padding-top:var(--px-90);z-index:50"
  >
    <div
      onclick={(e) => e.stopPropagation()}
      onkeydown={onKeydown}
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      style="width:var(--px-560);height:fit-content;max-height:60vh;background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);box-shadow:0 var(--px-24) var(--px-60) rgba(0,0,0,.5);overflow:hidden;display:flex;flex-direction:column"
    >
      <div style="display:flex;align-items:center;gap:var(--px-10);padding:var(--px-14) var(--px-16);border-bottom:var(--px-1) solid var(--border)">
        <span style="color:var(--muted);font-size:var(--px-16)">⌕</span>
        <input
          bind:this={inputEl}
          bind:value={palette.query}
          placeholder="Type a command or search…"
          style="border:none;background:transparent;color:var(--text);font-size:var(--px-15);outline:none;width:100%;font-family:inherit"
        />
      </div>
      <div style="overflow:auto;padding:var(--px-6)">
        {#if filtered.length === 0}
          <div style="padding:var(--px-16);text-align:center;color:var(--muted);font-size:var(--px-12_5)">
            {#if palette.query}No results for “{palette.query}”{:else}Type to search commands…{/if}
          </div>
          {#if !palette.query && palette.recent.length}
            <div style="padding:var(--px-6) var(--px-12) var(--px-2);font-size:var(--px-10);text-transform:uppercase;letter-spacing:.06em;color:var(--muted)">Recent</div>
            {#each palette.recent as r (r)}
              <div onclick={() => (palette.query = r)} onkeydown={(e) => e.key === 'Enter' && (palette.query = r)} role="button" tabindex="0" style="padding:var(--px-7) var(--px-12);font-size:var(--px-12_5);color:var(--text2);cursor:pointer;border-radius:var(--px-8)">⟲ {r}</div>
            {/each}
          {/if}
        {:else}
          {#each filtered as a, i (a.id)}
            {@const showCat = i === 0 || filtered[i - 1].category !== a.category}
            {#if showCat}
              <div style="padding:var(--px-6) var(--px-12) var(--px-2);font-size:var(--px-10);text-transform:uppercase;letter-spacing:.06em;color:var(--muted)">{a.category}</div>
            {/if}
            <div
              onclick={() => runAt(i)}
              onmouseenter={() => (palette.selected = i)}
              onkeydown={(e) => e.key === 'Enter' && runAt(i)}
              role="button"
              tabindex="0"
              style="display:flex;align-items:center;gap:var(--px-11);padding:var(--px-9) var(--px-12);border-radius:var(--px-8);cursor:pointer;background:{i === palette.selected ? 'var(--hover)' : 'transparent'}"
            >
              <span class="mono" style="flex:none;width:var(--px-26);text-align:center;color:{a.iconColor};font-size:var(--px-13)">{a.icon}</span>
              <span style="font-size:var(--px-13);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{a.label}</span>
              <span style="margin-left:auto;font-size:var(--px-10_5);color:var(--muted);flex:none">{a.hint}</span>
            </div>
          {/each}
        {/if}
      </div>
    </div>
  </div>
{/if}
