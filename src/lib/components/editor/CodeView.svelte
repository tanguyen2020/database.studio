<script lang="ts">
  // Small Monaco surface for everything that is NOT the query editor: the JSON
  // cell editor and the read-only SQL/DDL previews that used to be `<pre>` blocks
  // coloured by our own highlighter. Monaco is already in the bundle (loaded on
  // demand — see $lib/editor/monaco), so these get real tokenizing per dialect,
  // folding, find and selection for free.
  //
  // Deliberately quiet: no completion, no lint, no context menu, no minimap. It is
  // a viewer/small editor, not a second query editor.
  import { onMount } from 'svelte'
  import type * as monaco from 'monaco-editor'
  import { loadMonaco, defineDsTheme, watchDsTheme, editorFont, DS_THEME, type MonacoApi } from '$lib/editor/monaco'
  import { DS_JSON, registerSqlMonarch } from '$lib/editor/monarch'
  import { highlightJson, jsonTokenColor } from '$lib/format/json'
  import { IS_TAURI } from '$lib/demo'

  interface Props {
    value: string
    /** language id — DS_JSON, or editorLanguageId(system) for SQL */
    language: string
    readOnly?: boolean
    /** fixed CSS height, or 'auto' to grow with the content up to maxHeight */
    height?: string
    /** cap for height:'auto', in px */
    maxHeight?: number
    /** floor for the box, in px — a one-line payload should still read as a viewer */
    minHeight?: number
    autofocus?: boolean
    onChange?: (text: string) => void
    /** Ctrl/Cmd+Enter inside the editor */
    onSubmit?: () => void
    /** Escape inside the editor (Monaco swallows it, so dialogs need this) */
    onCancel?: () => void
    ariaLabel?: string
  }

  let {
    value,
    language,
    readOnly = false,
    height = '40vh',
    maxHeight = 420,
    minHeight = 0,
    autofocus = false,
    onChange,
    onSubmit,
    onCancel,
    ariaLabel = 'Code',
  }: Props = $props()

  let host = $state<HTMLDivElement | null>(null)
  let box = $state<HTMLDivElement | null>(null)
  /** Monaco could not be brought up — show the text as plain, selectable content
   *  instead of an empty box (see the fallback below). */
  let failed = $state(false)
  let editor: monaco.editor.IStandaloneCodeEditor | null = null
  let m: MonacoApi
  const auto = $derived(height === 'auto')

  /** Test seam (browser/demo only, never in the desktop build): the small editors,
   *  so a spec can read the MODEL text instead of Monaco's tokenised spans. */
  function registerTestView(ed: monaco.editor.IStandaloneCodeEditor) {
    if (IS_TAURI) return
    const w = window as unknown as { __dsViews?: monaco.editor.IStandaloneCodeEditor[] }
    w.__dsViews = [...(w.__dsViews ?? []).filter((e) => e !== ed), ed]
  }

  function unregisterTestView(ed: monaco.editor.IStandaloneCodeEditor) {
    if (IS_TAURI) return
    const w = window as unknown as { __dsViews?: monaco.editor.IStandaloneCodeEditor[] }
    w.__dsViews = (w.__dsViews ?? []).filter((e) => e !== ed)
  }

  /** Smallest height that still shows something (below this the viewer reads as
   *  broken — see collapse guard in fitHeight). */
  const MIN_BOX_PX = 28

  /**
   * Size the box from the content when asked (height:'auto'), and — always — catch
   * the case where a percentage height resolved to nothing.
   *
   * A `height:100%` box inside a flex parent whose own height is indefinite (a
   * modal sized by its content, for example) collapses to a few pixels: Monaco
   * then holds the text but the user sees an empty strip. That shipped once (the
   * Kafka/NATS/Redis payload popups measured 7px tall), so the guard belongs in
   * the component, not in each caller.
   */
  function fitHeight() {
    if (!editor || !box) return
    const lines = editor.getModel()?.getLineCount() ?? 1
    const lh = editor.getOption(m.editor.EditorOption.lineHeight) || 18
    const wanted = Math.min(maxHeight, Math.max(minHeight, lh + 12, lines * lh + 12))
    if (auto) {
      box.style.height = `${wanted}px`
      return
    }
    // fixed/percentage height: only step in when the layout gave us nothing
    if (box.getBoundingClientRect().height < MIN_BOX_PX) {
      box.style.height = `${wanted}px`
      box.style.flex = '1 1 auto'
    }
  }

  onMount(() => {
    let disposed = false
    const subs: monaco.IDisposable[] = []

    void (async () => {
      try {
        m = await loadMonaco()
      } catch (e) {
        // The viewer must still show the payload: a dialog whose only job is to
        // display JSON must never come up blank because a chunk failed to load.
        if (!disposed) failed = true
        console.error('CodeView: Monaco failed to load', e)
        return
      }
      if (disposed || !host) return
      defineDsTheme(m)
      watchDsTheme()
      try {
        await registerSqlMonarch(m)
      } catch (e) {
        // Highlighting is optional — keep going with Monaco's built-in languages.
        console.error('CodeView: language registration failed', e)
      }
      if (disposed || !host) return
      const font = editorFont()

      editor = m.editor.create(host, {
        value,
        language,
        theme: DS_THEME,
        readOnly,
        automaticLayout: true,
        fontFamily: font.fontFamily,
        fontSize: font.fontSize - 1,
        lineNumbers: 'off',
        glyphMargin: false,
        folding: true,
        lineDecorationsWidth: 6,
        lineNumbersMinChars: 0,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        renderLineHighlight: 'none',
        overviewRulerLanes: 0,
        hideCursorInOverviewRuler: true,
        scrollbar: { useShadows: false, vertical: 'auto', horizontal: 'auto' },
        wordWrap: 'on',
        // a viewer, not an IDE: nothing here suggests, lints or lightbulbs
        quickSuggestions: false,
        suggestOnTriggerCharacters: false,
        wordBasedSuggestions: 'off',
        parameterHints: { enabled: false },
        codeLens: false,
        links: false,
        contextmenu: false,
        occurrencesHighlight: 'off',
        renderWhitespace: 'none',
        stickyScroll: { enabled: false },
        unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false },
        padding: { top: 6, bottom: 6 },
        // select-all + retype must REPLACE the value, not wrap it in brackets
        autoSurround: 'never',
        ariaLabel,
        domReadOnly: readOnly,
      })

      const model = editor.getModel()!
      subs.push(
        model.onDidChangeContent(() => {
          onChange?.(model.getValue())
          fitHeight()
        }),
        editor.onKeyDown((e: monaco.IKeyboardEvent) => {
          if (e.keyCode === m.KeyCode.Escape) {
            onCancel?.()
            return
          }
          if (e.keyCode === m.KeyCode.Enter && (e.ctrlKey || e.metaKey) && onSubmit) {
            e.preventDefault()
            e.stopPropagation()
            onSubmit()
          }
        }),
      )
      fitHeight()
      // one more pass after the browser has laid the dialog/pane out, which is
      // when a collapsed percentage height becomes visible
      requestAnimationFrame(() => {
        if (!disposed) fitHeight()
      })
      registerTestView(editor)
      if (autofocus) {
        editor.focus()
        editor.setPosition(model.getFullModelRange().getEndPosition())
      }
    })()

    return () => {
      disposed = true
      if (editor) unregisterTestView(editor)
      for (const s of subs) s.dispose()
      const model = editor?.getModel()
      editor?.dispose()
      model?.dispose()
      editor = null
    }
  })

  // Text replaced from outside (Format / Minify, or a new value to preview).
  $effect(() => {
    const next = value
    const model = editor?.getModel()
    if (!model || model.getValue() === next) return
    // one undo step, and keep the caret where it was when possible
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: next }], () => null)
    fitHeight()
  })

  $effect(() => {
    editor?.updateOptions({ readOnly })
  })

  export function focus() {
    editor?.focus()
  }

  export function getValue(): string {
    return editor?.getModel()?.getValue() ?? value
  }
</script>

<div
  bind:this={box}
  class="cv-box"
  style="{auto ? '' : `height:${height};`}min-height:{Math.max(minHeight, MIN_BOX_PX)}px"
>
  {#if failed}
    <!-- Monaco is unavailable: selectable text beats an empty viewer, and JSON
         still gets its colours from the app's own tokenizer. -->
    <pre class="selectable mono cv-fallback" aria-label={ariaLabel}>{#if language === DS_JSON}{#each highlightJson(value) as t}<span
            style="color:{jsonTokenColor(t.kind)}">{t.text}</span>{/each}{:else}{value}{/if}</pre>
  {:else}
    <div bind:this={host} class="cv-host"></div>
  {/if}
</div>

<style>
  .cv-box {
    width: 100%;
    box-sizing: border-box;
    border-radius: var(--px-9);
    border: var(--px-1) solid var(--border);
    background: var(--panel);
    overflow: hidden;
  }
  .cv-host {
    width: 100%;
    height: 100%;
  }
  .cv-fallback {
    margin: 0;
    width: 100%;
    height: 100%;
    overflow: auto;
    padding: var(--px-8);
    font-size: var(--px-12);
    color: var(--text2);
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
