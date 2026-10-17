// Stack Management resources — one config per kind, rendered by EsManageView
// (list on the left, JSON editor + actions on the right). Each kind is the REST
// surface Kibana's management pages use; the request shapes are exercised against
// a real cluster by src-tauri/tests/elasticsearch_integration.rs.

import { seg } from './api'

export interface ResourceRow {
  name: string
  /** short secondary text in the list */
  meta?: string
  /** small pills (e.g. "managed", "hidden", status) */
  badges?: string[]
  /** the definition shown in the editor (when the list already carries it) */
  body?: unknown
}

export interface ResourceAction {
  key: string
  label: string
  /** confirm text — present for destructive / heavy actions */
  confirm?: string
  method: string
  path: (name: string) => string
  /** request body; may use the edited definition */
  body?: (name: string, def: unknown) => unknown
  /** show the response in the result panel (simulate, explain, preview…) */
  showResult?: boolean
}

export interface ResourceKind {
  key: string
  label: string
  singular: string
  /** one-line description at the top of the page */
  blurb: string
  listPath: string
  parseList: (json: unknown) => ResourceRow[]
  /** GET one definition (when the list does not carry it) */
  getPath?: (name: string) => string
  /** extract the editable definition from GET one / the list row */
  pickBody?: (json: unknown, name: string) => unknown
  /** PUT/POST to create or update; absent = read-only kind */
  savePath?: (name: string) => string
  saveMethod?: string
  /** create without a body (data streams) */
  saveNoBody?: boolean
  deletePath?: (name: string) => string
  /** body proposed when creating a new one */
  template?: (name: string) => unknown
  actions?: ResourceAction[]
  /** name rules / hint for the "New" dialog */
  namePlaceholder?: string
  /** license / feature hint when the cluster refuses the list */
  requires?: string
}

const objEntries = (j: unknown): [string, Record<string, unknown>][] =>
  Object.entries((j ?? {}) as Record<string, Record<string, unknown>>)

const hiddenBadge = (name: string, meta?: Record<string, unknown>) => {
  const b: string[] = []
  if (name.startsWith('.')) b.push('hidden')
  if ((meta as { managed?: boolean } | undefined)?.managed) b.push('managed')
  return b
}

export const RESOURCE_KINDS: ResourceKind[] = [
  {
    key: 'index-templates',
    label: 'Index templates',
    singular: 'index template',
    blurb: 'Settings, mappings and aliases applied automatically to new indices and data streams whose name matches a pattern.',
    listPath: '/_index_template',
    parseList: (j) =>
      ((j as { index_templates?: { name: string; index_template: Record<string, unknown> }[] }).index_templates ?? []).map((t) => ({
        name: t.name,
        meta: ((t.index_template.index_patterns as string[]) ?? []).join(', '),
        badges: [
          ...(t.index_template.data_stream ? ['data stream'] : []),
          ...hiddenBadge(t.name, t.index_template._meta as Record<string, unknown>),
        ],
        body: t.index_template,
      })),
    savePath: (n) => `/_index_template/${seg(n)}`,
    saveMethod: 'PUT',
    deletePath: (n) => `/_index_template/${seg(n)}`,
    template: (n) => ({
      index_patterns: [`${n}-*`],
      priority: 100,
      template: {
        settings: { number_of_shards: 1, number_of_replicas: 1 },
        mappings: { properties: { '@timestamp': { type: 'date' } } },
        aliases: {},
      },
      composed_of: [],
    }),
    actions: [
      {
        key: 'simulate',
        label: 'Preview',
        method: 'POST',
        path: (n) => `/_index_template/_simulate/${seg(n)}`,
        showResult: true,
      },
    ],
  },
  {
    key: 'component-templates',
    label: 'Component templates',
    singular: 'component template',
    blurb: 'Reusable building blocks (settings, mappings, aliases) that index templates compose.',
    listPath: '/_component_template',
    parseList: (j) =>
      ((j as { component_templates?: { name: string; component_template: Record<string, unknown> }[] }).component_templates ?? []).map(
        (t) => ({
          name: t.name,
          meta: Object.keys((t.component_template.template as Record<string, unknown>) ?? {}).join(' · '),
          badges: hiddenBadge(t.name, t.component_template._meta as Record<string, unknown>),
          body: t.component_template,
        }),
      ),
    savePath: (n) => `/_component_template/${seg(n)}`,
    saveMethod: 'PUT',
    deletePath: (n) => `/_component_template/${seg(n)}`,
    template: () => ({ template: { settings: {}, mappings: { properties: {} } }, _meta: { description: '' } }),
  },
  {
    key: 'pipelines',
    label: 'Ingest pipelines',
    singular: 'pipeline',
    blurb: 'Processors that transform documents before they are indexed (parse, enrich, rename, drop…). Test them with Simulate.',
    listPath: '/_ingest/pipeline',
    parseList: (j) =>
      objEntries(j).map(([name, p]) => ({
        name,
        meta: (p.description as string) || `${((p.processors as unknown[]) ?? []).length} processors`,
        badges: hiddenBadge(name, p._meta as Record<string, unknown>),
        body: p,
      })),
    savePath: (n) => `/_ingest/pipeline/${seg(n)}`,
    saveMethod: 'PUT',
    deletePath: (n) => `/_ingest/pipeline/${seg(n)}`,
    template: () => ({
      description: '',
      processors: [{ set: { field: 'ingested_at', value: '{{_ingest.timestamp}}' } }],
    }),
    actions: [
      {
        key: 'simulate',
        label: 'Simulate',
        method: 'POST',
        path: () => '/_ingest/pipeline/_simulate?verbose=true',
        body: (_n, def) => ({ pipeline: def, docs: [{ _source: { message: 'Hello world', status: 'paid' } }] }),
        showResult: true,
      },
    ],
  },
  {
    key: 'ilm',
    label: 'Index lifecycle policies',
    singular: 'lifecycle policy',
    blurb: 'Hot → warm → cold → frozen → delete: when to roll over, shrink, move and delete indices.',
    listPath: '/_ilm/policy',
    parseList: (j) =>
      objEntries(j).map(([name, p]) => {
        const phases = Object.keys(((p.policy as Record<string, unknown>)?.phases as Record<string, unknown>) ?? {})
        const usedBy = ((p.in_use_by as { indices?: string[] })?.indices ?? []).length
        return {
          name,
          meta: `${phases.join(' → ') || 'no phases'}${usedBy ? ` · ${usedBy} indices` : ''}`,
          badges: hiddenBadge(name, (p.policy as { _meta?: Record<string, unknown> })?._meta),
          body: { policy: p.policy },
        }
      }),
    savePath: (n) => `/_ilm/policy/${seg(n)}`,
    saveMethod: 'PUT',
    deletePath: (n) => `/_ilm/policy/${seg(n)}`,
    template: () => ({
      policy: {
        phases: {
          hot: { min_age: '0ms', actions: { rollover: { max_age: '30d', max_primary_shard_size: '50gb' } } },
          delete: { min_age: '90d', actions: { delete: {} } },
        },
      },
    }),
  },
  {
    key: 'data-streams',
    label: 'Data streams',
    singular: 'data stream',
    blurb: 'Append-only time series (logs, metrics, events) backed by rolling hidden indices. Needs a matching index template with "data_stream": {}.',
    listPath: '/_data_stream',
    parseList: (j) =>
      ((j as { data_streams?: Record<string, unknown>[] }).data_streams ?? []).map((d) => ({
        name: d.name as string,
        meta: `${((d.indices as unknown[]) ?? []).length} backing indices · gen ${d.generation ?? '—'}`,
        badges: [String(d.status ?? '').toLowerCase(), ...(d.hidden ? ['hidden'] : [])].filter(Boolean),
        body: d,
      })),
    savePath: (n) => `/_data_stream/${seg(n)}`,
    saveMethod: 'PUT',
    saveNoBody: true,
    deletePath: (n) => `/_data_stream/${seg(n)}`,
    actions: [
      { key: 'rollover', label: 'Roll over', method: 'POST', path: (n) => `/${seg(n)}/_rollover`, showResult: true },
      { key: 'stats', label: 'Stats', method: 'GET', path: (n) => `/_data_stream/${seg(n)}/_stats?human=true`, showResult: true },
    ],
    namePlaceholder: 'logs-myapp-default',
  },
  {
    key: 'snapshot-repos',
    label: 'Snapshot repositories',
    singular: 'repository',
    blurb: 'Where snapshots are stored (shared file system, S3, GCS, Azure…). Verify a repository, then take and restore snapshots.',
    listPath: '/_snapshot',
    parseList: (j) =>
      objEntries(j).map(([name, r]) => ({
        name,
        meta: `${r.type ?? ''}${(r.settings as { location?: string })?.location ? ` · ${(r.settings as { location?: string }).location}` : ''}`,
        body: r,
      })),
    savePath: (n) => `/_snapshot/${seg(n)}`,
    saveMethod: 'PUT',
    deletePath: (n) => `/_snapshot/${seg(n)}`,
    template: (n) => ({ type: 'fs', settings: { location: n, compress: true } }),
    actions: [
      { key: 'verify', label: 'Verify', method: 'POST', path: (n) => `/_snapshot/${seg(n)}/_verify`, showResult: true },
      { key: 'cleanup', label: 'Clean up', method: 'POST', path: (n) => `/_snapshot/${seg(n)}/_cleanup`, showResult: true },
    ],
    requires: 'path.repo must list the location for a shared file system repository.',
  },
  {
    key: 'slm',
    label: 'Snapshot lifecycle policies',
    singular: 'SLM policy',
    blurb: 'Take snapshots on a schedule and expire the old ones automatically.',
    listPath: '/_slm/policy',
    parseList: (j) =>
      objEntries(j).map(([name, p]) => {
        const pol = p.policy as Record<string, unknown>
        return { name, meta: `${pol?.schedule ?? ''} → ${pol?.repository ?? ''}`, body: pol }
      }),
    savePath: (n) => `/_slm/policy/${seg(n)}`,
    saveMethod: 'PUT',
    deletePath: (n) => `/_slm/policy/${seg(n)}`,
    template: () => ({
      schedule: '0 30 1 * * ?',
      name: '<nightly-snap-{now/d}>',
      repository: '',
      config: { indices: ['*'], include_global_state: false },
      retention: { expire_after: '30d', min_count: 5, max_count: 50 },
    }),
    actions: [{ key: 'execute', label: 'Run now', method: 'POST', path: (n) => `/_slm/policy/${seg(n)}/_execute`, showResult: true }],
  },
  {
    key: 'scripts',
    label: 'Stored scripts & search templates',
    singular: 'stored script',
    blurb: 'Painless scripts and mustache search templates stored in the cluster, referenced by id.',
    listPath: '/_cluster/state/metadata?filter_path=metadata.stored_scripts',
    parseList: (j) =>
      objEntries((j as { metadata?: { stored_scripts?: unknown } })?.metadata?.stored_scripts).map(([name, s]) => ({
        name,
        meta: String(s.lang ?? ''),
        body: { script: s },
      })),
    savePath: (n) => `/_scripts/${seg(n)}`,
    saveMethod: 'PUT',
    deletePath: (n) => `/_scripts/${seg(n)}`,
    template: () => ({ script: { lang: 'mustache', source: { query: { match: { '{{field}}': '{{value}}' } } } } }),
  },
  {
    key: 'enrich',
    label: 'Enrich policies',
    singular: 'enrich policy',
    blurb: 'Lookup data copied from a source index and joined into documents by an ingest pipeline.',
    listPath: '/_enrich/policy',
    parseList: (j) =>
      ((j as { policies?: { config: Record<string, Record<string, unknown>> }[] }).policies ?? []).map((p) => {
        const [type, cfg] = Object.entries(p.config)[0] ?? ['', {}]
        return { name: String(cfg.name ?? ''), meta: `${type} · ${((cfg.indices as string[]) ?? []).join(', ')}`, body: { [type]: cfg } }
      }),
    savePath: (n) => `/_enrich/policy/${seg(n)}`,
    saveMethod: 'PUT',
    deletePath: (n) => `/_enrich/policy/${seg(n)}`,
    template: () => ({ match: { indices: [''], match_field: '', enrich_fields: [] } }),
    actions: [{ key: 'execute', label: 'Execute', method: 'PUT', path: (n) => `/_enrich/policy/${seg(n)}/_execute`, showResult: true }],
  },
  {
    key: 'transforms',
    label: 'Transforms',
    singular: 'transform',
    blurb: 'Pivot or keep the latest document per entity into a summary index, continuously or once.',
    listPath: '/_transform?size=1000',
    parseList: (j) =>
      ((j as { transforms?: Record<string, unknown>[] }).transforms ?? []).map((t) => ({
        name: t.id as string,
        meta: `${((t.source as { index?: string[] })?.index ?? []).join(', ')} → ${(t.dest as { index?: string })?.index ?? ''}`,
        body: Object.fromEntries(
          Object.entries(t).filter(([k]) => !['id', 'version', 'create_time', 'authorization'].includes(k)),
        ),
      })),
    savePath: (n) => `/_transform/${seg(n)}`,
    saveMethod: 'PUT',
    deletePath: (n) => `/_transform/${seg(n)}?force=true`,
    template: () => ({
      source: { index: [''] },
      dest: { index: '' },
      pivot: { group_by: { key: { terms: { field: '' } } }, aggregations: { count: { value_count: { field: '_id' } } } },
    }),
    actions: [
      { key: 'start', label: 'Start', method: 'POST', path: (n) => `/_transform/${seg(n)}/_start`, showResult: true },
      { key: 'stop', label: 'Stop', method: 'POST', path: (n) => `/_transform/${seg(n)}/_stop`, showResult: true },
      { key: 'stats', label: 'Stats', method: 'GET', path: (n) => `/_transform/${seg(n)}/_stats`, showResult: true },
      { key: 'preview', label: 'Preview', method: 'POST', path: () => '/_transform/_preview', body: (_n, d) => d, showResult: true },
    ],
  },
  {
    key: 'watches',
    label: 'Watcher',
    singular: 'watch',
    blurb: 'Alerting: run a search on a schedule and act (email, webhook, index…) when a condition is met.',
    listPath: '/_watcher/_query/watches',
    parseList: (j) =>
      ((j as { watches?: { _id: string; watch?: Record<string, unknown>; status?: { state?: { active?: boolean } } }[] }).watches ?? []).map(
        (w) => ({ name: w._id, meta: w.status?.state?.active === false ? 'inactive' : 'active', body: w.watch }),
      ),
    getPath: (n) => `/_watcher/watch/${seg(n)}`,
    pickBody: (j) => (j as { watch?: unknown }).watch,
    savePath: (n) => `/_watcher/watch/${seg(n)}`,
    saveMethod: 'PUT',
    deletePath: (n) => `/_watcher/watch/${seg(n)}`,
    template: () => ({
      trigger: { schedule: { interval: '10m' } },
      input: { search: { request: { indices: [''], body: { query: { match_all: {} } } } } },
      condition: { compare: { 'ctx.payload.hits.total': { gt: 0 } } },
      actions: { log: { logging: { text: 'Found {{ctx.payload.hits.total}} hits' } } },
    }),
    actions: [
      { key: 'execute', label: 'Execute', method: 'POST', path: (n) => `/_watcher/watch/${seg(n)}/_execute`, showResult: true },
      { key: 'activate', label: 'Activate', method: 'PUT', path: (n) => `/_watcher/watch/${seg(n)}/_activate`, showResult: true },
      { key: 'deactivate', label: 'Deactivate', method: 'PUT', path: (n) => `/_watcher/watch/${seg(n)}/_deactivate`, showResult: true },
    ],
    requires: 'Watcher needs a Gold (or trial) license.',
  },
]

export function resourceKind(key: string): ResourceKind | undefined {
  return RESOURCE_KINDS.find((k) => k.key === key)
}
