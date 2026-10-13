// Export wizard state (Phase 5 · T14). Two modes:
//   - 'table':  export a table with column subset + WHERE + LIMIT (paged fetch)
//   - 'result': export the current in-memory result grid (column subset + limit)
class ExportStore {
  open = $state(false)
  mode = $state<'table' | 'result'>('table')
  connId = $state<string | null>(null)
  schema = $state('')
  table = $state('')
  // result-mode payload (materialized rows already in the client)
  resultHeaders = $state<string[]>([])
  resultRows = $state<Record<string, unknown>[]>([])
  /** [name, type] of the result columns — lets Excel export write numbers as numbers. */
  resultCols = $state<[string, string][]>([])

  showTable(connId: string, schema: string, table: string) {
    this.mode = 'table'
    this.connId = connId
    this.schema = schema
    this.table = table
    this.resultHeaders = []
    this.resultRows = []
    this.resultCols = []
    this.open = true
  }

  showResult(connId: string, headers: string[], rows: Record<string, unknown>[], cols: [string, string][] = []) {
    this.mode = 'result'
    this.connId = connId
    this.schema = ''
    this.table = 'result'
    this.resultHeaders = headers
    this.resultRows = rows
    this.resultCols = cols
    this.open = true
  }

  close() {
    this.open = false
  }
}

export const exportWizard = new ExportStore()
