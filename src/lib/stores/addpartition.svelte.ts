// Add-partition dialog state — opened from the table context menu (Partitions ▸
// Add Partition…). Carries the target table so the dialog can introspect its
// partitioning strategy and offer structured inputs + a live script.
class AddPartitionStore {
  open = $state(false)
  connId = $state<string | null>(null)
  schema = $state('')
  table = $state('')
  system = $state('')
  /** foreign-database binding for the "Open in SQL tab" fallback */
  database = $state<string | undefined>(undefined)

  show(connId: string, schema: string, table: string, system: string, database?: string) {
    this.connId = connId
    this.schema = schema
    this.table = table
    this.system = system
    this.database = database
    this.open = true
  }

  close() {
    this.open = false
  }
}

export const addPartitionWizard = new AddPartitionStore()
