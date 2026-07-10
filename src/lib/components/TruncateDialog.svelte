<script lang="ts">
  // Truncate confirm dialog — shows the exact per-dialect statement(s) for the chosen
  // variant and runs them only after an explicit confirm (destructive). Backdrop click
  // does NOT close (rule chung); use × / Cancel / Escape.
  import { truncateWizard } from '$lib/stores/truncate.svelte'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import * as ipc from '$lib/ipc'
  import { genTruncateStatements, truncateOptions } from '$lib/sql/truncate'
  import { autofocus } from '$lib/actions/autofocus'

  // Effect-mirror the store's open flag (reliable cross-component tracking, Svelte 5).
  let dlgOpen = $state(false)
  $effect(() => {
    dlgOpen = truncateWizard.open
  })

  let busy = $state(false)
  let err = $state<string | null>(null)

  const w = truncateWizard
  const label = $derived(truncateOptions(w.system).find((o) => o.variant === w.variant)?.label ?? 'Truncate')
  const statements = $derived(
    w.connId ? genTruncateStatements(w.system, w.schema, w.table, w.variant) : [],
  )

  async function run() {
    if (busy || !w.connId || !statements.length) return
    busy = true
    err = null
    try {
      for (let i = 0; i < statements.length; i++) {
        const res = await ipc.execStatement(w.connId, statements[i], i)
        if (!res.ok) {
          err = res.error?.message ?? 'Truncate failed'
          return
        }
      }
      toasts.success(`Truncated ${w.schema}.${w.table}`)
      await explorer.refresh(w.connId, { kind: 'table', schema: w.schema, table: w.table }).catch(() => {})
      w.onDone?.()
      w.close()
    } catch (e) {
      err = String(e)
    } finally {
      busy = false
    }
  }
</script>

{#if dlgOpen}
  <!-- backdrop does NOT confirm/close; only ×/Cancel/Escape -->
  <div
    onkeydown={(e) => e.key === 'Escape' && !busy && w.close()}
    role="presentation"
    style="position:fixed;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:60"
  >
    <div
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.key === 'Escape' && !busy && w.close()}
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      style="width:var(--px-560);max-width:94vw;background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);box-shadow:0 var(--px-30) var(--px-70) var(--rgba-0-0-0-_55);overflow:hidden;display:flex;flex-direction:column"
    >
      <div style="flex:none;display:flex;align-items:center;gap:var(--px-10);padding:var(--px-15) var(--px-18);border-bottom:var(--px-1) solid var(--border)">
        <span style="color:var(--error);font-size:var(--px-16)">⚠</span>
        <span style="font-weight:700;font-size:var(--px-15)">{label}</span>
        <span onclick={() => !busy && w.close()} onkeydown={(e) => e.key === 'Enter' && !busy && w.close()} role="button" tabindex="0" style="margin-left:auto;cursor:pointer;color:var(--muted);font-size:var(--px-20)">×</span>
      </div>

      <div style="flex:1;min-height:0;padding:var(--px-16) var(--px-18);display:flex;flex-direction:column;gap:var(--px-12)">
        <div style="font-size:var(--px-13);color:var(--text);line-height:1.5">
          This permanently removes <b>all rows</b> from <b class="mono">{w.schema}.{w.table}</b>. This cannot be undone.
        </div>
        <div style="display:flex;flex-direction:column;gap:var(--px-4)">
          <span class="mono" style="font-size:var(--px-11);text-transform:uppercase;letter-spacing:.06em;color:var(--muted)">Statement{statements.length > 1 ? 's' : ''}</span>
          <pre class="selectable mono" style="margin:0;padding:var(--px-10) var(--px-12);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-8);font-size:var(--px-12);line-height:1.55;white-space:pre-wrap;overflow-x:auto;color:var(--text)">{statements.join('\n')}</pre>
        </div>
        {#if err}<div class="mono" style="font-size:var(--px-12);color:var(--error)">✗ {err}</div>{/if}
      </div>

      <div style="flex:none;display:flex;gap:var(--px-9);padding:var(--px-13) var(--px-18);border-top:var(--px-1) solid var(--border);background:var(--panel)">
        <span use:autofocus onclick={() => !busy && w.close()} onkeydown={(e) => e.key === 'Enter' && !busy && w.close()} role="button" tabindex="0" style="font-size:var(--px-12_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-8) var(--px-16);cursor:pointer">Cancel</span>
        <span onclick={run} onkeydown={(e) => e.key === 'Enter' && run()} role="button" tabindex="0" aria-disabled={busy} style="margin-left:auto;font-size:var(--px-12_5);background:var(--error);color:var(--hex-fff);border-radius:var(--px-8);padding:var(--px-8) var(--px-18);cursor:{busy ? 'not-allowed' : 'pointer'};opacity:{busy ? 0.6 : 1};font-weight:600">{busy ? 'Truncating…' : label}</span>
      </div>
    </div>
  </div>
{/if}
