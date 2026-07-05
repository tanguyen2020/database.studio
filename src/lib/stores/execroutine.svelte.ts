// Execute Routine dialog state (T28). Holds the routine to run; the dialog
// collects argument values by signature and opens the CALL/SELECT in a SQL tab.
import type { RoutineInfo } from '$lib/types'

class ExecRoutineStore {
  open = $state(false)
  connId = $state<string | null>(null)
  schema = $state('')
  routine = $state<RoutineInfo | null>(null)

  show(connId: string, schema: string, routine: RoutineInfo) {
    this.connId = connId
    this.schema = schema
    this.routine = routine
    this.open = true
  }

  close() {
    this.open = false
  }
}

export const execRoutineWizard = new ExecRoutineStore()
