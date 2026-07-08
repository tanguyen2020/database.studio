// Unify Collation… (MySQL/MariaDB) — converge a database on one collation.
// State only; the dialog runs the audit, builds the ALTERs, and executes them.
class CollationStore {
  open = $state(false)
  connId = $state<string | null>(null)
  database = $state('')

  show(connId: string, database: string) {
    this.connId = connId
    this.database = database
    this.open = true
  }

  close() {
    this.open = false
  }
}

export const collationWizard = new CollationStore()
