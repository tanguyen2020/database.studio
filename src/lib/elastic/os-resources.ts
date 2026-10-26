// OpenSearch management pages (SPEC-OPENSEARCH.md §2) — the same shape as the
// Elasticsearch Stack Management kinds (resources.ts) and rendered by the same
// EsManageView, but on the APIs OpenSearch really has: ISM instead of ILM, Snapshot
// Management instead of SLM, the Index Management plugin's transforms and rollups,
// Alerting monitors instead of Watcher. Every request here was measured on
// OpenSearch 3.9 and is replayed against a real cluster by
// src-tauri/tests/opensearch_integration.rs.

import { seg } from './api'
import { RESOURCE_KINDS, type ResourceKind, type ResourceRow } from './resources'

type Obj = Record<string, unknown>

const shared = (key: string): ResourceKind => {
  const k = RESOURCE_KINDS.find((x) => x.key === key)
  if (!k) throw new Error(`unknown kind ${key}`)
  return k
}

/** `{_seq_no, _primary_term}` of a GET-one answer — needed to update (O14). */
export function seqOf(j: unknown): { seq: number; term: number } | null {
  const o = (j ?? {}) as { _seq_no?: number; _primary_term?: number }
  return typeof o._seq_no === 'number' && typeof o._primary_term === 'number' ? { seq: o._seq_no, term: o._primary_term } : null
}

/** Drop the fields the server writes itself; sending them back is noise in the editor. */
export function strip(o: unknown, keys: string[]): Obj {
  return Object.fromEntries(Object.entries((o ?? {}) as Obj).filter(([k, v]) => !keys.includes(k) && v !== null))
}

const systemBadge = (name: string) => (name.startsWith('.') ? ['hidden'] : [])

function schedule(s: unknown): string {
  const sc = (s ?? {}) as { interval?: { period?: number; unit?: string }; cron?: { expression?: string } }
  if (sc.interval?.period) return `every ${sc.interval.period} ${String(sc.interval.unit ?? '').toLowerCase()}`
  if (sc.cron?.expression) return `cron ${sc.cron.expression}`
  return ''
}

const ISM_READONLY = ['policy_id', 'last_updated_time', 'schema_version']
const TRANSFORM_READONLY = ['transform_id', 'schema_version', 'metadata_id', 'updated_at', 'enabled_at', 'user', 'roles']
const ROLLUP_READONLY = ['rollup_id', 'schema_version', 'metadata_id', 'last_updated_time', 'enabled_time', 'user', 'roles']
const SM_READONLY = ['name', 'schema_version', 'last_updated_time', 'enabled_time', 'schedule', 'user']
const MONITOR_READONLY = ['schema_version', 'last_update_time', 'enabled_time', 'user', 'owner']

export const OS_RESOURCE_KINDS: ResourceKind[] = [
  shared('index-templates'),
  shared('component-templates'),
  // `GET _ingest/pipeline` answers 404 {} while no pipeline exists (measured)
  { ...shared('pipelines'), emptyOn404: true },
  {
    key: 'ism',
    label: 'Index State Management policies',
    singular: 'ISM policy',
    blurb: 'States and transitions an index moves through — roll over, force merge, move to warm, snapshot, delete — and which new indices get the policy automatically.',
    listPath: '/_plugins/_ism/policies?size=1000',
    emptyOn404: true,
    parseList: (j) =>
      ((j as { policies?: { _id: string; policy: Obj }[] }).policies ?? []).map((p): ResourceRow => {
        const states = ((p.policy.states as { name: string }[]) ?? []).map((s) => s.name)
        const auto = ((p.policy.ism_template as { index_patterns?: string[] }[] | null) ?? []).flatMap((t) => t.index_patterns ?? [])
        return {
          name: p._id,
          meta: `${states.join(' → ') || 'no states'}${auto.length ? ` · applies to ${auto.join(', ')}` : ''}`,
          badges: systemBadge(p._id),
          body: { policy: strip(p.policy, ISM_READONLY) },
        }
      }),
    getPath: (n) => `/_plugins/_ism/policies/${seg(n)}`,
    pickBody: (j) => ({ policy: strip((j as { policy?: unknown }).policy, ISM_READONLY) }),
    concurrency: seqOf,
    savePath: (n) => `/_plugins/_ism/policies/${seg(n)}`,
    saveMethod: 'PUT',
    deletePath: (n) => `/_plugins/_ism/policies/${seg(n)}`,
    template: (n) => ({
      policy: {
        description: 'Roll over hot indices daily, delete them after 30 days',
        default_state: 'hot',
        states: [
          {
            name: 'hot',
            actions: [{ rollover: { min_index_age: '1d', min_primary_shard_size: '30gb' } }],
            transitions: [{ state_name: 'delete', conditions: { min_index_age: '30d' } }],
          },
          { name: 'delete', actions: [{ delete: {} }], transitions: [] },
        ],
        ism_template: [{ index_patterns: [`${n}-*`], priority: 100 }],
      },
    }),
    editorHelp: 'States run their actions in order, then follow the first transition whose condition is met. ism_template attaches the policy to new indices that match.',
  },
  shared('data-streams'),
  shared('snapshot-repos'),
  {
    key: 'sm',
    label: 'Snapshot policies',
    singular: 'snapshot policy',
    blurb: 'Snapshot Management: take snapshots on a cron schedule and delete the old ones by age or count.',
    listPath: '/_plugins/_sm/policies?size=1000',
    emptyOn404: true,
    parseList: (j) =>
      ((j as { policies?: { _id: string; sm_policy: Obj }[] }).policies ?? []).map((p): ResourceRow => {
        const pol = p.sm_policy
        const cron = ((pol.creation as Obj)?.schedule as { cron?: { expression?: string } })?.cron?.expression ?? ''
        const repo = (pol.snapshot_config as { repository?: string })?.repository ?? ''
        return {
          name: String(pol.name ?? p._id),
          meta: `${cron}${repo ? ` → ${repo}` : ''}`,
          badges: pol.enabled === false ? ['stopped'] : [],
          body: strip(pol, SM_READONLY),
        }
      }),
    getPath: (n) => `/_plugins/_sm/policies/${seg(n)}`,
    pickBody: (j) => strip((j as { sm_policy?: unknown }).sm_policy, SM_READONLY),
    concurrency: seqOf,
    createMethod: 'POST',
    createPath: (n) => `/_plugins/_sm/policies/${seg(n)}`,
    savePath: (n) => `/_plugins/_sm/policies/${seg(n)}`,
    saveMethod: 'PUT',
    deletePath: (n) => `/_plugins/_sm/policies/${seg(n)}`,
    template: () => ({
      description: 'Nightly snapshot of every index, keep the last 7',
      creation: { schedule: { cron: { expression: '0 1 * * *', timezone: 'UTC' } } },
      deletion: { schedule: { cron: { expression: '0 2 * * *', timezone: 'UTC' } }, condition: { max_count: 7, min_count: 1 } },
      snapshot_config: { repository: '', indices: '*', include_global_state: false, date_format: 'yyyy-MM-dd-HH:mm' },
    }),
    actions: [
      { key: 'start', label: 'Start', method: 'POST', path: (n) => `/_plugins/_sm/policies/${seg(n)}/_start`, showResult: true },
      { key: 'stop', label: 'Stop', method: 'POST', path: (n) => `/_plugins/_sm/policies/${seg(n)}/_stop`, showResult: true },
      { key: 'explain', label: 'Status', method: 'GET', path: (n) => `/_plugins/_sm/policies/${seg(n)}/_explain`, showResult: true },
    ],
    requires: 'The repository named in snapshot_config must exist.',
  },
  shared('scripts'),
  {
    key: 'transforms',
    label: 'Transforms',
    singular: 'transform',
    blurb: 'Summarise an index into a new one — group by fields and compute aggregations — on a schedule.',
    listPath: '/_plugins/_transform?size=1000',
    emptyOn404: true,
    parseList: (j) =>
      ((j as { transforms?: { _id: string; transform: Obj }[] }).transforms ?? []).map(
        (t): ResourceRow => ({
          name: t._id,
          meta: `${t.transform.source_index ?? ''} → ${t.transform.target_index ?? ''}${schedule(t.transform.schedule) ? ` · ${schedule(t.transform.schedule)}` : ''}`,
          badges: t.transform.enabled ? ['enabled'] : ['disabled'],
          body: { transform: strip(t.transform, TRANSFORM_READONLY) },
        }),
      ),
    getPath: (n) => `/_plugins/_transform/${seg(n)}`,
    pickBody: (j) => ({ transform: strip((j as { transform?: unknown }).transform, TRANSFORM_READONLY) }),
    concurrency: seqOf,
    savePath: (n) => `/_plugins/_transform/${seg(n)}`,
    saveMethod: 'PUT',
    deletePath: (n) => `/_plugins/_transform/${seg(n)}`,
    template: (n) => ({
      transform: {
        enabled: false,
        continuous: false,
        description: '',
        schedule: { interval: { period: 1, unit: 'Hours', start_time: Math.floor(Date.now() / 1000) } },
        source_index: '',
        target_index: `${n}-summary`,
        data_selection_query: { match_all: {} },
        page_size: 1000,
        groups: [{ terms: { source_field: '', target_field: '' } }],
        aggregations: { count: { value_count: { field: '_id' } } },
      },
    }),
    actions: [
      { key: 'start', label: 'Start', method: 'POST', path: (n) => `/_plugins/_transform/${seg(n)}/_start`, showResult: true },
      { key: 'stop', label: 'Stop', method: 'POST', path: (n) => `/_plugins/_transform/${seg(n)}/_stop`, showResult: true },
      { key: 'stats', label: 'Status', method: 'GET', path: (n) => `/_plugins/_transform/${seg(n)}/_explain`, showResult: true },
      { key: 'preview', label: 'Preview', method: 'POST', path: () => '/_plugins/_transform/_preview', body: (_n, d) => d, showResult: true },
    ],
  },
  {
    key: 'rollups',
    label: 'Rollups',
    singular: 'rollup job',
    blurb: 'Keep old time-series data small: pre-aggregate it per time bucket into a rollup index you can still search.',
    listPath: '/_plugins/_rollup/jobs?size=1000',
    emptyOn404: true,
    parseList: (j) =>
      ((j as { rollups?: { _id: string; rollup: Obj }[] }).rollups ?? []).map(
        (r): ResourceRow => ({
          name: r._id,
          meta: `${r.rollup.source_index ?? ''} → ${r.rollup.target_index ?? ''}${schedule(r.rollup.schedule) ? ` · ${schedule(r.rollup.schedule)}` : ''}`,
          badges: r.rollup.enabled ? ['enabled'] : ['disabled'],
          body: { rollup: strip(r.rollup, ROLLUP_READONLY) },
        }),
      ),
    getPath: (n) => `/_plugins/_rollup/jobs/${seg(n)}`,
    pickBody: (j) => ({ rollup: strip((j as { rollup?: unknown }).rollup, ROLLUP_READONLY) }),
    concurrency: seqOf,
    savePath: (n) => `/_plugins/_rollup/jobs/${seg(n)}`,
    saveMethod: 'PUT',
    deletePath: (n) => `/_plugins/_rollup/jobs/${seg(n)}`,
    template: (n) => ({
      rollup: {
        enabled: false,
        continuous: false,
        description: '',
        schedule: { interval: { period: 1, unit: 'Days', start_time: Math.floor(Date.now() / 1000) } },
        source_index: '',
        target_index: `${n}-rollup`,
        page_size: 1000,
        delay: 0,
        dimensions: [{ date_histogram: { source_field: '@timestamp', fixed_interval: '1h' } }],
        metrics: [{ source_field: '', metrics: [{ avg: {} }, { min: {} }, { max: {} }, { sum: {} }, { value_count: {} }] }],
      },
    }),
    actions: [
      { key: 'start', label: 'Start', method: 'POST', path: (n) => `/_plugins/_rollup/jobs/${seg(n)}/_start`, showResult: true },
      { key: 'stop', label: 'Stop', method: 'POST', path: (n) => `/_plugins/_rollup/jobs/${seg(n)}/_stop`, showResult: true },
      { key: 'stats', label: 'Status', method: 'GET', path: (n) => `/_plugins/_rollup/jobs/${seg(n)}/_explain`, showResult: true },
    ],
  },
  {
    key: 'monitors',
    label: 'Alerting monitors',
    singular: 'monitor',
    blurb: 'Run a query on a schedule and raise an alert (and send notifications) when a trigger condition is met.',
    listPath: '/_plugins/_alerting/monitors/_search',
    listMethod: 'POST',
    listBody: { size: 1000, query: { match_all: {} } },
    emptyOn404: true,
    parseList: (j) =>
      ((j as { hits?: { hits?: { _id: string; _source: Obj }[] } }).hits?.hits ?? [])
        // the config index also holds workflows / alert documents
        .filter((h) => h._source?.type === 'monitor')
        .map(
          (h): ResourceRow => ({
            name: String(h._source.name ?? h._id),
            id: h._id,
            meta: `${String(h._source.monitor_type ?? '').replace(/_/g, ' ')}${schedule(h._source.schedule) ? ` · ${schedule(h._source.schedule)}` : ''}`,
            badges: h._source.enabled ? ['enabled'] : ['disabled'],
          }),
        ),
    getPath: (id) => `/_plugins/_alerting/monitors/${seg(id)}`,
    pickBody: (j) => strip((j as { monitor?: unknown }).monitor, MONITOR_READONLY),
    createMethod: 'POST',
    createPath: () => '/_plugins/_alerting/monitors',
    savePath: (id) => `/_plugins/_alerting/monitors/${seg(id)}`,
    saveMethod: 'PUT',
    deletePath: (id) => `/_plugins/_alerting/monitors/${seg(id)}`,
    template: (n) => ({
      type: 'monitor',
      name: n,
      monitor_type: 'query_level_monitor',
      enabled: false,
      schedule: { period: { interval: 5, unit: 'MINUTES' } },
      inputs: [{ search: { indices: [''], query: { size: 0, query: { range: { '@timestamp': { gte: '{{period_end}}||-5m', lte: '{{period_end}}' } } } } } }],
      triggers: [
        {
          name: 'Any hit',
          severity: '1',
          condition: { script: { source: 'ctx.results[0].hits.total.value > 0', lang: 'painless' } },
          actions: [],
        },
      ],
    }),
    actions: [
      { key: 'execute', label: 'Run now (dry run)', method: 'POST', path: (id) => `/_plugins/_alerting/monitors/${seg(id)}/_execute?dryrun=true`, showResult: true },
      { key: 'alerts', label: 'Alerts', method: 'GET', path: (id) => `/_plugins/_alerting/monitors/alerts?monitorId=${encodeURIComponent(id)}`, showResult: true },
    ],
    namePlaceholder: 'high-error-rate',
    editorHelp: 'The query runs every interval; each trigger condition is a Painless script over ctx.results. Add actions to notify a channel.',
  },
]

export function osResourceKind(key: string): ResourceKind | undefined {
  return OS_RESOURCE_KINDS.find((k) => k.key === key)
}
