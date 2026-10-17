// Pure helpers for the Dev Tools pages (Search Profiler, Painless, grok demo).

export interface ProfileRow {
  shard: string
  depth: number
  type: string
  description: string
  nanos: number
}

interface ProfNode {
  type?: string
  description?: string
  time_in_nanos?: number
  children?: ProfNode[]
}

/** `profile` of a search response → one row per query / collector / aggregation
 *  component, depth-first, so the UI can indent and bar-chart the timings. */
export function flattenProfile(profile: unknown): ProfileRow[] {
  const out: ProfileRow[] = []
  const shards = (profile as { shards?: { id?: string; searches?: { query?: ProfNode[]; collector?: ProfNode[] }[]; aggregations?: ProfNode[] }[] })?.shards ?? []
  const walk = (shard: string, nodes: ProfNode[] | undefined, depth: number) => {
    for (const n of nodes ?? []) {
      out.push({ shard, depth, type: n.type ?? (n as { name?: string }).name ?? '?', description: n.description ?? (n as { reason?: string }).reason ?? '', nanos: Number(n.time_in_nanos ?? 0) })
      walk(shard, n.children, depth + 1)
    }
  }
  for (const s of shards) {
    const id = String(s.id ?? '').replace(/^\[([^\]]+)\]\[([^\]]+)\]\[(\d+)\]$/, '$2[$3]') || '?'
    for (const search of s.searches ?? []) {
      walk(id, search.query, 0)
      walk(id, search.collector, 0)
    }
    walk(id, s.aggregations, 0)
  }
  return out
}

/** Tiny arithmetic evaluator for the demo Painless endpoint (numbers, params.x,
 *  + - * / % and parentheses) — never `eval`. Returns null when out of scope. */
export function evalArithmetic(src: string, params: Record<string, unknown>): number | null {
  const text = src
    .replace(/\/\/.*$/gm, '')
    .replace(/\breturn\b/g, '')
    .replace(/;/g, '')
    .replace(/params\.(\w+)/g, (_, k: string) => (typeof params[k] === 'number' ? String(params[k]) : 'NaN'))
    .trim()
  if (!/^[\d\s+\-*/%().]+$/.test(text)) return null
  let i = 0
  const peek = () => text[i]
  const skip = () => {
    while (text[i] === ' ' || text[i] === '\n' || text[i] === '\t') i++
  }
  const num = (): number => {
    skip()
    if (peek() === '(') {
      i++
      const v = expr()
      skip()
      i++ // ')'
      return v
    }
    if (peek() === '-') {
      i++
      return -num()
    }
    const m = /^\d+(\.\d+)?/.exec(text.slice(i))
    if (!m) throw new Error('bad number')
    i += m[0].length
    return Number(m[0])
  }
  const term = (): number => {
    let v = num()
    for (;;) {
      skip()
      const c = peek()
      if (c !== '*' && c !== '/' && c !== '%') return v
      i++
      const r = num()
      v = c === '*' ? v * r : c === '/' ? v / r : v % r
    }
  }
  const expr = (): number => {
    let v = term()
    for (;;) {
      skip()
      const c = peek()
      if (c !== '+' && c !== '-') return v
      i++
      const r = term()
      v = c === '+' ? v + r : v - r
    }
  }
  try {
    const v = expr()
    skip()
    return i === text.length && Number.isFinite(v) ? v : null
  } catch {
    return null
  }
}

/** Grok subset for the demo cluster: the common built-in patterns → named regex groups. */
export const GROK_BUILTINS: Record<string, string> = {
  WORD: '\\b\\w+\\b',
  NUMBER: '[+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)',
  INT: '[+-]?\\d+',
  IP: '\\d{1,3}(?:\\.\\d{1,3}){3}',
  IPV4: '\\d{1,3}(?:\\.\\d{1,3}){3}',
  URIPATH: '/[^\\s?#]*',
  URIPATHPARAM: '/[^\\s#]*',
  DATA: '.*?',
  GREEDYDATA: '.*',
  NOTSPACE: '\\S+',
  SPACE: '\\s*',
  LOGLEVEL: '(?:TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)',
  TIMESTAMP_ISO8601: '\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?',
  HOSTNAME: '[a-zA-Z0-9][a-zA-Z0-9.-]*',
  EMAILADDRESS: '[^\\s@]+@[^\\s@]+',
  QS: '"[^"]*"',
}

/** Apply a grok pattern (demo subset) → extracted fields, or null when it does not match. */
export function grokMatch(pattern: string, text: string, custom: Record<string, string> = {}): Record<string, string> | null {
  const defs = { ...GROK_BUILTINS, ...custom }
  const names: string[] = []
  let depth = 0
  const expand = (p: string): string =>
    p.replace(/%\{(\w+)(?::([\w.@]+))?\}/g, (_, name: string, field?: string) => {
      const def = defs[name]
      if (def == null) throw new Error(`Unable to find pattern [${name}] in Grok's pattern dictionary`)
      if (++depth > 50) throw new Error('grok pattern recursion')
      const inner = expand(def)
      if (!field) return `(?:${inner})`
      names.push(field)
      return `(?<g${names.length - 1}>${inner})`
    })
  const re = new RegExp(`^${expand(pattern)}$`)
  const m = re.exec(text)
  if (!m) return null
  return Object.fromEntries(names.map((n, i) => [n, m.groups?.[`g${i}`] ?? '']))
}
