// Copy Table to… (T25) — copy a source table's structure + data to another
// connection/schema. State only; the dialog does DDL translation + paged copy.
class CopyStore {
  open = $state(false)
  srcConnId = $state<string | null>(null)
  srcSchema = $state('')
  srcTable = $state('')

  show(connId: string, schema: string, table: string) {
    this.srcConnId = connId
    this.srcSchema = schema
    this.srcTable = table
    this.open = true
  }

  close() {
    this.open = false
  }
}

export const copyWizard = new CopyStore()
