// Generate Test Data (T26) — dialog state only. The dialog builds column
// generators, fetches FK parent pools, and runs batched INSERTs.
class TestDataStore {
  open = $state(false)
  connId = $state<string | null>(null)
  schema = $state('')
  table = $state('')

  show(connId: string, schema: string, table: string) {
    this.connId = connId
    this.schema = schema
    this.table = table
    this.open = true
  }

  close() {
    this.open = false
  }
}

export const testDataWizard = new TestDataStore()
