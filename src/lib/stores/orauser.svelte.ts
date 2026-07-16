// Oracle "Create User" dialog state (U6).
class OraUserStore {
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

export const oraUserWizard = new OraUserStore()
