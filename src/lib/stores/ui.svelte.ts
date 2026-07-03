// UI-level state: dialogs, theme, panel sizes (persisted via app_state).

import * as ipc from '$lib/ipc'
import type { ProfileDraft, ProfilePublic } from '$lib/types'

export interface EditConnectedRequest {
  draft: ProfileDraft
  tabCount: number
}

class UiStore {
  theme = $state<'dark' | 'light'>('dark')

  // Connection Manager dialogs
  pickerOpen = $state(false)
  /** picker → form should open in Quick Connect (one-off) mode */
  pickerQuick = $state(false)
  /** null = closed; profile with empty id = new */
  formProfile = $state<ProfilePublic | null>(null)
  /** form is a one-off Quick Connect (Connect instead of Save, no persist) */
  formQuick = $state(false)
  deleteTarget = $state<ProfilePublic | null>(null)
  /** connection tree grouping: by system type (prototype-faithful) or by folder */
  connGroupMode = $state<'type' | 'folder'>('type')
  /** save-while-connected decision dialog (Cancel / Save & Reconnect / Save only) */
  editConnected = $state<EditConnectedRequest | null>(null)

  // Layout sizes (px) — all resizers persist their size
  sidebarWidth = $state(278)
  connListHeight = $state(200)
  editorHeight = $state(320)
  // Object Properties (right panel) — mặc định mở 264px như prototype (dòng 2295)
  rightPanelOpen = $state(true)
  rightPanelWidth = $state(264)
  sizesLoaded = $state(false)

  setConnGroupMode(mode: 'type' | 'folder') {
    this.connGroupMode = mode
    void ipc.setAppState('conn_group_mode', mode)
  }

  toggleTheme() {
    this.theme = this.theme === 'dark' ? 'light' : 'dark'
    document.documentElement.classList.toggle('dark', this.theme === 'dark')
    void ipc.setAppState('theme', this.theme)
  }

  async loadPersisted() {
    try {
      const [theme, sizes, groupMode] = await Promise.all([
        ipc.getAppState('theme'),
        ipc.getAppState('layout_sizes'),
        ipc.getAppState('conn_group_mode'),
      ])
      if (theme === 'light' || theme === 'dark') {
        this.theme = theme
      }
      if (groupMode === 'type' || groupMode === 'folder') {
        this.connGroupMode = groupMode
      }
      document.documentElement.classList.toggle('dark', this.theme === 'dark')
      if (sizes) {
        const parsed = JSON.parse(sizes)
        if (parsed.sidebarWidth > 150) this.sidebarWidth = parsed.sidebarWidth
        if (parsed.connListHeight > 100) this.connListHeight = parsed.connListHeight
        if (parsed.editorHeight > 100) this.editorHeight = parsed.editorHeight
        if (parsed.rightPanelWidth > 150) this.rightPanelWidth = parsed.rightPanelWidth
        if (typeof parsed.rightPanelOpen === 'boolean') this.rightPanelOpen = parsed.rightPanelOpen
      }
    } catch {
      // defaults are fine
    } finally {
      this.sizesLoaded = true
    }
  }

  private sizeTimer: ReturnType<typeof setTimeout> | null = null

  persistSizes() {
    if (this.sizeTimer) clearTimeout(this.sizeTimer)
    this.sizeTimer = setTimeout(() => {
      void ipc.setAppState(
        'layout_sizes',
        JSON.stringify({
          sidebarWidth: this.sidebarWidth,
          connListHeight: this.connListHeight,
          editorHeight: this.editorHeight,
          rightPanelWidth: this.rightPanelWidth,
          rightPanelOpen: this.rightPanelOpen,
        }),
      )
    }, 500)
  }
}

export const ui = new UiStore()
