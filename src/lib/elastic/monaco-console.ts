// Monaco language for the Dev Tools console (`ds-es-console`): method / path /
// JSON body highlighting + completion (methods, endpoints with the cluster's index
// names, Query DSL keys, field types, mapping field names).

import type { MonacoApi } from '$lib/editor/monaco'
import type * as monaco from 'monaco-editor'
import { BODY_KEYS, ENDPOINTS, FIELD_TYPES, METHODS } from './console'

export const ES_CONSOLE_LANG = 'ds-es-console'

let registered = false

export interface ConsoleCompletionContext {
  indexNames: () => string[]
  /** mapping fields of an index named in the current request's path */
  fieldsOf: (index: string) => Promise<string[]>
}

let ctxRef: ConsoleCompletionContext | null = null

/** The console currently focused provides index / field names to the completer. */
export function setConsoleContext(ctx: ConsoleCompletionContext | null) {
  ctxRef = ctx
}

export function registerConsoleLanguage(m: MonacoApi) {
  if (registered) return
  registered = true
  m.languages.register({ id: ES_CONSOLE_LANG })
  m.languages.setLanguageConfiguration(ES_CONSOLE_LANG, {
    comments: { lineComment: '#' },
    brackets: [
      ['{', '}'],
      ['[', ']'],
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '"', close: '"' },
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '"', close: '"' },
    ],
  })
  m.languages.setMonarchTokensProvider(ES_CONSOLE_LANG, {
    tokenizer: {
      root: [
        [/^\s*(#|\/\/).*$/, 'comment'],
        [/^(GET|POST|PUT|DELETE|HEAD|PATCH|get|post|put|delete|head|patch)(\s+)/, ['keyword', 'white'], '@path'],
        [/"""/, 'string', '@triple'],
        [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'string.key'],
        [/"(?:[^"\\]|\\.)*"/, 'string.value'],
        [/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/, 'number'],
        [/\b(?:true|false|null)\b/, 'keyword'],
        [/[{}[\],:]/, 'delimiter'],
        [/\s+/, 'white'],
      ],
      path: [
        [/\$\{[^}]*\}/, 'type'],
        [/\?[^\s]*/, 'predefined'],
        [/[^\s?$]+/, 'identifier.quote'],
        [/$/, '', '@pop'],
        [/\s+/, 'white', '@pop'],
      ],
      triple: [
        [/"""/, 'string', '@pop'],
        [/./, 'string'],
      ],
    },
  })

  m.languages.registerCompletionItemProvider(ES_CONSOLE_LANG, {
    triggerCharacters: ['/', '"', ' ', '_'],
    provideCompletionItems: async (model: monaco.editor.ITextModel, pos: monaco.Position) => {
      const line = model.getLineContent(pos.lineNumber)
      const before = line.slice(0, pos.column - 1)
      const word = model.getWordUntilPosition(pos)
      const K = m.languages.CompletionItemKind
      // 1) method at the start of a line
      if (/^\s*[A-Za-z]*$/.test(before) && !insideBody(model, pos.lineNumber)) {
        return {
          suggestions: METHODS.map((mm, i) => ({
            label: mm,
            kind: K.Keyword,
            insertText: `${mm} `,
            sortText: String(i),
            range: { startLineNumber: pos.lineNumber, endLineNumber: pos.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn },
            command: { id: 'editor.action.triggerSuggest', title: '' },
          })),
        }
      }
      // 2) path after the method
      const pm = /^\s*(GET|POST|PUT|DELETE|HEAD|PATCH)\s+(\S*)$/i.exec(before)
      if (pm) {
        const typed = pm[2]
        const start = before.length - typed.length + 1
        const range = { startLineNumber: pos.lineNumber, endLineNumber: pos.lineNumber, startColumn: start, endColumn: pos.column }
        const lead = typed.startsWith('/') ? '/' : ''
        const method = pm[1].toUpperCase() as (typeof METHODS)[number]
        const names = ctxRef?.indexNames() ?? []
        const out: monaco.languages.CompletionItem[] = []
        const seen = new Set<string>()
        const push = (path: string, doc: string, kind: monaco.languages.CompletionItemKind, body?: string) => {
          if (seen.has(path)) return
          seen.add(path)
          out.push({
            label: lead + path,
            kind,
            detail: doc,
            insertText: lead + path + (body ? `\n${body}` : ''),
            filterText: lead + path,
            range,
          })
        }
        for (const ep of ENDPOINTS) {
          if (!ep.methods.includes(method)) continue
          if (ep.path.includes('{index}')) {
            const typedIndex = /^\/?([^/]+)\//.exec(typed)?.[1]
            for (const n of typedIndex ? [typedIndex] : names.slice(0, 30)) push(ep.path.replace('{index}', n), ep.doc, K.Function, ep.body)
          } else push(ep.path, ep.doc, K.Function, ep.body)
        }
        for (const n of names) push(n, 'index', K.Folder)
        return { suggestions: out }
      }
      // 3) inside a JSON body
      const range = { startLineNumber: pos.lineNumber, endLineNumber: pos.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn }
      if (/"type"\s*:\s*"[\w]*$/.test(before)) {
        return { suggestions: FIELD_TYPES.map((t) => ({ label: t, kind: K.EnumMember, insertText: t, range })) }
      }
      const inKey = /(^|[{,]\s*)"?[\w.@]*$/.test(before.trimStart()) || /^\s*"?[\w.@]*$/.test(before)
      if (!inKey) return { suggestions: [] }
      const quoted = /"[\w.@]*$/.test(before)
      const qRange = quoted
        ? { ...range, startColumn: before.lastIndexOf('"') + 1, endColumn: pos.column + (line[pos.column - 1] === '"' ? 1 : 0) }
        : range
      const out: monaco.languages.CompletionItem[] = BODY_KEYS.map((k) => ({
        label: k.key === 'terms_agg' ? 'terms (aggregation)' : k.key,
        kind: K.Property,
        detail: k.doc,
        insertText: k.snippet ?? `"${k.key}": $0`,
        insertTextRules: m.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        range: qRange,
        sortText: `1${k.key}`,
      }))
      // field names of the index in the request path
      const idx = requestIndexAbove(model, pos.lineNumber)
      if (idx && ctxRef) {
        const fields = await ctxRef.fieldsOf(idx).catch(() => [])
        for (const f of fields) {
          out.push({ label: f, kind: K.Field, detail: `field of ${idx}`, insertText: quoted ? `"${f}"` : `"${f}"`, range: qRange, sortText: `0${f}` })
        }
      }
      return { suggestions: out }
    },
  })
}

/** Is this line inside a request body (i.e. not the method line)? */
function insideBody(model: monaco.editor.ITextModel, line: number): boolean {
  for (let l = line - 1; l >= 1; l--) {
    const t = model.getLineContent(l)
    if (/^(GET|POST|PUT|DELETE|HEAD|PATCH)\s/i.test(t)) return /[{[]/.test(model.getLineContent(l + 1) ?? '') || l + 1 <= line - 1
    if (!t.trim()) return false
  }
  return false
}

/** Index of the request the caret is in (`GET /orders/_search` → orders). */
function requestIndexAbove(model: monaco.editor.ITextModel, line: number): string | null {
  for (let l = line; l >= 1; l--) {
    const m = /^(GET|POST|PUT|DELETE|HEAD|PATCH)\s+\/?([^/\s?_][^/\s?]*)/i.exec(model.getLineContent(l))
    if (m) return m[2]
    if (/^(GET|POST|PUT|DELETE|HEAD|PATCH)\s/i.test(model.getLineContent(l))) return null
  }
  return null
}
