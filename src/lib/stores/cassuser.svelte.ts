// Cassandra "Create Role" dialog state (U7).
class CassUserStore {
  open = $state(false)
  connId = $state<string | null>(null)

  show(connId: string) {
    this.connId = connId
    this.open = true
  }

  close() {
    this.open = false
  }
}

export const cassUserWizard = new CassUserStore()
