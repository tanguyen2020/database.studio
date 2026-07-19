// Shared "Grant access" wizard (UX) — a guided popup used by every engine's
// User Manager: pick a scope + an access level, see the SQL, Apply. The engine
// supplies the scope list + a build(kind, scope) → statements callback and an
// onApply(statements) sink (managers queue into their Pending changes).

export interface GrantLevel {
  kind: string
  label: string
  desc: string
  /** destructive (revoke) → styled in red + confirm-ish. */
  danger?: boolean
}

/** The four standard access levels shown by the wizard. */
export const STANDARD_LEVELS: GrantLevel[] = [
  { kind: 'read-only', label: 'Read-only', desc: 'View data (SELECT)' },
  { kind: 'read-write', label: 'Read-Write', desc: 'View + insert / update / delete' },
  { kind: 'full', label: 'Full', desc: 'All privileges on the scope' },
  { kind: 'revoke-all', label: 'Revoke all', desc: 'Remove all access on the scope', danger: true },
]

/** A grouped apply: the same statements targeted at one outer scope (e.g. a
 *  PostgreSQL database — schema-grant SQL has no database qualifier, so the
 *  database is decided by which connection runs it). */
export interface GrantGroup {
  scope2: string
  statements: string[]
}

class GrantWizardStore {
  open = $state(false)
  title = $state('Grant access')
  role = $state('')
  scopeLabel = $state('Scope')
  scopes = $state<string[]>([])
  levels = $state<GrantLevel[]>(STANDARD_LEVELS)
  build = $state<(kind: string, scope: string) => string[]>(() => [])
  onApply = $state<(statements: string[]) => void>(() => {})

  // Optional outer scope dimension (PostgreSQL: databases). When set, the dialog
  // shows a second multi-select and hands the manager grouped statements (one
  // group per selected outer scope) via onApplyGrouped instead of onApply.
  scope2Label = $state<string | null>(null)
  scopes2 = $state<string[]>([])
  scope2Default = $state<string[]>([])
  onApplyGrouped = $state<((groups: GrantGroup[]) => void) | null>(null)
  // Optional: load the inner scopes (schemas) for the chosen outer scopes
  // (databases). When set, the dialog refreshes the schema list as the database
  // selection changes — schemas differ per database.
  loadScopes = $state<((scope2: string[]) => Promise<string[]>) | null>(null)

  // After a user/role is created, a manager picks this up (matching connId),
  // reloads, selects the new principal, and opens the wizard on it. `database`
  // is an optional hint (MSSQL: the database the new user lives in).
  afterCreate = $state<{ connId: string; principal: string; database?: string; tick: number } | null>(null)
  private tick = 0
  requestAfterCreate(connId: string, principal: string, database?: string) {
    this.tick += 1
    this.afterCreate = { connId, principal, database, tick: this.tick }
  }

  show(opts: {
    title: string
    role: string
    scopeLabel: string
    scopes: string[]
    levels?: GrantLevel[]
    build: (kind: string, scope: string) => string[]
    onApply: (statements: string[]) => void
    scope2Label?: string
    scopes2?: string[]
    scope2Default?: string[]
    onApplyGrouped?: (groups: GrantGroup[]) => void
    loadScopes?: (scope2: string[]) => Promise<string[]>
  }) {
    this.title = opts.title
    this.role = opts.role
    this.scopeLabel = opts.scopeLabel
    this.scopes = opts.scopes
    this.levels = opts.levels ?? STANDARD_LEVELS
    this.build = opts.build
    this.onApply = opts.onApply
    this.scope2Label = opts.scope2Label ?? null
    this.scopes2 = opts.scopes2 ?? []
    this.scope2Default = opts.scope2Default ?? []
    this.onApplyGrouped = opts.onApplyGrouped ?? null
    this.loadScopes = opts.loadScopes ?? null
    this.open = true
  }

  close() {
    this.open = false
  }
}

export const grantWizard = new GrantWizardStore()
