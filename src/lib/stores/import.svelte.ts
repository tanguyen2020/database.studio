// CSV Import wizard state (Phase 5 · T4).
class ImportStore {
  open = $state(false)
  connId = $state<string | null>(null)
  schema = $state('')
  /** Pre-set target (MongoDB: the collection right-clicked; schemaless → no mapping). */
  table = $state('')

  show(connId: string, schema: string, table = '') {
    this.open = true
    this.connId = connId
    this.schema = schema
    this.table = table
  }
  close() {
    this.open = false
  }
}

export const importWizard = new ImportStore()
