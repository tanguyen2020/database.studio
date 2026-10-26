// Elasticsearch or OpenSearch behind an Elasticsearch-engine connection
// (SPEC-OPENSEARCH.md). Every screen of the workspace asks here which product it is
// talking to, so the words, the query languages and the management pages follow the
// server — never a hard-coded "Elasticsearch".
import { connections } from '$lib/stores/connections.svelte'
import { isOpenSearch } from '$lib/brand'

export type SearchFlavor = 'elasticsearch' | 'opensearch'

export interface SearchProduct {
  flavor: SearchFlavor
  os: boolean
  /** "OpenSearch" / "Elasticsearch" */
  name: string
  /** the companion UI people know the features from */
  dashboards: string
  /** Discover's query language: DQL (OpenSearch Dashboards) / KQL (Kibana) — same syntax */
  queryLanguage: string
  queryLanguageLong: string
}

export function productOf(flavor: SearchFlavor): SearchProduct {
  const os = flavor === 'opensearch'
  return {
    flavor,
    os,
    name: os ? 'OpenSearch' : 'Elasticsearch',
    dashboards: os ? 'OpenSearch Dashboards' : 'Kibana',
    queryLanguage: os ? 'DQL' : 'KQL',
    queryLanguageLong: os ? 'Dashboards Query Language' : 'Kibana Query Language',
  }
}

/** The product of a connection id (derived ids `{base}#tab-…` / `{base}::…` included). */
export function searchProduct(connId: string | null | undefined): SearchProduct {
  return productOf(isOpenSearch(connections.byId(connId ?? '')) ? 'opensearch' : 'elasticsearch')
}

// ---- query languages (SPEC-OPENSEARCH.md O3–O5) -------------------------------

/** Elasticsearch: ES|QL + SQL. OpenSearch: PPL + SQL (no ES|QL). */
export type QueryLanguage = 'esql' | 'sql' | 'ppl'

export function queryLanguages(flavor: SearchFlavor): QueryLanguage[] {
  return flavor === 'opensearch' ? ['ppl', 'sql'] : ['esql', 'sql']
}

/** The piped language of the product — the one a new query tab starts with. */
export function pipedLanguage(flavor: SearchFlavor): QueryLanguage {
  return flavor === 'opensearch' ? 'ppl' : 'esql'
}

/** A language saved on a tab may not exist on this server (ES|QL on OpenSearch). */
export function languageFor(flavor: SearchFlavor, saved: QueryLanguage | undefined): QueryLanguage {
  return saved && queryLanguages(flavor).includes(saved) ? saved : pipedLanguage(flavor)
}

export const LANGUAGE_LABEL: Record<QueryLanguage, string> = { esql: 'ES|QL', sql: 'SQL', ppl: 'PPL' }

export const LANGUAGE_HELP: Record<QueryLanguage, string> = {
  esql: 'Piped query language — FROM, WHERE, EVAL, STATS … BY, KEEP, SORT, LIMIT.',
  ppl: 'Piped Processing Language — source=, where, eval, stats … by, fields, sort, head.',
  sql: 'SQL over indices — SELECT … FROM index WHERE … GROUP BY … ORDER BY … LIMIT.',
}

export const LANGUAGE_EXAMPLES: Record<QueryLanguage, { label: string; query: string }[]> = {
  esql: [],
  sql: [],
  ppl: [
    { label: 'First rows', query: 'source = {index} | head 20' },
    { label: 'Count by field', query: 'source = {index} | stats count() by {field}' },
    { label: 'Filter and pick fields', query: "source = {index} | where {field} != '' | fields {field} | head 50" },
    { label: 'Top values', query: 'source = {index} | top 10 {field}' },
  ],
}
