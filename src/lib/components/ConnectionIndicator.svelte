<script lang="ts">
  // port từ thanh accent trong connection row, Database Studio.dc.html dòng 117:
  // width:3px; align-self:stretch; border-radius:2px; background:accent;
  // margin:1px 0 1px 4px
  import { systemMeta } from '$lib/systems'

  interface Props {
    system: string | null | undefined
    /** true = nằm trong connection row (có margin như HTML); false = tự bố trí */
    rowMargin?: boolean
    height?: string
  }

  let { system, rowMargin = true, height }: Props = $props()

  const meta = $derived(systemMeta(system))
</script>

<span
  style="width:var(--px-3);flex:none;border-radius:var(--px-2);background:{meta.accent};{height ? `height:${height};` : 'align-self:stretch;'}{rowMargin ? 'margin:var(--px-1) 0 var(--px-1) var(--px-4);' : ''}"
  aria-hidden="true"
></span>
