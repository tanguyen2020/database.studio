// One-line preview of a message value for a grid cell: a JSON object reads as
// `key value · key value`, typed, instead of a raw `{"k":"v",…}` string.
// Pure → unit-testable; PayloadPreview.svelte only renders the parts.

export type PreviewType = 'string' | 'number' | 'bool' | 'null' | 'object' | 'array'

export interface PreviewPart {
  /** object key (absent for array items / a bare value) */
  k?: string
  /** the value as shown: strings unquoted, containers summarised */
  v: string
  t: PreviewType
}

export interface Preview {
  kind: 'object' | 'array' | 'value' | 'text' | 'empty'
  parts: PreviewPart[]
  /** keys / items not shown */
  more: number
  /** items in an array / keys in an object */
  size?: number
}

const CAP = 80 // characters of one shown value

function typeOf(v: unknown): PreviewType {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  switch (typeof v) {
    case 'string':
      return 'string'
    case 'number':
    case 'bigint':
      return 'number'
    case 'boolean':
      return 'bool'
    case 'object':
      return 'object'
    default:
      return 'string'
  }
}

function shown(v: unknown): string {
  const t = typeOf(v)
  if (t === 'array') {
    const n = (v as unknown[]).length
    return `[${n} item${n === 1 ? '' : 's'}]`
  }
  if (t === 'object') {
    const n = Object.keys(v as object).length
    return `{${n} key${n === 1 ? '' : 's'}}`
  }
  const s = t === 'string' ? (v as string) : String(v)
  const one = s.replace(/\s+/g, ' ')
  return one.length > CAP ? one.slice(0, CAP - 1) + '…' : one
}

/** Preview of `text`; at most `max` parts. Only containers parse — a bare string
 *  or number stays as the text it was. */
export function previewOf(text: string, max = 6): Preview {
  if (text.trim() === '') return { kind: 'empty', parts: [], more: 0 }
  const first = text.trimStart()[0]
  if (first === '{' || first === '[') {
    try {
      const parsed: unknown = JSON.parse(text)
      if (Array.isArray(parsed)) {
        const parts = parsed.slice(0, max).map((v) => ({ v: shown(v), t: typeOf(v) }))
        return { kind: 'array', parts, more: Math.max(0, parsed.length - max), size: parsed.length }
      }
      if (parsed !== null && typeof parsed === 'object') {
        const entries = Object.entries(parsed as Record<string, unknown>)
        const parts = entries.slice(0, max).map(([k, v]) => ({ k, v: shown(v), t: typeOf(v) }))
        return { kind: 'object', parts, more: Math.max(0, entries.length - max), size: entries.length }
      }
    } catch {
      /* not JSON — falls through to text */
    }
  }
  return { kind: 'text', parts: [{ v: shown(text), t: 'string' }], more: 0 }
}

// ---- tree view of a JSON document (the payload viewer's "Tree") -------------

export interface TreeNode {
  /** stable path: "$", "$.user", "$.items[3]" */
  path: string
  key: string | null
  /** array index when this node is an array item */
  index: number | null
  depth: number
  t: PreviewType
  /** leaf value as shown (strings unquoted) — containers: summary */
  v: string
  /** children count of a container */
  size: number
  value: unknown
}

const ident = /^[A-Za-z_$][\w$]*$/
function childPath(parent: string, key: string | number): string {
  if (typeof key === 'number') return `${parent}[${key}]`
  return ident.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`
}

/** The visible rows of a tree: walks `value`, descending only into containers that
 *  are open (`isOpen(path, depth)`); an array shows at most `limit(path)` items. */
export function flattenTree(
  value: unknown,
  isOpen: (path: string, depth: number) => boolean,
  limit: (path: string) => number = () => 200,
): (TreeNode & { more?: number })[] {
  const out: (TreeNode & { more?: number })[] = []
  const visit = (v: unknown, path: string, key: string | null, index: number | null, depth: number) => {
    const t = typeOf(v)
    const size = t === 'array' ? (v as unknown[]).length : t === 'object' ? Object.keys(v as object).length : 0
    out.push({ path, key, index, depth, t, v: t === 'string' ? (v as string) : shown(v), size, value: v })
    if ((t !== 'array' && t !== 'object') || !isOpen(path, depth)) return
    if (t === 'array') {
      const arr = v as unknown[]
      const cap = limit(path)
      arr.slice(0, cap).forEach((item, i) => visit(item, childPath(path, i), null, i, depth + 1))
      if (arr.length > cap) out.push({ path: `${path}#more`, key: null, index: null, depth: depth + 1, t: 'null', v: '', size: 0, value: null, more: arr.length - cap })
    } else {
      for (const [k, item] of Object.entries(v as Record<string, unknown>)) visit(item, childPath(path, k), k, null, depth + 1)
    }
  }
  visit(value, '$', null, null, 0)
  return out
}

/** Every container path — for "Expand all". */
export function containerPaths(value: unknown): string[] {
  const out: string[] = []
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) {
      out.push(path)
      v.forEach((item, i) => walk(item, childPath(path, i)))
    } else if (v !== null && typeof v === 'object') {
      out.push(path)
      for (const [k, item] of Object.entries(v as Record<string, unknown>)) walk(item, childPath(path, k))
    }
  }
  walk(value, '$')
  return out
}
