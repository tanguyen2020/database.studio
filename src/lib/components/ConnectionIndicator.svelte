<script lang="ts">
  import { systemMeta } from '$lib/systems'

  interface Props {
    system: string | null | undefined
    /** stretch to the row height (default) or fixed height */
    height?: string
  }

  let { system, height = '100%' }: Props = $props()

  const meta = $derived(systemMeta(system))
</script>

<!-- 3px vertical accent bar — never gray for a known system -->
<span
  class="inline-block w-[3px] shrink-0 rounded-full"
  style="background: {meta.accent}; height: {height};"
  aria-hidden="true"
></span>
