// One Rename popup for every object the Explorer can rename (table, database,
// schema, function, procedure). The caller describes the object and how to rename
// it; the popup collects the new name, shows the exact statement, runs it and keeps
// a server refusal on screen so the name can be fixed and retried.

export type RenameKind = 'table' | 'database' | 'schema' | 'function' | 'procedure'

export interface RenameRequest {
  kind: RenameKind
  system: string
  /** current name */
  name: string
  /** where it lives, for the subtitle: "public · Postgres" */
  where?: string
  /** names already used next to it — refused before anything is sent */
  taken?: string[]
  /** where `taken` names live, for the message: "in this schema" */
  takenScope?: string
  /** one sentence on what renaming does and does not change */
  note?: string
  /** statement for a new name; an SQL comment means the engine cannot do it */
  build: (to: string) => string
  /** runs the statement; resolves to the server's error message, or null when done */
  run: (sql: string, to: string) => Promise<string | null>
  /** opens the statement in a SQL tab instead of running it */
  openInTab: (sql: string) => void
}

class RenameWizard {
  req = $state<RenameRequest | null>(null)

  open(req: RenameRequest) {
    this.req = req
  }

  close() {
    this.req = null
  }
}

export const renameWizard = new RenameWizard()
