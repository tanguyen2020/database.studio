<script lang="ts">
  // Sidebar connection list: grouped by category → system, env tags,
  // accent bars, status dots, filter, rich context menu.
  import * as ContextMenu from '$lib/components/ui/context-menu'
  import ConnectionIndicator from '$lib/components/ConnectionIndicator.svelte'
  import SystemBadge from '$lib/components/SystemBadge.svelte'
  import SystemIcon from '$lib/components/SystemIcon.svelte'
  import { CATEGORY_ORDER, SYSTEM_ORDER, envMeta, systemMeta } from '$lib/systems'
  import { connections } from '$lib/stores/connections.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { ui } from '$lib/stores/ui.svelte'
  import type { ProfilePublic } from '$lib/types'

  const filtered = $derived(
    connections.profiles.filter((p) =>
      p.name.toLowerCase().includes(connections.filter.toLowerCase()),
    ),
  )

  interface Group {
    category: string
    showCategory: boolean
    system: string
    items: ProfilePublic[]
  }

  const groups = $derived.by(() => {
    const out: Group[] = []
    let lastCategory = ''
    for (const category of CATEGORY_ORDER) {
      for (const system of SYSTEM_ORDER) {
        const meta = systemMeta(system)
        if (meta.category !== category) continue
        const items = filtered.filter((p) => p.system === system)
        if (items.length === 0) continue
        out.push({
          category,
          showCategory: category !== lastCategory,
          system,
          items,
        })
        lastCategory = category
      }
    }
    return out
  })

  let collapsed = $state<Set<string>>(new Set())

  function toggleGroup(system: string) {
    const next = new Set(collapsed)
    if (next.has(system)) next.delete(system)
    else next.add(system)
    collapsed = next
  }

  function select(p: ProfilePublic) {
    connections.selectedId = p.id
  }

  async function openOrToggle(p: ProfilePublic) {
    connections.selectedId = p.id
    if (!p.connected) await connections.connect(p.id)
  }

  function newQueryConsole(p: ProfilePublic) {
    connections.selectedId = p.id
    tabs.openSqlTab({ connectionId: p.id, title: `${p.name} · query` })
  }

  async function testConn(p: ProfilePublic) {
    toasts.show(`Đang test "${p.name}"...`, { system: p.system })
    const res = await connections.test({ profile: p, password: null, ssh_password: null })
    if (res.ok) {
      toasts.success(
        `${p.name}: kết nối OK · ${res.latency_ms} ms${res.server_version ? ` · ${res.server_version}` : ''}`,
        p.system,
      )
    } else {
      toasts.error(`${p.name}: ${res.error}`, p.system)
    }
  }

  function connString(p: ProfilePublic): string {
    // Never embed the password in a copied connection string.
    switch (p.system) {
      case 'postgres':
        return `postgresql://${p.user}@${p.host}:${p.port}/${p.database}`
      case 'mysql':
      case 'mariadb':
        return `mysql://${p.user}@${p.host}:${p.port}/${p.database}`
      case 'mssql':
        return `Server=${p.host},${p.port};Database=${p.database};User Id=${p.user};`
      case 'sqlite':
        return p.sqlite_mode === 'in-memory' ? 'sqlite::memory:' : `sqlite://${p.sqlite_path}`
      default:
        return `${p.system}://${p.host}:${p.port}`
    }
  }

  async function copyConnString(p: ProfilePublic) {
    await navigator.clipboard.writeText(connString(p))
    toasts.success('Đã copy connection string (không kèm password)', p.system)
  }

  function requestDelete(p: ProfilePublic) {
    ui.deleteTarget = p
  }

  function editConn(p: ProfilePublic) {
    ui.formProfile = { ...p }
  }
</script>

<div class="flex h-full flex-col overflow-hidden">
  <div class="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
    <span class="text-[11px] font-semibold uppercase tracking-wide text-text2">Connections</span>
    <div class="grow"></div>
    <button
      class="rounded px-1.5 py-0.5 text-[13px] leading-none text-text2 hover:bg-hover hover:text-foreground"
      title="New connection"
      onclick={() => (ui.pickerOpen = true)}
    >
      +
    </button>
  </div>

  <div class="px-2 py-1.5">
    <input
      class="w-full rounded-md border border-input bg-surface px-2 py-1 text-[12px] outline-none placeholder:text-mutedfg focus:border-ring"
      placeholder="Filter connections..."
      bind:value={connections.filter}
    />
  </div>

  <div class="min-h-0 grow overflow-y-auto pb-2">
    {#each groups as group (group.system)}
      {#if group.showCategory}
        <div class="px-2 pb-0.5 pt-2 text-[9.5px] font-bold uppercase tracking-[0.12em] text-mutedfg">
          {group.category}
        </div>
      {/if}
      <button
        class="flex w-full items-center gap-1 px-2 py-1 text-left text-[11px] font-semibold text-text2 hover:bg-hover"
        onclick={() => toggleGroup(group.system)}
      >
        <span class="inline-block w-3 text-[9px]">{collapsed.has(group.system) ? '▸' : '▾'}</span>
        {systemMeta(group.system).label}
        <span class="text-mutedfg">({group.items.length})</span>
      </button>

      {#if !collapsed.has(group.system)}
        {#each group.items as p (p.id)}
          <ContextMenu.Root>
            <ContextMenu.Trigger>
              <div
                class="group flex h-[30px] w-full cursor-pointer items-center gap-2 pl-2 pr-2 {connections.selectedId === p.id
                  ? 'bg-hover'
                  : 'hover:bg-hover/60'}"
                role="button"
                tabindex="0"
                onclick={() => select(p)}
                ondblclick={() => openOrToggle(p)}
                onkeydown={(e) => e.key === 'Enter' && openOrToggle(p)}
              >
                <ConnectionIndicator system={p.system} height="18px" />
                <SystemIcon system={p.system} size={15} />
                <span class="truncate text-[12.5px]">{p.name}</span>
                <!-- port từ env pill trong Database Studio.dc.html (dòng 123) -->
                <span
                  style="flex:none;margin-right:var(--px-7);font-size:var(--px-8_5);font-weight:700;letter-spacing:.04em;padding:var(--px-1) var(--px-5);border-radius:var(--px-4);background:{envMeta(p.env).bg};color:{envMeta(p.env).fg}"
                >
                  {envMeta(p.env).label}
                </span>
                <div class="grow"></div>
                {#if connections.connecting.has(p.id)}
                  <span class="animate-pulse text-[10px] text-text2">…</span>
                {:else}
                  <span
                    class="h-[7px] w-[7px] rounded-full"
                    style="background: {p.connected ? systemMeta(p.system).accent : 'var(--border2)'};"
                    title={p.connected ? `Connected · ${p.latency_ms ?? '–'} ms` : 'Disconnected'}
                  ></span>
                {/if}
              </div>
            </ContextMenu.Trigger>
            <ContextMenu.Content class="w-56">
              <ContextMenu.Item onclick={() => newQueryConsole(p)}>New Query Console</ContextMenu.Item>
              {#if p.connected}
                <ContextMenu.Item onclick={() => connections.disconnect(p.id)}>Disconnect</ContextMenu.Item>
              {:else}
                <ContextMenu.Item onclick={() => openOrToggle(p)}>Open Connection</ContextMenu.Item>
              {/if}
              <ContextMenu.Separator />
              <ContextMenu.Item onclick={() => editConn(p)}>Edit Connection…</ContextMenu.Item>
              <ContextMenu.Item onclick={() => connections.duplicate(p.id)}>Duplicate</ContextMenu.Item>
              <ContextMenu.Item onclick={() => testConn(p)}>Test Connection</ContextMenu.Item>
              <ContextMenu.Item onclick={() => copyConnString(p)}>Copy Connection String</ContextMenu.Item>
              <ContextMenu.Separator />
              <ContextMenu.Item onclick={() => connections.load()}>Refresh</ContextMenu.Item>
              <ContextMenu.Separator />
              <ContextMenu.Item
                class="text-error data-highlighted:text-error"
                onclick={() => requestDelete(p)}
              >
                Delete Connection
              </ContextMenu.Item>
            </ContextMenu.Content>
          </ContextMenu.Root>
        {/each}
      {/if}
    {/each}

    {#if connections.loaded && groups.length === 0}
      <div class="px-3 py-6 text-center text-[12px] text-mutedfg">
        {connections.filter ? 'Không có connection khớp filter' : 'Chưa có connection nào.'}
        {#if !connections.filter}
          <button class="mt-2 block w-full text-primary hover:underline" onclick={() => (ui.pickerOpen = true)}>
            + Tạo connection đầu tiên
          </button>
        {/if}
      </div>
    {/if}
  </div>
</div>
