<script lang="ts">
  // CodeMirror 6 SQL editor. Dialect-aware highlighting, F5 / Ctrl+Enter /
  // Ctrl+F5 / Esc keymap, execution-error squiggles (tầng 2 — advisory lint
  // tầng 1 arrives in Phase 2).
  import { onMount } from 'svelte'
  import {
    EditorView,
    keymap,
    lineNumbers,
    ViewPlugin,
    Decoration,
    type DecorationSet,
    type ViewUpdate,
  } from '@codemirror/view'
  import { EditorState, Compartment, RangeSetBuilder, type Extension } from '@codemirror/state'
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
    moveCompletionSelection,
    completionStatus,
    startCompletion,
    closeBrackets,
    closeBracketsKeymap,
    completionKeymap,
    type CompletionSource,
    type Completion,
  } from '@codemirror/autocomplete'
  import { functionCatalog, type FnHint } from '$lib/sql/functions'
  import { expectsColumnHere } from '$lib/sql/column-context'
  import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
  import { linter, setDiagnostics, type Diagnostic } from '@codemirror/lint'
  import {
    sql,
    SQLDialect,
    PostgreSQL,
    MySQL,
    MSSQL,
    SQLite,
    StandardSQL,
    type SQLNamespace,
  } from '@codemirror/lang-sql'
  import { clickHouseDialect } from '$lib/sql/ch-editor-dialect'
  import { lineColToOffset } from '$lib/sql/statements'

  interface Props {
    value: string
    system: string
    readOnly?: boolean
    /** schema-aware autocomplete (Phase 2): nested { schema: { table: {self,children} } }
     *  from the explorer cache; reserved identifiers carry a quoted `apply`. */
    schema?: SQLNamespace
    defaultSchema?: string
    /** async completion cho `alias.`/`table.` — lazy-load cột của bảng trong FROM/JOIN */
    columnSource?: CompletionSource
    /** functions introspected from the live server (list_functions) — merged with
     *  the static built-ins + curated signatures for the dialect. */
    dynamicFunctions?: FnHint[]
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
    dynamicFunctions,
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
  /** Set when Escape closes the popup; cleared on the next edit. Keeps a late
   *  column load (see refreshCompletion) from re-opening a dismissed popup. */
  let completionDismissed = false

  function baseDialect(sys: string): SQLDialect {
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
      case 'clickhouse':
        return clickHouseDialect // lang-sql has no CH dialect → our own
      default:
        return StandardSQL
    }
  }

  // Set of known function names for a dialect — the merged catalog (static +
  // curated + introspected `dynamicFunctions`, so server/extension functions like
  // PG `date_trunc` colour too) PLUS the dialect's own `builtin` words (covers
  // ClickHouse's CH_FUNCTIONS). Driven purely by the function catalog: real
  // functions (incl. MSSQL GETDATE/DATEADD which are also dialect keywords) colour,
  // while non-function keywords (IN/VALUES/EXISTS — not in any catalog) do not — so
  // there's NO keyword subtraction (that dropped keyword-named functions). Used only
  // to COLOUR calls; never fed to the tokenizer, so completion/quoting are unaffected.
  function fnColorSet(sys: string): Set<string> {
    const set = new Set<string>(functionCatalog(sys, dynamicFunctions ?? []).map((f) => f.name.toLowerCase()))
    for (const w of ((baseDialect(sys).spec?.builtin ?? '') as string).split(/\s+/)) {
      if (w) set.add(w.toLowerCase())
    }
    return set
  }

  // Colour known function calls (`name(`) via a decoration — NOT by adding names
  // to the dialect `builtin`. Putting functions in `builtin` makes the tokenizer
  // read them as complete keywords, which broke table completion when a table
  // prefix equals a function name (typing `ord` → the `ORD` function shadowed a
  // table `order`). A decoration leaves tokenization untouched.
  const fnMark = Decoration.mark({ class: 'cm-sql-fn' })
  function functionHighlighter(sys: string) {
    const set = fnColorSet(sys)
    const build = (view: EditorView): DecorationSet => {
      const b = new RangeSetBuilder<Decoration>()
      const re = /\b([A-Za-z_]\w*)\s*(?=\()/g
      for (const { from, to } of view.visibleRanges) {
        const text = view.state.sliceDoc(from, to)
        let m: RegExpExecArray | null
        while ((m = re.exec(text))) {
          if (set.has(m[1].toLowerCase())) {
            const s = from + m.index
            b.add(s, s + m[1].length, fnMark)
          }
        }
      }
      return b.finish()
    }
    return ViewPlugin.fromClass(
      class {
        decorations: DecorationSet
        constructor(view: EditorView) {
          this.decorations = build(view)
        }
        update(u: ViewUpdate) {
          if (u.docChanged || u.viewportChanged) this.decorations = build(u.view)
        }
      },
      { decorations: (v) => v.decorations },
    )
  }

  // The SINGLE function-completion source (with signatures). Because the keyword
  // source below EXCLUDES function names, functions are suggested exactly once —
  // no duplicate bare/keyword entry alongside the signature one.
  function fnSource(sys: string): CompletionSource {
    const options: Completion[] = functionCatalog(sys, dynamicFunctions ?? []).map((f) => ({
      label: f.name,
      type: 'function',
      detail: f.signature,
      info: f.detail,
    }))
    return (ctx) => {
      const word = ctx.matchBefore(/\w+/)
      if (!word || (word.from === word.to && !ctx.explicit)) return null
      // after `alias.` / `table.` only columns are meaningful — skip functions
      if (word.from > 0 && ctx.state.sliceDoc(word.from - 1, word.from) === '.') return null
      // In a table-reference position (after FROM/JOIN/INTO/UPDATE/TABLE) suggest
      // tables, not functions — otherwise a function like MySQL `ORD` would shadow
      // a table named `order` when you type `ord`.
      const pre = ctx.state.sliceDoc(Math.max(0, word.from - 40), word.from)
      if (/\b(from|join|into|update|table)\s+$/i.test(pre)) return null
      return { from: word.from, options }
    }
  }

  function langExt(sys: string) {
    // MongoDB is mongosh, not SQL — keep the plain lang-sql path (no function/
    // keyword SQL sources); its columnSource provides Mongo methods/operators.
    if (sys === 'mongodb') {
      const base = sql({ dialect: StandardSQL, schema, defaultSchema })
      const exts: Extension[] = [base]
      if (columnSource) exts.push(base.language.data.of({ autocomplete: columnSource }))
      return exts
    }
    // Relational: use lang-sql's own `sql()` for schema + keyword completion +
    // language (its schema/alias/reserved-word-quoting behaviour is subtle — hand-
    // wiring it broke alias-column completion). On top we add a colour decoration
    // and the function source. Functions from the static/introspected catalog are
    // NOT dialect keywords, so they're offered once (only by fnSource); the handful
    // that are also keywords (count/coalesce/…) behave exactly as before.
    const base = sql({ dialect: baseDialect(sys), schema, defaultSchema })
    const exts: Extension[] = [base, functionHighlighter(sys), base.language.data.of({ autocomplete: fnSource(sys) })]
    if (columnSource) exts.push(base.language.data.of({ autocomplete: columnSource }))
    return exts
  }

  // Tab / Enter acceptance. `acceptCompletion` only fires when an option is
  // actually selected, but post-dot column completions can open with nothing
  // selected (selected = -1) — so Tab/Enter would do nothing until you pressed an
  // arrow key. This selects the first option when none is, then accepts, so a
  // single Tab/Enter always inserts the suggestion. Returns false when no popup is
  // open, letting Enter fall through to a normal newline.
  function acceptOrSelectFirst(view: EditorView): boolean {
    if (completionStatus(view.state) == null) return false
    if (acceptCompletion(view)) return true
    if (moveCompletionSelection(true)(view)) return acceptCompletion(view)
    return false
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
    // Known function calls, coloured by the functionHighlighter decoration.
    '.cm-sql-fn': { color: 'var(--syntax-function)' },
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
    // Autocomplete popup: wider for readability, and each row is a flex line so
    // the qualifier (schema/database for a table, data type for a column) sits at
    // the RIGHT edge instead of crowding the identifier.
    '.cm-tooltip.cm-tooltip-autocomplete > ul': {
      minWidth: 'var(--px-340)',
      maxWidth: 'var(--px-520)',
      fontFamily: 'var(--font-mono, monospace)',
    },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
      display: 'flex',
      alignItems: 'center',
      padding: 'var(--px-4) var(--px-10)',
    },
    '.cm-tooltip-autocomplete .cm-completionLabel': {
      flex: '0 1 auto',
      minWidth: '0',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    },
    '.cm-tooltip-autocomplete .cm-completionDetail': {
      flex: 'none',
      marginLeft: 'auto',
      paddingLeft: 'var(--px-16)',
      // brighter than --muted so the schema/type qualifier at the right edge is
      // easy to read on the popup background
      color: 'var(--text2)',
      fontStyle: 'normal',
    },
    // on the highlighted row (blue background) the qualifier needs a light color to
    // stay legible — mirror the white label CodeMirror uses for the selected item
    '.cm-tooltip-autocomplete ul li[aria-selected] .cm-completionDetail': {
      color: 'var(--hex-fff)',
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
              completionDismissed = true // don't let a late load re-open the popup
              onCancel?.()
              return false // let Esc also close panels etc.
            },
          },
          // When the completion popup is open, Tab and Enter both accept the
          // highlighted (or, if none, the first) suggestion. acceptOrSelectFirst
          // returns false when no completion is active, so Tab falls through to
          // indentWithTab (normal indentation) and Enter to a normal newline —
          // accepting a suggestion never re-indents or shifts the line.
          {
            key: 'Tab',
            run: acceptOrSelectFirst,
          },
          {
            key: 'Enter',
            run: acceptOrSelectFirst,
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
            completionDismissed = false // typing again re-arms completion
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
    // Picking another schema must repoint unqualified completions. Today a cache
    // mutation usually rebuilds anyway, but that is incidental — depend on the
    // pick itself.
    void defaultSchema
    void system
    void dynamicFunctions // server functions arrived → rebuild the completion source
    view?.dispatch({ effects: langCompartment.reconfigure(langExt(system)) })
  })

  // ---- public API (via bind:this) ----

  /** Focus the editor (e.g. when a fresh Query tab opens via Ctrl/Cmd+N). */
  export function focus() {
    view?.focus()
  }

  /** Re-run the completion sources because data they need has just arrived
   *  (columns load lazily — the source returns null on the first call and kicks
   *  off the fetch). Without this the popup stays empty until the user types
   *  another character, which reads as "no column suggestions" on any server that
   *  doesn't answer instantly.
   *
   *  Deliberately narrow, so a late background answer can only ever FILL the popup
   *  the user was already waiting on — never open one they didn't ask for:
   *   - the editor must have focus,
   *   - Escape must not have dismissed completion since the last edit,
   *   - the caret must sit right after an identifier char or a dot (the contexts
   *     that suggest something). startCompletion() counts as an EXPLICIT request,
   *     and an explicit request in empty space would dump the whole function
   *     catalog on screen. */
  export function refreshCompletion() {
    if (!view?.hasFocus || completionDismissed) return
    const pos = view.state.selection.main.head
    const prev = view.state.sliceDoc(Math.max(0, pos - 1), pos)
    // an identifier/dot context, or a position that expects a column with nothing
    // typed yet (after WHERE / SET / AND …) — the same positions the completion
    // source offers from, so late-arriving columns show up there too.
    if (!/[\w$.]/.test(prev) && !expectsColumnHere(view.state.sliceDoc(Math.max(0, pos - 60), pos))) return
    startCompletion(view)
  }

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
