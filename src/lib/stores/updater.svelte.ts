// In-app updates. The desktop build checks GitHub Releases on start-up and lets
// the user install a newer version without downloading an installer by hand.
//
// The Tauri plugins are imported LAZILY (inside the methods) so the browser/demo
// build — which has no Tauri runtime — never pulls them in; every entry point
// early-returns when IS_TAURI is false, which keeps Vitest/Playwright unaffected.

import { IS_TAURI } from '$lib/demo'
import { toasts } from './toast.svelte'
import { formatBytes, isNewer, mayPrompt, progressPercent } from '$lib/update/version'

/** Persisted across runs so "Skip this version" survives a restart. */
const SKIP_KEY = 'update:skippedVersion'

export interface PendingUpdate {
  version: string
  currentVersion: string
  notes?: string
  date?: string
}

class UpdaterStore {
  /** Set when a newer release is available and the user hasn't dismissed it. */
  available = $state<PendingUpdate | null>(null)
  /** A check is in flight (drives the "Checking…" state of the manual button). */
  checking = $state(false)
  /** Download + install in progress. */
  installing = $state(false)
  /** 0..100, or null while the server sends no content-length. */
  progress = $state<number | null>(null)
  /** Human-readable size of the download, '' when unknown. */
  size = $state('')
  /** Last check failed — shown in Settings, never as a start-up popup. */
  error = $state<string | null>(null)
  /** True once an update is staged and only a restart is left. */
  readyToRestart = $state(false)

  /** "Later" silences the start-up prompt until the next launch. */
  private dismissedThisRun = false
  /** The plugin's Update handle for the pending version (null once consumed). */
  private handle: unknown = null

  get skippedVersion(): string | null {
    try {
      return localStorage.getItem(SKIP_KEY)
    } catch {
      return null
    }
  }

  private setSkipped(v: string | null) {
    try {
      if (v) localStorage.setItem(SKIP_KEY, v)
      else localStorage.removeItem(SKIP_KEY)
    } catch {
      /* private mode — skipping just won't persist */
    }
  }

  /**
   * Check GitHub Releases.
   * - `silent` (start-up): failures stay quiet (offline is normal) and a version
   *   the user skipped, or dismissed this run, does not re-prompt.
   * - manual (Settings button): always reports the outcome, including
   *   "you're up to date", and ignores a previous skip.
   */
  async check(opts: { silent?: boolean } = {}) {
    if (!IS_TAURI) {
      this.fakeCheck(opts)
      return
    }
    if (this.checking || this.installing) return
    this.checking = true
    this.error = null
    try {
      const { check } = await import('@tauri-apps/plugin-updater')
      const update = await check()
      if (!update || !isNewer(update.version, update.currentVersion)) {
        this.handle = null
        this.available = null
        if (!opts.silent) toasts.success('You are running the latest version.')
        return
      }
      this.handle = update
      if (opts.silent && !mayPrompt(update.version, this.skippedVersion, this.dismissedThisRun)) return
      this.available = {
        version: update.version,
        currentVersion: update.currentVersion,
        notes: update.body ?? undefined,
        date: update.date ?? undefined,
      }
    } catch (e) {
      this.error = String(e)
      // A failed start-up check must not interrupt the app: no network, GitHub
      // down, or a release without a manifest are all normal.
      if (!opts.silent) toasts.error(`Could not check for updates: ${e}`)
    } finally {
      this.checking = false
    }
  }

  /** Download + install the pending update, then relaunch into it. */
  async installNow() {
    if (!IS_TAURI || !this.handle || this.installing) return
    const update = this.handle as {
      downloadAndInstall: (cb: (ev: DownloadEvent) => void) => Promise<void>
    }
    this.installing = true
    this.progress = null
    this.error = null
    let total = 0
    let got = 0
    try {
      await update.downloadAndInstall((ev) => {
        if (ev.event === 'Started') {
          total = ev.data.contentLength ?? 0
          this.size = formatBytes(total)
          this.progress = progressPercent(0, total)
        } else if (ev.event === 'Progress') {
          got += ev.data.chunkLength ?? 0
          this.progress = progressPercent(got, total)
        } else if (ev.event === 'Finished') {
          this.progress = 100
        }
      })
      this.readyToRestart = true
      const { relaunch } = await import('@tauri-apps/plugin-process')
      await relaunch()
    } catch (e) {
      this.error = String(e)
      toasts.error(`Update failed: ${e}`)
      this.installing = false
      this.readyToRestart = false
    }
  }

  /** Ask again on the next launch. */
  later() {
    this.dismissedThisRun = true
    this.available = null
  }

  /** Never prompt for this exact version again (a newer one still prompts). */
  skip() {
    if (this.available) this.setSkipped(this.available.version)
    this.available = null
  }

  /**
   * e2e seam (demo/browser only, like `?slowIntrospect`): `?fakeUpdate=<version>`
   * renders the prompt so the dialog's wiring is testable without a desktop
   * runtime. There is no real update to install, so the buttons that dismiss are
   * the ones under test. Never reachable in Tauri — check() returns before this.
   */
  private fakeCheck(opts: { silent?: boolean }) {
    let version = ''
    try {
      version = new URLSearchParams(window.location.search).get('fakeUpdate') ?? ''
    } catch {
      return
    }
    if (!version) {
      if (!opts.silent) toasts.success('You are running the latest version.')
      return
    }
    if (opts.silent && !mayPrompt(version, this.skippedVersion, this.dismissedThisRun)) return
    this.available = { version, currentVersion: __APP_VERSION__, notes: 'Demo release notes.' }
  }

  /** Manual check from Settings — bypasses a previous skip/dismissal. */
  async checkManually() {
    this.dismissedThisRun = false
    this.setSkipped(null)
    await this.check({ silent: false })
  }
}

/** Shape of the plugin's download callback events (kept local: importing the
 *  type would pull the plugin into the browser bundle). */
type DownloadEvent =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength?: number } }
  | { event: 'Finished'; data?: unknown }

export const updater = new UpdaterStore()
