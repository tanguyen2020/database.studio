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

class GrantWizardStore {
  open = $state(false)
  title = $state('Grant access')
  role = $state('')
  scopeLabel = $state('Scope')
  scopes = $state<string[]>([])
  levels = $state<GrantLevel[]>(STANDARD_LEVELS)
  build = $state<(kind: string, scope: string) => string[]>(() => [])
  onApply = $state<(statements: string[]) => void>(() => {})

  show(opts: {
    title: string
    role: string
    scopeLabel: string
    scopes: string[]
    levels?: GrantLevel[]
    build: (kind: string, scope: string) => string[]
    onApply: (statements: string[]) => void
  }) {
    this.title = opts.title
    this.role = opts.role
    this.scopeLabel = opts.scopeLabel
    this.scopes = opts.scopes
    this.levels = opts.levels ?? STANDARD_LEVELS
    this.build = opts.build
    this.onApply = opts.onApply
    this.open = true
  }

  close() {
    this.open = false
  }
}

export const grantWizard = new GrantWizardStore()
