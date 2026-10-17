<script lang="ts">
  // The payload viewer's Tree view: a JSON document as a collapsible outline —
  // keys in plain type, values coloured by kind, containers summarised when
  // closed ("{3 keys}", "[12 items]"), indent guides, and a copy action per row.
  // Opens two levels deep; long arrays show 200 items at a time.
  import Icon from '$lib/components/Icon.svelte'
  import { containerPaths, flattenTree } from '$lib/viewer/preview'

  let { value, onCopy }: { value: unknown; onCopy?: (text: string) => void } = $props()

  const OPEN_DEPTH = 2
  // explicit choices override the default (open while depth < OPEN_DEPTH)
  let opened = $state<Record<string, boolean>>({})
  let limits = $state<Record<string, number>>({})
  const isOpen = (path: string, depth: number) => opened[path] ?? depth < OPEN_DEPTH
  const rows = $derived(flattenTree(value, isOpen, (p) => limits[p] ?? 200))

  function toggle(path: string, depth: number) {
    opened = { ...opened, [path]: !isOpen(path, depth) }
  }
  export function expandAll() {
    opened = Object.fromEntries(containerPaths(value).map((p) => [p, true]))
  }
  export function collapseAll() {
    opened = Object.fromEntries(containerPaths(value).map((p) => [p, p === '$']))
  }
  function copyNode(v: unknown) {
    const text = typeof v === 'string' ? v : JSON.stringify(v, null, 2)
    onCopy?.(text)
  }
  const label = (r: { key: string | null; index: number | null }) => (r.key !== null ? r.key : r.index !== null ? String(r.index) : '')
</script>

<div class="jt" role="tree" aria-label="Payload tree">
  {#each rows as r (r.path)}
    {#if r.more}
      <div class="jt-row" style="--d:{r.depth}">
        <span class="jt-guides"></span>
        <span
          role="button"
          tabindex="0"
          class="jt-more"
          onclick={() => (limits = { ...limits, [r.path.replace('#more', '')]: (limits[r.path.replace('#more', '')] ?? 200) + 200 })}
          onkeydown={(e) => e.key === 'Enter' && (limits = { ...limits, [r.path.replace('#more', '')]: (limits[r.path.replace('#more', '')] ?? 200) + 200 })}
        >Show {Math.min(200, r.more).toLocaleString('en-US')} more · {r.more.toLocaleString('en-US')} left</span>
      </div>
    {:else}
      {@const box = r.t === 'object' || r.t === 'array'}
      {@const open = box && isOpen(r.path, r.depth)}
      <div
        class="jt-row"
        class:box
        style="--d:{r.depth}"
        role="treeitem"
        aria-selected="false"
        aria-expanded={box ? open : undefined}
        aria-level={r.depth + 1}
        tabindex="-1"
        data-path={r.path}
        onclick={() => box && toggle(r.path, r.depth)}
        onkeydown={(e) => box && (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggle(r.path, r.depth))}
      >
        <span class="jt-guides"></span>
        <span class="jt-chev" class:open aria-hidden="true">{#if box}<svg width="10" height="10" viewBox="0 0 10 10"><path d="M3 2l4 3-4 3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>{/if}</span>
        {#if r.depth === 0}
          <span class="jt-root">{r.t === 'array' ? 'Array' : r.t === 'object' ? 'Object' : 'Value'}</span>
        {:else}
          <span class="jt-key" class:idx={r.index !== null}>{label(r)}</span>
        {/if}
        {#if box}
          <span class="jt-sum">{r.t === 'array' ? `${r.size} item${r.size === 1 ? '' : 's'}` : `${r.size} key${r.size === 1 ? '' : 's'}`}</span>
        {:else if r.t === 'string'}
          <span class="jt-v t-string">"{r.v}"</span>
        {:else if r.t === 'bool' || r.t === 'null'}
          <span class="jt-pill t-{r.t}">{r.v}</span>
        {:else}
          <span class="jt-v t-{r.t}">{r.v}</span>
        {/if}
        <span
          role="button"
          tabindex="0"
          class="jt-copy"
          title={box ? 'Copy this part as JSON' : 'Copy value'}
          aria-label={box ? 'Copy this part as JSON' : 'Copy value'}
          onclick={(e) => {
            e.stopPropagation()
            copyNode(r.value)
          }}
          onkeydown={(e) => e.key === 'Enter' && copyNode(r.value)}
        ><Icon name="copy" size={12} /></span>
      </div>
    {/if}
  {/each}
</div>

<style>
  .jt {
    padding: var(--px-6) 0;
    font-size: var(--px-13);
    line-height: 1.4;
    overflow: auto;
  }
  .jt-row {
    position: relative;
    display: flex;
    align-items: flex-start;
    gap: var(--px-6);
    min-height: var(--px-26);
    padding: var(--px-3) var(--px-12) var(--px-3) calc(var(--px-12) + var(--d) * var(--px-18));
    outline: none;
  }
  .jt-row:hover {
    background: var(--hover);
  }
  .jt-row.box {
    cursor: pointer;
  }
  /* one hairline per ancestor level — keeps deep documents readable */
  .jt-guides {
    position: absolute;
    top: 0;
    bottom: 0;
    left: calc(var(--px-12) + var(--px-5));
    width: calc(var(--d) * var(--px-18));
    background: repeating-linear-gradient(90deg, var(--border) 0 var(--px-1), transparent var(--px-1) var(--px-18));
    pointer-events: none;
  }
  .jt-chev {
    flex: none;
    width: var(--px-12);
    height: var(--px-20);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--muted);
    transition: transform 0.12s;
  }
  .jt-chev.open {
    transform: rotate(90deg);
  }
  .jt-root {
    font-weight: 600;
    color: var(--text);
  }
  .jt-key {
    flex: none;
    max-width: 40%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 600;
    color: var(--text);
  }
  .jt-key::after {
    content: '';
    margin-right: var(--px-4);
  }
  .jt-key.idx {
    font-weight: 500;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .jt-sum {
    color: var(--muted);
    font-size: var(--px-12);
  }
  .jt-v {
    min-width: 0;
    font-family: var(--font-mono);
    font-size: var(--px-12_5);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .t-string {
    color: var(--syntax-string);
  }
  .t-number {
    color: var(--syntax-number);
  }
  .jt-pill {
    padding: 0 var(--px-6);
    border-radius: var(--px-5);
    font-family: var(--font-mono);
    font-size: var(--px-11_5);
    font-weight: 600;
  }
  .jt-pill.t-bool {
    color: var(--syntax-keyword);
    background: color-mix(in srgb, var(--syntax-keyword) 12%, transparent);
  }
  .jt-pill.t-null {
    color: var(--muted);
    background: var(--panel);
  }
  .jt-copy {
    flex: none;
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    padding: var(--px-3);
    border-radius: var(--px-5);
    color: var(--muted);
    opacity: 0;
    cursor: pointer;
  }
  .jt-row:hover .jt-copy {
    opacity: 1;
  }
  .jt-copy:hover {
    color: var(--primary);
    background: color-mix(in srgb, var(--primary) 12%, transparent);
  }
  .jt-more {
    color: var(--primary);
    font-size: var(--px-12);
    font-weight: 500;
    cursor: pointer;
  }
</style>
