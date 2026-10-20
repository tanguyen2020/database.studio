// Backup & Restore dialog state. `show(connId, system)` keeps its old signature;
// the optional third argument names the database (the node that was right-clicked)
// and the tab to open on.
export type BackupTab = 'backup' | 'restore'

export interface BackupShowOptions {
  /** Database / keyspace / logical db the action is for (default: the connection's). */
  database?: string
  tab?: BackupTab
  /** Pre-filled restore file (a finished backup → Restore from this file…). */
  src?: string
}

class BackupStore {
  open = $state(false)
  connId = $state<string | null>(null)
  system = $state('')
  database = $state('')
  tab = $state<BackupTab>('backup')
  src = $state('')
  /** Bumped on every show() so the dialog re-initialises even when re-opened on the same target. */
  nonce = $state(0)

  show(connId: string, system: string, opts: BackupShowOptions = {}) {
    this.connId = connId
    this.system = system
    this.database = opts.database ?? ''
    this.tab = opts.tab ?? 'backup'
    this.src = opts.src ?? ''
    this.nonce++
    this.open = true
  }
  close() {
    this.open = false
  }
}

export const backupWizard = new BackupStore()
