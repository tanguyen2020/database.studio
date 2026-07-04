// ClickHouse TTL Policy viewer state (Phase 5 · T7c).
import * as ipc from '$lib/ipc'

class ChTtlStore {
  open = $state(false)
  connId = $state<string | null>(null)
  schema = $state('')
  table = $state('')
  meta = $state<ipc.ChTableMeta | null>(null)
  error = $state<string | null>(null)

  async show(connId: string, schema: string, table: string) {
    this.open = true
    this.connId = connId
    this.schema = schema
    this.table = table
    this.meta = null
    this.error = null
    try {
      this.meta = await ipc.chTableMeta(connId, schema, table)
    } catch (e) {
      this.error = String(e)
    }
  }

  close() {
    this.open = false
  }
}

export const chTtl = new ChTtlStore()
