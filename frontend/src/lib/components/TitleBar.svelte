<script lang="ts">
  import { ui } from '$lib/stores/ui.svelte'
</script>

<div class="flex h-[32px] shrink-0 items-center gap-2 border-b border-border bg-header px-3">
  <span class="text-[13px] font-semibold tracking-tight">◴ Database Studio</span>
  <div class="grow"></div>
  <button
    class="rounded px-1.5 py-0.5 text-[13px] text-text2 hover:bg-hover hover:text-foreground"
    title="Toggle theme"
    onclick={() => ui.toggleTheme()}
  >
    {ui.theme === 'dark' ? '☾' : '☀'}
  </button>
</div>
