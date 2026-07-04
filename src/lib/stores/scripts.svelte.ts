// Generate Scripts wizard state (Phase 5 · T15). Whole-schema / multi-object
// script generation (structure / data / both) with dependency ordering.
class ScriptsStore {
  open = $state(false)
  connId = $state<string | null>(null)
  schema = $state('')

  show(connId: string, schema: string) {
    this.open = true
    this.connId = connId
    this.schema = schema
  }
  close() {
    this.open = false
  }
}

export const scriptsWizard = new ScriptsStore()
