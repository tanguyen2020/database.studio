// Truncate-confirm dialog state — opened from the table context menu. Carries the
// target + chosen variant so the dialog shows the exact statement(s) and runs them
// after an explicit confirm. `database` binds execution to a foreign-db sub-connection.
import type { TruncateVariant } from '$lib/sql/truncate'

class TruncateStore {
  open = $state(false)
  connId = $state<string | null>(null)
  schema = $state('')
  table = $state('')
  system = $state('')
  variant = $state<TruncateVariant>('plain')
  database = $state<string | undefined>(undefined)
  /** optional callback after a successful truncate (e.g. refresh the caller's view) */
  onDone = $state<(() => void) | undefined>(undefined)

  show(
    connId: string,
    schema: string,
    table: string,
    system: string,
    variant: TruncateVariant,
    database?: string,
    onDone?: () => void,
  ) {
    this.connId = connId
    this.schema = schema
    this.table = table
    this.system = system
    this.variant = variant
    this.database = database
    this.onDone = onDone
    this.open = true
  }

  close() {
    this.open = false
  }
}

export const truncateWizard = new TruncateStore()
