// SQL Server "New Login / User / Role" dialog state (U3). One dialog serves all
// three create flows via `mode`; `database` binds User/Role creation to the DB
// whose Security node opened it.
class MssqlUserStore {
  open = $state(false)
  connId = $state<string | null>(null)
  mode = $state<'login' | 'user' | 'role'>('login')
  database = $state<string>('')
  /** Login names available to map a new user to (mode='user'). */
  logins = $state<string[]>([])

  show(connId: string, mode: 'login' | 'user' | 'role', database = '', logins: string[] = []) {
    this.connId = connId
    this.mode = mode
    this.database = database
    this.logins = logins
    this.open = true
  }

  close() {
    this.open = false
  }
}

export const mssqlUserWizard = new MssqlUserStore()
