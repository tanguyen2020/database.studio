<script lang="ts">
  import { toasts } from '$lib/stores/toast.svelte'
</script>

<div class="pointer-events-none fixed bottom-8 right-3 z-50 flex w-[340px] flex-col gap-2">
  {#each toasts.items as toast (toast.id)}
    <button
      class="pointer-events-auto animate-in slide-in-from-right rounded-md border border-border bg-raised px-3 py-2 text-left text-[12px] shadow-lg"
      style="border-left: 3px solid {toast.accent};"
      onclick={() => toasts.dismiss(toast.id)}
    >
      <span class={toast.kind === 'error' ? 'text-error' : ''}>{toast.message}</span>
    </button>
  {/each}
</div>
