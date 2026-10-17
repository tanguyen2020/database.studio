// KQL (Kibana Query Language) → Elasticsearch Query DSL.
//
// The Discover query bar speaks KQL by default (like Kibana), with Lucene as the
// alternative. Supported (the KQL a developer types day to day):
//   status:paid              field match            (match)
//   customer:"Ada Lovelace"  phrase                 (match_phrase)
//   host:web-*               wildcard               (wildcard, case-insensitive)
//   tags:*                   field exists           (exists)
//   amount >= 100            range: < <= > >=       (range)
//   status:(paid or pending) value list
//   error                    free text on all fields (multi_match / query_string for *)
//   a and b · a or b · not a · ( … )               boolean logic
// Two clauses side by side with no operator are AND-ed.

export type Dsl = Record<string, unknown>

export class KqlError extends Error {
  constructor(
    message: string,
    public pos: number,
  ) {
    super(message)
  }
}

type Tok =
  | { k: 'word'; v: string; pos: number }
  | { k: 'str'; v: string; pos: number }
  | { k: 'op'; v: '(' | ')' | ':' | '<' | '<=' | '>' | '>='; pos: number }
  | { k: 'kw'; v: 'and' | 'or' | 'not'; pos: number }
  | { k: 'eof'; pos: number }

export function tokenize(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (c === '"') {
      const start = i
      let v = ''
      i++
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < src.length) {
          v += src[i + 1]
          i += 2
        } else v += src[i++]
      }
      if (i >= src.length) throw new KqlError('Unterminated quoted string', start)
      i++
      out.push({ k: 'str', v, pos: start })
      continue
    }
    if (c === '(' || c === ')' || c === ':') {
      out.push({ k: 'op', v: c, pos: i++ })
      continue
    }
    if (c === '<' || c === '>') {
      const two = src[i + 1] === '='
      out.push({ k: 'op', v: (two ? `${c}=` : c) as '<' | '<=' | '>' | '>=', pos: i })
      i += two ? 2 : 1
      continue
    }
    const start = i
    let v = ''
    while (i < src.length && !/[\s():<>"]/.test(src[i])) {
      if (src[i] === '\\' && i + 1 < src.length) {
        v += src[i + 1]
        i += 2
      } else v += src[i++]
    }
    const low = v.toLowerCase()
    if (low === 'and' || low === 'or' || low === 'not') out.push({ k: 'kw', v: low, pos: start })
    else out.push({ k: 'word', v, pos: start })
  }
  out.push({ k: 'eof', pos: src.length })
  return out
}

const isWild = (s: string) => s.includes('*')
const numOrStr = (s: string): string | number => (/^-?\d+(\.\d+)?$/.test(s) ? Number(s) : s)

class Parser {
  i = 0
  constructor(private t: Tok[]) {}
  peek() {
    return this.t[this.i]
  }
  next() {
    return this.t[this.i++]
  }
  isKw(v: string) {
    const p = this.peek()
    return p.k === 'kw' && p.v === v
  }
  isOp(v: string) {
    const p = this.peek()
    return p.k === 'op' && p.v === v
  }

  parse(): Dsl {
    if (this.peek().k === 'eof') return { match_all: {} }
    const e = this.or()
    const p = this.peek()
    if (p.k !== 'eof') throw new KqlError(`Unexpected '${'v' in p ? p.v : ''}'`, p.pos)
    return e
  }

  or(): Dsl {
    const parts = [this.and()]
    while (this.isKw('or')) {
      this.next()
      parts.push(this.and())
    }
    return parts.length === 1 ? parts[0] : { bool: { should: parts, minimum_should_match: 1 } }
  }

  and(): Dsl {
    const parts = [this.not()]
    for (;;) {
      if (this.isKw('and')) {
        this.next()
        parts.push(this.not())
        continue
      }
      const p = this.peek()
      // implicit AND: another clause starts right away
      if (p.k === 'word' || p.k === 'str' || (p.k === 'kw' && p.v === 'not') || (p.k === 'op' && p.v === '(')) {
        parts.push(this.not())
        continue
      }
      break
    }
    return parts.length === 1 ? parts[0] : { bool: { filter: parts } }
  }

  not(): Dsl {
    if (this.isKw('not')) {
      this.next()
      return { bool: { must_not: [this.not()] } }
    }
    return this.primary()
  }

  primary(): Dsl {
    const p = this.peek()
    if (p.k === 'op' && p.v === '(') {
      this.next()
      const e = this.or()
      if (!this.isOp(')')) throw new KqlError("Missing ')'", this.peek().pos)
      this.next()
      return e
    }
    if (p.k === 'str') {
      this.next()
      return { multi_match: { query: p.v, type: 'phrase', lenient: true } }
    }
    if (p.k === 'word') {
      this.next()
      const n = this.peek()
      if (n.k === 'op' && n.v === ':') {
        this.next()
        return this.fieldValue(p.v)
      }
      if (n.k === 'op' && (n.v === '<' || n.v === '<=' || n.v === '>' || n.v === '>=')) {
        this.next()
        const val = this.next()
        if (val.k !== 'word' && val.k !== 'str') throw new KqlError(`A value is expected after '${n.v}'`, val.pos)
        const key = { '<': 'lt', '<=': 'lte', '>': 'gt', '>=': 'gte' }[n.v]
        return { range: { [p.v]: { [key]: numOrStr(val.v) } } }
      }
      // free text
      if (isWild(p.v)) return { query_string: { query: p.v, analyze_wildcard: true } }
      return { multi_match: { query: p.v, type: 'best_fields', lenient: true } }
    }
    throw new KqlError(p.k === 'eof' ? 'The query ends too early' : `Unexpected '${'v' in p ? p.v : ''}'`, p.pos)
  }

  fieldValue(field: string): Dsl {
    const p = this.peek()
    if (p.k === 'op' && p.v === '(') {
      // value list: field:(a or b and c)
      this.next()
      const e = this.valueOr(field)
      if (!this.isOp(')')) throw new KqlError("Missing ')'", this.peek().pos)
      this.next()
      return e
    }
    return this.value(field)
  }

  valueOr(field: string): Dsl {
    const parts = [this.valueAnd(field)]
    while (this.isKw('or')) {
      this.next()
      parts.push(this.valueAnd(field))
    }
    return parts.length === 1 ? parts[0] : { bool: { should: parts, minimum_should_match: 1 } }
  }

  valueAnd(field: string): Dsl {
    const parts = [this.valueNot(field)]
    while (this.isKw('and')) {
      this.next()
      parts.push(this.valueNot(field))
    }
    return parts.length === 1 ? parts[0] : { bool: { filter: parts } }
  }

  valueNot(field: string): Dsl {
    if (this.isKw('not')) {
      this.next()
      return { bool: { must_not: [this.valueNot(field)] } }
    }
    if (this.isOp('(')) {
      this.next()
      const e = this.valueOr(field)
      if (!this.isOp(')')) throw new KqlError("Missing ')'", this.peek().pos)
      this.next()
      return e
    }
    return this.value(field)
  }

  value(field: string): Dsl {
    const v = this.next()
    if (v.k === 'str') return { match_phrase: { [field]: v.v } }
    if (v.k !== 'word') throw new KqlError(`A value is expected after '${field}:'`, v.pos)
    if (v.v === '*') return { exists: { field } }
    if (isWild(v.v)) return { wildcard: { [field]: { value: v.v, case_insensitive: true } } }
    return { match: { [field]: numOrStr(v.v) } }
  }
}

/** KQL text → Query DSL. Empty text = match_all. Throws KqlError on bad syntax. */
export function kqlToDsl(src: string): Dsl {
  return new Parser(tokenize(src)).parse()
}

/** Lucene query syntax goes through query_string (Kibana's "Lucene" mode). */
export function luceneToDsl(src: string): Dsl {
  const q = src.trim()
  if (!q) return { match_all: {} }
  return { query_string: { query: q, analyze_wildcard: true } }
}

export type QueryLanguage = 'kql' | 'lucene'

export interface Filter {
  field: string
  op: 'is' | 'is not' | 'exists' | 'does not exist' | 'is one of'
  value?: string
  values?: string[]
  disabled?: boolean
}

export function filterToDsl(f: Filter): { clause: Dsl; negate: boolean } {
  switch (f.op) {
    case 'is':
      return { clause: { match_phrase: { [f.field]: numOrStr(f.value ?? '') } }, negate: false }
    case 'is not':
      return { clause: { match_phrase: { [f.field]: numOrStr(f.value ?? '') } }, negate: true }
    case 'exists':
      return { clause: { exists: { field: f.field } }, negate: false }
    case 'does not exist':
      return { clause: { exists: { field: f.field } }, negate: true }
    case 'is one of':
      return {
        clause: {
          bool: {
            should: (f.values ?? []).map((v) => ({ match_phrase: { [f.field]: numOrStr(v) } })),
            minimum_should_match: 1,
          },
        },
        negate: false,
      }
  }
}

export function filterLabel(f: Filter): string {
  switch (f.op) {
    case 'is':
      return `${f.field}: ${f.value}`
    case 'is not':
      return `NOT ${f.field}: ${f.value}`
    case 'exists':
      return `${f.field}: exists`
    case 'does not exist':
      return `NOT ${f.field}: exists`
    case 'is one of':
      return `${f.field}: is one of ${(f.values ?? []).join(', ')}`
  }
}

/** The full `query` of a Discover search: query bar + filter pills + time range. */
export function buildQuery(opts: {
  text: string
  language: QueryLanguage
  filters?: Filter[]
  timeField?: string | null
  from?: string | null
  to?: string | null
}): Dsl {
  const main = opts.language === 'kql' ? kqlToDsl(opts.text) : luceneToDsl(opts.text)
  const filter: Dsl[] = []
  const mustNot: Dsl[] = []
  if (!('match_all' in main)) filter.push(main)
  for (const f of opts.filters ?? []) {
    if (f.disabled) continue
    const { clause, negate } = filterToDsl(f)
    ;(negate ? mustNot : filter).push(clause)
  }
  if (opts.timeField && (opts.from || opts.to)) {
    const r: Record<string, string> = { format: 'strict_date_optional_time' }
    if (opts.from) r.gte = opts.from
    if (opts.to) r.lte = opts.to
    filter.push({ range: { [opts.timeField]: r } })
  }
  if (!filter.length && !mustNot.length) return { match_all: {} }
  const bool: Dsl = {}
  if (filter.length) bool.filter = filter
  if (mustNot.length) bool.must_not = mustNot
  return { bool }
}
