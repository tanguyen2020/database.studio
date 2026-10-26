<script lang="ts">
  // stream-workspace:redis — Workbench section (SPEC-REDIS-BROWSER.md §2): the
  // command console that lived inside the old Redis workspace tab, on the shared
  // stream shell. Commands that wipe data or stop the server are confirmed first.
  import * as ipc from '$lib/ipc'
  import Icon from '$lib/components/Icon.svelte'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { redisDb } from '$lib/stores/redisDb.svelte'
  import { autofocus } from '$lib/actions/autofocus'
  import { connections } from '$lib/stores/connections.svelte'
  import { brandLabel } from '$lib/brand'
  import { dangerOf, isReadOnlyCommand, selectedDb, tokenizeCommand, type DangerInfo } from '$lib/stream/redis-workbench'
  import '$lib/components/workspace/users/um.css'

  let { connId }: { connId: string } = $props()
  // Redis or Valkey (SPEC-VALKEY.md) — the name every sentence uses
  const product = $derived(brandLabel(connections.byId(connId) ?? { system: 'redis' }))

  interface Run {
    cmd: string
    out: string
    err: boolean
    ms: number
    db: number
  }
  let input = $state('')
  let log = $state<Run[]>([])
  let history = $state<string[]>([])
  let histIdx = $state(-1)
  let busy = $state(false)
  let pending = $state<{ line: string; args: string[]; danger: DangerInfo } | null>(null)
  let output = $state<HTMLDivElement | null>(null)
  let inputEl = $state<HTMLInputElement | null>(null)

  const db = $derived(redisDb.get(connId))
  const EXAMPLES = ['PING', 'INFO memory', 'DBSIZE', 'SCAN 0 MATCH user:* COUNT 100', 'TTL session:abc123', 'HGETALL user:1001']

  function submit() {
    const line = input.trim()
    if (!line || busy) return
    const args = tokenizeCommand(line)
    if (!args.length) return
    const danger = dangerOf(args, db)
    if (danger) {
      pending = { line, args, danger }
      return
    }
    void run(line, args)
  }

  async function run(line: string, args: string[]) {
    pending = null
    busy = true
    history = [...history.filter((h) => h !== line), line].slice(-100)
    histIdx = -1
    input = ''
    const started = performance.now()
    const atDb = db
    try {
      const out = await ipc.redisCommand(connId, args)
      log = [...log, { cmd: line, out, err: false, ms: Math.round(performance.now() - started), db: atDb }]
      const sel = selectedDb(args)
      if (sel != null) redisDb.set(connId, sel)
      else if (!isReadOnlyCommand(args)) explorer.bumpRedis(connId) // key lists refresh
    } catch (e) {
      log = [...log, { cmd: line, out: String(e), err: true, ms: Math.round(performance.now() - started), db: atDb }]
    } finally {
      busy = false
      queueMicrotask(() => {
        if (output) output.scrollTop = output.scrollHeight
        inputEl?.focus()
      })
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault()
      submit()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (!history.length) return
      histIdx = histIdx < 0 ? history.length - 1 : Math.max(0, histIdx - 1)
      input = history[histIdx]
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (histIdx < 0) return
      histIdx++
      if (histIdx >= history.length) {
        histIdx = -1
        input = ''
      } else input = history[histIdx]
    }
  }

  async function copy(text: string) {
    await navigator.clipboard.writeText(text)
  }
</script>

<div class="rw">
  <div class="rw-out" bind:this={output} aria-live="polite">
    {#if log.length === 0}
      <div class="rw-empty">
        <b>Run {product} commands</b>
        <span>Type a command below and press Enter — the same commands you would use in <span class="mono">{product === 'Valkey' ? 'valkey-cli' : 'redis-cli'}</span>. Commands that delete data ask first.</span>
        <div class="rw-examples">
          {#each EXAMPLES as ex (ex)}
            <button type="button" class="rw-chip mono" onclick={() => { input = ex; inputEl?.focus() }}>{ex}</button>
          {/each}
        </div>
      </div>
    {:else}
      {#each log as r, i (i)}
        <div class="rw-run" class:err={r.err}>
          <div class="rw-cmd">
            <span class="rw-db">Database {r.db}</span>
            <span class="mono rw-line">{r.cmd}</span>
            <span class="rw-ms" title="Round trip">{r.ms} ms</span>
            <button type="button" class="rw-icon" title="Copy the result" aria-label="Copy the result" onclick={() => copy(r.out)}><Icon name="copy" size={12} /></button>
            <button type="button" class="rw-icon" title="Run again" aria-label="Run again" onclick={() => { input = r.cmd; inputEl?.focus() }}><Icon name="refresh" size={12} /></button>
          </div>
          <pre class="mono selectable rw-res">{r.out}</pre>
        </div>
      {/each}
    {/if}
  </div>
  <div class="rw-in">
    <span class="rw-prompt mono" title="Commands run on this database">db{db} ›</span>
    <input
      bind:this={inputEl}
      bind:value={input}
      class="mono rw-input"
      placeholder="GET key · HSET user:1 name Ada · SCAN 0 MATCH user:*"
      aria-label="Redis command"
      spellcheck="false"
      autocomplete="off"
      onkeydown={onKey}
    />
    <span class="rw-hint">↑ ↓ history</span>
    {#if log.length}<button type="button" class="cfm-btn" onclick={() => (log = [])}>Clear</button>{/if}
    <button type="button" class="cfm-btn primary" onclick={submit} disabled={busy || !input.trim()}>{busy ? 'Running…' : 'Run'}</button>
  </div>
</div>

{#if pending}
  <div class="um-backdrop" role="presentation">
    <div
      class="um-dlg sm"
      role="alertdialog"
      aria-modal="true"
      aria-label="Confirm command"
      tabindex="-1"
      onkeydown={(e) => e.key === 'Escape' && (pending = null)}
    >
      <div class="um-dlg-head">
        <span class="um-dlg-icon danger"><Icon name="warning" size={18} /></span>
        <div class="um-dlg-title"><b>Run this command?</b><span class="mono">{pending.line}</span></div>
      </div>
      <div class="um-dlg-body"><p class="rw-confirm">{pending.danger.consequence}</p></div>
      <div class="um-dlg-foot">
        <span class="rw-grow"></span>
        <button type="button" class="cfm-btn" use:autofocus onclick={() => (pending = null)}>Cancel</button>
        <button type="button" class="cfm-btn danger" onclick={() => pending && run(pending.line, pending.args)}>{pending.danger.verb}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .rw {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    margin: var(--px-14) var(--px-18) var(--px-18);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-10);
    background: var(--surface);
    overflow: hidden;
    box-shadow: var(--shadow-xs);
  }
  .rw-out {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: var(--px-10) var(--px-14);
  }
  .rw-empty {
    display: flex;
    flex-direction: column;
    gap: var(--px-6);
    padding: var(--px-18) var(--px-4);
    font-size: var(--px-12_5);
    color: var(--text2);
    max-width: var(--px-640);
  }
  .rw-empty b {
    font-size: var(--px-14);
    color: var(--text);
  }
  .rw-examples {
    display: flex;
    flex-wrap: wrap;
    gap: var(--px-6);
    margin-top: var(--px-8);
  }
  .rw-chip {
    border: var(--px-1) solid var(--border2);
    background: var(--raised);
    color: var(--text2);
    border-radius: var(--px-12);
    padding: var(--px-3) var(--px-10);
    font-size: var(--px-11_5);
    cursor: pointer;
  }
  .rw-chip:hover {
    color: var(--text);
    border-color: color-mix(in srgb, var(--primary) 45%, var(--border2));
  }
  .rw-run {
    padding: var(--px-8) 0;
    border-bottom: var(--px-1) solid var(--border);
  }
  .rw-run:last-child {
    border-bottom: 0;
  }
  .rw-cmd {
    display: flex;
    align-items: center;
    gap: var(--px-8);
    font-size: var(--px-12);
  }
  .rw-db {
    flex: none;
    font-size: var(--px-11);
    font-weight: 600;
    color: var(--muted);
  }
  .rw-line {
    flex: 1;
    min-width: 0;
    color: var(--text);
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .rw-ms {
    flex: none;
    font-size: var(--px-11);
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .rw-icon {
    flex: none;
    display: inline-flex;
    border: 0;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    padding: var(--px-3);
    border-radius: var(--px-5);
  }
  .rw-icon:hover {
    color: var(--text);
    background: var(--hover);
  }
  .rw-res {
    margin: var(--px-4) 0 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: var(--px-12);
    color: var(--text2);
  }
  .rw-run.err .rw-res {
    color: var(--danger-text);
  }
  .rw-in {
    flex: none;
    display: flex;
    align-items: center;
    gap: var(--px-8);
    padding: var(--px-8) var(--px-10);
    border-top: var(--px-1) solid var(--border);
    background: var(--panel);
  }
  .rw-prompt {
    flex: none;
    font-size: var(--px-12);
    font-weight: 700;
    color: var(--sacc-red);
  }
  .rw-input {
    flex: 1;
    min-width: 0;
    height: var(--px-30);
    box-sizing: border-box;
    border: var(--px-1) solid var(--border2);
    border-radius: var(--px-8);
    background: var(--raised);
    color: var(--text);
    font-size: var(--px-12_5);
    padding: 0 var(--px-10);
    outline: none;
  }
  .rw-input:focus {
    border-color: var(--primary);
  }
  .rw-hint {
    flex: none;
    font-size: var(--px-11);
    color: var(--muted);
  }
  .rw-confirm {
    margin: 0;
    line-height: 1.5;
    color: var(--text2);
  }
  .rw-grow {
    flex: 1;
  }
</style>
