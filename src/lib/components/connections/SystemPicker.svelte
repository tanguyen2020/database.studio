<script lang="ts">
  // New-connection picker — port 1:1 từ Database Studio.dc.html dòng 1580-1598
  // (lưới 3 cột, card icon 30 + label; connTypes dòng 5745).
  // Khác prototype: hệ chưa tới phase bị disable (mờ + tooltip) thay vì click được.
  import SystemIcon from '$lib/components/SystemIcon.svelte'
  import { SYSTEM_ORDER, systemMeta } from '$lib/systems'
  import { connections } from '$lib/stores/connections.svelte'
  import { ui } from '$lib/stores/ui.svelte'
  import type { SystemType } from '$lib/types'

  function pick(system: SystemType) {
    if (!systemMeta(system).available) return
    ui.pickerOpen = false
    ui.formQuick = ui.pickerQuick
    ui.formProfile = connections.makeBlankProfile(system)
  }

  function close() {
    ui.pickerOpen = false
    ui.pickerQuick = false
  }
</script>

{#if ui.pickerOpen}
  <!-- Backdrop-click does NOT close (use × or Escape) — consistent with the
       connection form, so the New Connection flow isn't dismissed accidentally. -->
  <div
    onkeydown={(e) => e.key === 'Escape' && close()}
    role="presentation"
    style="position:fixed;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:57"
  >
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
    <div
      onclick={(e) => e.stopPropagation()}
      role="dialog"
      aria-label="New Connection"
      tabindex="-1"
      style="width:var(--px-520);max-width:94vw;background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);box-shadow:0 var(--px-30) var(--px-70) var(--rgba-0-0-0-_55);overflow:hidden"
    >
      <div style="display:flex;align-items:center;gap:var(--px-10);padding:var(--px-16) var(--px-20);border-bottom:var(--px-1) solid var(--border)">
        <span style="font-weight:700;font-size:var(--px-15)">{ui.pickerQuick ? 'Quick Connect' : 'New Connection'}</span>
        <span style="font-size:var(--px-12);color:var(--muted)">{ui.pickerQuick ? 'One-off · not saved' : 'Choose database type'}</span>
        <span
          onclick={close}
          onkeydown={(e) => e.key === 'Enter' && close()}
          role="button"
          tabindex="0"
          style="margin-left:auto;cursor:pointer;color:var(--muted);font-size:var(--px-20)"
        >×</span>
      </div>
      <div style="padding:var(--px-18) var(--px-20);display:grid;grid-template-columns:1fr 1fr 1fr;gap:var(--px-12)">
        {#each SYSTEM_ORDER as key (key)}
          {@const meta = systemMeta(key)}
          <div
            onclick={() => pick(key as SystemType)}
            onkeydown={(e) => e.key === 'Enter' && pick(key as SystemType)}
            role="button"
            tabindex="0"
            class="picker-card"
            style="display:flex;flex-direction:column;align-items:center;gap:var(--px-9);padding:var(--px-18) var(--px-10);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-10);cursor:{meta.available ? 'pointer' : 'not-allowed'};opacity:{meta.available ? 1 : 0.45}"
            title={meta.available ? meta.label : `${meta.label} — coming soon`}
          >
            <span style="display:flex;align-items:center;justify-content:center;height:var(--px-34)"><SystemIcon system={key} size={30} /></span>
            <span style="font-size:var(--px-12_5);font-weight:600">{meta.label}</span>
          </div>
        {/each}
      </div>
      <!-- footer: Close button (same action as the × / Escape) -->
      <div style="display:flex;justify-content:flex-end;gap:var(--px-8);padding:var(--px-14) var(--px-20);border-top:var(--px-1) solid var(--border)">
        <span onclick={close} onkeydown={(e) => e.key === 'Enter' && close()} role="button" tabindex="0" class="pk-btn">Close</span>
      </div>
    </div>
  </div>
{/if}

<style>
  /* style-hover của card (dòng 1590) */
  .picker-card:hover {
    border-color: var(--border2) !important;
    background: var(--hover) !important;
  }
  /* footer Close button */
  .pk-btn {
    font-size: var(--px-12_5);
    color: var(--text2);
    background: var(--panel);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-7);
    padding: var(--px-6) var(--px-16);
    cursor: pointer;
    font-weight: 600;
  }
  .pk-btn:hover {
    background: var(--hover);
  }
</style>
