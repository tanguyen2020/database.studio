// One-off generator: copies the official Elastic UI (EUI) SVGs verbatim into a TS
// module. Usage: node gen-eui-icons.cjs <svgsDir> <out.ts>
const fs = require('fs')
const path = require('path')
const [dir, out] = process.argv.slice(2)

const GLYPHS = {
  discover: 'product_discover', console: 'command_line', cluster: 'cluster', index: 'index', template: 'layers',
  component: 'puzzle_piece', pipeline: 'processor', lifecycle: 'timeline', snapshot: 'storage', stream: 'queue',
  alias: 'link', shield: 'shield', user: 'user', users: 'users', key: 'key', play: 'play', filter: 'filter',
  filterInclude: 'filter_include', filterExclude: 'filter_exclude', calendar: 'calendar', doc: 'document',
  documents: 'documents', table: 'table', json: 'code', gear: 'gear', plus: 'plus', trash: 'trash', edit: 'pencil',
  expand: 'maximize', copy: 'copy', sql: 'database', script: 'code', transform: 'pivot', watch: 'megaphone',
  enrich: 'merge', node: 'server', shard: 'shard', task: 'list_check', mapping: 'mapping', stats: 'stats',
  close: 'cross', search: 'magnify', refresh: 'refresh', chevron: 'chevron_single_right', info: 'info',
  warning: 'warning', check: 'check', download: 'download', history: 'clock_counter', wrench: 'wrench',
  curl: 'command_line', eye: 'eye', eyeSlash: 'eye_slash', lock: 'lock', sortUp: 'sort_up', sortDown: 'sort_down',
  sortable: 'sortable', fullScreen: 'full_screen', save: 'save', help: 'help', clock: 'clock', inspect: 'inspect',
  indexOpen: 'index_open', indexClose: 'index_close', indexSettings: 'index_settings', indexEdit: 'index_edit',
}
const APPS = {
  discover: 'app_discover', console: 'app_console', indexManagement: 'app_index_management', pipeline: 'app_pipeline',
  sql: 'app_sql', management: 'app_management', monitoring: 'app_monitoring', usersRoles: 'app_users_roles',
  watches: 'app_watches', devtools: 'app_devtools', searchProfiler: 'app_search_profiler', indexRollup: 'app_index_rollup',
  crossCluster: 'app_cross_cluster_replication', security: 'app_security', savedObjects: 'app_saved_objects',
}
const TOKENS = {
  text: 'token_text', string: 'token_string', keyword: 'token_keyword', number: 'token_number', date: 'token_date',
  boolean: 'token_boolean', ip: 'token_ip', geo: 'token_geo', shape: 'token_shape', nested: 'token_nested',
  object: 'token_object', flattened: 'token_flattened', binary: 'token_binary', range: 'token_range',
  histogram: 'token_histogram', vectorDense: 'token_vector_dense', vectorSparse: 'token_vector_sparse',
  semanticText: 'token_semantic_text', completion: 'token_completion_suggester', join: 'token_join',
  percolator: 'token_percolator', rankFeature: 'token_rank_feature', rankFeatures: 'token_rank_features',
  tokenCount: 'token_token_count', alias: 'token_alias', null: 'token_null', field: 'token_field',
}

function read(file) {
  const raw = fs.readFileSync(file, 'utf8')
  const vb = /viewBox="([^"]+)"/.exec(raw)[1]
  const body = raw
    .replace(/^[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '')
    .replace(/\s+/g, ' ')
    .replace(/> </g, '><')
    .trim()
  return { vb, body }
}

function block(name, map, sub = '') {
  const lines = Object.entries(map).map(([k, f]) => {
    const { vb, body } = read(path.join(dir, sub, `${f}.svg`))
    return `  ${JSON.stringify(k)}: { vb: ${JSON.stringify(vb)}, body: ${JSON.stringify(body)}, src: ${JSON.stringify(f)} },`
  })
  return `export const ${name} = {\n${lines.join('\n')}\n} as const satisfies Record<string, EuiSvg>\n`
}

const logo = read(path.join(dir, 'logo_elasticsearch.svg'))
const elastic = read(path.join(dir, 'logo_elastic.svg'))
const ts = `// GENERATED from the official Elastic UI icon set (@elastic/eui 123.1.0, dist/svgs)
// — the SVG paths are copied verbatim, not redrawn. EUI is © Elasticsearch B.V.,
// dual licensed SSPL 1.0 / Elastic License 2.0; the Elasticsearch logo is a
// trademark of Elasticsearch B.V., shown to identify Elasticsearch connections.
// Regenerate: node gen-eui-icons.cjs <eui>/dist/svgs src/lib/elastic/eui-icons.ts

export interface EuiSvg {
  /** viewBox of the original file */
  vb: string
  /** inner SVG markup of the original file */
  body: string
  /** original file name in EUI (without .svg) */
  src: string
}

/** Elasticsearch product logo (32×32). \`euiIcon__fillNegative\` is the ink part. */
export const ES_LOGO: EuiSvg = { vb: ${JSON.stringify(logo.vb)}, body: ${JSON.stringify(logo.body)}, src: 'logo_elasticsearch' }
/** Elastic company cluster mark (32×32). */
export const ELASTIC_LOGO: EuiSvg = { vb: ${JSON.stringify(elastic.vb)}, body: ${JSON.stringify(elastic.body)}, src: 'logo_elastic' }

/** 16×16 glyphs (monochrome, fill = currentColor). */
${block('EUI_GLYPHS', GLYPHS)}
/** 32×32 Kibana app icons (two-tone: \`euiIcon__fillSecondary\` is the accent). */
${block('EUI_APPS', APPS)}
/** 16×16 field-type tokens (Discover / mappings). */
${block('EUI_TOKENS', TOKENS, 'tokens')}
export type EuiGlyph = keyof typeof EUI_GLYPHS
export type EuiApp = keyof typeof EUI_APPS
export type EuiToken = keyof typeof EUI_TOKENS
`
fs.writeFileSync(out, ts)
console.log('wrote', out, ts.length)
