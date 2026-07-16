// MongoDB "Add User" dialog state (U5). `database` = the authentication database
// the user is created in.
class MongoUserStore {
  open = $state(false)
  connId = $state<string | null>(null)
  database = $state('admin')

  show(connId: string, database: string) {
    this.connId = connId
    this.database = database
    this.open = true
  }

  close() {
    this.open = false
  }
}

export const mongoUserWizard = new MongoUserStore()
