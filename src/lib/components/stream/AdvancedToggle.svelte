<script lang="ts">
  // Raw technical values (config keys, x-arguments, ids) stay behind "Advanced"
  // so the default view reads in plain language (rule U3).
  import type { Snippet } from 'svelte'
  import Chevron from '$lib/components/Chevron.svelte'

  let { label = 'Advanced', children }: { label?: string; children: Snippet } = $props()
  let open = $state(false)
</script>

<div class="adv">
  <button type="button" class="adv-toggle" aria-expanded={open} onclick={() => (open = !open)}>
    <Chevron {open} size={11} />
    {label}
  </button>
  {#if open}<div class="adv-body">{@render children()}</div>{/if}
</div>

<style>
  .adv-toggle {
    display: inline-flex;
    align-items: center;
    gap: var(--px-6);
    border: 0;
    background: transparent;
    padding: var(--px-4) 0;
    font-family: var(--font-main);
    font-size: var(--px-12);
    font-weight: 600;
    color: var(--text2);
    cursor: pointer;
  }
  .adv-toggle:hover {
    color: var(--text);
  }
  .adv-body {
    margin-top: var(--px-6);
  }
</style>
