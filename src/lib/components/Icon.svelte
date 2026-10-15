<script lang="ts">
  // Small UI icon set (stroke, 16-unit grid, currentColor) for chrome controls that
  // used to be Unicode glyphs (⟳ + × ⌄ ⊟ ⌕ ⇤). Fonts draw those glyphs at
  // different weights and baselines, which is what made the chrome look patched
  // together; one drawn set keeps every control the same weight.
  export type IconName = 'refresh' | 'plus' | 'close' | 'chevron-down' | 'merge' | 'search' | 'panel-right' | 'query' | 'expand' | 'copy' | 'trash'
  let { name, size = 14 }: { name: IconName; size?: number } = $props()
</script>

<svg
  viewBox="0 0 16 16"
  width={size}
  height={size}
  fill="none"
  stroke="currentColor"
  stroke-width="1.6"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  focusable="false"
  style="display:inline-block;flex:none;vertical-align:middle"
>
  {#if name === 'refresh'}
    <path d="M13.2 6.4A5.3 5.3 0 0 0 3.6 4.6L2.6 5.8" />
    <path d="M2.6 2.8v3h3" />
    <path d="M2.8 9.6a5.3 5.3 0 0 0 9.6 1.8l1-1.2" />
    <path d="M13.4 13.2v-3h-3" />
  {:else if name === 'plus'}
    <path d="M8 3v10M3 8h10" />
  {:else if name === 'close'}
    <path d="M4 4l8 8M12 4l-8 8" />
  {:else if name === 'chevron-down'}
    <path d="M4 6l4 4 4-4" />
  {:else if name === 'merge'}
    <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
    <path d="M5.5 8h5" />
  {:else if name === 'search'}
    <circle cx="7" cy="7" r="4.2" />
    <path d="M10.2 10.2 13.5 13.5" />
  {:else if name === 'panel-right'}
    <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
    <path d="M10 2.5v11" />
  {:else if name === 'query'}
    <path d="M4 2.5h5.5L12.5 5.5v8H4z" />
    <path d="M9.5 2.5v3h3M6 8.5h4.5M6 11h3" />
  {:else if name === 'expand'}
    <path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" />
  {:else if name === 'copy'}
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.6" />
    <path d="M10.5 5.5V3.9a1.4 1.4 0 0 0-1.4-1.4H3.9a1.4 1.4 0 0 0-1.4 1.4v5.2a1.4 1.4 0 0 0 1.4 1.4h1.6" />
  {:else if name === 'trash'}
    <path d="M2.8 4.3h10.4M6.3 4.3V3a.8.8 0 0 1 .8-.8h1.8a.8.8 0 0 1 .8.8v1.3M4.3 4.3l.6 8.5a1 1 0 0 0 1 .9h4.2a1 1 0 0 0 1-.9l.6-8.5" />
  {/if}
</svg>
