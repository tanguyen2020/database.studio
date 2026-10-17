<script lang="ts">
  // Kibana app icon (official EUI asset, 32×32, two-tone): the main shape takes the
  // text colour, `euiIcon__fillSecondary` the Elastic teal — as in Kibana's nav.
  import { EUI_APPS, ES_LOGO, type EuiApp } from '$lib/elastic/eui-icons'

  let { name, size = 24 }: { name: EuiApp | 'elasticsearch'; size?: number } = $props()
  const icon = $derived(name === 'elasticsearch' ? ES_LOGO : EUI_APPS[name])
</script>

<svg class="es-app-icon" viewBox={icon.vb} width={size} height={size} aria-hidden="true" focusable="false" data-eui={icon.src}>{@html icon.body}</svg>

<style>
  .es-app-icon {
    display: inline-block;
    flex: none;
    fill: var(--text);
  }
  .es-app-icon :global(.euiIcon__fillSecondary) {
    fill: var(--es-accent);
  }
  .es-app-icon :global(.euiIcon__fillNegative) {
    fill: var(--text);
  }
</style>
