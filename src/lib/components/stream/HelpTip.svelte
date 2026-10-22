<script lang="ts">
  // An ⓘ next to a term that explains it in one sentence (rule U1). It is a real
  // focusable control so keyboard and screen-reader users get the explanation too.
  import Icon from '$lib/components/Icon.svelte'

  let { text, size = 12 }: { text: string; size?: number } = $props()
</script>

<button type="button" class="ht" aria-label={text} title={text}><Icon name="info" {size} /></button>

<style>
  .ht {
    display: inline-flex;
    border: 0;
    background: transparent;
    padding: 0;
    vertical-align: middle;
    color: var(--muted);
    cursor: help;
    border-radius: var(--px-4);
  }
  .ht:hover,
  .ht:focus-visible {
    color: var(--primary);
    outline: none;
  }
</style>
