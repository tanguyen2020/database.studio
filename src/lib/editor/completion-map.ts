// Editor-agnostic mapping of completion results onto one flat, ordered list.
//
// The completion SOURCES are shared with the CodeMirror era (schema/keyword
// completion from @codemirror/lang-sql plus this app's own column/function/Mongo
// sources) — they are driven headlessly, so all their hard-won behaviour is kept
// (reserved-word quoting via `apply`, alias resolution, dotted schema keys).
// This module turns their output into what Monaco needs, and pins the ORDER,
// which is the part Monaco does differently:
//
//   • CodeMirror ranked by `boost` (columns 200 > tables 150 > functions 0 >
//     keywords -1), so a prefix-matched table beat an exact-matched function of
//     another name (typing `ord` had to offer the table `order`, not MySQL's
//     `ORD()` function).
//   • Monaco sorts by fuzzy score first, then by the order items were supplied
//     (`idx`) — `sortText` is not consulted. So the rank lives in the ARRAY order
//     here, and the one identifier the user is most likely typing is marked
//     `preselect`, which is the only lever that survives Monaco's score sort.

/** The subset of a CodeMirror `Completion` these sources actually produce. */
export interface CmOption {
  label: string
  type?: string
  detail?: string
  info?: unknown
  boost?: number
  apply?: unknown
  [k: string]: unknown
}

export interface CmResult {
  from: number
  /** end of the replaced range when a source extends it (lang-sql swallows the
   *  closing quote of a quoted identifier); defaults to the cursor. */
  to?: number
  options: readonly CmOption[]
}

/** Editor-neutral completion item; the component maps `kind` onto Monaco's enum. */
export interface MappedCompletion {
  label: string
  insertText: string
  kind: string
  detail?: string
  documentation?: string
  /** document offset the replacement starts at */
  from: number
  /** document offset the replacement ends at, when a source extends past the cursor */
  to?: number
  /** lower sorts first */
  rank: number
  preselect: boolean
}

/** Rank per completion type — mirrors the CodeMirror boosts we used to set. */
export function rankOf(type: string | undefined): number {
  switch (type) {
    case 'property': // column / document field
      return 0
    case 'type': // table / view
      return 1
    case 'class': // Mongo collection
      return 2
    case 'method': // Mongo collection method
      return 3
    case 'function':
      return 4
    case 'keyword':
    case 'constant':
      return 5
    default:
      return 3
  }
}

/** True for the ranks that represent real database identifiers. */
function isIdentifier(rank: number): boolean {
  return rank <= 2
}

/**
 * Could `word` fuzzy-match `label`? True when every character of the word appears
 * in the label, in order (case-insensitive) — the necessary condition for ANY
 * fuzzy match, so filtering on it can only drop items the editor would have
 * dropped anyway. It exists for cost: a production catalog answers with thousands
 * of options per keystroke (2000 tables + 2000 functions + the dialect keywords),
 * and building an item for each is what made a big-schema completion take ~330ms.
 */
export function couldMatch(label: string, wordLow: string): boolean {
  if (!wordLow) return true
  let i = 0
  let nonAscii = false
  for (let j = 0; j < label.length && i < wordLow.length; j++) {
    const c = label.charCodeAt(j)
    if (c > 127) nonAscii = true
    // inline ASCII lower-casing: this loop runs over thousands of labels per keystroke
    const lc = c >= 65 && c <= 90 ? c + 32 : c
    if (lc === wordLow.charCodeAt(i)) i++
  }
  if (i === wordLow.length) return true
  if (!nonAscii) return false
  // a label with non-ASCII letters needs real case folding — rare, so pay for it here
  const low = label.toLowerCase()
  let k = 0
  for (let j = 0; j < low.length && k < wordLow.length; j++) {
    if (low.charCodeAt(j) === wordLow.charCodeAt(k)) k++
  }
  return k === wordLow.length
}

function docText(info: unknown): string | undefined {
  return typeof info === 'string' && info ? info : undefined
}

/**
 * Merge the results of several completion sources into one ordered list.
 *
 * @param results one entry per source that returned something
 * @param word    text already typed at the completion position (used to decide
 *                which item to preselect); pass '' when nothing is typed
 */
export function mapCompletions(results: readonly (CmResult | null | undefined)[], word: string): MappedCompletion[] {
  const byLabel = new Map<string, MappedCompletion>()
  const order: MappedCompletion[] = []
  const wordLow = word.toLowerCase()

  for (const res of results) {
    if (!res || !res.options?.length) continue
    for (const o of res.options) {
      if (!o?.label) continue
      if (!couldMatch(o.label, wordLow)) continue
      const rank = typeof o.boost === 'number' ? rankFromBoost(o.boost, o.type) : rankOf(o.type)
      const item: MappedCompletion = {
        label: o.label,
        // `apply` carries the text to insert (e.g. the quoted `"order"`); a
        // function-valued apply only exists for CodeMirror snippets, which none
        // of these sources produce — fall back to the label if one ever appears.
        insertText: typeof o.apply === 'string' ? o.apply : o.label,
        kind: o.type ?? 'variable',
        detail: o.detail,
        documentation: docText(o.info),
        from: res.from,
        ...(typeof res.to === 'number' ? { to: res.to } : {}),
        rank,
        preselect: false,
      }
      const key = item.label.toLowerCase()
      const prev = byLabel.get(key)
      if (prev) {
        // Same name offered twice (a table that is also a keyword, a function
        // that is also a keyword): keep the more specific one so the popup shows
        // one row — and so accepting it inserts the identifier, quoted.
        if (item.rank < prev.rank) Object.assign(prev, item)
        continue
      }
      byLabel.set(key, item)
      order.push(item)
    }
  }

  // plain string compare, NOT localeCompare: a big catalog sorts thousands of
  // labels per keystroke and localeCompare costs ~50ms of that on its own.
  order.sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.label < b.label ? -1 : a.label > b.label ? 1 : 0))

  // Preselect the first identifier that continues what the user typed. Without
  // this, an exact-match keyword/function of a DIFFERENT name outranks it on
  // Monaco's fuzzy score and Tab would insert the wrong thing.
  if (wordLow) {
    const pick = order.find((i) => isIdentifier(i.rank) && i.label.toLowerCase().startsWith(wordLow))
    if (pick) pick.preselect = true
  }
  return order
}

/** A source may set an explicit boost; keep its intent but stay on our scale. */
function rankFromBoost(boost: number, type: string | undefined): number {
  if (boost >= 200) return 0
  if (boost >= 150) return 1
  if (boost > 0) return 2
  // lang-sql's keyword source boosts everything to -1 (keywords AND type names),
  // so a negative boost means "language word", never a database identifier.
  if (boost < 0) return 5
  return rankOf(type)
}
