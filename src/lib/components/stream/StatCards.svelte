<script lang="ts" module>
  export interface StatCard {
    label: string
    value: string
    sub?: string
    /** colour only when it means something (rule U5) */
    tone?: 'ok' | 'warn' | 'bad' | 'num' | null
    help?: string
    onClick?: () => void
  }
</script>

<script lang="ts">
  // A row of headline numbers for an Overview section (SPEC-STREAM-SHELL.md §3).
  import Icon from '$lib/components/Icon.svelte'

  let { items }: { items: StatCard[] } = $props()
</script>

<div class="sc-grid">
  {#each items as s (s.label)}
    {#if s.onClick}
      <button type="button" class="sc-card clickable" onclick={s.onClick} title={s.help}>
        <span class="sc-label">{s.label}{#if s.help}<span class="sc-help" aria-hidden="true"><Icon name="info" size={11} /></span>{/if}</span>
        <span class="sc-value {s.tone ?? ''}">{s.value}</span>
        {#if s.sub}<span class="sc-sub">{s.sub}</span>{/if}
      </button>
    {:else}
      <div class="sc-card" title={s.help}>
        <span class="sc-label">{s.label}{#if s.help}<span class="sc-help" aria-hidden="true"><Icon name="info" size={11} /></span>{/if}</span>
        <span class="sc-value {s.tone ?? ''}">{s.value}</span>
        {#if s.sub}<span class="sc-sub">{s.sub}</span>{/if}
      </div>
    {/if}
  {/each}
</div>

<style>
  .sc-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(var(--px-160), 1fr));
    gap: var(--px-12);
  }
  .sc-card {
    display: flex;
    flex-direction: column;
    gap: var(--px-4);
    padding: var(--px-12) var(--px-14);
    border-radius: var(--px-10);
    border: var(--px-1) solid var(--border);
    background: var(--surface);
    box-shadow: var(--shadow-xs);
    text-align: left;
    font-family: var(--font-main);
    min-width: 0;
  }
  .sc-card.clickable {
    cursor: pointer;
  }
  .sc-card.clickable:hover {
    border-color: color-mix(in srgb, var(--primary) 45%, var(--border));
  }
  .sc-card.clickable:focus-visible {
    outline: var(--px-2) solid var(--ring-soft);
  }
  .sc-label {
    display: inline-flex;
    align-items: center;
    gap: var(--px-4);
    font-size: var(--px-12);
    color: var(--text2);
  }
  .sc-help {
    display: inline-flex;
    color: var(--muted);
  }
  .sc-value {
    font-size: var(--px-22);
    font-weight: 650;
    color: var(--text);
    font-variant-numeric: tabular-nums;
    line-height: 1.15;
  }
  /* a healthy state or a plain count needs no colour — only problems are coloured */
  .sc-value.ok {
    color: var(--text);
  }
  .sc-value.warn {
    color: var(--sacc-amber);
  }
  .sc-value.bad {
    color: var(--danger-text);
  }
  .sc-value.num {
    color: var(--text);
  }
  .sc-sub {
    font-size: var(--px-11_5);
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
