// Unit test tab store — mở/đóng/reorder/pin/jump/restore-closed/orphan/persist-order.
// IPC được mock: test logic store thuần, không cần Tauri runtime.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('$lib/ipc', () => ({
  saveTabs: vi.fn(async () => {}),
  loadTabs: vi.fn(async () => []),
  getAppState: vi.fn(async () => null),
  setAppState: vi.fn(async () => {}),
  listConnections: vi.fn(async () => []),
}))

import { tabs } from './tabs.svelte'

function reset() {
  tabs.tabs = []
  tabs.activeTabId = null
  tabs.activeTabId1 = null
  tabs.splitDir = null
  tabs.activePane = 0
  tabs.pendingClose = null
  tabs.restored = true
}

beforeEach(reset)

describe('tab store — mở/kích hoạt', () => {
  it('openSqlTab tạo tab active với context đầy đủ', () => {
    const t = tabs.openSqlTab({ connectionId: null, title: 'Untitled query' })
    expect(tabs.tabs).toHaveLength(1)
    expect(tabs.activeTabId).toBe(t.id)
    expect(t.contentType).toBe('sql-editor')
    expect(t.isPinned).toBe(false)
    expect(t.isDirty).toBe(false)
  })

  it('tab mới kế thừa connection của tab active (connection-aware)', () => {
    const a = tabs.openSqlTab({ connectionId: 'c1' })
    a.systemType = 'postgres'
    const b = tabs.openSqlTab({})
    expect(b.connectionId).toBe('c1')
  })

  it('Ctrl+Tab / Ctrl+Shift+Tab xoay vòng', () => {
    const a = tabs.openSqlTab({ connectionId: null })
    const b = tabs.openSqlTab({ connectionId: null })
    const c = tabs.openSqlTab({ connectionId: null })
    expect(tabs.activeTabId).toBe(c.id)
    tabs.next()
    expect(tabs.activeTabId).toBe(a.id)
    tabs.prev()
    expect(tabs.activeTabId).toBe(c.id)
    tabs.prev()
    expect(tabs.activeTabId).toBe(b.id)
  })

  it('Ctrl+1..9: jump theo số, 9 = tab cuối', () => {
    const ids = [1, 2, 3, 4].map(() => tabs.openSqlTab({ connectionId: null }).id)
    tabs.jumpTo(2)
    expect(tabs.activeTabId).toBe(ids[1])
    tabs.jumpTo(9)
    expect(tabs.activeTabId).toBe(ids[3])
  })
})

describe('tab store — đóng/restore', () => {
  it('đóng tab sạch: đóng ngay, active chuyển sang tab kế', () => {
    const a = tabs.openSqlTab({ connectionId: null })
    const b = tabs.openSqlTab({ connectionId: null })
    tabs.activate(a.id)
    expect(tabs.requestClose([a.id])).toBe(true)
    expect(tabs.tabs.map((t) => t.id)).toEqual([b.id])
    expect(tabs.activeTabId).toBe(b.id)
  })

  it('tab dirty → pendingClose (save-before-close), KHÔNG đóng ngay', () => {
    const a = tabs.openSqlTab({ connectionId: null })
    tabs.setDirty(a.id, true)
    expect(tabs.requestClose([a.id])).toBe(false)
    expect(tabs.tabs).toHaveLength(1)
    expect(tabs.pendingClose?.map((t) => t.id)).toEqual([a.id])
  })

  it('Ctrl+Shift+T restore tab vừa đóng (LIFO)', () => {
    const a = tabs.openSqlTab({ connectionId: null, title: 'first' })
    const b = tabs.openSqlTab({ connectionId: null, title: 'second' })
    tabs.forceClose([a.id])
    tabs.forceClose([b.id])
    expect(tabs.tabs).toHaveLength(0)
    tabs.restoreClosed()
    expect(tabs.tabs[0].title).toBe('second')
    tabs.restoreClosed()
    expect(tabs.tabs.map((t) => t.title).sort()).toEqual(['first', 'second'])
  })

  it('closeOthers/closeToRight bỏ qua tab pinned', () => {
    const a = tabs.openSqlTab({ connectionId: null })
    const b = tabs.openSqlTab({ connectionId: null })
    const c = tabs.openSqlTab({ connectionId: null })
    tabs.togglePin(b.id)
    tabs.closeOthers(a.id)
    expect(tabs.tabs.map((t) => t.id).sort()).toEqual([a.id, b.id].sort())
    const d = tabs.openSqlTab({ connectionId: null })
    tabs.togglePin(d.id)
    const e = tabs.openSqlTab({ connectionId: null })
    tabs.closeToRight(a.id)
    expect(tabs.tabs.some((t) => t.id === d.id)).toBe(true)
    expect(tabs.tabs.some((t) => t.id === e.id)).toBe(false)
  })
})

describe('tab store — reorder/rename/duplicate', () => {
  it('drag reorder đổi vị trí', () => {
    const a = tabs.openSqlTab({ connectionId: null, title: 'a' })
    const b = tabs.openSqlTab({ connectionId: null, title: 'b' })
    const c = tabs.openSqlTab({ connectionId: null, title: 'c' })
    tabs.reorder(0, 2)
    expect(tabs.tabs.map((t) => t.title)).toEqual(['b', 'c', 'a'])
    void a
    void b
    void c
  })

  it('rename giữ title trim, bỏ qua rỗng', () => {
    const a = tabs.openSqlTab({ connectionId: null, title: 'old' })
    tabs.rename(a.id, '  new title  ')
    expect(tabs.byId(a.id)?.title).toBe('new title')
    tabs.rename(a.id, '   ')
    expect(tabs.byId(a.id)?.title).toBe('new title')
  })

  it('duplicate chèn cạnh bản gốc, không pinned', () => {
    const a = tabs.openSqlTab({ connectionId: null, title: 'q1' })
    tabs.togglePin(a.id)
    tabs.duplicate(a.id)
    expect(tabs.tabs).toHaveLength(2)
    expect(tabs.tabs[1].title).toBe('q1 (copy)')
    expect(tabs.tabs[1].isPinned).toBe(false)
  })
})

describe('tab store — orphan (Force Delete)', () => {
  it('orphanByConnection: tab giữ nội dung, mất connection, systemType=orphan', () => {
    const a = tabs.openSqlTab({ connectionId: 'c9', query: 'SELECT 1' })
    a.systemType = 'postgres'
    tabs.orphanByConnection('c9')
    const t = tabs.byId(a.id)!
    expect(t.connectionId).toBeNull()
    expect(t.systemType).toBe('orphan')
    expect((t.state as { query: string }).query).toBe('SELECT 1')
  })
})

describe('tab store — persist', () => {
  it('persist ghi pinned trước (restore pinned-first theo spec)', async () => {
    const ipc = await import('$lib/ipc')
    const a = tabs.openSqlTab({ connectionId: null, title: 'normal' })
    const b = tabs.openSqlTab({ connectionId: null, title: 'pinned' })
    tabs.togglePin(b.id)
    await tabs.persist()
    const call = vi.mocked(ipc.saveTabs).mock.lastCall![0] as Array<{ id: string }>
    expect(call[0].id).toBe(b.id)
    expect(call[1].id).toBe(a.id)
  })
})

describe('split view (T11)', () => {
  it('moveToSplit đưa tab sang pane 1 + bật split', () => {
    const a = tabs.openSqlTab({ connectionId: null })
    const b = tabs.openSqlTab({ connectionId: null })
    tabs.moveToSplit(b.id, 'v')
    expect(tabs.splitDir).toBe('v')
    expect(tabs.tabsInPane(0).map((t) => t.id)).toEqual([a.id])
    expect(tabs.tabsInPane(1).map((t) => t.id)).toEqual([b.id])
    expect(tabs.activePane).toBe(1)
    expect(tabs.activeInPane(1)?.id).toBe(b.id)
    expect(tabs.active?.id).toBe(b.id)
  })

  it('openSqlTab({pane:1}) mở tab trong pane 1 khi đang split', () => {
    const a = tabs.openSqlTab({ connectionId: null })
    tabs.moveToSplit(a.id, 'v') // giờ pane 0 rỗng, split bật
    const c = tabs.openSqlTab({ connectionId: null, pane: 0 })
    expect(tabs.tabsInPane(0).map((t) => t.id)).toEqual([c.id])
  })

  it('closeSplit gộp mọi tab về pane 0', () => {
    const a = tabs.openSqlTab({ connectionId: null })
    const b = tabs.openSqlTab({ connectionId: null })
    tabs.moveToSplit(b.id)
    tabs.closeSplit()
    expect(tabs.splitDir).toBeNull()
    expect(tabs.tabsInPane(1)).toHaveLength(0)
    expect(tabs.tabsInPane(0).map((t) => t.id).sort()).toEqual([a.id, b.id].sort())
  })

  it('đóng tab cuối của pane 1 → tự tắt split', () => {
    const a = tabs.openSqlTab({ connectionId: null })
    const b = tabs.openSqlTab({ connectionId: null })
    tabs.moveToSplit(b.id)
    tabs.forceClose([b.id])
    expect(tabs.splitDir).toBeNull()
    expect(tabs.active?.id).toBe(a.id)
  })

  it('toggleSplitDir đổi v↔h', () => {
    const a = tabs.openSqlTab({ connectionId: null })
    const b = tabs.openSqlTab({ connectionId: null })
    tabs.moveToSplit(b.id, 'v')
    tabs.toggleSplitDir()
    expect(tabs.splitDir).toBe('h')
  })
})
