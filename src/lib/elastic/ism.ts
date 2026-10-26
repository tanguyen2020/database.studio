// OpenSearch Index State Management state of one index (SPEC-OPENSEARCH.md O7),
// read from `GET _plugins/_ism/explain/{index}`. Measured on OpenSearch 3.9: right
// after `_plugins/_ism/add` the explain answer still shows no policy for ~1–2 s, then
// the policy id without a state until the first ISM run (job interval, default 5 min).

export interface IsmIndexState {
  managed: boolean
  policy: string | null
  /** attached, but ISM has not run on it yet */
  pending: boolean
  enabled: boolean | null
  state: string | null
  action: string | null
  step: string | null
  stepStatus: string | null
  failed: boolean
  retries: number | null
  /** ISM's own message ("Successfully initialized policy", the failure reason…) */
  info: string | null
}

type Obj = Record<string, unknown>

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)

export function parseIsmExplain(json: unknown, index: string): IsmIndexState {
  const all = (json ?? {}) as Record<string, Obj>
  const e = (all[index] ?? Object.entries(all).find(([k, v]) => k !== 'total_managed_indices' && v && typeof v === 'object')?.[1] ?? {}) as Obj
  const policy = str(e.policy_id) ?? str(e['index.plugins.index_state_management.policy_id']) ?? str(e['index.opendistro.index_state_management.policy_id'])
  const state = str((e.state as Obj | undefined)?.name)
  const action = (e.action ?? null) as Obj | null
  const step = (e.step ?? null) as Obj | null
  const retry = (e.retry_info ?? null) as Obj | null
  const failed = action?.failed === true || retry?.failed === true || step?.step_status === 'failed'
  return {
    managed: !!policy,
    policy,
    pending: !!policy && !state,
    enabled: typeof e.enabled === 'boolean' ? e.enabled : null,
    state,
    action: str(action?.name),
    step: str(step?.name),
    stepStatus: str(step?.step_status),
    failed,
    retries: typeof retry?.consumed_retries === 'number' ? retry.consumed_retries : typeof action?.consumed_retries === 'number' ? (action.consumed_retries as number) : null,
    info: str((e.info as Obj | undefined)?.message) ?? str((e.info as Obj | undefined)?.cause),
  }
}

/** One plain sentence for the lifecycle card. */
export function ismSummary(s: IsmIndexState): string {
  if (!s.managed) return 'No ISM policy manages this index.'
  if (s.failed) return `Policy ${s.policy} failed${s.action ? ` in action “${s.action}”` : ''}${s.retries != null ? ` after ${s.retries} retries` : ''}.`
  if (s.pending) return `Policy ${s.policy} is attached. ISM starts managing the index on its next run (every few minutes).`
  if (s.enabled === false) return `Policy ${s.policy} is attached but ISM is paused for this index.`
  return `Policy ${s.policy} — in state “${s.state}”${s.action ? `, running “${s.action}”` : ''}.`
}
