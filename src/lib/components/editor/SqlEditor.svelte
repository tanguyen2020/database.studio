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
    defaultHighlightStyle,
  } from '@codemirror/language'
  import {
    autocompletion,
    closeBrackets,
    closeBracketsKeymap,
    completionKeymap,
  } from '@codemirror/autocomplete'
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
    /** lint tầng 1 — advisory, debounce 400ms do linter đảm nhiệm, KHÔNG chặn Run */
    lintSource?: (doc: string) => Promise<Diagnostic[]>
    onChange?: (doc: string) => void
    onRun?: () => void
    onRunAtCursor?: () => void
    onCancel?: () => void
  }

  let {
    value,
    system,
    readOnly = false,
    schema,
    defaultSchema,
    lintSource,
    onChange,
    onRun,
    onRunAtCursor,
    onCancel,
  }: Props = $props()

  let container = $state<HTMLDivElement | null>(null)
  let view: EditorView | null = null
  const langCompartment = new Compartment()

  function langExt(sys: string) {
    return sql({ dialect: dialectFor(sys), schema, defaultSchema })
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
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
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
            key: 'Escape',
            run: () => {
              onCancel?.()
              return false // let Esc also close panels etc.
            },
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
