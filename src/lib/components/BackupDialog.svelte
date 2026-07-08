<script lang="ts">
  // Backup & Restore wizard (Phase 5 · T22). Hiển thị tình trạng công cụ (có/thiếu
  // binary), chọn tên file đích, chạy backup + lịch sử, và restore (confirm).
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import { backupWizard } from '$lib/stores/backup.svelte'
  import { toasts } from '$lib/stores/toast.svelte'

  let toolStatus = $state<ipc.BackupToolStatus | null>(null)
  let dest = $state('')
  let src = $state('')
  let running = $state(false)
  let confirmRestore = $state(false)
  let result = $state<string | null>(null)

  $effect(() => {
    if (backupWizard.open) untrack(() => void init())
  })
  async function init() {
    toolStatus = null
    result = null
    confirmRestore = false
    running = false
    dest = `${backupWizard.system || 'db'}-backup-${Date.now()}.${backupWizard.system === 'sqlite' ? 'db' : 'sql'}`
    src = ''
    if (backupWizard.connId) {
      toolStatus = await ipc.backupToolStatus(backupWizard.connId).catch(() => null)
    }
  }

  async function runBackup() {
    if (!backupWizard.connId || !dest.trim()) return
    running = true
    result = null
    try {
      result = await ipc.backupDatabase(backupWizard.connId, dest.trim())
      backupWizard.record(dest.trim(), true)
      toasts.success('Backup complete')
    } catch (e) {
      result = `✗ ${e}`
      backupWizard.record(dest.trim(), false)
      toasts.error(String(e))
    } finally {
      running = false
    }
  }

  async function runRestore() {
    if (!backupWizard.connId || !src.trim()) return
    running = true
    result = null
    confirmRestore = false
    try {
      result = await ipc.restoreDatabase(backupWizard.connId, src.trim())
      toasts.success('Restore complete')
    } catch (e) {
      result = `✗ ${e}`
      toasts.error(String(e))
    } finally {
      running = false
    }
  }
</script>

{#if backupWizard.open}
  <!-- backdrop click does NOT close (avoid losing input); use × / Cancel / Escape -->
  <div onkeydown={(e) => e.key === 'Escape' && !running && backupWizard.close()} role="presentation" style="position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:56">
    <div onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.key === 'Escape' && !running && backupWizard.close()} role="dialog" aria-modal="true" tabindex="-1" style="width:var(--px-560);max-width:95vw;max-height:90vh;background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);box-shadow:0 var(--px-30) var(--px-70) rgba(0,0,0,.55);overflow:hidden;display:flex;flex-direction:column">
      <div style="flex:none;display:flex;align-items:center;gap:var(--px-10);padding:var(--px-15) var(--px-18);border-bottom:var(--px-1) solid var(--border)">
        <span style="font-weight:700;font-size:var(--px-15)">Backup & Restore · {backupWizard.system}</span>
        <span onclick={() => !running && backupWizard.close()} onkeydown={(e) => e.key === 'Enter' && !running && backupWizard.close()} role="button" tabindex="0" style="margin-left:auto;cursor:pointer;color:var(--muted);font-size:var(--px-20)">×</span>
      </div>
      <div style="flex:1;overflow:auto;min-height:0;padding:var(--px-16) var(--px-18);display:flex;flex-direction:column;gap:var(--px-12)">
        {#if toolStatus}
          <div style="font-size:var(--px-11_5);color:{toolStatus.available ? '#27AE60' : 'var(--error)'}">
            {toolStatus.available ? `✓ Tool: ${toolStatus.tool}` : `✗ Missing tool: ${toolStatus.tool ?? 'not supported'} — install it and retry`}
          </div>
        {/if}

        <div style="font-size:var(--px-13);font-weight:600">Backup</div>
        <label style="font-size:var(--px-12);color:var(--text2)">Destination file
          <input bind:value={dest} class="mono" style="display:block;margin-top:var(--px-5);width:100%;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-8);color:var(--text);font-size:var(--px-12)" />
        </label>
        <span onclick={() => !running && runBackup()} onkeydown={(e) => e.key === 'Enter' && !running && runBackup()} role="button" tabindex="0" style="align-self:flex-start;font-size:var(--px-12_5);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-8);padding:var(--px-7) var(--px-16);cursor:{running ? 'not-allowed' : 'pointer'};opacity:{running ? 0.6 : 1};font-weight:600">{running ? 'Working…' : 'Backup now'}</span>

        <div style="height:var(--px-1);background:var(--border);margin:var(--px-4) 0"></div>
        <div style="font-size:var(--px-13);font-weight:600">Restore</div>
        <label style="font-size:var(--px-12);color:var(--text2)">Backup file to restore
          <input bind:value={src} placeholder="backup file path" class="mono" style="display:block;margin-top:var(--px-5);width:100%;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-8);color:var(--text);font-size:var(--px-12)" />
        </label>
        {#if confirmRestore}
          <div style="display:flex;align-items:center;gap:var(--px-8);font-size:var(--px-11_5);color:var(--error)">
            Overwrite current data?
            <span onclick={runRestore} onkeydown={(e) => e.key === 'Enter' && runRestore()} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--error);color:var(--hex-fff);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer;font-weight:600">Confirm restore</span>
            <span onclick={() => (confirmRestore = false)} onkeydown={(e) => e.key === 'Enter' && (confirmRestore = false)} role="button" tabindex="0" style="font-size:var(--px-11_5);color:var(--text2);cursor:pointer">Cancel</span>
          </div>
        {:else}
          <span onclick={() => src.trim() && (confirmRestore = true)} onkeydown={(e) => e.key === 'Enter' && src.trim() && (confirmRestore = true)} role="button" tabindex="0" style="align-self:flex-start;font-size:var(--px-12_5);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-7) var(--px-16);cursor:pointer">Restore…</span>
        {/if}

        {#if result !== null}
          <div style="font-size:var(--px-12_5);color:{result.startsWith('✓') ? '#27AE60' : 'var(--error)'};padding:var(--px-6) 0">{result}</div>
        {/if}

        {#if backupWizard.history.length}
          <div style="font-size:var(--px-11);color:var(--muted);margin-top:var(--px-4)">History</div>
          {#each backupWizard.history as h (h.at + h.dest)}
            <div class="mono" style="font-size:var(--px-10_5);color:var(--text2)">{h.ok ? '✓' : '✗'} {h.at} · {h.dest}</div>
          {/each}
        {/if}
      </div>
    </div>
  </div>
{/if}
