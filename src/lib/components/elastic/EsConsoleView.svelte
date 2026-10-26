<script lang="ts">
  // Dev Tools · Console (Kibana): requests on the left, response on the right.
  // ▶ in the gutter (or Ctrl+Enter) runs the request at the caret; a selection runs
  // every request it touches, one after another. Auto-indent, copy as cURL,
  // variables (${name}), history — the whole REST API is reachable from here.
  import { onMount, untrack } from 'svelte'
  import '$lib/elastic/es.css'
  import type * as monaco from 'monaco-editor'
  import * as ipc from '$lib/ipc'
  import type { TabState } from '$lib/types'
  import { connections } from '$lib/stores/connections.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { explorer } from '$lib/stores/explorer.svelte'
  import CodeView from '$lib/components/editor/CodeView.svelte'
  import { DS_JSON } from '$lib/editor/monarch'
  import { DS_THEME, defineDsTheme, editorFont, loadMonaco, releaseAppKeybindings, watchDsTheme, type MonacoApi } from '$lib/editor/monaco'
  import EsIcon from './EsIcon.svelte'
  import EsAppIcon from './EsAppIcon.svelte'
  import {
    applyVariables,
    bodyToWire,
    formatBody,
    normalizePath,
    parseConsole,
    requestAt,
    requestsIn,
    STATUS_TEXT,
    statusTone,
    toCurl,
    type ConsoleRequest,
  } from '$lib/elastic/console'
  import { ES_CONSOLE_LANG, registerConsoleLanguage, setConsoleContext } from '$lib/elastic/monaco-console'
  import { searchProduct } from '$lib/elastic/flavor'

  let { tab }: { tab: TabState } = $props()
  const connId = $derived(tab.connectionId ?? '')
  // the tab object is stable for this component's lifetime
  const st = untrack(() => tab.state as { text?: string; seed?: string; vars?: { name: string; value: string }[] })

  const DEFAULT_TEXT = `# Welcome to the Dev Tools console.
# Run the request at the caret with ▶ or Ctrl+Enter. Select several to run them in order.

GET _cluster/health

GET _cat/indices?v&s=index

GET /_search
{
  "query": {
    "match_all": {}
  },
  "size": 10
}
`

  let host = $state<HTMLDivElement | null>(null)
  let editor: monaco.editor.IStandaloneCodeEditor | null = null
  let m: MonacoApi
  let failed = $state(false)
  let running = $state(false)
  let output = $state('')
  let lastStatus = $state<{ status: number; took: number; bytes: number; method: string; path: string } | null>(null)
  let warnings = $state<string[]>([])
  let localError = $state<string | null>(null)
  let vars = $state<{ name: string; value: string }[]>(st.vars ?? [])
  let panel = $state<'none' | 'vars' | 'history' | 'help'>('none')
  let indexNames = $state<string[]>([])
  let splitPct = $state(52)
  const fieldsCache = new Map<string, Promise<string[]>>()

  const HISTORY_KEY = $derived(`es-console-history:${connId}`)
  let history = $state<{ method: string; path: string; body: string; at: number }[]>([])

  function loadHistory() {
    try {
      history = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]')
    } catch {
      history = []
    }
  }
  function pushHistory(r: ConsoleRequest) {
    history = [{ method: r.method, path: r.path, body: r.body, at: Date.now() }, ...history.filter((h) => !(h.method === r.method && h.path === r.path && h.body === r.body))].slice(0, 50)
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history))
    } catch {
      /* private mode */
    }
  }

  function initialText(): string {
    if (st.seed) {
      const s = st.seed
      st.seed = undefined
      return s
    }
    return st.text ?? DEFAULT_TEXT
  }

  let decorations: monaco.editor.IEditorDecorationsCollection | null = null
  function refreshDecorations() {
    if (!editor) return
    const reqs = parseConsole(editor.getValue())
    const caret = editor.getPosition()?.lineNumber ?? 1
    const cur = requestAt(reqs, caret)
    decorations?.set([
      ...reqs.map((r) => ({
        range: new m.Range(r.startLine, 1, r.startLine, 1),
        options: { glyphMarginClassName: 'es-run-glyph', glyphMarginHoverMessage: { value: `Run ${r.method} ${r.path}` } },
      })),
      ...(cur
        ? [{ range: new m.Range(cur.startLine, 1, cur.endLine, 1), options: { isWholeLine: true, className: 'es-req-active' } }]
        : []),
    ])
  }

  onMount(() => {
    let disposed = false
    const subs: monaco.IDisposable[] = []
    loadHistory()
    void ipc
      .esIndices(connId)
      .then((ix) => (indexNames = ix.filter((i) => !i.hidden).map((i) => i.name)))
      .catch(() => {})
    const ctx = {
      indexNames: () => indexNames,
      flavor: () => searchProduct(connId).flavor,
      fieldsOf: (index: string) => {
        if (!fieldsCache.has(index)) fieldsCache.set(index, ipc.esMappingFields(connId, index).then((f) => f.map(([n]) => n)).catch(() => []))
        return fieldsCache.get(index)!
      },
    }
    void (async () => {
      try {
        m = await loadMonaco()
      } catch (e) {
        if (!disposed) failed = true
        console.error('Console: Monaco failed to load', e)
        return
      }
      if (disposed || !host) return
      defineDsTheme(m)
      watchDsTheme()
      registerConsoleLanguage(m)
      releaseAppKeybindings(m)
      const font = editorFont()
      editor = m.editor.create(host, {
        value: initialText(),
        language: ES_CONSOLE_LANG,
        theme: DS_THEME,
        automaticLayout: true,
        fontFamily: font.fontFamily,
        fontSize: font.fontSize,
        glyphMargin: true,
        lineNumbers: 'on',
        lineNumbersMinChars: 3,
        folding: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        tabSize: 2,
        wordWrap: 'on',
        quickSuggestions: { other: true, strings: true, comments: false },
        suggestOnTriggerCharacters: true,
        wordBasedSuggestions: 'off',
        contextmenu: false,
        stickyScroll: { enabled: false },
        acceptSuggestionOnCommitCharacter: false,
        renderLineHighlight: 'line',
        padding: { top: 8, bottom: 8 },
        ariaLabel: 'Console requests',
      })
      decorations = editor.createDecorationsCollection([])
      const model = editor.getModel()!
      model.setEOL(m.editor.EndOfLineSequence.LF)
      setConsoleContext(ctx)
      subs.push(
        model.onDidChangeContent(() => {
          st.text = model.getValue()
          refreshDecorations()
        }),
        editor.onDidChangeCursorPosition(() => refreshDecorations()),
        editor.onDidFocusEditorText(() => setConsoleContext(ctx)),
        editor.onMouseDown((e) => {
          if (e.target.type === m.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && e.target.position) {
            const r = requestAt(parseConsole(model.getValue()), e.target.position.lineNumber)
            if (r && r.startLine === e.target.position.lineNumber) void runRequests([r])
          }
        }),
      )
      editor.addAction({ id: 'es.run', label: 'Run request', keybindings: [m.KeyMod.CtrlCmd | m.KeyCode.Enter], run: () => void runAtCaret() })
      editor.addAction({ id: 'es.indent', label: 'Auto indent', keybindings: [m.KeyMod.CtrlCmd | m.KeyCode.KeyI], run: () => autoIndent() })
      refreshDecorations()
      registerTestEditor(editor)
      editor.focus()
    })()
    return () => {
      disposed = true
      if (editor) unregisterTestEditor(editor)
      for (const s of subs) s.dispose()
      const model = editor?.getModel()
      editor?.dispose()
      model?.dispose()
      editor = null
    }
  })

  /** Test seam (browser/demo only): specs read / write the console's model. */
  function registerTestEditor(ed: monaco.editor.IStandaloneCodeEditor) {
    if (typeof window === 'undefined' || '__TAURI_INTERNALS__' in window) return
    const w = window as unknown as { __esConsole?: monaco.editor.IStandaloneCodeEditor }
    w.__esConsole = ed
  }
  function unregisterTestEditor(ed: monaco.editor.IStandaloneCodeEditor) {
    const w = window as unknown as { __esConsole?: monaco.editor.IStandaloneCodeEditor }
    if (w.__esConsole === ed) w.__esConsole = undefined
  }

  function currentRequests(): ConsoleRequest[] {
    if (!editor) return []
    const reqs = parseConsole(editor.getValue())
    const sel = editor.getSelection()
    if (sel && !sel.isEmpty()) return requestsIn(reqs, sel.startLineNumber, sel.endLineNumber)
    const r = requestAt(reqs, editor.getPosition()?.lineNumber ?? 1)
    return r ? [r] : []
  }

  async function runAtCaret() {
    const reqs = currentRequests()
    if (!reqs.length) {
      toasts.show('Put the caret in a request (a line starting with GET / POST / PUT / DELETE…)', { system: 'elasticsearch' })
      return
    }
    await runRequests(reqs)
  }

  async function runRequests(reqs: ConsoleRequest[]) {
    if (running) return
    running = true
    localError = null
    warnings = []
    const parts: string[] = []
    try {
      for (const r of reqs) {
        const path = normalizePath(applyVariables(r.path, vars))
        const { wire, error } = bodyToWire(path, applyVariables(r.body, vars))
        if (error && reqs.length === 1) localError = `Request body is not valid JSON (${error}) — sent as typed.`
        const res = await ipc.esRequest(connId, r.method, path, wire)
        pushHistory(r)
        lastStatus = { status: res.status, took: res.took_ms, bytes: res.bytes, method: r.method, path }
        warnings = [...warnings, ...res.warnings]
        const body = res.json != null ? JSON.stringify(res.json, null, 2) : (res.text ?? (r.method === 'HEAD' ? '' : ''))
        const head = reqs.length > 1 ? `# ${r.method} ${path} ${res.status} ${STATUS_TEXT[res.status] ?? ''}\n` : ''
        parts.push(head + (body || (r.method === 'HEAD' ? `${res.status} ${STATUS_TEXT[res.status] ?? ''}` : '')))
        // index-level writes change what the explorer shows
        if (res.ok && r.method !== 'GET' && r.method !== 'HEAD') explorer.bumpEs(connId)
      }
    } catch (e) {
      localError = String((e as Error).message ?? e)
    } finally {
      output = parts.join('\n\n')
      running = false
    }
  }

  function autoIndent() {
    if (!editor) return
    const model = editor.getModel()!
    const reqs = currentRequests()
    const edits: monaco.editor.IIdentifiedSingleEditOperation[] = []
    for (const r of reqs) {
      if (!r.body.trim()) continue
      const formatted = formatBody(r.path, r.body)
      edits.push({ range: new m.Range(r.startLine + 1, 1, r.endLine, model.getLineMaxColumn(r.endLine)), text: formatted })
    }
    if (edits.length) editor.executeEdits('es-auto-indent', edits)
  }

  async function copyCurl() {
    const reqs = currentRequests()
    if (!reqs.length) return
    const p = connections.byId(connId)
    const base = p ? (/^https?:\/\//i.test(p.host) ? p.host : `${p.ssl ? 'https' : 'http'}://${p.host}:${p.port}`) : 'http://localhost:9200'
    const text = reqs.map((r) => toCurl({ ...r, path: applyVariables(r.path, vars), body: applyVariables(r.body, vars) }, base)).join('\n\n')
    await navigator.clipboard.writeText(text)
    toasts.success(`Copied ${reqs.length === 1 ? 'request' : `${reqs.length} requests`} as cURL (no credentials)`, 'elasticsearch')
  }

  function insertFromHistory(h: { method: string; path: string; body: string }) {
    if (!editor) return
    const model = editor.getModel()!
    const end = model.getLineCount()
    const text = `\n${h.method} ${h.path}${h.body ? `\n${h.body}` : ''}\n`
    editor.executeEdits('es-history', [{ range: new m.Range(end, model.getLineMaxColumn(end), end, model.getLineMaxColumn(end)), text }])
    editor.revealLine(model.getLineCount())
    editor.setPosition({ lineNumber: end + 2, column: 1 })
    editor.focus()
    panel = 'none'
  }

  function persistVars() {
    st.vars = $state.snapshot(vars)
  }

  // splitter between request and response
  function dragSplit(e: PointerEvent) {
    const wrap = (e.currentTarget as HTMLElement).parentElement!
    const rect = wrap.getBoundingClientRect()
    const move = (ev: PointerEvent) => {
      splitPct = Math.min(80, Math.max(20, ((ev.clientX - rect.left) / rect.width) * 100))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const tone = $derived(lastStatus ? statusTone(lastStatus.status) : null)
</script>

<div class="es-page" data-testid="es-console">
  <div class="esc-bar">
    <span class="esc-title"><EsAppIcon name="console" size={20} /> Console</span>
    <button class="eg-btn primary" onclick={runAtCaret} disabled={running} aria-busy={running} title="Run the request at the caret (Ctrl+Enter)">
      {#if running}<span class="es-spin"><EsIcon name="refresh" size={13} /></span>{:else}<EsIcon name="play" size={13} />{/if}
      {running ? 'Running…' : 'Send request'}
    </button>
    <button class="eg-btn" onclick={autoIndent} title="Auto indent (Ctrl+I)"><EsIcon name="json" size={13} /> Auto indent</button>
    <button class="eg-btn" onclick={copyCurl} title="Copy the request as a cURL command"><EsIcon name="curl" size={13} /> Copy as cURL</button>
    <span style="margin-left:auto;display:flex;gap:var(--px-6)">
      <button class="eg-btn" class:primary={panel === 'vars'} onclick={() => (panel = panel === 'vars' ? 'none' : 'vars')}>Variables{vars.length ? ` (${vars.length})` : ''}</button>
      <button class="eg-btn" class:primary={panel === 'history'} onclick={() => (panel = panel === 'history' ? 'none' : 'history')}><EsIcon name="history" size={13} /> History</button>
      <button class="eg-btn" class:primary={panel === 'help'} onclick={() => (panel = panel === 'help' ? 'none' : 'help')}><EsIcon name="info" size={13} /> Help</button>
    </span>
  </div>

  {#if panel !== 'none'}
    <div class="esc-panel">
      {#if panel === 'vars'}
        <div class="es-help" style="margin:0 0 var(--px-8)">Use <span class="mono">{'${name}'}</span> in a path or body — replaced before the request is sent.</div>
        {#each vars as v, i (i)}
          <div style="display:flex;gap:var(--px-6);margin-bottom:var(--px-6)">
            <input class="es-input mono" style="width:var(--px-180)" bind:value={v.name} placeholder="name" aria-label="Variable name {i + 1}" onchange={persistVars} />
            <input class="es-input mono" style="flex:1 1 auto" bind:value={v.value} placeholder="value" aria-label="Variable value {i + 1}" onchange={persistVars} />
            <button class="eg-btn" aria-label="Remove variable" onclick={() => { vars = vars.filter((_, j) => j !== i); persistVars() }}><EsIcon name="trash" size={13} /></button>
          </div>
        {/each}
        <button class="eg-btn" onclick={() => { vars = [...vars, { name: '', value: '' }]; persistVars() }}><EsIcon name="plus" size={13} /> Add variable</button>
      {:else if panel === 'history'}
        {#if !history.length}
          <div class="es-help" style="margin:0">Requests you send appear here.</div>
        {:else}
          <div style="max-height:var(--px-200);overflow:auto">
            {#each history as h (h.at + h.path)}
              <div class="es-row" role="button" tabindex="0" onclick={() => insertFromHistory(h)} onkeydown={(e) => e.key === 'Enter' && insertFromHistory(h)} title="Insert into the console">
                <span class="es-badge accent" style="min-width:var(--px-48);justify-content:center">{h.method}</span>
                <span class="mono es-ellipsis" style="flex:1 1 auto">{h.path}</span>
                <span style="font-size:var(--px-11);color:var(--muted)">{new Date(h.at).toLocaleString()}</span>
              </div>
            {/each}
          </div>
          <button class="eg-btn" style="margin-top:var(--px-6)" onclick={() => { history = []; localStorage.removeItem(HISTORY_KEY) }}>Clear history</button>
        {/if}
      {:else}
        <div class="esc-help-grid">
          <span><kbd>Ctrl</kbd>+<kbd>Enter</kbd></span><span>Send the request at the caret (or every selected request)</span>
          <span><kbd>Ctrl</kbd>+<kbd>I</kbd></span><span>Auto indent the request body</span>
          <span><kbd>Ctrl</kbd>+<kbd>Space</kbd></span><span>Suggest endpoints, index names, Query DSL keys and fields</span>
          <span><kbd>Ctrl</kbd>+<kbd>/</kbd></span><span>Comment / uncomment lines</span>
          <span class="mono">"""…"""</span><span>Multi-line strings (scripts) — sent as a JSON string</span>
          <span class="mono">POST _bulk</span><span>One JSON document per line (NDJSON); added automatically</span>
        </div>
      {/if}
    </div>
  {/if}

  <div class="esc-split">
    <div class="esc-left" style="width:{splitPct}%">
      {#if failed}
        <div class="es-callout danger" style="margin:var(--px-12)">The editor could not be loaded. Reopen the tab to try again.</div>
      {:else}
        <div bind:this={host} class="esc-editor"></div>
      {/if}
    </div>
    <div class="esc-splitter" role="separator" aria-orientation="vertical" aria-label="Resize console panes" onpointerdown={dragSplit}></div>
    <div class="esc-right">
      <div class="esc-status" data-testid="es-console-status">
        {#if lastStatus}
          <span class="es-badge {tone}" data-testid="es-status-badge">{lastStatus.status} – {STATUS_TEXT[lastStatus.status] ?? ''}</span>
          <span class="es-badge">{lastStatus.took} ms</span>
          <span class="es-badge">{lastStatus.bytes.toLocaleString('en-US')} B</span>
          <span class="mono es-ellipsis" style="font-size:var(--px-11_5);color:var(--text2)">{lastStatus.method} {lastStatus.path}</span>
        {:else}
          <span style="font-size:var(--px-12);color:var(--muted)">Response appears here</span>
        {/if}
        {#if output}
          <button class="eg-btn" style="margin-left:auto" onclick={() => { navigator.clipboard.writeText(output); toasts.success('Copied response', 'elasticsearch') }}><EsIcon name="copy" size={13} /> Copy</button>
        {/if}
      </div>
      {#if localError}<div class="es-callout warn" role="alert" style="margin:var(--px-8)">{localError}</div>{/if}
      {#each warnings as w (w)}<div class="es-callout warn" role="note" style="margin:var(--px-8) var(--px-8) 0">#! {w}</div>{/each}
      <div class="esc-out">
        {#if output}
          <CodeView value={output} language={DS_JSON} readOnly height="100%" ariaLabel="Console response" />
        {:else}
          <div class="es-empty"><div class="es-empty-title">Send a request</div>Press ▶ next to a request or Ctrl+Enter.</div>
        {/if}
      </div>
    </div>
  </div>
</div>

<style>
  .esc-bar {
    flex: none;
    display: flex;
    align-items: center;
    gap: var(--px-8);
    padding: var(--px-8) var(--px-14);
    background: var(--surface);
    border-bottom: var(--px-1) solid var(--border);
    flex-wrap: wrap;
  }
  .esc-title {
    display: inline-flex;
    gap: var(--px-6);
    align-items: center;
    font-weight: 700;
    font-size: var(--px-14);
    color: var(--es-accent);
    margin-right: var(--px-8);
  }
  .esc-panel {
    flex: none;
    padding: var(--px-10) var(--px-14);
    background: var(--panel);
    border-bottom: var(--px-1) solid var(--border);
  }
  .esc-help-grid {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: var(--px-6) var(--px-16);
    font-size: var(--px-12_5);
    color: var(--text2);
  }
  .esc-help-grid kbd {
    font-family: var(--font-mono);
    font-size: var(--px-11);
    padding: var(--px-1) var(--px-5);
    border: var(--px-1) solid var(--border2);
    border-radius: var(--px-4);
    background: var(--raised);
  }
  .esc-split {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
  }
  .esc-left {
    min-width: 0;
    display: flex;
    background: var(--surface);
  }
  .esc-editor {
    flex: 1 1 auto;
    min-height: 0;
    height: 100%;
  }
  .esc-splitter {
    flex: none;
    width: var(--px-5);
    cursor: col-resize;
    background: var(--border);
  }
  .esc-splitter:hover {
    background: var(--es-accent);
  }
  .esc-right {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    background: var(--surface);
  }
  .esc-status {
    flex: none;
    display: flex;
    align-items: center;
    gap: var(--px-6);
    padding: var(--px-8) var(--px-12);
    border-bottom: var(--px-1) solid var(--border);
    min-width: 0;
  }
  .esc-out {
    flex: 1 1 auto;
    min-height: 0;
    padding: var(--px-8);
    display: flex;
    flex-direction: column;
  }
  :global(.es-run-glyph) {
    cursor: pointer;
  }
  :global(.es-run-glyph::before) {
    content: '';
    display: block;
    margin: var(--px-4) 0 0 var(--px-5);
    width: 0;
    height: 0;
    border-top: var(--px-5) solid transparent;
    border-bottom: var(--px-5) solid transparent;
    border-left: var(--px-8) solid var(--es-accent);
  }
  :global(.es-req-active) {
    background: color-mix(in srgb, var(--es-accent) 6%, transparent);
  }
</style>
