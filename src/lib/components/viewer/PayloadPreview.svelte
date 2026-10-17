<script lang="ts">
  // A message value in a grid cell: a JSON object reads as `key value · key value`
  // with typed colours instead of a raw `{"k":"v",…}` string. Shared by the Kafka,
  // NATS, RabbitMQ and Redis grids. `inverted` = the row is selected (white text).
  import { previewOf } from '$lib/viewer/preview'

  let { text, inverted = false, max = 6 }: { text: string; inverted?: boolean; max?: number } = $props()
  const p = $derived(previewOf(text, max))
</script>

<span class="pp" class:inv={inverted} title={text}>
  {#if p.kind === 'empty'}
    <span class="pp-empty">empty</span>
  {:else if p.kind === 'text'}
    <span class="pp-text">{p.parts[0].v}</span>
  {:else}
    {#if p.kind === 'array'}<span class="pp-tag">{p.size} item{p.size === 1 ? '' : 's'}</span>{/if}
    {#each p.parts as part, i (i)}
      <span class="pp-pair">
        {#if part.k !== undefined}<span class="pp-k">{part.k}</span>{/if}
        <span class="pp-v t-{part.t}">{part.v}</span>
      </span>
    {/each}
    {#if p.more}<span class="pp-more">+{p.more} more</span>{/if}
  {/if}
</span>

<style>
  .pp {
    display: block;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--px-12_5);
  }
  .pp-pair {
    margin-right: var(--px-12);
  }
  .pp-k {
    color: var(--muted);
    font-size: var(--px-11_5);
    font-weight: 500;
    margin-right: var(--px-5);
  }
  .pp-v {
    font-family: var(--font-mono);
    font-size: var(--px-12);
    color: var(--text);
  }
  .t-string {
    color: var(--syntax-string);
  }
  .t-number {
    color: var(--syntax-number);
  }
  .t-bool {
    color: var(--syntax-keyword);
  }
  .t-null,
  .t-object,
  .t-array {
    color: var(--muted);
  }
  .pp-text {
    font-family: var(--font-mono);
    font-size: var(--px-12);
    color: var(--text2);
  }
  .pp-empty {
    color: var(--muted);
    font-style: italic;
  }
  .pp-tag {
    display: inline-block;
    margin-right: var(--px-8);
    padding: 0 var(--px-6);
    border-radius: var(--px-5);
    font-size: var(--px-11);
    font-weight: 600;
    color: var(--text2);
    background: var(--panel);
    border: var(--px-1) solid var(--border);
  }
  .pp-more {
    color: var(--muted);
    font-size: var(--px-11_5);
  }
  /* selected row: everything white so the blue highlight never hides it */
  .inv .pp-k,
  .inv .pp-v,
  .inv .pp-text,
  .inv .pp-empty,
  .inv .pp-more {
    color: var(--hex-fff);
  }
  .inv .pp-k,
  .inv .pp-more {
    opacity: 0.75;
  }
  .inv .pp-tag {
    color: var(--hex-fff);
    background: transparent;
    border-color: currentColor;
  }
</style>
