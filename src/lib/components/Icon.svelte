<script module lang="ts">
  export type IconName = 'refresh' | 'plus' | 'close' | 'chevron-down' | 'fold' | 'unfold' | 'merge' | 'search' | 'panel-right' | 'query' | 'expand' | 'copy' | 'trash'
    | 'download' | 'filter' | 'sort' | 'chevron-left' | 'chevron-right' | 'first' | 'last' | 'paste' | 'edit' | 'table' | 'braces' | 'code' | 'file' | 'columns' | 'rows' | 'sliders' | 'check'
    | 'database' | 'puzzle' | 'upload' | 'link' | 'unlink' | 'chart' | 'cpu' | 'play' | 'folder' | 'zap' | 'info' | 'warning'
    | 'user' | 'users' | 'shield' | 'key' | 'lock' | 'eye' | 'eye-off' | 'sparkle'
    | 'clock' | 'archive' | 'server' | 'send'
</script>

<script lang="ts">
  // Small UI icon set (stroke, 16-unit grid, currentColor) for chrome controls that
  // used to be Unicode glyphs (⟳ + × ⌄ ⊟ ⌕ ⇤). Fonts draw those glyphs at
  // different weights and baselines, which is what made the chrome look patched
  // together; one drawn set keeps every control the same weight.
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
  {:else if name === 'fold'}
    <path d="M5 3l3 3 3-3M5 13l3-3 3 3" />
  {:else if name === 'unfold'}
    <path d="M5 6l3-3 3 3M5 10l3 3 3-3" />
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
  {:else if name === 'download'}
    <path d="M8 2.5v7.5M4.8 7 8 10.2 11.2 7M3 13h10" />
  {:else if name === 'filter'}
    <path d="M2.5 3.5h11L9.3 8.6v4.2l-2.6-1.3V8.6z" />
  {:else if name === 'sort'}
    <path d="M5 3v10M2.8 10.8 5 13l2.2-2.2M11 13V3M8.8 5.2 11 3l2.2 2.2" />
  {:else if name === 'chevron-left'}
    <path d="M10 4 6 8l4 4" />
  {:else if name === 'chevron-right'}
    <path d="m6 4 4 4-4 4" />
  {:else if name === 'first'}
    <path d="M4 3.5v9M11.5 4 7.5 8l4 4" />
  {:else if name === 'last'}
    <path d="M12 3.5v9M4.5 4l4 4-4 4" />
  {:else if name === 'paste'}
    <rect x="3.5" y="3" width="9" height="11" rx="1.6" />
    <path d="M6 3V2.4h4V3M6 7.5h4M6 10h2.5" />
  {:else if name === 'edit'}
    <path d="M10.4 2.9 13.1 5.6 5.8 12.9 2.6 13.4 3.1 10.2z" />
  {:else if name === 'table'}
    <rect x="2.5" y="3" width="11" height="10" rx="1.6" />
    <path d="M2.5 6.5h11M2.5 9.8h11M6.3 6.5V13" />
  {:else if name === 'braces'}
    <path d="M6 2.8c-1.4 0-1.9.6-1.9 1.8v1.6c0 .9-.4 1.4-1.4 1.8 1 .4 1.4.9 1.4 1.8v1.6c0 1.2.5 1.8 1.9 1.8M10 2.8c1.4 0 1.9.6 1.9 1.8v1.6c0 .9.4 1.4 1.4 1.8-1 .4-1.4.9-1.4 1.8v1.6c0 1.2-.5 1.8-1.9 1.8" />
  {:else if name === 'code'}
    <path d="M5.5 4.5 2.5 8l3 3.5M10.5 4.5l3 3.5-3 3.5M9 3 7 13" />
  {:else if name === 'file'}
    <path d="M4 2.5h5.5L12.5 5.5v8H4z" />
    <path d="M9.5 2.5v3h3" />
  {:else if name === 'columns'}
    <rect x="2.5" y="3" width="11" height="10" rx="1.6" />
    <path d="M8 3v10" />
  {:else if name === 'rows'}
    <rect x="2.5" y="3" width="11" height="10" rx="1.6" />
    <path d="M2.5 8h11" />
  {:else if name === 'sliders'}
    <path d="M3 4.5h6M12 4.5h1M3 11.5h1M7 11.5h6" />
    <circle cx="10.5" cy="4.5" r="1.5" />
    <circle cx="5.5" cy="11.5" r="1.5" />
  {:else if name === 'check'}
    <path d="m3.5 8.5 3 3 6-7" />
  {:else if name === 'database'}
    <ellipse cx="8" cy="4" rx="5" ry="1.8" />
    <path d="M3 4v8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8V4M3 8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8" />
  {:else if name === 'puzzle'}
    <path d="M6.5 2.8a1.4 1.4 0 0 1 2.8 0v1.2h3.2v3.2h-1.2a1.4 1.4 0 0 0 0 2.8h1.2v3.2H9.3v-1.2a1.4 1.4 0 0 0-2.8 0v1.2H3.3V10h1.2a1.4 1.4 0 0 0 0-2.8H3.3V4h3.2z" />
  {:else if name === 'send'}
    <path d="M14 2 7 9M14 2l-4.5 12-2.5-5-5-2.5L14 2Z" />
  {:else if name === 'upload'}
    <path d="M8 10.5V2.8M5 5.6 8 2.6l3 3M3 10.5v1.7c0 .7.5 1.3 1.2 1.3h7.6c.7 0 1.2-.6 1.2-1.3v-1.7" />
  {:else if name === 'link'}
    <path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2-2a2.6 2.6 0 0 0-3.7-3.7l-.7.7M9.2 6.8a2.6 2.6 0 0 0-3.7 0l-2 2a2.6 2.6 0 0 0 3.7 3.7l.7-.7" />
  {:else if name === 'unlink'}
    <path d="M9.4 4.1l.3-.3a2.6 2.6 0 0 1 3.7 3.7l-1.3 1.3M6.6 11.9l-.3.3a2.6 2.6 0 0 1-3.7-3.7l1.3-1.3M2.5 2.5l11 11" />
  {:else if name === 'chart'}
    <path d="M2.5 13.5h11" />
    <path d="M4.5 13.5V9M8 13.5V4.5M11.5 13.5v-6" />
  {:else if name === 'cpu'}
    <rect x="4" y="4" width="8" height="8" rx="1.4" />
    <path d="M6.5 6.5h3v3h-3zM6 2v2M10 2v2M6 12v2M10 12v2M2 6h2M2 10h2M12 6h2M12 10h2" />
  {:else if name === 'play'}
    <path d="M5 3.3v9.4L12.5 8z" />
  {:else if name === 'folder'}
    <path d="M2.5 4.3c0-.7.5-1.3 1.2-1.3h2.6l1.4 1.6h4.6c.7 0 1.2.6 1.2 1.3v6.3c0 .7-.5 1.3-1.2 1.3H3.7c-.7 0-1.2-.6-1.2-1.3z" />
  {:else if name === 'zap'}
    <path d="M9 2 3.5 9h4L7 14l5.5-7h-4z" />
  {:else if name === 'info'}
    <circle cx="8" cy="8" r="5.6" />
    <path d="M8 7.3v3.6M8 5.1v.1" />
  {:else if name === 'warning'}
    <path d="M8 2.6 14 13H2z" />
    <path d="M8 6.6v3M8 11.3v.1" />
  {:else if name === 'user'}
    <circle cx="8" cy="5.4" r="2.6" />
    <path d="M3 13.6c.6-2.6 2.6-4 5-4s4.4 1.4 5 4" />
  {:else if name === 'users'}
    <circle cx="6" cy="5.6" r="2.3" />
    <path d="M1.8 13.4c.5-2.3 2.2-3.6 4.2-3.6s3.7 1.3 4.2 3.6" />
    <path d="M10.6 3.5a2.2 2.2 0 0 1 0 4.3M12.2 9.9c1.1.6 1.8 1.8 2 3.5" />
  {:else if name === 'shield'}
    <path d="M8 1.8 13 3.7v4c0 3.1-2.1 5.5-5 6.5-2.9-1-5-3.4-5-6.5v-4z" />
    <path d="m5.8 8 1.5 1.5 2.9-3" />
  {:else if name === 'key'}
    <circle cx="5.2" cy="10.8" r="2.8" />
    <path d="m7.2 8.8 6-6M11.2 4.8l1.6 1.6M9.8 6.2l1.2 1.2" />
  {:else if name === 'lock'}
    <rect x="3.2" y="7.2" width="9.6" height="6.6" rx="1.4" />
    <path d="M5.4 7.2V5.1a2.6 2.6 0 0 1 5.2 0v2.1" />
  {:else if name === 'eye'}
    <path d="M1.6 8S4 3.6 8 3.6 14.4 8 14.4 8 12 12.4 8 12.4 1.6 8 1.6 8z" />
    <circle cx="8" cy="8" r="2" />
  {:else if name === 'eye-off'}
    <path d="M6.3 3.8A6.5 6.5 0 0 1 8 3.6C12 3.6 14.4 8 14.4 8a12 12 0 0 1-1.7 2.2M10 11.9a6 6 0 0 1-2 .5C4 12.4 1.6 8 1.6 8a12 12 0 0 1 2.6-3" />
    <path d="M6.6 6.6a2 2 0 0 0 2.8 2.8M2.4 2.4l11.2 11.2" />
  {:else if name === 'sparkle'}
    <path d="M8 1.8 9.3 6.7 14.2 8 9.3 9.3 8 14.2 6.7 9.3 1.8 8l4.9-1.3z" />
  {:else if name === 'clock'}
    <circle cx="8" cy="8" r="6" /><path d="M8 4.8V8l2.2 1.5" />
  {:else if name === 'archive'}
    <rect x="2" y="2.6" width="12" height="3.4" rx="1" /><path d="M3.2 6v6.4c0 .6.4 1 1 1h7.6c.6 0 1-.4 1-1V6M6.4 8.8h3.2" />
  {:else if name === 'server'}
    <rect x="2.4" y="2.4" width="11.2" height="4.6" rx="1" /><rect x="2.4" y="9" width="11.2" height="4.6" rx="1" /><path d="M5 4.7h.01M5 11.3h.01" />
  {/if}
</svg>
