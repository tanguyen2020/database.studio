// CSV Import wizard state (Phase 5 · T4).
class ImportStore {
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

export const importWizard = new ImportStore()
