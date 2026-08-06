<script lang="ts">
  // In-app update prompt. Appears when the start-up check (or the manual check in
  // Settings) finds a newer release on GitHub. Install downloads the signed
  // package, then relaunches — no manual installer download.
  import { updater } from '$lib/stores/updater.svelte'

  // Reliable open gate for a class-$state singleton toggled from elsewhere
  // (same pattern as the other dialogs — see the T31 note in CLAUDE.md).
  let dlgOpen = $state(false)
  $effect(() => {
    dlgOpen = !!updater.available
  })

  const pending = $derived(updater.available)
  const busy = $derived(updater.installing)
</script>

{#if dlgOpen && pending}
  <!-- backdrop click does NOT close (project rule for form/dialog popups) -->
  <div
    onkeydown={(e) => e.key === 'Escape' && !busy && updater.later()}
    role="presentation"
    style="position:fixed;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:60"
  >
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Update available"
      tabindex="-1"
      style="width:var(--px-460);max-width:94vw;background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);box-shadow:0 var(--px-30) var(--px-70) var(--rgba-0-0-0-_55);overflow:hidden;display:flex;flex-direction:column"
    >
      <div style="flex:none;display:flex;align-items:center;gap:var(--px-10);padding:var(--px-15) var(--px-18);border-bottom:var(--px-1) solid var(--border)">
        <span style="font-weight:700;font-size:var(--px-15)">Update available</span>
        <span class="mono" style="font-size:var(--px-11_5);color:var(--muted)">{pending.currentVersion} → {pending.version}</span>
        {#if !busy}
          <span
            onclick={() => updater.later()}
            onkeydown={(e) => e.key === 'Enter' && updater.later()}
            role="button"
            tabindex="0"
            title="Remind me on the next launch"
            style="margin-left:auto;cursor:pointer;color:var(--muted);font-size:var(--px-20)">×</span>
        {/if}
      </div>

      <div style="padding:var(--px-16) var(--px-18);display:flex;flex-direction:column;gap:var(--px-10)">
        <div style="font-size:var(--px-12_5);color:var(--text2)">
          Database Studio <b style="color:var(--text)">{pending.version}</b> is available.
          It installs itself and restarts the app — no installer to download.
        </div>

        {#if pending.notes}
          <div style="font-size:var(--px-11_5);color:var(--muted)">Release notes</div>
          <pre
            class="selectable"
            style="margin:0;max-height:var(--px-180);overflow:auto;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-8) var(--px-10);font-size:var(--px-11_5);color:var(--text2);white-space:pre-wrap">{pending.notes}</pre>
        {/if}

        {#if busy}
          <div style="display:flex;align-items:center;gap:var(--px-8);font-size:var(--px-12);color:var(--text2)">
            <span>{updater.readyToRestart ? 'Restarting…' : 'Downloading…'}</span>
            {#if updater.size}<span class="mono" style="color:var(--muted)">{updater.size}</span>{/if}
            {#if updater.progress !== null}<span class="mono" style="margin-left:auto">{updater.progress}%</span>{/if}
          </div>
          <div style="height:var(--px-6);background:var(--panel);border-radius:var(--px-4);overflow:hidden">
            <div
              style="height:100%;background:var(--primary);width:{updater.progress === null ? 100 : updater.progress}%;opacity:{updater.progress === null ? 0.4 : 1};transition:width .2s"
            ></div>
          </div>
        {/if}
      </div>

      <div style="flex:none;display:flex;align-items:center;gap:var(--px-8);padding:var(--px-12) var(--px-18);border-top:var(--px-1) solid var(--border)">
        {#if !busy}
          <button
            onclick={() => updater.skip()}
            title="Never prompt for this version again"
            style="background:transparent;border:none;color:var(--muted);font-size:var(--px-12);cursor:pointer">Skip this version</button>
        {/if}
        <div style="margin-left:auto;display:flex;gap:var(--px-8)">
          <button
            onclick={() => updater.later()}
            disabled={busy}
            style="background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-7);padding:var(--px-7) var(--px-14);color:var(--text);font-size:var(--px-12_5);cursor:{busy ? 'default' : 'pointer'};opacity:{busy ? 0.5 : 1}">Later</button>
          <button
            onclick={() => void updater.installNow()}
            disabled={busy}
            style="background:var(--primary);border:none;border-radius:var(--px-7);padding:var(--px-7) var(--px-14);color:var(--hex-fff);font-weight:600;font-size:var(--px-12_5);cursor:{busy ? 'default' : 'pointer'};opacity:{busy ? 0.6 : 1}">
            {busy ? 'Installing…' : 'Update and restart'}
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}
