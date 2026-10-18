// DuckDB dialogs (Import file · Export to file · Attach database). Each carries
// the connection it runs on plus where it was opened from, so the dialog can
// preselect the database / schema / table.

class DuckImportStore {
  open = $state(false)
  connId = $state<string | null>(null)
  database = $state<string | null>(null)
  schema = $state('main')
  /** append into this table instead of creating one */
  table = $state<string | null>(null)
  /** start from this file (drag & drop, "Import file…" with a path) */
  path = $state('')
  /** bumps on every show() so a re-open with the same target resets the wizard */
  seq = $state(0)

  show(connId: string, opts: { database?: string | null; schema?: string; table?: string | null; path?: string } = {}) {
    this.connId = connId
    this.database = opts.database ?? null
    this.schema = opts.schema || 'main'
    this.table = opts.table ?? null
    this.path = opts.path ?? ''
    this.seq++
    this.open = true
  }

  close() {
    this.open = false
  }
}

export type DuckExportTarget =
  | { kind: 'table'; schema: string; table: string; database?: string | null }
  | { kind: 'query'; sql: string }
  | { kind: 'database'; database?: string | null }

class DuckExportStore {
  open = $state(false)
  connId = $state<string | null>(null)
  source = $state<DuckExportTarget | null>(null)
  seq = $state(0)

  show(connId: string, source: DuckExportTarget) {
    this.connId = connId
    this.source = source
    this.seq++
    this.open = true
  }

  close() {
    this.open = false
  }
}

class DuckAttachStore {
  open = $state(false)
  connId = $state<string | null>(null)
  seq = $state(0)
  /** called after a successful ATTACH (refresh the tree / the page) */
  onDone: ((alias: string) => void) | null = null

  show(connId: string, onDone?: (alias: string) => void) {
    this.connId = connId
    this.onDone = onDone ?? null
    this.seq++
    this.open = true
  }

  close() {
    this.open = false
  }
}

export const duckImport = new DuckImportStore()
export const duckExport = new DuckExportStore()
export const duckAttach = new DuckAttachStore()
