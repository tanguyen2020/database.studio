// Data Transfer (multi-table, cross-connection). State only; DataTransferDialog
// does the planning (copy/plan.ts) + paged read→insert→verify loop. Opened from
// a schema node ("Transfer data to…") or from a table ("Copy to…" with one table
// preselected).
class TransferStore {
  open = $state(false)
  srcConnId = $state<string | null>(null)
  srcSchema = $state('')
  /** tables ticked when the dialog opens (empty = none) */
  preTables = $state<string[]>([])

  show(connId: string, schema: string, tables: string[] = []) {
    this.srcConnId = connId
    this.srcSchema = schema
    this.preTables = tables
    this.open = true
  }

  close() {
    this.open = false
  }
}

export const transferWizard = new TransferStore()
