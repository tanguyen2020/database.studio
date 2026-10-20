// Backup / restore jobs, run OUTSIDE the Backup & Restore dialog: the dialog
// configures one and starts it, then closes. The job is shown in its own
// progress window (BackupProgressWindow.svelte) until it ends — only Stop ends it
// early. One running job per connection (a second one is refused by the dialog).
import * as ipc from '$lib/ipc'
import { pushSample, type Sample } from '$lib/backup/progress'

export type JobStatus = 'running' | 'done' | 'failed' | 'stopped'

export interface BackupJob {
  id: string
  kind: 'backup' | 'restore'
  system: string
  /** Base connection id (no `::db` / `#tab-` suffix). */
  connId: string
  connName: string
  /** What it is about, as the user reads it: the database / keyspace / file. */
  target: string
  started: number
  ended: number | null
  progress: ipc.BackupProgress | null
  samples: Sample[]
  stopping: boolean
  /** A SQL Server RESTORE cannot be stopped safely once it starts. */
  canStop: boolean
  status: JobStatus
  outcome: ipc.BackupOutcome | null
  error: string | null
  /** For a finished backup: what "Restore from this file…" opens with. */
  restoreFrom: { path: string; database: string } | null
}

export interface JobSpec {
  kind: 'backup' | 'restore'
  system: string
  connId: string
  connName: string
  target: string
  canStop: boolean
  /** The file a backup can be restored from afterwards (null: not applicable). */
  restoreFrom?: (outcome: ipc.BackupOutcome) => { path: string; database: string } | null
  run: (jobId: string, onProgress: (p: ipc.BackupProgress) => void) => Promise<ipc.BackupOutcome>
  onDone?: (outcome: ipc.BackupOutcome) => void
  onFail?: (error: string) => void
}

/** A stopped job surfaces as an error whose message says it was cancelled. */
export function isCancelled(error: string): boolean {
  return /\bcancel/i.test(error)
}

export function newJobId(): string {
  return `bk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

class BackupJobs {
  jobs = $state<BackupJob[]>([])
  /** The job shown in the progress window (null: the window is closed). */
  shownId = $state<string | null>(null)

  get shown(): BackupJob | undefined {
    return this.shownId ? this.jobs.find((j) => j.id === this.shownId) : undefined
  }

  /** The running job of a connection, if any. */
  activeFor(connId: string): BackupJob | undefined {
    return this.jobs.find((j) => j.connId === connId && j.status === 'running')
  }

  private get(id: string): BackupJob | undefined {
    // always the proxied entry: mutating the raw object would bypass $state
    return this.jobs.find((j) => j.id === id)
  }

  start(spec: JobSpec): string {
    const id = newJobId()
    this.jobs.push({
      id,
      kind: spec.kind,
      system: spec.system,
      connId: spec.connId,
      connName: spec.connName,
      target: spec.target,
      started: Date.now(),
      ended: null,
      progress: null,
      samples: [],
      stopping: false,
      canStop: spec.canStop,
      status: 'running',
      outcome: null,
      error: null,
      restoreFrom: null,
    })
    this.shownId = id
    const onProgress = (p: ipc.BackupProgress) => {
      const j = this.get(id)
      if (!j || j.status !== 'running' || p.jobId !== id) return
      j.progress = p
      j.samples = pushSample(j.samples, { at: Date.now(), done: p.done })
    }
    void spec
      .run(id, onProgress)
      .then((outcome) => {
        const j = this.get(id)
        if (j) {
          j.status = 'done'
          j.outcome = outcome
          j.ended = Date.now()
          j.stopping = false
          j.restoreFrom = spec.restoreFrom?.(outcome) ?? null
        }
        spec.onDone?.(outcome)
      })
      .catch((e) => {
        const error = String(e)
        const j = this.get(id)
        if (j) {
          j.status = isCancelled(error) ? 'stopped' : 'failed'
          j.error = error
          j.ended = Date.now()
          j.stopping = false
        }
        spec.onFail?.(error)
      })
    return id
  }

  async stop(id: string) {
    const j = this.get(id)
    if (!j || j.status !== 'running' || j.stopping || !j.canStop) return
    j.stopping = true
    await ipc.cancelBackup(id).catch(() => {})
  }

  /** Close a finished job's window. */
  dismiss(id: string) {
    if (this.shownId === id) this.shownId = null
    this.jobs = this.jobs.filter((j) => j.id !== id || j.status === 'running')
  }
}

export const backupJobs = new BackupJobs()
