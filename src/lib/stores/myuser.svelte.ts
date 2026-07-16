// MySQL / MariaDB "Add Account" dialog state (U2). Opened from the User Manager
// "Add Account" button and the Explorer context menu.
class MyUserStore {
  open = $state(false)
  connId = $state<string | null>(null)
  system = $state<'mysql' | 'mariadb'>('mysql')

  show(connId: string, system: 'mysql' | 'mariadb') {
    this.connId = connId
    this.system = system
    this.open = true
  }

  close() {
    this.open = false
  }
}

export const myUserWizard = new MyUserStore()
