<script lang="ts">
  // Field-type token (EuiToken, as in Kibana Discover / mappings): the official EUI
  // token glyph on a tinted square in the type's colour.
  import { EUI_TOKENS } from '$lib/elastic/eui-icons'
  import { fieldTypeToken } from '$lib/elastic/format'

  let { type, size = 18 }: { type: string; size?: number } = $props()
  const tok = $derived(fieldTypeToken(type))
  const icon = $derived(EUI_TOKENS[tok.token])
</script>

<span class="es-field-token" style="color:{tok.color};width:{size}px;height:{size}px" title={tok.title} data-type={type || 'unknown'}>
  <svg viewBox={icon.vb} width={size - 2} height={size - 2} fill="currentColor" aria-hidden="true" focusable="false" data-eui={icon.src}>{@html icon.body}</svg>
</span>

<style>
  .es-field-token {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--px-4);
    background: color-mix(in srgb, currentColor 14%, transparent);
    box-shadow: inset 0 0 0 var(--px-1) color-mix(in srgb, currentColor 30%, transparent);
  }
</style>
