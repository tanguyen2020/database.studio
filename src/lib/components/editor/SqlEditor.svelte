<script lang="ts">
  // CodeMirror 6 SQL editor. Dialect-aware highlighting, F5 / Ctrl+Enter /
  // Ctrl+F5 / Esc keymap, execution-error squiggles (tầng 2 — advisory lint
  // tầng 1 arrives in Phase 2).
  import { onMount } from 'svelte'
  import { EditorView, keymap, lineNumbers } from '@codemirror/view'
  import { EditorState, Compartment } from '@codemirror/state'
  import {
    defaultKeymap,
    history,
    historyKeymap,
    indentWithTab,
  } from '@codemirror/commands'
  import {
    bracketMatching,
    foldGutter,
    foldKeymap,
    indentOnInput,
    syntaxHighlighting,
    HighlightStyle,
  } from '@codemirror/language'
  import { tags as t } from '@lezer/highlight'
  import {
    autocompletion,
    acceptCompletion,
    closeBrackets,
    closeBracketsKeymap,
    completionKeymap,
    type CompletionSource,
  } from '@codemirror/autocomplete'
  import { functionSignatures } from '$lib/sql/functions'
  import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
  import { linter, setDiagnostics, type Diagnostic } from '@codemirror/lint'
  import { sql, PostgreSQL, MySQL, MSSQL, SQLite, StandardSQL } from '@codemirror/lang-sql'
  import { lineColToOffset } from '$lib/sql/statements'

  interface Props {
    value: string
    system: string
    readOnly?: boolean
    /** schema-aware autocomplete (Phase 2): { table: [cols] } từ explorer cache */
    schema?: Record<string, string[]>
    defaultSchema?: string
    /** async completion cho `alias.`/`table.` — lazy-load cột của bảng trong FROM/JOIN */
    columnSource?: CompletionSource
    /** lint tầng 1 — advisory, debounce 400ms do linter đảm nhiệm, KHÔNG chặn Run */
    lintSource?: (doc: string) => Promise<Diagnostic[]>
    onChange?: (doc: string) => void
    onRun?: () => void
    onRunAtCursor?: () => void
    onCancel?: () => void
    onFormat?: () => void
    onExplain?: () => void
    onSaveSnippet?: () => void
  }

  let {
    value,
    system,
    readOnly = false,
    schema,
    defaultSchema,
    columnSource,
    lintSource,
    onChange,
    onRun,
    onRunAtCursor,
    onCancel,
    onFormat,
    onExplain,
    onSaveSnippet,
  }: Props = $props()

  let container = $state<HTMLDivElement | null>(null)
  let view: EditorView | null = null
  const langCompartment = new Compartment()

  // T21 — function-signature completion (bổ sung cạnh keyword/schema của lang-sql).
  function fnSource(sys: string): CompletionSource {
    const options = functionSignatures(sys).map((f) => ({
      label: f.name,
      type: 'function',
      detail: f.signature,
      info: f.detail,
    }))
    return (ctx) => {
      const word = ctx.matchBefore(/\w+/)
      if (!word || (word.from === word.to && !ctx.explicit)) return null
      return { from: word.from, options }
    }
  }

  function langExt(sys: string) {
    const base = sql({ dialect: dialectFor(sys), schema, defaultSchema })
    // merge function completions vào language data (không thay keyword/schema source).
    // columnSource (nếu có) xử lý `alias.`/`table.` — lazy-load cột của bảng thật
    // referenced trong FROM/JOIN (built-in chỉ resolve alias khi cột đã nạp sẵn).
    const exts = [base, base.language.data.of({ autocomplete: fnSource(sys) })]
    if (columnSource) exts.push(base.language.data.of({ autocomplete: columnSource }))
    return exts
  }

  function dialectFor(sys: string) {
    switch (sys) {
      case 'postgres':
        return PostgreSQL
      case 'mysql':
      case 'mariadb':
        return MySQL
      case 'mssql':
        return MSSQL
      case 'sqlite':
        return SQLite
      default:
        return StandardSQL
    }
  }

  // Theme-aware SQL syntax palette (AUDIT-3 item 2). Colors resolve from CSS
  // vars (--syntax-*) so light/dark each get a high-contrast, low-strain palette.
  const syntaxHl = HighlightStyle.define([
    { tag: [t.keyword, t.operatorKeyword, t.modifier], color: 'var(--syntax-keyword)', fontWeight: '600' },
    { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--syntax-string)' },
    { tag: [t.number, t.bool, t.null], color: 'var(--syntax-number)' },
    { tag: [t.lineComment, t.blockComment, t.comment], color: 'var(--syntax-comment)', fontStyle: 'italic' },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--syntax-function)' },
    { tag: [t.typeName, t.className, t.namespace], color: 'var(--syntax-type)' },
    { tag: [t.operator, t.punctuation, t.separator, t.paren, t.bracket], color: 'var(--syntax-operator)' },
    { tag: [t.variableName, t.propertyName, t.name], color: 'var(--text)' },
  ])

  const editorTheme = EditorView.theme({
    '&': {
      height: '100%',
      fontSize: 'var(--px-13)',
      backgroundColor: 'var(--surface)',
      color: 'var(--text)',
    },
    '.cm-content': {
      fontFamily: 'var(--font-mono, monospace)',
      caretColor: 'var(--text)',
    },
    '.cm-gutters': {
      backgroundColor: 'var(--surface)',
      color: 'var(--muted)',
      border: 'none',
      borderRight: 'var(--px-1) solid var(--border)',
    },
    '.cm-activeLine': { backgroundColor: 'var(--hover)' },
    '.cm-activeLineGutter': { backgroundColor: 'var(--hover)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
      backgroundColor: 'var(--rgba-74-110-224-_20) !important',
    },
    '.cm-cursor': { borderLeftColor: 'var(--text)' },
    '.cm-lintRange-error': {
      backgroundImage: 'none',
      textDecoration: 'underline wavy var(--error) var(--px-1)',
    },
    '.cm-tooltip': {
      backgroundColor: 'var(--raised)',
      color: 'var(--text)',
      border: 'var(--px-1) solid var(--border2)',
    },
  })

  onMount(() => {
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        foldGutter(),
        history(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        highlightSelectionMatches(),
        syntaxHighlighting(syntaxHl, { fallback: true }),
        langCompartment.of(langExt(system)),
        // autocomplete: keywords dialect + table/column từ schema cache (lang-sql)
        autocompletion(),
        // lint tầng 1 — advisory, debounce 400ms (addendum §1.1), không chặn Run
        linter(async (v) => (lintSource ? await lintSource(v.state.doc.toString()) : []), {
          delay: 400,
        }),
        editorTheme,
        EditorState.readOnly.of(readOnly),
        keymap.of([
          // run bindings take precedence
          {
            key: 'F5',
            run: () => {
              onRun?.()
              return true
            },
          },
          {
            key: 'Ctrl-Enter',
            run: () => {
              onRunAtCursor?.()
              return true
            },
          },
          {
            key: 'Ctrl-F5',
            run: () => {
              onCancel?.()
              return true
            },
          },
          {
            key: 'Mod-Shift-f',
            run: () => {
              onFormat?.()
              return true
            },
          },
          {
            key: 'Mod-Shift-e',
            run: () => {
              onExplain?.()
              return true
            },
          },
          {
            key: 'Mod-s',
            run: () => {
              onSaveSnippet?.()
              return true
            },
          },
          {
            key: 'Escape',
            run: () => {
              onCancel?.()
              return false // let Esc also close panels etc.
            },
          },
          // When the completion popup is open, Tab and Enter both accept the
          // highlighted suggestion. acceptCompletion returns false when no
          // completion is active, so Tab then falls through to indentWithTab
          // (normal indentation) — accepting a suggestion never re-indents or
          // shifts the line, leaving the query's left/right alignment intact.
          {
            key: 'Tab',
            run: acceptCompletion,
          },
          ...closeBracketsKeymap,
          ...completionKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...foldKeymap,
          ...searchKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChange?.(update.state.doc.toString())
          }
        }),
      ],
    })
    view = new EditorView({ state, parent: container! })
    return () => view?.destroy()
  })

  // dialect/schema đổi (đổi connection trong tab hoặc cache autocomplete nạp xong)
  // → reconfigure lang: reload autocomplete (spec phase-1 §6 + phase-2 §1)
  $effect(() => {
    void schema
    view?.dispatch({ effects: langCompartment.reconfigure(langExt(system)) })
  })

  // ---- public API (via bind:this) ----

  export function getDoc(): string {
    return view?.state.doc.toString() ?? ''
  }

  /** Thay toàn bộ nội dung (Format SQL) — giữ trong 1 transaction để undo được. */
  export function setDoc(next: string) {
    if (!view) return
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: next },
    })
  }

  export function getSelection(): string {
    if (!view) return ''
    const { from, to } = view.state.selection.main
    return from === to ? '' : view.state.sliceDoc(from, to)
  }

  /** 0-based [from, to) of the primary selection (from === to when empty). */
  export function getSelectionRange(): { from: number; to: number } {
    if (!view) return { from: 0, to: 0 }
    const { from, to } = view.state.selection.main
    return { from, to }
  }

  export function getCursorOffset(): number {
    return view?.state.selection.main.head ?? 0
  }

  /** Jump to a 1-based line/col and focus (Messages click-to-jump). */
  export function jumpTo(line: number, col: number) {
    if (!view) return
    const offset = lineColToOffset(view.state.doc.toString(), line, col)
    view.dispatch({
      selection: { anchor: offset },
      scrollIntoView: true,
    })
    view.focus()
  }

  /** Highlight execution errors (positions already mapped to the document). */
  export function showErrors(
    errors: { line: number; col: number; endLine?: number; endCol?: number; message: string }[],
  ) {
    if (!view) return
    const doc = view.state.doc.toString()
    const diagnostics: Diagnostic[] = errors.map((e) => {
      const from = lineColToOffset(doc, e.line, e.col)
      const to =
        e.endLine != null && e.endCol != null
          ? lineColToOffset(doc, e.endLine, e.endCol)
          : Math.min(from + 1, doc.length)
      return { from, to: Math.max(to, from + 1), severity: 'error', message: e.message }
    })
    view.dispatch(setDiagnostics(view.state, diagnostics))
  }

  export function clearErrors() {
    if (view) view.dispatch(setDiagnostics(view.state, []))
  }
</script>

<div bind:this={container} class="h-full min-h-0 overflow-hidden selectable"></div>
