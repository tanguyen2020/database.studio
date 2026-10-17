<script lang="ts" module>
  import type { EuiGlyph } from '$lib/elastic/eui-icons'
  export type EsIconName = EuiGlyph
</script>

<script lang="ts">
  // Glyphs of the Elasticsearch workspace — the official Elastic UI (EUI) icons,
  // copied verbatim into eui-icons.ts (never redrawn). Monochrome, currentColor.
  import { EUI_GLYPHS } from '$lib/elastic/eui-icons'

  let { name, size = 16 }: { name: EsIconName; size?: number } = $props()
  const icon = $derived(EUI_GLYPHS[name])
</script>

<svg
  class="es-eui-glyph"
  viewBox={icon.vb}
  width={size}
  height={size}
  fill="currentColor"
  aria-hidden="true"
  focusable="false"
  data-eui={icon.src}
  style="display:inline-block;flex:none;vertical-align:middle">{@html icon.body}</svg>
