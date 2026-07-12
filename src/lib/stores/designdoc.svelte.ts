// Design Document dialog state (MongoDB) — target connection/database/collection;
// the dialog loads the sampled fields and applies add/rename/drop field ops via
// updateMany (see $lib/mongo/design).
class DesignDocStore {
  open = $state(false)
  connId = $state<string | null>(null)
  database = $state('')
  collection = $state('')

  show(connId: string, database: string, collection: string) {
    this.connId = connId
    this.database = database
    this.collection = collection
    this.open = true
  }

  close() {
    this.open = false
  }
}

export const designDocWizard = new DesignDocStore()
