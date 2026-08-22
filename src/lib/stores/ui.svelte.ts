// UI-level state: dialogs, theme, panel sizes (persisted via app_state).

import * as ipc from '$lib/ipc'
import type { ProfileDraft, ProfilePublic } from '$lib/types'

/** Sidebar layout: where the Connections panel sits relative to the Explorer.
 *  'stacked' = one column (Connections above Explorer — the prototype layout),
 *  'left'    = two panels side by side, Connections on the left,
 *  'right'   = two panels side by side, Connections on the right. */
export type SidebarLayout = 'left' | 'stacked' | 'right'

export interface EditConnectedRequest {
  draft: ProfileDraft
  tabCount: number
}

class UiStore {
  theme = $state<'dark' | 'light'>('dark')
  /** Global UI scale ("font size"). The whole app is sized in absolute px tokens,
   *  so scaling font alone would break layouts — this zooms the entire UI (font +
   *  spacing proportionally), like a browser zoom. 1 = 100%. */
  fontScale = $state<number>(1)

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
  /** Chosen by the three layout buttons in the title bar; persisted. */
  sidebarLayout = $state<SidebarLayout>('stacked')
  /** Width of the Connections panel while the sidebar is split (px). */
  connPanelWidth = $state(240)
  /** true when Connections and Explorer are two side-by-side panels. */
  get sidebarSplit() {
    return this.sidebarLayout !== 'stacked'
  }
  editorHeight = $state(320)
  // Object Properties (right panel) — hidden on startup; reopen via the edge
  // handle / title-bar button. Width 264px when shown.
  rightPanelOpen = $state(false)
  rightPanelWidth = $state(264)
  // Result panel (query editor) — collapsible. When hidden the editor fills the
  // pane; running a statement or Explain auto-shows it again (see SqlWorkspace).
  // Toggled by the toolbar button + Ctrl/Cmd+J. Persisted with the other sizes.
  resultPanelHidden = $state(false)
  sizesLoaded = $state(false)

  // T21 — signal ticks cho shortcut cần context editor/result/explorer.
  formatTick = $state(0)
  explorerFindTick = $state(0)
  resultView = $state<'grid' | 'json' | 'single'>('grid')
  resultViewTick = $state(0)
  copyJsonTick = $state(0)
  requestFormat() {
    this.formatTick++
  }
  requestExplorerFind() {
    this.explorerFindTick++
  }
  requestResultView(mode: 'grid' | 'json' | 'single') {
    this.resultView = mode
    this.resultViewTick++
  }
  requestCopyJson() {
    this.copyJsonTick++
  }

  // Connections sidebar shortcuts — the list owns the behaviour, App.svelte only
  // ticks the signal (same pattern as the editor/explorer ticks above).
  connFocusTick = $state(0)
  connFilterTick = $state(0)
  connToggleTick = $state(0)
  /** Move keyboard focus into the Connections list (Ctrl/Cmd+Shift+B). */
  requestConnectionsFocus() {
    this.connFocusTick++
  }
  /** Open + focus the Connections filter box (Ctrl/Cmd+Shift+K). */
  requestConnectionsFilter() {
    this.connFilterTick++
  }
  /** Connect / disconnect the selected connection (Ctrl/Cmd+Shift+O). */
  requestConnectionToggle() {
    this.connToggleTick++
  }
  /** Remembers which side Connections was on, so merge → split comes back the same. */
  private lastSplitSide: SidebarLayout = 'left'

  /** Pick the sidebar layout (the three title-bar buttons). */
  setSidebarLayout(mode: SidebarLayout) {
    this.sidebarLayout = mode
    if (mode !== 'stacked') this.lastSplitSide = mode
    // localStorage as well as app_state: the layout is picked deliberately, so it
    // must survive a restart even where app_state isn't available (browser build),
    // and it applies at boot without waiting on the backend.
    try {
      localStorage.setItem('sidebar_layout', mode)
    } catch {
      /* private mode / storage disabled — app_state still persists */
    }
    this.persistSizes()
  }

  /** Split ⇄ merge shortcut (the button in the panel headers); splitting returns
   *  to the side last picked. */
  toggleSidebarSplit() {
    this.setSidebarLayout(this.sidebarSplit ? 'stacked' : this.lastSplitSide)
  }
  toggleResultPanel() {
    this.resultPanelHidden = !this.resultPanelHidden
    this.persistSizes()
  }
  /** Force the result panel visible — called when a statement/Explain runs. */
  showResultPanel() {
    if (this.resultPanelHidden) {
      this.resultPanelHidden = false
      this.persistSizes()
    }
  }

  setConnGroupMode(mode: 'type' | 'folder') {
    this.connGroupMode = mode
    void ipc.setAppState('conn_group_mode', mode)
  }

  toggleTheme() {
    this.setTheme(this.theme === 'dark' ? 'light' : 'dark')
  }

  setTheme(theme: 'dark' | 'light') {
    this.theme = theme
    document.documentElement.classList.toggle('dark', theme === 'dark')
    // localStorage = fast, synchronous, applied at boot (no flash); app_state =
    // backend copy. Both are written so the choice survives an app restart.
    try {
      localStorage.setItem('theme', theme)
    } catch {
      /* private mode / storage disabled — app_state still persists */
    }
    void ipc.setAppState('theme', theme)
  }

  private applyFontScale() {
    // Chromium/WebView2 `zoom` scales the whole document (font + px-token spacing).
    document.documentElement.style.zoom = String(this.fontScale)
  }

  setFontScale(scale: number) {
    this.fontScale = Math.min(2, Math.max(0.75, scale))
    this.applyFontScale()
    void ipc.setAppState('font_scale', String(this.fontScale))
  }

  async loadPersisted() {
    try {
      const [theme, sizes, groupMode, fontScale] = await Promise.all([
        ipc.getAppState('theme'),
        ipc.getAppState('layout_sizes'),
        ipc.getAppState('conn_group_mode'),
        ipc.getAppState('font_scale'),
      ])
      // Prefer localStorage (what boot already applied); fall back to the backend
      // app_state for installs saved before localStorage was used, and mirror it
      // back so future boots are flash-free.
      let stored: string | null = null
      try {
        stored = localStorage.getItem('theme')
      } catch {
        stored = null
      }
      if (stored !== 'light' && stored !== 'dark') {
        stored = theme // migrate from app_state
        if ((theme === 'light' || theme === 'dark')) {
          try {
            localStorage.setItem('theme', theme)
          } catch {
            /* ignore */
          }
        }
      }
      if (stored === 'light' || stored === 'dark') {
        this.theme = stored
      }
      if (groupMode === 'type' || groupMode === 'folder') {
        this.connGroupMode = groupMode
      }
      const fs = Number(fontScale)
      if (Number.isFinite(fs) && fs >= 0.75 && fs <= 2) {
        this.fontScale = fs
      }
      this.applyFontScale()
      document.documentElement.classList.toggle('dark', this.theme === 'dark')
      try {
        const stored = localStorage.getItem('sidebar_layout')
        if (stored === 'left' || stored === 'right' || stored === 'stacked') {
          this.sidebarLayout = stored
          if (stored !== 'stacked') this.lastSplitSide = stored
        } else {
          const split = localStorage.getItem('sidebar_split') // pre-3-mode key
          if (split === '1') this.sidebarLayout = 'left'
          else if (split === '0') this.sidebarLayout = 'stacked'
        }
      } catch {
        /* fall back to app_state below */
      }
      if (sizes) {
        const parsed = JSON.parse(sizes)
        if (parsed.sidebarWidth > 150) this.sidebarWidth = parsed.sidebarWidth
        if (parsed.connListHeight > 100) this.connListHeight = parsed.connListHeight
        if (parsed.editorHeight > 100) this.editorHeight = parsed.editorHeight
        if (parsed.rightPanelWidth > 150) this.rightPanelWidth = parsed.rightPanelWidth
        if (typeof parsed.resultPanelHidden === 'boolean') this.resultPanelHidden = parsed.resultPanelHidden
        let hasLocalLayout = false
        try {
          hasLocalLayout =
            localStorage.getItem('sidebar_layout') !== null ||
            localStorage.getItem('sidebar_split') !== null
        } catch {
          hasLocalLayout = false
        }
        if (!hasLocalLayout) {
          const m = parsed.sidebarLayout
          if (m === 'left' || m === 'right' || m === 'stacked') this.sidebarLayout = m
          else if (typeof parsed.sidebarSplit === 'boolean') {
            this.sidebarLayout = parsed.sidebarSplit ? 'left' : 'stacked' // pre-3-mode installs
          }
          if (this.sidebarLayout !== 'stacked') this.lastSplitSide = this.sidebarLayout
        }
        if (parsed.connPanelWidth > 150) this.connPanelWidth = parsed.connPanelWidth
        // rightPanelOpen intentionally NOT restored — the Properties panel always
        // starts hidden on app open; the user reopens it via the edge handle.
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
          resultPanelHidden: this.resultPanelHidden,
          sidebarLayout: this.sidebarLayout,
          connPanelWidth: this.connPanelWidth,
        }),
      )
    }, 500)
  }
}

export const ui = new UiStore()
