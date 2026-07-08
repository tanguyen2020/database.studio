// Execute Routine dialog state (T28). Holds the routine to run; the dialog
// collects argument values by signature and opens the CALL/SELECT in a SQL tab.
import type { RoutineInfo } from '$lib/types'

class ExecRoutineStore {
  open = $state(false)
  connId = $state<string | null>(null)
  schema = $state('')
  routine = $state<RoutineInfo | null>(null)
  /** database the routine lives in — the opened SQL tab binds/runs there so the
   *  routine body resolves against the right DB (MySQL schema==db, foreign DB). */
  database = $state<string | undefined>(undefined)

  show(connId: string, schema: string, routine: RoutineInfo, database?: string) {
    this.connId = connId
    this.schema = schema
    this.routine = routine
    this.database = database
    this.open = true
  }

  close() {
    this.open = false
  }
}

export const execRoutineWizard = new ExecRoutineStore()
