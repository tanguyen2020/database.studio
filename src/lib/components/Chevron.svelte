<script lang="ts">
  // Disclosure chevron — replaces the ▸ / ▾ text glyphs. One drawn shape that
  // rotates when opened, so every tree/group in the app expands the same way.
  let { open = false, size = 12 }: { open?: boolean; size?: number } = $props()
</script>

<svg
  class="ds-chev"
  class:open
  viewBox="0 0 16 16"
  width={size}
  height={size}
  aria-hidden="true"
  focusable="false"
>
  <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
</svg>

<style>
  .ds-chev {
    display: inline-block;
    vertical-align: middle;
    flex: none;
    transition: transform 0.15s ease;
  }
  .ds-chev.open {
    transform: rotate(90deg);
  }
  @media (prefers-reduced-motion: reduce) {
    .ds-chev {
      transition: none;
    }
  }
</style>
