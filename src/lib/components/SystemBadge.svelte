<script lang="ts">
  import { systemMeta } from '$lib/systems'

  interface Props {
    system: string | null | undefined
    /** sm = tab bar / status bar, md = connection list / pickers */
    size?: 'sm' | 'md'
    /** dim without losing the system color (inactive tabs) */
    dimmed?: boolean
  }

  let { system, size = 'sm', dimmed = false }: Props = $props()

  const meta = $derived(systemMeta(system))
</script>

<span
  class="mono inline-flex shrink-0 select-none items-center justify-center rounded-[4px] border font-semibold leading-none
    {size === 'sm' ? 'h-[16px] min-w-[22px] px-1 text-[9.5px]' : 'h-[20px] min-w-[28px] px-1.5 text-[11px]'}"
  style="background: {meta.bg}; border-color: {meta.border}; color: {meta.fg}; opacity: {dimmed ? 0.6 : 1};"
  title={meta.label}
>
  {meta.badge}
</span>
