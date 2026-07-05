// New Database dialog state — holds the target connection + engine; the dialog
// collects a name and runs CREATE DATABASE on that connection.
class NewDatabaseStore {
  open = $state(false)
  connId = $state<string | null>(null)
  system = $state('')

  show(connId: string, system: string) {
    this.connId = connId
    this.system = system
    this.open = true
  }

  close() {
    this.open = false
  }
}

export const newDatabaseWizard = new NewDatabaseStore()
