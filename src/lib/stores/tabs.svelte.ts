// Multi-tab system store. Every tab carries full context — there is no
// global "active connection". Persisted to SQLite storage via IPC.

import * as ipc from '$lib/ipc'
import type { SystemType, TabContentType, TabState } from '$lib/types'
import { connections } from './connections.svelte'

const MAX_CLOSED_STACK = 20

let nextUntitled = 1

function uuid(): string {
  return crypto.randomUUID()
}

class TabsStore {
  tabs = $state<TabState[]>([])
  activeTabId = $state<string | null>(null)
  /** stack of recently closed tabs for Ctrl+Shift+T */
  private closedStack: TabState[] = []
  /** tabs pending the save-before-close dialog */
  pendingClose = $state<TabState[] | null>(null)
  restored = $state(false)

  get active(): TabState | null {
    return this.tabs.find((t) => t.id === this.activeTabId) ?? null
  }

  byId(id: string): TabState | null {
    return this.tabs.find((t) => t.id === id) ?? null
  }

  tabsForConnection(connId: string): TabState[] {
    return this.tabs.filter((t) => t.connectionId === connId)
  }

  // ---- open / activate -----------------------------------------------------

  /** New SQL editor tab. Inherits the active tab's connection unless given. */
  openSqlTab(opts?: {
    connectionId?: string | null
    title?: string
    query?: string
    activate?: boolean
  }): TabState {
    const connId =
      opts?.connectionId !== undefined
        ? opts.connectionId
        : this.active?.connectionId ?? connections.selectedId
    const profile = connections.byId(connId)
    const tab: TabState = {
      id: uuid(),
      connectionId: connId ?? null,
      connectionName: profile?.name ?? '',
      systemType: (profile?.system as SystemType) ?? 'orphan',
      contentType: 'sql-editor',
      title: opts?.title ?? `Untitled ${nextUntitled++}`,
      isPinned: false,
      isDirty: false,
      state: { query: opts?.query ?? '' },
    }
    this.tabs.push(tab)
    if (opts?.activate !== false) this.activeTabId = tab.id
    this.schedulePersist()
    return tab
  }

  openTableViewer(connectionId: string, schema: string, table: string): TabState {
    const profile = connections.byId(connectionId)
    const tab: TabState = {
      id: uuid(),
      connectionId,
      connectionName: profile?.name ?? '',
      systemType: (profile?.system as SystemType) ?? 'orphan',
      contentType: 'table-viewer',
      title: `${table}`,
      isPinned: false,
      isDirty: false,
      state: { schema, table },
    }
    this.tabs.push(tab)
    this.activeTabId = tab.id
    this.schedulePersist()
    return tab
  }

  /** Redis key browser tab — 1 tab / connection (focus nếu đã mở). */
  openRedisTab(connectionId: string): TabState {
    const existing = this.tabs.find(
      (t) => t.contentType === 'redis' && t.connectionId === connectionId,
    )
    if (existing) {
      this.activeTabId = existing.id
      return existing
    }
    const profile = connections.byId(connectionId)
    const tab: TabState = {
      id: uuid(),
      connectionId,
      connectionName: profile?.name ?? '',
      systemType: (profile?.system as SystemType) ?? 'orphan',
      contentType: 'redis',
      title: `${profile?.name ?? 'Redis'} · keys`,
      isPinned: false,
      isDirty: false,
      state: {},
    }
    this.tabs.push(tab)
    this.activeTabId = tab.id
    this.schedulePersist()
    return tab
  }

  /** Redis Pub/Sub monitor tab — 1 tab / connection. */
  openRedisPubSubTab(connectionId: string): TabState {
    const existing = this.tabs.find(
      (t) => t.contentType === 'redis-pubsub' && t.connectionId === connectionId,
    )
    if (existing) {
      this.activeTabId = existing.id
      return existing
    }
    const profile = connections.byId(connectionId)
    const tab: TabState = {
      id: uuid(),
      connectionId,
      connectionName: profile?.name ?? '',
      systemType: (profile?.system as SystemType) ?? 'orphan',
      contentType: 'redis-pubsub',
      title: `${profile?.name ?? 'Redis'} · Pub/Sub`,
      isPinned: false,
      isDirty: false,
      state: {},
    }
    this.tabs.push(tab)
    this.activeTabId = tab.id
    this.schedulePersist()
    return tab
  }

  /** Mở (hoặc focus nếu đã có) một tab tiện ích singleton — History / Saved. */
  openUtilityTab(contentType: 'history' | 'saved', title: string): TabState {
    const existing = this.tabs.find((t) => t.contentType === contentType)
    if (existing) {
      this.activeTabId = existing.id
      return existing
    }
    const tab: TabState = {
      id: uuid(),
      connectionId: this.active?.connectionId ?? connections.selectedId ?? null,
      connectionName: '',
      systemType: 'orphan',
      contentType,
      title,
      isPinned: false,
      isDirty: false,
      state: {},
    }
    this.tabs.push(tab)
    this.activeTabId = tab.id
    this.schedulePersist()
    return tab
  }

  activate(id: string) {
    if (this.byId(id)) this.activeTabId = id
  }

  next() {
    this.step(1)
  }

  prev() {
    this.step(-1)
  }

  private step(dir: 1 | -1) {
    if (this.tabs.length === 0) return
    const idx = this.tabs.findIndex((t) => t.id === this.activeTabId)
    const nextIdx = (idx + dir + this.tabs.length) % this.tabs.length
    this.activeTabId = this.tabs[nextIdx].id
  }

  jumpTo(n: number) {
    // Ctrl+1..9 — 9 jumps to the last tab (browser convention)
    if (this.tabs.length === 0) return
    const idx = n >= 9 ? this.tabs.length - 1 : Math.min(n - 1, this.tabs.length - 1)
    this.activeTabId = this.tabs[idx].id
  }

  // ---- close ---------------------------------------------------------------

  /**
   * Requests closing tabs. Dirty tabs trigger the save-before-close dialog
   * (pendingClose); clean tabs close immediately. Returns true when closed.
   */
  requestClose(ids: string[]): boolean {
    const targets = this.tabs.filter((t) => ids.includes(t.id))
    const dirty = targets.filter((t) => t.isDirty)
    if (dirty.length > 0) {
      this.pendingClose = targets
      return false
    }
    this.forceClose(ids)
    return true
  }

  forceClose(ids: string[]) {
    const closing = this.tabs.filter((t) => ids.includes(t.id))
    for (const tab of closing) {
      this.closedStack.push($state.snapshot(tab) as TabState)
    }
    if (this.closedStack.length > MAX_CLOSED_STACK) {
      this.closedStack.splice(0, this.closedStack.length - MAX_CLOSED_STACK)
    }
    const wasActive = ids.includes(this.activeTabId ?? '')
    const oldIdx = this.tabs.findIndex((t) => t.id === this.activeTabId)
    this.tabs = this.tabs.filter((t) => !ids.includes(t.id))
    if (wasActive) {
      const idx = Math.min(oldIdx, this.tabs.length - 1)
      this.activeTabId = idx >= 0 ? this.tabs[idx].id : null
    }
    this.pendingClose = null
    this.schedulePersist()
  }

  closeActive() {
    if (this.activeTabId) this.requestClose([this.activeTabId])
  }

  closeOthers(id: string) {
    this.requestClose(this.tabs.filter((t) => t.id !== id && !t.isPinned).map((t) => t.id))
  }

  closeToRight(id: string) {
    const idx = this.tabs.findIndex((t) => t.id === id)
    if (idx < 0) return
    this.requestClose(this.tabs.slice(idx + 1).filter((t) => !t.isPinned).map((t) => t.id))
  }

  restoreClosed() {
    const tab = this.closedStack.pop()
    if (!tab) return
    // Re-orphan if the connection has vanished meanwhile.
    if (tab.connectionId && !connections.byId(tab.connectionId)) {
      tab.systemType = 'orphan'
      tab.connectionId = null
    }
    this.tabs.push(tab)
    this.activeTabId = tab.id
    this.schedulePersist()
  }

  // ---- mutations -------------------------------------------------------------

  reorder(fromIdx: number, toIdx: number) {
    if (fromIdx === toIdx || fromIdx < 0 || toIdx < 0) return
    const [moved] = this.tabs.splice(fromIdx, 1)
    this.tabs.splice(toIdx, 0, moved)
    this.schedulePersist()
  }

  rename(id: string, title: string) {
    const tab = this.byId(id)
    if (tab && title.trim()) {
      tab.title = title.trim()
      this.schedulePersist()
    }
  }

  togglePin(id: string) {
    const tab = this.byId(id)
    if (tab) {
      tab.isPinned = !tab.isPinned
      this.schedulePersist()
    }
  }

  duplicate(id: string) {
    const tab = this.byId(id)
    if (!tab) return
    const copy: TabState = {
      ...($state.snapshot(tab) as TabState),
      id: uuid(),
      isPinned: false,
      title: `${tab.title} (copy)`,
    }
    const idx = this.tabs.findIndex((t) => t.id === id)
    this.tabs.splice(idx + 1, 0, copy)
    this.activeTabId = copy.id
    this.schedulePersist()
  }

  setDirty(id: string, dirty: boolean) {
    const tab = this.byId(id)
    if (tab && tab.isDirty !== dirty) tab.isDirty = dirty
  }

  /** Change the tab's connection (toolbar dropdown). */
  setConnection(id: string, connectionId: string | null) {
    const tab = this.byId(id)
    if (!tab) return
    const profile = connections.byId(connectionId)
    tab.connectionId = connectionId
    tab.connectionName = profile?.name ?? ''
    tab.systemType = (profile?.system as SystemType) ?? 'orphan'
    this.schedulePersist()
  }

  /** Force Delete: connection removed, tabs stay orphaned (gray ⚠ badge). */
  orphanByConnection(connId: string) {
    for (const tab of this.tabs) {
      if (tab.connectionId === connId) {
        tab.connectionId = null
        tab.systemType = 'orphan'
      }
    }
    this.schedulePersist()
  }

  /** Reassign an orphaned tab to another connection. */
  reassign(tabId: string, connectionId: string) {
    this.setConnection(tabId, connectionId)
  }

  // ---- persistence -----------------------------------------------------------

  private persistTimer: ReturnType<typeof setTimeout> | null = null

  schedulePersist() {
    if (!this.restored) return
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => void this.persist(), 400)
  }

  async persist() {
    if (!this.restored) return
    // pinned tabs are stored first so they restore first
    const ordered = [...this.tabs].sort((a, b) => Number(b.isPinned) - Number(a.isPinned))
    const payload = ordered.map((t) => ({
      id: t.id,
      is_pinned: t.isPinned,
      payload: { ...($state.snapshot(t) as TabState), activeTabId: undefined },
    }))
    try {
      await ipc.saveTabs(payload)
      await ipc.setAppState('active_tab', this.activeTabId ?? '')
    } catch {
      // persistence must never break the editing flow
    }
  }

  async restore() {
    try {
      const payloads = await ipc.loadTabs<TabState>()
      const restored: TabState[] = []
      for (const p of payloads) {
        if (!p || typeof p !== 'object' || !p.id) continue
        // connection gone since last session → orphan
        if (p.connectionId && !connections.byId(p.connectionId)) {
          p.connectionId = null
          p.systemType = 'orphan'
        }
        restored.push(p)
      }
      this.tabs = restored
      const savedActive = await ipc.getAppState('active_tab')
      this.activeTabId =
        savedActive && restored.some((t) => t.id === savedActive)
          ? savedActive
          : restored[0]?.id ?? null
    } catch {
      this.tabs = []
    } finally {
      this.restored = true
    }
  }
}

export const tabs = new TabsStore()
