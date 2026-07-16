// PostgreSQL "Create Login/Group Role" dialog state (U1). Opened from the User
// Manager "New Role" button and the Explorer "Login/Group Roles" context menu.
class PgRoleStore {
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

export const pgRoleWizard = new PgRoleStore()
