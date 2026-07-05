// ClickHouse Create MV / Dictionary dialog state (T30).
class ChCreateStore {
  open = $state(false)
  mode = $state<'mv' | 'dict'>('mv')
  connId = $state<string | null>(null)
  db = $state('')

  show(connId: string, db: string, mode: 'mv' | 'dict') {
    this.connId = connId
    this.db = db
    this.mode = mode
    this.open = true
  }

  close() {
    this.open = false
  }
}

export const chCreateWizard = new ChCreateStore()
