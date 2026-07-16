<script lang="ts">
  // User Manager (Users / Roles & Privileges) — shell.
  // U0: framework + generic principal list read via ipc.usersView. Per-engine
  // detail panes, mutation dialogs and the privilege grid land in their phases
  // (U1 PostgreSQL, U2 MySQL/MariaDB, U3 MSSQL, …). Dispatch is by systemType;
  // until a per-engine manager exists the shell renders the principal list plus
  // a phase note so the wiring is visible and testable.
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import type { TabState } from '$lib/types'

  interface Props {
    tab: TabState
  }
  let { tab }: Props = $props()

  // The default introspection view name per engine (principal list).
  const listView = $derived.by(() => {
    switch (tab.systemType) {
      case 'postgres':
        return 'roles'
      case 'mysql':
      case 'mariadb':
      case 'mssql':
      case 'clickhouse':
      case 'cassandra':
      case 'mongodb':
      case 'oracle':
        return 'users'
      default:
        return 'roles'
    }
  })

  // Human label for the principal group per engine (native terminology).
  const groupLabel = $derived.by(() => {
    switch (tab.systemType) {
      case 'postgres':
        return 'Login/Group Roles'
      case 'mysql':
      case 'mariadb':
        return 'Users and Privileges'
      case 'mssql':
        return 'Logins'
      case 'clickhouse':
        return 'Users & Roles'
      case 'cassandra':
        return 'Roles'
      case 'oracle':
        return 'Users'
      case 'mongodb':
        return 'Users'
      default:
        return 'Principals'
    }
  })

  let cols = $state<[string, string][]>([])
  let rows = $state<Record<string, unknown>[]>([])
  let loading = $state(false)
  let refreshing = $state(false)
  let error = $state<string | null>(null)
  let selected = $state<number>(-1)

  async function load() {
    if (!tab.connectionId) return
    loading = true
    error = null
    try {
      const res = await ipc.usersView(tab.connectionId, listView)
      cols = res.cols
      rows = res.rows
      // Preselect the focused principal if the tab was opened from a tree node.
      const focus = (tab.state as { focus?: string }).focus
      if (focus) {
        const nameCol = cols[0]?.[0]
        const i = rows.findIndex((r) => nameCol && String(r[nameCol]) === focus)
        selected = i
      }
    } catch (e) {
      error = String(e)
      cols = []
      rows = []
    } finally {
      loading = false
    }
  }

  async function refresh() {
    if (refreshing) return
    refreshing = true
    try {
      await load()
    } finally {
      refreshing = false
    }
  }

  $effect(() => {
    void listView
    void tab.connectionId
    untrack(() => void load())
  })

  const nameOf = (r: Record<string, unknown>) => {
    const c = cols[0]?.[0]
    return c ? String(r[c] ?? '') : ''
  }
  const fmt = (v: unknown) => (v == null ? '' : typeof v === 'boolean' ? (v ? '✓' : '') : typeof v === 'object' ? JSON.stringify(v) : String(v))
</script>

<div style="flex:1;display:flex;flex-direction:column;min-height:0">
  <div style="flex:none;display:flex;align-items:center;gap:var(--px-8);padding:var(--px-9) var(--px-14);border-bottom:var(--px-1) solid var(--border);background:var(--surface);flex-wrap:wrap">
    <span style="font-size:var(--px-12);font-weight:700">{groupLabel}</span>
    <span style="font-size:var(--px-11);color:var(--muted)">{rows.length} {rows.length === 1 ? 'principal' : 'principals'}</span>
    <span
      onclick={refresh}
      onkeydown={(e) => e.key === 'Enter' && refresh()}
      role="button"
      tabindex="0"
      aria-busy={refreshing}
      style="margin-left:auto;font-size:var(--px-11_5);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer;opacity:{refreshing ? 0.6 : 1}"
      >{refreshing ? '⟳ Refreshing…' : '⟳ Refresh'}</span
    >
  </div>
  <div style="flex:1;display:flex;min-height:0">
    <!-- Principal list -->
    <div role="listbox" tabindex="-1" aria-label={groupLabel} style="flex:none;width:var(--px-252);border-right:var(--px-1) solid var(--border);overflow:auto;min-height:0">
      {#if error}
        <div style="padding:var(--px-14);color:var(--error);font-size:var(--px-12)">{error}</div>
      {:else if loading}
        <div style="padding:var(--px-14);color:var(--muted);font-size:var(--px-12)">Loading…</div>
      {:else}
        {#each rows as r, i (i)}
          <div
            onclick={() => (selected = i)}
            onkeydown={(e) => e.key === 'Enter' && (selected = i)}
            role="option"
            tabindex="0"
            aria-selected={selected === i}
            style="padding:var(--px-6) var(--px-12);font-size:var(--px-12_5);cursor:pointer;border-bottom:var(--px-1) solid var(--border);background:{selected === i ? 'var(--grid-select)' : 'transparent'};color:{selected === i ? 'var(--hex-fff)' : 'var(--text)'}"
          >
            {nameOf(r)}
          </div>
        {/each}
      {/if}
    </div>
    <!-- Detail -->
    <div style="flex:1;overflow:auto;min-height:0;padding:var(--px-14)">
      {#if selected >= 0 && rows[selected]}
        <table class="mono" style="border-collapse:collapse;font-size:var(--px-12)">
          <tbody>
            {#each cols as c (c[0])}
              <tr>
                <td style="padding:var(--px-4) var(--px-12) var(--px-4) 0;color:var(--text2);font-weight:600;white-space:nowrap;vertical-align:top">{c[0]}</td>
                <td style="padding:var(--px-4) 0;color:var(--text)">{fmt(rows[selected][c[0]])}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {:else}
        <div style="color:var(--muted);font-size:var(--px-12)">Select a principal to view details.</div>
      {/if}
      <div style="margin-top:var(--px-16);font-size:var(--px-11);color:var(--muted)">
        Full management (create · password · grant · revoke) for this engine is delivered in its phase.
      </div>
    </div>
  </div>
</div>
