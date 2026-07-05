// Backup & Restore wizard state (Phase 5 · T22).
class BackupStore {
  open = $state(false)
  connId = $state<string | null>(null)
  system = $state('')
  /** Lịch sử backup trong phiên (dest + thời điểm). */
  history = $state<{ dest: string; at: string; ok: boolean }[]>([])

  show(connId: string, system: string) {
    this.open = true
    this.connId = connId
    this.system = system
  }
  close() {
    this.open = false
  }
  record(dest: string, ok: boolean) {
    this.history = [{ dest, at: new Date().toLocaleString(), ok }, ...this.history].slice(0, 20)
  }
}

export const backupWizard = new BackupStore()
