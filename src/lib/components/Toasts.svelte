<script lang="ts">
  // Toast — spec overview §2.6: border-left màu accent của connection phát sinh
  // event. Prototype chỉ có flash text inline (dòng 2648); toast nổi là spec.
  // Animation slidein port từ keyframes của prototype (app.css).
  import { toasts } from '$lib/stores/toast.svelte'
</script>

<div style="pointer-events:none;position:fixed;bottom:var(--px-30);right:var(--px-12);z-index:50;display:flex;width:var(--px-340);flex-direction:column;gap:var(--px-8)">
  {#each toasts.items as toast (toast.id)}
    <div
      onclick={() => toasts.dismiss(toast.id)}
      onkeydown={(e) => e.key === 'Enter' && toasts.dismiss(toast.id)}
      role="button"
      tabindex="0"
      style="pointer-events:auto;animation:slidein .25s ease;border-radius:var(--px-7);border:var(--px-1) solid var(--border);border-left:var(--px-3) solid {toast.accent};background:var(--raised);padding:var(--px-8) var(--px-12);text-align:left;font-size:var(--px-12);box-shadow:0 var(--px-16) var(--px-40) var(--rgba-0-0-0-_45);cursor:pointer"
    >
      <span style={toast.kind === 'error' ? 'color:var(--error)' : ''}>{toast.message}</span>
    </div>
  {/each}
</div>
