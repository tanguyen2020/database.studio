<script lang="ts">
  // port từ badge pill trong Database Studio.dc.html:
  //  - dòng 873 (history row): font-size 9px, 700, radius 3px, padding 1px 6px,
  //    background bg, color fg, border 1px solid border
  //  - dòng 1180 (saved query): như trên nhưng KHÔNG có border
  import { systemMeta } from '$lib/systems'

  interface Props {
    system: string | null | undefined
    /** dòng 1180 dùng pill không viền */
    border?: boolean
  }

  let { system, border = true }: Props = $props()

  const meta = $derived(systemMeta(system))
</script>

<span
  style="flex:none;font-size:var(--px-9);font-weight:700;border-radius:var(--px-3);padding:var(--px-1) var(--px-6);background:{meta.bg};color:{meta.fg};{border ? `border:var(--px-1) solid ${meta.border};` : ''}"
  title={meta.label}
>
  {meta.badge}
</span>
