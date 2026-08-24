// Headless CodeMirror document used ONLY to drive the SQL completion sources.
//
// Editing/rendering/typing now belong to Monaco. Completion, however, keeps using
// @codemirror/lang-sql's `schemaCompletionSource` + `keywordCompletionSource` and
// this app's own sources, because their behaviour is subtle and test-pinned:
// reserved-word quoting on accept, alias-aware `alias.column`, dotted schema keys
// (`crm.example.com`), quoted identifiers. Those sources need an `EditorState`
// with the SQL language (they read the syntax tree), so we keep one here — a
// document with no view, updated incrementally so a big script is re-parsed only
// around the change instead of from scratch on every keystroke.

import { EditorState, type Extension } from '@codemirror/state'
import { CompletionContext, type CompletionSource } from '@codemirror/autocomplete'
import type { CmResult } from './completion-map'

/**
 * Smallest single replacement turning `oldDoc` into `newDoc` (common prefix and
 * suffix trimmed). Keeping the change local is what lets Lezer reuse the parse
 * tree — a whole-document replace would re-parse everything per keystroke.
 * Returns null when the documents are identical.
 */
export function minimalChange(
  oldDoc: string,
  newDoc: string,
): { from: number; to: number; insert: string } | null {
  if (oldDoc === newDoc) return null
  let start = 0
  const max = Math.min(oldDoc.length, newDoc.length)
  while (start < max && oldDoc.charCodeAt(start) === newDoc.charCodeAt(start)) start++
  let endOld = oldDoc.length
  let endNew = newDoc.length
  while (endOld > start && endNew > start && oldDoc.charCodeAt(endOld - 1) === newDoc.charCodeAt(endNew - 1)) {
    endOld--
    endNew--
  }
  return { from: start, to: endOld, insert: newDoc.slice(start, endNew) }
}

export class HeadlessDoc {
  private state: EditorState

  constructor(
    private language: Extension,
    doc = '',
  ) {
    this.state = EditorState.create({ doc, extensions: [language] })
  }

  /** Swap the SQL dialect (connection/system changed) — keeps the document. */
  setLanguage(language: Extension) {
    if (language === this.language) return
    this.language = language
    this.state = EditorState.create({ doc: this.state.doc, extensions: [language] })
  }

  /** Bring the headless document in line with the editor's text. */
  sync(doc: string): EditorState {
    const change = minimalChange(this.state.doc.toString(), doc)
    if (change) this.state = this.state.update({ changes: change }).state
    return this.state
  }

  context(doc: string, pos: number, explicit: boolean): CompletionContext {
    const state = this.sync(doc)
    return new CompletionContext(state, Math.min(pos, state.doc.length), explicit)
  }
}

/**
 * Run every source against one context and collect the results that produced
 * options. A source may be async (none of ours are today) — awaited so a future
 * one keeps working.
 */
export async function runSources(
  sources: readonly (CompletionSource | undefined | null)[],
  ctx: CompletionContext,
): Promise<CmResult[]> {
  const out: CmResult[] = []
  for (const src of sources) {
    if (!src) continue
    let res: unknown
    try {
      res = src(ctx)
      if (res && typeof (res as PromiseLike<unknown>).then === 'function') res = await res
    } catch {
      continue // a broken source must never break the whole popup
    }
    if (!res) continue
    const r = res as CmResult
    if (Array.isArray(r.options) && r.options.length > 0 && typeof r.from === 'number') out.push(r)
  }
  return out
}
