<script lang="ts">
  // One payload viewer for every message broker / cache screen (Kafka, NATS, Redis,
  // RabbitMQ). A real product viewer instead of a bare code box: where the message
  // comes from, its facts (topic, partition, offset, key…), Formatted ⇄ Raw, word
  // wrap, line numbers, a validity + size summary and Copy with feedback.
  // Overlays the nearest positioned ancestor (the tab). The backdrop does NOT close
  // it (rule chung) — Close / Escape do.
  import type { Snippet } from 'svelte'
  import CodeView from '$lib/components/editor/CodeView.svelte'
  import JsonTree from '$lib/components/viewer/JsonTree.svelte'
  import SystemIcon from '$lib/components/SystemIcon.svelte'
  import { DS_JSON } from '$lib/editor/monarch'
  import { analyzePayload, payloadCount, payloadSize } from '$lib/viewer/payload'
  import type { MessageConsumer } from '$lib/stream/consumers'

  export interface PayloadFact {
    label: string
    value: string | number
    /** raw content (keys, subjects, routing keys) reads in monospace */
    mono?: boolean
  }

  interface Props {
    /** "Message", "Message #1000", "Value" … */
    title: string
    /** engine that produced it — drives the icon */
    system: string
    /** one line under the title ("Kafka message · payments") */
    subtitle?: string
    facts?: PayloadFact[]
    /** the payload exactly as received */
    text: string
    /** a caveat shown next to the format chip (e.g. "binary — shown as base64") */
    note?: string
    onClose: () => void
    /** who reads this message and whether they processed it: undefined = not
     *  applicable (no section), null = still loading */
    consumers?: MessageConsumer[] | null
    /** heading of that section ("Consumer groups", "Consumers") */
    consumersLabel?: string
    /** why the consumers could not be read */
    consumersError?: string
    /** what "none" means here ("No consumer group reads this topic.") */
    consumersEmpty?: string
    /** accessible name of the dialog (defaults to the title) */
    ariaLabel?: string
    /** extra sections under the payload (e.g. AMQP properties) */
    children?: Snippet
  }
  let {
    title,
    system,
    subtitle = '',
    facts = [],
    text,
    note = '',
    onClose,
    consumers,
    consumersLabel = 'Consumers',
    consumersError = '',
    consumersEmpty = 'Nothing reads this message.',
    ariaLabel,
    children,
  }: Props = $props()
  const STATE_LABEL = { processed: 'Processed', 'in-flight': 'In flight', pending: 'Pending', unknown: 'Unknown' } as const

  const info = $derived(analyzePayload(text))
  // a JSON object / array opens as a Tree; Formatted and Raw stay one click away
  const canTree = $derived(info.shape === 'object' || info.shape === 'array')
  const firstView = (): 'tree' | 'pretty' => (canTree ? 'tree' : 'pretty')
  let view = $state<'tree' | 'pretty' | 'raw'>(firstView())
  const parsed = $derived(canTree ? (JSON.parse(text) as unknown) : null)
  let tree = $state<ReturnType<typeof JsonTree> | null>(null)
  let wrap = $state(true)
  let copied = $state(false)
  let copyTimer: ReturnType<typeof setTimeout> | undefined
  const shown = $derived(info.isJson && view === 'raw' ? info.raw : info.pretty)
  // Tree copies the formatted document (same as Formatted)

  async function copyText(t: string) {
    try {
      await navigator.clipboard.writeText(t)
    } catch {
      /* clipboard unavailable */
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(shown)
      copied = true
      clearTimeout(copyTimer)
      copyTimer = setTimeout(() => (copied = false), 1600)
    } catch {
      copied = false
    }
  }

  const focusOnMount = (node: HTMLElement) => node.focus()
</script>

<div role="presentation" class="pd-backdrop">
  <div
    role="dialog"
    aria-modal="true"
    aria-label={ariaLabel ?? title}
    tabindex="-1"
    class="pd"
    use:focusOnMount
    onkeydown={(e) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }}
  >
    <!-- header -->
    <div class="pd-head">
      <span class="pd-icon" aria-hidden="true"><SystemIcon {system} size={20} /></span>
      <div class="pd-titles">
        <span class="pd-title">{title}</span>
        {#if subtitle}<span class="pd-sub" title={subtitle}>{subtitle}</span>{/if}
      </div>
      <span onclick={onClose} onkeydown={(e) => e.key === 'Enter' && onClose()} role="button" tabindex="0" aria-label="Close viewer" class="pd-x">×</span>
    </div>

    <!-- facts -->
    {#if facts.length}
      <dl class="pd-facts">
        {#each facts as f (f.label)}
          <div class="pd-fact">
            <dt>{f.label}</dt>
            <dd class:mono={f.mono} title={String(f.value)}>{f.value === '' ? '—' : f.value}</dd>
          </div>
        {/each}
      </dl>
    {/if}

    <!-- who reads it, and did they get to this message yet -->
    {#if consumers !== undefined}
      <section class="pd-cons" aria-label={consumersLabel}>
        <div class="pd-cons-head">
          <span>{consumersLabel}</span>
          {#if consumers}<span class="ds-count">{consumers.length}</span>{/if}
          {#if consumers && consumers.length}
            <span class="pd-cons-sum">
              {consumers.filter((c) => c.state === 'processed').length} processed · {consumers.filter((c) => c.state !== 'processed').length} not yet
            </span>
          {/if}
        </div>
        {#if consumersError}
          <div class="pd-cons-note bad">{consumersError}</div>
        {:else if consumers === null}
          <div class="pd-cons-note">Loading…</div>
        {:else if consumers.length === 0}
          <div class="pd-cons-note">{consumersEmpty}</div>
        {:else}
          <ul class="pd-cons-list">
            {#each consumers as c (c.name)}
              <li data-consumer={c.name} data-state={c.state}>
                <span class="pd-state {c.state}">{STATE_LABEL[c.state]}</span>
                <span class="pd-cons-name" title={c.name}>{c.name}</span>
                <span class="pd-cons-detail" title={c.detail}>{c.detail}</span>
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/if}

    <!-- toolbar -->
    <div class="pd-bar">
      {#if info.isJson}
        <div class="ds-seg" role="group" aria-label="Payload view">
          {#if canTree}<span role="button" tabindex="0" aria-pressed={view === 'tree'} onclick={() => (view = 'tree')} onkeydown={(e) => e.key === 'Enter' && (view = 'tree')}>Tree</span>{/if}
          <span role="button" tabindex="0" aria-pressed={view === 'pretty'} onclick={() => (view = 'pretty')} onkeydown={(e) => e.key === 'Enter' && (view = 'pretty')}>Formatted</span>
          <span role="button" tabindex="0" aria-pressed={view === 'raw'} onclick={() => (view = 'raw')} onkeydown={(e) => e.key === 'Enter' && (view = 'raw')}>Raw</span>
        </div>
      {/if}
      {#if view === 'tree'}
        <span role="button" tabindex="0" class="pd-toggle" title="Open every level" onclick={() => tree?.expandAll()} onkeydown={(e) => e.key === 'Enter' && tree?.expandAll()}>Expand all</span>
        <span role="button" tabindex="0" class="pd-toggle" title="Close everything below the top level" onclick={() => tree?.collapseAll()} onkeydown={(e) => e.key === 'Enter' && tree?.collapseAll()}>Collapse all</span>
      {:else}
      <span role="button" tabindex="0" class="pd-toggle" aria-pressed={wrap} title="Wrap long lines" onclick={() => (wrap = !wrap)} onkeydown={(e) => e.key === 'Enter' && (wrap = !wrap)}>Wrap</span>
      {/if}
      <span class="pd-chip" class:ok={info.isJson} data-testid="payload-format">{info.isJson ? 'Valid JSON' : info.shape === 'empty' ? 'Empty' : 'Plain text'}</span>
      {#if note}<span class="pd-note">{note}</span>{/if}
      <span class="pd-stats">
        {#if payloadCount(info)}<span>{payloadCount(info)}</span>{/if}
        <span>{info.lines.toLocaleString('en-US')} line{info.lines === 1 ? '' : 's'}</span>
        <span>{payloadSize(info.bytes)}</span>
      </span>
    </div>

    <!-- payload -->
    {#if view === 'tree' && canTree}
      <div class="pd-code pd-tree">
        <JsonTree bind:this={tree} value={parsed} onCopy={copyText} />
      </div>
    {:else}
    <div class="pd-code">
      <CodeView
        value={shown}
        language={info.isJson ? DS_JSON : 'plaintext'}
        readOnly
        height="auto"
        maxHeight={460}
        minHeight={180}
        {wrap}
        lineNumbers
        ariaLabel="Payload"
      />
    </div>
    {/if}

    {#if children}{@render children()}{/if}

    <!-- footer -->
    <div class="pd-foot">
      <span class="pd-hint">Esc to close</span>
      <span onclick={copy} onkeydown={(e) => e.key === 'Enter' && copy()} role="button" tabindex="0" class="pv-btn primary pd-btn" aria-live="polite">{copied ? 'Copied ✓' : 'Copy'}</span>
      <span onclick={onClose} onkeydown={(e) => e.key === 'Enter' && onClose()} role="button" tabindex="0" class="pv-btn pd-btn">Close</span>
    </div>
  </div>
</div>

<style>
  .pd-backdrop {
    position: absolute;
    inset: 0;
    z-index: 50;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--px-20);
    background: var(--rgba-0-0-0-_5);
  }
  .pd {
    width: min(var(--px-840), 100%);
    max-height: 100%;
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border: var(--px-1) solid var(--border2);
    border-radius: var(--px-14);
    box-shadow: var(--shadow-lg);
    overflow: hidden;
    outline: none;
  }
  .pd-head {
    flex: none;
    display: flex;
    align-items: center;
    gap: var(--px-12);
    padding: var(--px-14) var(--px-18);
    border-bottom: var(--px-1) solid var(--border);
  }
  .pd-icon {
    flex: none;
    width: var(--px-38);
    height: var(--px-38);
    border-radius: var(--px-10);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--panel);
    border: var(--px-1) solid var(--border);
  }
  .pd-titles {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--px-2);
  }
  .pd-title {
    font-size: var(--px-16);
    font-weight: 650;
    color: var(--text);
  }
  .pd-sub {
    font-size: var(--px-12);
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .pd-x {
    flex: none;
    width: var(--px-28);
    height: var(--px-28);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--px-6);
    color: var(--muted);
    font-size: var(--px-20);
    cursor: pointer;
  }
  .pd-x:hover {
    background: var(--hover);
    color: var(--text);
  }
  /* each fact as wide as its value (a timestamp or key never gets cut to fit a
     fixed column); they wrap onto more rows when the dialog is narrow */
  .pd-facts {
    flex: none;
    margin: 0;
    display: flex;
    flex-wrap: wrap;
    gap: var(--px-1);
    background: var(--border);
    border-bottom: var(--px-1) solid var(--border);
  }
  .pd-fact {
    flex: 1 1 auto;
    min-width: var(--px-110);
    max-width: 100%;
    padding: var(--px-8) var(--px-18);
    background: var(--surface);
  }
  .pd-fact dt {
    font-size: var(--px-11);
    font-weight: 600;
    color: var(--muted);
    margin-bottom: var(--px-2);
  }
  .pd-fact dd {
    margin: 0;
    font-size: var(--px-13);
    color: var(--text);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .pd-fact dd.mono {
    font-size: var(--px-12);
  }
  .pd-cons {
    flex: none;
    padding: var(--px-10) var(--px-18) var(--px-4);
    border-bottom: var(--px-1) solid var(--border);
  }
  .pd-cons-head {
    display: flex;
    align-items: center;
    gap: var(--px-8);
    font-size: var(--px-12);
    font-weight: 600;
    color: var(--text2);
    margin-bottom: var(--px-6);
  }
  .pd-cons-sum {
    margin-left: auto;
    font-weight: 400;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .pd-cons-note {
    font-size: var(--px-12_5);
    color: var(--muted);
    padding: var(--px-2) 0 var(--px-8);
  }
  .pd-cons-note.bad {
    color: var(--danger-text);
  }
  .pd-cons-list {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: var(--px-140);
    overflow: auto;
  }
  .pd-cons-list li {
    display: flex;
    align-items: center;
    gap: var(--px-10);
    padding: var(--px-5) 0;
    font-size: var(--px-13);
    min-width: 0;
  }
  .pd-cons-name {
    flex: none;
    max-width: 40%;
    font-weight: 600;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .pd-cons-detail {
    flex: 1;
    min-width: 0;
    font-size: var(--px-12);
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .pd-state {
    flex: none;
    min-width: var(--px-80);
    text-align: center;
    font-size: var(--px-11);
    font-weight: 600;
    border-radius: var(--px-10);
    padding: var(--px-2) var(--px-8);
  }
  .pd-state.processed {
    color: var(--sacc-green);
    background: color-mix(in srgb, var(--sacc-green) 13%, transparent);
  }
  .pd-state.pending {
    color: var(--sacc-amber);
    background: color-mix(in srgb, var(--sacc-amber) 15%, transparent);
  }
  .pd-state.in-flight {
    color: var(--primary);
    background: color-mix(in srgb, var(--primary) 12%, transparent);
  }
  .pd-state.unknown {
    color: var(--text2);
    background: var(--panel);
  }
  .pd-bar {
    flex: none;
    display: flex;
    align-items: center;
    gap: var(--px-10);
    padding: var(--px-10) var(--px-18);
    flex-wrap: wrap;
  }
  .pd-toggle {
    display: inline-flex;
    align-items: center;
    height: var(--px-28);
    padding: 0 var(--px-10);
    border-radius: var(--px-7);
    border: var(--px-1) solid var(--border2);
    background: var(--raised);
    font-size: var(--px-12_5);
    color: var(--text2);
    cursor: pointer;
  }
  .pd-toggle[aria-pressed='true'] {
    color: var(--primary);
    border-color: color-mix(in srgb, var(--primary) 45%, var(--border2));
    background: color-mix(in srgb, var(--primary) 8%, var(--raised));
  }
  .pd-chip {
    display: inline-flex;
    align-items: center;
    gap: var(--px-6);
    height: var(--px-22);
    padding: 0 var(--px-9);
    border-radius: var(--px-11);
    font-size: var(--px-11_5);
    font-weight: 600;
    color: var(--text2);
    background: var(--panel);
  }
  .pd-chip.ok {
    color: var(--sacc-green);
    background: color-mix(in srgb, var(--sacc-green) 13%, transparent);
  }
  .pd-note {
    font-size: var(--px-12);
    color: var(--sacc-amber);
  }
  .pd-stats {
    margin-left: auto;
    display: inline-flex;
    gap: var(--px-12);
    font-size: var(--px-12);
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .pd-code.pd-tree {
    display: block;
    overflow: auto;
    max-height: var(--px-460);
    min-height: var(--px-180);
    background: var(--surface);
  }
  .pd-code {
    flex: 1;
    min-height: 0;
    display: flex;
    margin: 0 var(--px-18);
    border: var(--px-1) solid var(--border2);
    border-radius: var(--px-10);
    overflow: hidden;
    background: var(--raised);
  }
  .pd-foot {
    flex: none;
    display: flex;
    align-items: center;
    gap: var(--px-8);
    padding: var(--px-14) var(--px-18);
    margin-top: var(--px-14);
    border-top: var(--px-1) solid var(--border);
    background: var(--panel);
  }
  .pd-hint {
    margin-right: auto;
    font-size: var(--px-12);
    color: var(--muted);
  }
  .pd-btn {
    font-size: var(--px-12_5) !important;
    padding: var(--px-6) var(--px-16) !important;
    min-width: var(--px-80);
    text-align: center;
  }
</style>
