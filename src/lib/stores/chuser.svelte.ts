// ClickHouse "Create User / Role" dialog state (U4).
class ChUserStore {
  open = $state(false)
  connId = $state<string | null>(null)
  mode = $state<'user' | 'role'>('user')

  show(connId: string, mode: 'user' | 'role') {
    this.connId = connId
    this.mode = mode
    this.open = true
  }

  close() {
    this.open = false
  }
}

export const chUserWizard = new ChUserStore()
