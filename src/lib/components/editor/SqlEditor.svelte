<script module lang="ts">
  // Monaco SQL editor (replaces the CodeMirror 6 view — typing/rendering are
  // Monaco's now, which is what the switch was for).
  //
  // What is DELIBERATELY unchanged: the completion SOURCES. Schema/keyword
  // completion still comes from @codemirror/lang-sql and the column/function/Mongo
  // sources still live in SqlWorkspace, driven through a headless CodeMirror
  // document (see $lib/editor/cm-headless). That keeps every test-pinned
  // behaviour — reserved-word quoting on accept, alias-aware `alias.column`,
  // dotted schema keys, quoted identifiers — instead of re-deriving it.
  import {
    monaco,
    installMonacoWorkers,
    defineDsTheme,
    watchDsTheme,
    releaseAppKeybindings,
  } from '$lib/editor/monaco'
  import { registerSqlMonarch } from '$lib/editor/monarch'
  import { SQL_SYSTEMS, editorLanguageId } from '$lib/editor/dialect'
  import { IS_TAURI } from '$lib/demo'

  /** Per-model hooks, so ONE global completion provider can serve every open tab
   *  (tabs stay mounted — see the keep-alive pane in App.svelte). */
  type ModelHooks = {
    complete: (
      model: monaco.editor.ITextModel,
      position: monaco.Position,
      ctx: monaco.languages.CompletionContext,
    ) => Promise<monaco.languages.CompletionList>
  }
  const hooksByModel = new Map<monaco.editor.ITextModel, ModelHooks>()

  const KIND: Record<string, monaco.languages.CompletionItemKind> = {
    property: monaco.languages.CompletionItemKind.Field,
    type: monaco.languages.CompletionItemKind.Class,
    class: monaco.languages.CompletionItemKind.Struct,
    method: monaco.languages.CompletionItemKind.Method,
    function: monaco.languages.CompletionItemKind.Function,
    keyword: monaco.languages.CompletionItemKind.Keyword,
    constant: monaco.languages.CompletionItemKind.Constant,
    variable: monaco.languages.CompletionItemKind.Variable,
  }
  export function completionKind(type: string | undefined): monaco.languages.CompletionItemKind {
    return KIND[type ?? ''] ?? monaco.languages.CompletionItemKind.Variable
  }

  /** Test seam (browser/demo only — never in the desktop build): the editor
   *  instances, so a spec can ask the MODEL how many lines it holds instead of
   *  counting rendered gutter elements (Monaco virtualises them, and a hidden
   *  keep-alive pane renders none at all). */
  function registerTestEditor(ed: monaco.editor.IStandaloneCodeEditor) {
    if (IS_TAURI) return
    const w = window as unknown as { __dsEditors?: monaco.editor.IStandaloneCodeEditor[] }
    w.__dsEditors = [...(w.__dsEditors ?? []).filter((e) => e !== ed), ed]
  }

  function unregisterTestEditor(ed: monaco.editor.IStandaloneCodeEditor) {
    if (IS_TAURI) return
    const w = window as unknown as { __dsEditors?: monaco.editor.IStandaloneCodeEditor[] }
    w.__dsEditors = (w.__dsEditors ?? []).filter((e) => e !== ed)
  }

  let bootstrapped = false
  function bootstrapMonaco() {
    if (bootstrapped) return
    bootstrapped = true
    installMonacoWorkers()
    defineDsTheme()
    watchDsTheme()
    releaseAppKeybindings()
    registerSqlMonarch()
    // '.' → qualified names, '$' → Mongo operators, ' ' → a column position with
    // nothing typed yet (right after WHERE / SET / AND …), which the sources
    // answer and Monaco would otherwise never ask about.
    const triggerCharacters = ['.', '$', ' ']
    for (const lang of [...SQL_SYSTEMS.map(editorLanguageId), 'javascript']) {
      monaco.languages.registerCompletionItemProvider(lang, {
        triggerCharacters,
        provideCompletionItems: (model: monaco.editor.ITextModel, position: monaco.Position, ctx: monaco.languages.CompletionContext) =>
          hooksByModel.get(model)?.complete(model, position, ctx) ?? { suggestions: [] },
      })
    }
  }
</script>

<script lang="ts">
  import { onMount } from 'svelte'
  import { editorFont, DS_THEME } from '$lib/editor/monaco'
  import { HeadlessDoc, runSources } from '$lib/editor/cm-headless'
  import { mapCompletions } from '$lib/editor/completion-map'
  import { functionCatalog, type FnHint } from '$lib/sql/functions'
  import { expectsColumnHere } from '$lib/sql/column-context'
  import { lineColToOffset } from '$lib/sql/statements'
  import { schemaCompletionSource, keywordCompletionSource, type SQLNamespace } from '@codemirror/lang-sql'
  import { sqlDialectFor } from '$lib/editor/dialect'
  import { settings } from '$lib/stores/settings.svelte'
  import type { Completion, CompletionSource } from '@codemirror/autocomplete'
  import type { Diagnostic } from '@codemirror/lint'

  interface Props {
    value: string
    system: string
    readOnly?: boolean
    /** schema-aware autocomplete: nested { schema: { table: {self,children} } }
     *  from the explorer cache; reserved identifiers carry a quoted `apply`. */
    schema?: SQLNamespace
    defaultSchema?: string
    /** completion cho `alias.`/`table.` — lazy-load cột của bảng trong FROM/JOIN */
    columnSource?: CompletionSource
    /** functions introspected from the live server (list_functions) — merged with
     *  the static built-ins + curated signatures for the dialect. */
    dynamicFunctions?: FnHint[]
    /** lint tầng 1 — advisory, debounce 400ms, KHÔNG chặn Run */
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
  let editor: monaco.editor.IStandaloneCodeEditor | null = null
  let fnDecorations: monaco.editor.IEditorDecorationsCollection | null = null
  let headless: HeadlessDoc | null = null
  /** Set when Escape closes the popup; cleared on the next edit. Keeps a late
   *  column load (see refreshCompletion) from re-opening a dismissed popup. */
  let completionDismissed = false
  let lintTimer: ReturnType<typeof setTimeout> | null = null

  const LINT_OWNER = 'ds-lint'
  const EXEC_OWNER = 'ds-exec'
  const LINT_DELAY = 400

  /**
   * Editor options the user controls in Settings → Editor. These were never read
   * before (the CodeMirror editor ignored them too); Monaco takes them straight.
   * A missing/blank value falls back to the design tokens, so the defaults look
   * exactly like the prototype.
   */
  function userOptions(): monaco.editor.IEditorOptions {
    const s = settings.value
    const font = editorFont()
    const size = Number(s.fontSize)
    const delay = Number(s.autocompleteDelayMs)
    return {
      fontFamily: (s.fontFamily ?? '').trim() || font.fontFamily,
      fontSize: Number.isFinite(size) && size >= 8 && size <= 40 ? size : font.fontSize,
      wordWrap: s.wordWrap ? 'on' : 'off',
      quickSuggestionsDelay: Number.isFinite(delay) && delay >= 0 && delay <= 2000 ? delay : 20,
    }
  }

  /** Indentation is a MODEL option in Monaco, not an editor one. */
  function userModelOptions(): monaco.editor.ITextModelUpdateOptions {
    const tab = Number(settings.value.tabSize)
    return { tabSize: Number.isFinite(tab) && tab >= 1 && tab <= 8 ? tab : 2, insertSpaces: true }
  }

  /**
   * Keep the user's indentation. Monaco's model service re-detects indentation
   * from the text and overwrites what we set — and its `detectIndentation` flag
   * lives in the configuration service, out of reach of editor options (measured:
   * the tab size applied at mount was silently replaced by 4). Re-assert it when
   * the model reports a change; the equality check keeps this from looping.
   */
  function enforceModelOptions() {
    const model = editor?.getModel()
    if (!model) return
    const want = userModelOptions()
    const cur = model.getOptions()
    if (cur.tabSize !== want.tabSize || cur.insertSpaces !== want.insertSpaces) model.updateOptions(want)
  }

  // Set of known function names for a dialect — the merged catalog (static +
  // curated + introspected `dynamicFunctions`, so server/extension functions like
  // PG `date_trunc` colour too) PLUS the dialect's own `builtin` words (covers
  // ClickHouse's CH_FUNCTIONS). Driven purely by the function catalog: real
  // functions (incl. MSSQL GETDATE/DATEADD which are also dialect keywords) colour,
  // while non-function keywords (IN/VALUES/EXISTS — not in any catalog) do not.
  function fnColorSet(sys: string): Set<string> {
    const set = new Set<string>(functionCatalog(sys, dynamicFunctions ?? []).map((f) => f.name.toLowerCase()))
    for (const w of ((sqlDialectFor(sys).spec?.builtin ?? '') as string).split(/\s+/)) {
      if (w) set.add(w.toLowerCase())
    }
    return set
  }

  /** Function completions (with signatures). The keyword source below does not
   *  carry function names, so a function is suggested exactly once. */
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

  /** Completion sources for the current dialect/schema. Rebuilt only when their
   *  inputs change — `schemaCompletionSource` pre-builds a tree of the whole
   *  catalog, far too expensive to construct per keystroke. */
  let srcSchema: CompletionSource | undefined
  let srcKeyword: CompletionSource | undefined
  let srcFn: CompletionSource | undefined
  let colorSet = new Set<string>()
  function rebuildSources() {
    // MongoDB is mongosh, not SQL: its own source carries the collections,
    // methods, operators and fields — SQL keyword/function noise stays out.
    if (system === 'mongodb') {
      srcSchema = undefined
      srcKeyword = undefined
      srcFn = undefined
      colorSet = new Set()
      return
    }
    const dialect = sqlDialectFor(system)
    srcSchema = schema ? schemaCompletionSource({ dialect, schema, defaultSchema }) : undefined
    srcKeyword = keywordCompletionSource(dialect)
    srcFn = fnSource(system)
    colorSet = fnColorSet(system)
  }

  /** A caret right after `something.` — a qualified name, where only that
   *  table's/alias's columns make sense. */
  function isQualified(doc: string, offset: number): boolean {
    return /[\w$"`\]]\s*\.\s*[\w$]*$/.test(doc.slice(Math.max(0, offset - 80), offset))
  }

  /**
   * Sources to ask, in rank order. After `alias.` the keyword and function
   * sources are skipped: CodeMirror could rank them below the columns (boost),
   * but Monaco sorts by match score FIRST — an exact-match keyword (`or` for
   * `s.or`) would outrank the column `order` and Tab would insert the keyword.
   */
  function sourcesFor(qualified: boolean, word: string, explicit: boolean): (CompletionSource | undefined)[] {
    if (qualified) return [srcSchema, columnSource]
    // Nothing typed yet (the caret sits right after WHERE / SET / AND …, which is
    // why ' ' is a trigger character): only the column source has something
    // meaningful to say. Without this, every space would dump the dialect's whole
    // keyword list — CodeMirror never opened a popup there at all.
    if (!word && !explicit) return [columnSource]
    return [srcSchema, srcKeyword, srcFn, columnSource]
  }

  /**
   * Re-run the providers even when the popup is already open. `editor.action.
   * triggerSuggest` cannot do that — its precondition is "suggest widget NOT
   * visible" — so a late column load would leave the open popup stale. The
   * controller's own method has no such precondition.
   */
  function retriggerSuggest() {
    if (!editor) return
    type Ctrl = { triggerSuggest?: (only?: unknown, auto?: boolean, noFilter?: boolean) => void }
    const ctrl = editor.getContribution('editor.contrib.suggestController') as unknown as Ctrl | null
    if (ctrl?.triggerSuggest) ctrl.triggerSuggest(undefined, false, false)
    else editor.trigger('ds.completion', 'editor.action.triggerSuggest', {})
  }

  /** Text already typed at the caret — decides which suggestion is preselected. */
  function wordBefore(doc: string, offset: number): string {
    return /[\w$]*$/.exec(doc.slice(Math.max(0, offset - 64), offset))?.[0] ?? ''
  }

  async function complete(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
    ctx: monaco.languages.CompletionContext,
  ): Promise<monaco.languages.CompletionList> {
    if (!headless) return { suggestions: [] }
    const doc = model.getValue()
    const offset = model.getOffsetAt(position)
    const explicit = ctx.triggerKind === monaco.languages.CompletionTriggerKind.Invoke
    const cmCtx = headless.context(doc, offset, explicit)
    const word = wordBefore(doc, offset)
    const results = await runSources(sourcesFor(isQualified(doc, offset), word, explicit), cmCtx)
    const items = mapCompletions(results, word)
    const end = model.getPositionAt(offset)
    // All options from one source share a `from`, and a big catalog can return
    // thousands of them — resolve each distinct offset once instead of per item.
    const posCache = new Map<number, monaco.Position>()
    const posAt = (o: number) => {
      let p = posCache.get(o)
      if (!p) {
        p = model.getPositionAt(o)
        posCache.set(o, p)
      }
      return p
    }
    const suggestions = items.map((it) => {
      const start = posAt(it.from)
      const stop = it.to != null ? posAt(it.to) : end
      return {
        label: it.label,
        kind: completionKind(it.kind),
        insertText: it.insertText,
        detail: it.detail,
        documentation: it.documentation,
        preselect: it.preselect,
        // no filterText/sortText on purpose: filterText would only repeat the
        // label (and push Monaco onto its slower two-pass scoring path), and
        // Monaco's suggest sorts by score → distance → array order, never by
        // sortText — so both were pure cost per item on a big catalog.
        range: {
          startLineNumber: start.lineNumber,
          startColumn: start.column,
          endLineNumber: stop.lineNumber,
          endColumn: stop.column,
        },
      } satisfies monaco.languages.CompletionItem
    })
    // `incomplete` re-asks the sources on every keystroke (CodeMirror did the
    // same): that is how lazily-loaded columns and a freshly loaded catalog show
    // up without the user having to close and re-open the popup.
    return { suggestions, incomplete: true }
  }

  // ---- function-call colouring ------------------------------------------------
  // A decoration, not a tokenizer entry: putting catalog names into the language's
  // keyword list makes the tokenizer read a table prefix as a complete keyword
  // (typing `ord` then offered MySQL's `ORD` instead of the table `order`).
  // Only the visible range is scanned, so a 10k-line script stays cheap.
  function refreshFnDecorations() {
    if (!editor || !fnDecorations) return
    const model = editor.getModel()
    if (!model || colorSet.size === 0) {
      fnDecorations.set([])
      return
    }
    const decos: monaco.editor.IModelDeltaDecoration[] = []
    const re = /\b([A-Za-z_]\w*)\s*(?=\()/g
    for (const range of editor.getVisibleRanges()) {
      const last = Math.min(range.endLineNumber, model.getLineCount())
      for (let line = range.startLineNumber; line <= last; line++) {
        const text = model.getLineContent(line)
        re.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = re.exec(text))) {
          if (!colorSet.has(m[1].toLowerCase())) continue
          decos.push({
            range: new monaco.Range(line, m.index + 1, line, m.index + 1 + m[1].length),
            options: { inlineClassName: 'sql-fn' },
          })
        }
      }
    }
    fnDecorations.set(decos)
  }

  // ---- one flush per frame ----------------------------------------------------
  // Monaco reports a content change PER CHARACTER when a block of text lands at
  // once (a paste, or Playwright's insertText) — CodeMirror delivered that as a
  // single transaction. Everything below is O(document): reading the text out for
  // `onChange` (tab state + dirty flag), re-scanning the viewport for function
  // colouring, re-arming the lint timer. Measured on a 3.4 kB insert: 1737 ms
  // doing it per change, ~130 ms coalesced. One frame of delay is invisible, and
  // Run always reads the model directly (getDoc), never this.
  let flushFrame: number | null = null
  let pendingChange = false

  function scheduleFlush() {
    pendingChange = true
    if (flushFrame != null) return
    flushFrame = requestAnimationFrame(() => {
      flushFrame = null
      if (!pendingChange) return
      pendingChange = false
      flushChange()
    })
  }

  function flushChange(withLint = true) {
    const model = editor?.getModel()
    if (!model) return
    onChange?.(model.getValue())
    refreshFnDecorations()
    if (withLint) scheduleLint()
  }

  // ---- lint (advisory, debounced — never blocks Run) --------------------------
  function scheduleLint() {
    if (!lintSource) return
    if (lintTimer) clearTimeout(lintTimer)
    lintTimer = setTimeout(() => void runLint(), LINT_DELAY)
  }

  async function runLint() {
    const model = editor?.getModel()
    if (!model || !lintSource) return
    const doc = model.getValue()
    let diags: Diagnostic[] = []
    try {
      diags = await lintSource(doc)
    } catch {
      diags = []
    }
    if (model.isDisposed() || model.getValue() !== doc) return // stale
    monaco.editor.setModelMarkers(model, LINT_OWNER, diags.map((d) => toMarker(model, d)))
  }

  function toMarker(model: monaco.editor.ITextModel, d: Diagnostic): monaco.editor.IMarkerData {
    const from = model.getPositionAt(Math.max(0, d.from))
    const to = model.getPositionAt(Math.max(d.from + 1, d.to))
    return {
      message: d.message,
      severity:
        d.severity === 'error'
          ? monaco.MarkerSeverity.Error
          : d.severity === 'warning'
            ? monaco.MarkerSeverity.Warning
            : monaco.MarkerSeverity.Info,
      startLineNumber: from.lineNumber,
      startColumn: from.column,
      endLineNumber: to.lineNumber,
      endColumn: to.column,
    }
  }

  onMount(() => {
    bootstrapMonaco()
    rebuildSources()
    headless = new HeadlessDoc(sqlDialectFor(system).extension, value)

    editor = monaco.editor.create(container!, {
      value,
      language: editorLanguageId(system),
      theme: DS_THEME,
      readOnly,
      ...userOptions(),
      automaticLayout: true,
      lineNumbers: 'on',
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderLineHighlight: 'line',
      renderWhitespace: 'selection',
      insertSpaces: true,
      folding: true,
      // widgets must escape the pane's clipping (the editor sits in a fixed-height
      // flex row above the result panel)
      fixedOverflowWidgets: true,
      // the app owns right-click (see native-menu guard) — no editor menu
      contextmenu: false,
      // no language service here: nothing to hover-doc, lens or lint-fix. Hover
      // stays ON so a lint/execution error explains itself in a tooltip.
      codeLens: false,
      links: false,
      lightbulb: { enabled: monaco.editor.ShowLightbulbIconMode.Off },
      parameterHints: { enabled: false },
      stickyScroll: { enabled: false },
      unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false },
      quickSuggestions: { other: true, comments: false, strings: false },
      suggestOnTriggerCharacters: true,
      acceptSuggestionOnEnter: 'on',
      // Tab/Enter accept; a commit character never inserts behind the user's back
      acceptSuggestionOnCommitCharacter: false,
      tabCompletion: 'off',
      wordBasedSuggestions: 'off',
      suggest: { showWords: false, insertMode: 'replace', showStatusBar: false },
      padding: { top: 6, bottom: 6 },
      ariaLabel: 'Query editor',
      scrollbar: { useShadows: false },
    })

    const model = editor.getModel()!
    hooksByModel.set(model, { complete })
    model.updateOptions(userModelOptions())
    registerTestEditor(editor)
    fnDecorations = editor.createDecorationsCollection([])
    refreshFnDecorations()
    scheduleLint()

    const subs = [
      model.onDidChangeContent(() => {
        completionDismissed = false // typing again re-arms completion
        scheduleFlush()
      }),
      editor.onDidScrollChange(() => refreshFnDecorations()),
      model.onDidChangeOptions(() => enforceModelOptions()),
      editor.onKeyDown((e: monaco.IKeyboardEvent) => {
        if (e.keyCode !== monaco.KeyCode.Escape) return
        completionDismissed = true // don't let a late load re-open the popup
        onCancel?.()
        // no preventDefault: Escape must still close the suggest/find widget
      }),
    ]

    // Run/format bindings. `addAction` keeps them scoped to this editor instance,
    // which matters because every open tab has its own live editor.
    const actions: [string, string, number[], () => void][] = [
      ['ds.run', 'Run', [monaco.KeyCode.F5], () => onRun?.()],
      ['ds.runAtCursor', 'Run statement at cursor', [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter], () => onRunAtCursor?.()],
      ['ds.cancel', 'Cancel', [monaco.KeyMod.CtrlCmd | monaco.KeyCode.F5], () => onCancel?.()],
      ['ds.format', 'Format SQL', [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF], () => onFormat?.()],
      ['ds.explain', 'Explain', [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyE], () => onExplain?.()],
      ['ds.save', 'Save', [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS], () => onSaveSnippet?.()],
    ]
    for (const [id, label, keybindings, run] of actions) {
      editor.addAction({ id, label, keybindings, run })
    }

    return () => {
      if (lintTimer) clearTimeout(lintTimer)
      if (flushFrame != null) cancelAnimationFrame(flushFrame)
      // a tab closed one frame after the last edit must still report that edit
      if (pendingChange) flushChange(false)
      for (const s of subs) s.dispose()
      const m = editor?.getModel()
      if (m) hooksByModel.delete(m)
      if (editor) unregisterTestEditor(editor)
      editor?.dispose()
      m?.dispose()
      editor = null
      headless = null
    }
  })

  // dialect/schema đổi (đổi connection trong tab, cache autocomplete nạp xong,
  // server functions vừa về) → dựng lại completion sources + bảng màu hàm.
  $effect(() => {
    void schema
    void defaultSchema
    void system
    void dynamicFunctions
    void columnSource
    rebuildSources()
    headless?.setLanguage(sqlDialectFor(system).extension)
    const model = editor?.getModel()
    if (model) monaco.editor.setModelLanguage(model, editorLanguageId(system))
    refreshFnDecorations()
  })

  $effect(() => {
    editor?.updateOptions({ readOnly })
  })

  // Settings → Editor applies live: changing the font size or word wrap must not
  // need the tab to be reopened.
  $effect(() => {
    const s = settings.value
    void s.fontSize
    void s.fontFamily
    void s.tabSize
    void s.wordWrap
    void s.autocompleteDelayMs
    editor?.updateOptions(userOptions())
    editor?.getModel()?.updateOptions(userModelOptions())
  })

  // ---- public API (via bind:this) ----

  /** Focus the editor (e.g. when a fresh Query tab opens via Ctrl/Cmd+N). */
  export function focus() {
    editor?.focus()
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
   *   - the caret must sit right after an identifier char or a dot, or in a
   *     position that expects a column with nothing typed yet. */
  export function refreshCompletion() {
    if (!editor?.hasTextFocus() || completionDismissed) return
    const model = editor.getModel()
    const pos = editor.getPosition()
    if (!model || !pos) return
    const offset = model.getOffsetAt(pos)
    const doc = model.getValue()
    const prev = doc.slice(Math.max(0, offset - 1), offset)
    if (!/[\w$.]/.test(prev) && !expectsColumnHere(doc.slice(Math.max(0, offset - 60), offset))) return
    retriggerSuggest()
  }

  export function getDoc(): string {
    return editor?.getModel()?.getValue() ?? ''
  }

  /** Thay toàn bộ nội dung (Format SQL) — giữ trong 1 transaction để undo được. */
  export function setDoc(next: string) {
    const model = editor?.getModel()
    if (!model || !editor) return
    editor.pushUndoStop()
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: next }], () => null)
    editor.pushUndoStop()
  }

  export function getSelection(): string {
    const model = editor?.getModel()
    const sel = editor?.getSelection()
    if (!model || !sel) return ''
    return sel.isEmpty() ? '' : model.getValueInRange(sel)
  }

  /** 0-based [from, to) of the primary selection (from === to when empty). */
  export function getSelectionRange(): { from: number; to: number } {
    const model = editor?.getModel()
    const sel = editor?.getSelection()
    if (!model || !sel) return { from: 0, to: 0 }
    return {
      from: model.getOffsetAt(sel.getStartPosition()),
      to: model.getOffsetAt(sel.getEndPosition()),
    }
  }

  export function getCursorOffset(): number {
    const model = editor?.getModel()
    const pos = editor?.getPosition()
    if (!model || !pos) return 0
    return model.getOffsetAt(pos)
  }

  /** Jump to a 1-based line/col and focus (Messages click-to-jump). */
  export function jumpTo(line: number, col: number) {
    const model = editor?.getModel()
    if (!model || !editor) return
    const pos = model.getPositionAt(lineColToOffset(model.getValue(), line, col))
    editor.setPosition(pos)
    editor.revealPositionInCenterIfOutsideViewport(pos)
    editor.focus()
  }

  /** Highlight execution errors (positions already mapped to the document). */
  export function showErrors(
    errors: { line: number; col: number; endLine?: number; endCol?: number; message: string }[],
  ) {
    const model = editor?.getModel()
    if (!model) return
    const doc = model.getValue()
    const markers = errors.map((e) => {
      const from = lineColToOffset(doc, e.line, e.col)
      const to =
        e.endLine != null && e.endCol != null
          ? lineColToOffset(doc, e.endLine, e.endCol)
          : Math.min(from + 1, doc.length)
      return toMarker(model, { from, to: Math.max(to, from + 1), severity: 'error', message: e.message })
    })
    monaco.editor.setModelMarkers(model, EXEC_OWNER, markers)
  }

  export function clearErrors() {
    const model = editor?.getModel()
    if (model) monaco.editor.setModelMarkers(model, EXEC_OWNER, [])
  }
</script>

<div bind:this={container} class="ds-editor h-full min-h-0 overflow-hidden selectable" data-editor="sql"></div>

<style>
  /* Known function calls, coloured by the decoration above. Three classes beat
     Monaco's own two-class token rule, so no !important is needed. */
  :global(.monaco-editor .view-lines .sql-fn) {
    color: var(--syntax-function);
  }
  /* The suggestion popup: wide enough to read a signature, with the qualifier
     (schema for a table, data type for a column) at the right edge. Monaco sets
     an inline width of its own; min-width wins over it without !important. */
  :global(.monaco-editor .suggest-widget) {
    min-width: var(--px-520);
    font-family: var(--font-mono);
  }
  /* Monaco's row wrapper is `display: contents`, so the content block sizes to
     the text and the qualifier ends up glued to the label. Let it fill the row —
     its own `justify-content: space-between` then puts the qualifier at the edge. */
  :global(.monaco-editor .suggest-widget .monaco-list-row .main) {
    flex: 1 1 auto;
    min-width: 0;
  }
  /* the qualifier must stay legible on the highlighted (blue) row */
  :global(.monaco-editor .suggest-widget .monaco-list-row.focused .details-label) {
    color: var(--hex-fff);
    opacity: 1;
  }
</style>
