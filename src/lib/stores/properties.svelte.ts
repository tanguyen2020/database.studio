// Right-side Object Properties panel target. The ObjectExplorer publishes the
// currently-selected tree node here; PropertiesPanel renders its details
// (columns / indexes / definition). Additive to the existing inline Properties
// footer in the Explorer — this drives the standalone right panel.
export interface PropTarget {
  connId: string
  system: string
  /** 'table' | 'view' | 'column' | 'procedure' | 'function' | 'trigger' | 'sequence' | 'schema' | 'index' | 'dictionary' */
  kind: string
  /** display label, e.g. "Table", "Column" */
  typeLabel: string
  schema: string
  /** owning table/view name for a column */
  table?: string
  /** object name (or column name when kind === 'column') */
  name: string
}

class PropertiesStore {
  target = $state<PropTarget | null>(null)

  set(t: PropTarget | null) {
    this.target = t
  }
}

export const properties = new PropertiesStore()
