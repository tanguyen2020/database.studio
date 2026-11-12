<script lang="ts">
  // Export Connections — pick connections, optionally include their passwords
  // (sealed with a file password in the backend), save the file.
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import { connTransfer } from '$lib/stores/connTransfer.svelte'
  import { connections } from '$lib/stores/connections.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { brandKey, brandLabel } from '$lib/brand'
  import { exportFileName, filePasswordProblem, targetLabel } from '$lib/connections/transfer'
  import { saveText } from '$lib/elastic/save'
  import Icon from '$lib/components/Icon.svelte'
  import SystemIcon from '$lib/components/SystemIcon.svelte'
  import type { ProfilePublic } from '$lib/types'
  import '$lib/components/workspace/users/um.css'

  let dlgOpen = $state(false)
  $effect(() => {
    dlgOpen = connTransfer.mode === 'export'
  })

  let picked = $state<Set<string>>(new Set())
  let search = $state('')
  let withPasswords = $state(true)
  let filePw = $state('')
  let filePw2 = $state('')
  let showPw = $state(false)
  let busy = $state(false)
  let error = $state<string | null>(null)
  let done = $state<{ count: number; withPasswords: boolean } | null>(null)

  const saved = $derived(connections.profiles.filter((p) => !p.ephemeral))

  // Reset every time the dialog opens.
  $effect(() => {
    if (!dlgOpen) return
    untrack(() => {
      const pre = connTransfer.preselect.filter((id) => saved.some((p) => p.id === id))
      picked = new Set(pre.length ? pre : saved.map((p) => p.id))
      search = ''
      withPasswords = true
      filePw = ''
      filePw2 = ''
      showPw = false
      busy = false
      error = null
      done = null
    })
  })

  const shown = $derived.by(() => {
    const q = search.trim().toLowerCase()
    const list = q
      ? saved.filter((p) => `${p.name} ${p.host} ${p.database} ${brandLabel(p)}`.toLowerCase().includes(q))
      : saved
    return [...list].sort((a, b) => brandLabel(a).localeCompare(brandLabel(b)) || a.name.localeCompare(b.name))
  })
  const chosen = $derived(saved.filter((p) => picked.has(p.id)))
  const allShownPicked = $derived(shown.length > 0 && shown.every((p) => picked.has(p.id)))
  const pwProblem = $derived(withPasswords ? filePasswordProblem(filePw, filePw2) : null)
  const needsFiles = $derived(
    chosen.filter((p) => (p.ssh?.enabled && p.ssh.auth === 'key' && p.ssh.key_path) || (p.ssl && (p.ssl_ca || p.ssl_cert || p.ssl_key))),
  )
  const noSavedPassword = $derived(chosen.filter((p) => !p.has_password && p.system !== 'sqlite' && p.system !== 'duckdb'))
  const canExport = $derived(!busy && chosen.length > 0 && !pwProblem)

  function toggle(id: string) {
    const next = new Set(picked)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    picked = next
  }

  function toggleAll() {
    const next = new Set(picked)
    if (allShownPicked) for (const p of shown) next.delete(p.id)
    else for (const p of shown) next.add(p.id)
    picked = next
  }

  function close() {
    if (!busy) connTransfer.close()
  }

  async function doExport() {
    if (!canExport) return
    busy = true
    error = null
    try {
      // keep the order the user sees
      const ids = shown.filter((p) => picked.has(p.id)).map((p) => p.id)
      for (const p of chosen) if (!ids.includes(p.id)) ids.push(p.id)
      const text = await ipc.exportConnections(ids, withPasswords ? filePw : null)
      const ok = await saveText(exportFileName(), text, 'json', 'application/json')
      if (!ok) return // Save dialog cancelled — stay in the dialog
      done = { count: ids.length, withPasswords }
      toasts.success(
        `Exported ${ids.length} connection${ids.length === 1 ? '' : 's'}${withPasswords ? ' with passwords' : ''}`,
      )
    } catch (e) {
      error = String(e)
    } finally {
      busy = false
    }
  }

  function envLabel(p: ProfilePublic) {
    return p.env ? p.env[0].toUpperCase() + p.env.slice(1) : ''
  }
</script>

{#if dlgOpen}
  <!-- backdrop click does NOT close (rule for every form dialog); × / Cancel / Escape do -->
  <div onkeydown={(e) => e.key === 'Escape' && close()} role="presentation" class="um-backdrop">
    <div
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.key === 'Escape' && close()}
      role="dialog"
      aria-modal="true"
      aria-label="Export connections"
      tabindex="-1"
      class="um-dlg"
      style="width:var(--px-640);max-width:calc(100vw - var(--px-40))"
    >
      <div class="um-dlg-head">
        <span class="um-dlg-icon"><Icon name="upload" size={18} /></span>
        <div class="um-dlg-title">
          <b>Export connections</b>
          <span>Move them to another computer, or share them with your team</span>
        </div>
        <span class="um-dlg-x" onclick={close} onkeydown={(e) => e.key === 'Enter' && close()} role="button" tabindex="0" aria-label="Close" title="Close"><Icon name="close" size={16} /></span>
      </div>

      {#if done}
        <div class="um-dlg-body">
          <div class="xc-done" role="status">
            <span class="xc-done-icon"><Icon name="check" size={22} /></span>
            <div>
              <b>{done.count} connection{done.count === 1 ? '' : 's'} exported</b>
              {#if done.withPasswords}
                <p>The file and every password in it are encrypted. To import it, the other computer needs the <b>file password</b> — send that separately, not in the same message as the file.</p>
              {:else}
                <p>The file has hosts, ports and user names only. Whoever imports it types each password when connecting.</p>
              {/if}
              <p>On the other computer: <b>Connections → Import connections…</b></p>
            </div>
          </div>
        </div>
        <div class="um-dlg-foot">
          <span class="um-spacer"></span>
          <span class="cfm-btn primary" onclick={close} onkeydown={(e) => e.key === 'Enter' && close()} role="button" tabindex="0">Done</span>
        </div>
      {:else}
        <div class="um-dlg-body">
          <div class="um-section-title xc-sec">
            <span>Connections</span>
            <span class="xc-count" aria-live="polite">{chosen.length} of {saved.length} selected</span>
          </div>
          {#if saved.length === 0}
            <div class="um-callout" style="margin:0"><Icon name="info" size={15} /><span>There are no saved connections to export yet.</span></div>
          {:else}
            <div class="xc-tools">
              <label class="ds-search sm xc-search">
                <Icon name="search" size={12} />
                <input bind:value={search} placeholder="Search connections" aria-label="Search connections to export" spellcheck="false" />
              </label>
              <span class="eg-btn" onclick={toggleAll} onkeydown={(e) => e.key === 'Enter' && toggleAll()} role="button" tabindex="0">{allShownPicked ? 'Select none' : 'Select all'}</span>
            </div>
            <div class="xc-list" role="group" aria-label="Connections to export">
              {#each shown as p (p.id)}
                <label class="xc-row" class:on={picked.has(p.id)}>
                  <input type="checkbox" checked={picked.has(p.id)} onchange={() => toggle(p.id)} aria-label={p.name} />
                  <SystemIcon system={brandKey(p)} size={16} />
                  <span class="xc-text">
                    <span class="xc-name">{p.name}</span>
                    <span class="xc-sub mono" title={targetLabel(p)}>{targetLabel(p)}</span>
                  </span>
                  {#if p.env}<span class="um-badge">{envLabel(p)}</span>{/if}
                </label>
              {:else}
                <div class="xc-empty">No connection matches “{search}”.</div>
              {/each}
            </div>
          {/if}

          <div class="um-section-title xc-sec"><span>Passwords</span></div>
          <label class="um-toggle">
            <span class="um-toggle-text">
              <span>Include passwords</span>
              <span>Encrypts the whole file with a password you choose. Without it, the file holds hosts and user names only and everyone types each password again.</span>
            </span>
            <input type="checkbox" class="um-switch" bind:checked={withPasswords} aria-label="Include passwords" />
          </label>

          {#if withPasswords}
            <div class="um-row2">
              <label class="um-field">File password
                <div class="um-pw">
                  <input type={showPw ? 'text' : 'password'} bind:value={filePw} class="um-input" autocomplete="new-password" placeholder="At least 8 characters" aria-label="File password" />
                  <span class="eg-btn" onclick={() => (showPw = !showPw)} onkeydown={(e) => e.key === 'Enter' && (showPw = !showPw)} role="button" tabindex="0" title={showPw ? 'Hide password' : 'Show password'} aria-label={showPw ? 'Hide password' : 'Show password'}><Icon name={showPw ? 'eye-off' : 'eye'} size={13} /></span>
                </div>
              </label>
              <label class="um-field">Repeat it
                <input type={showPw ? 'text' : 'password'} bind:value={filePw2} class="um-input" autocomplete="new-password" aria-label="Repeat the file password" />
              </label>
            </div>
            {#if pwProblem && (filePw || filePw2)}
              <div class="um-field-err" role="alert">{pwProblem}</div>
            {:else}
              <div class="um-field-hint">Needed to import the file. There is no way to recover it — keep it somewhere safe.</div>
            {/if}
            {#if noSavedPassword.length > 0}
              <div class="um-callout" style="margin:var(--px-10) 0 0">
                <Icon name="info" size={15} />
                <span>{noSavedPassword.length === 1 ? `“${noSavedPassword[0].name}” has` : `${noSavedPassword.length} connections have`} no saved password — {noSavedPassword.length === 1 ? 'it goes' : 'they go'} into the file without one.</span>
              </div>
            {/if}
          {/if}

          {#if needsFiles.length > 0}
            <div class="um-callout warn" style="margin:var(--px-10) 0 0">
              <Icon name="warning" size={15} />
              <span>SSH keys and TLS certificates are not copied into the file — only their paths. Copy those files to the other computer too ({needsFiles.map((p) => p.name).join(', ')}).</span>
            </div>
          {/if}

          {#if error}
            <div class="um-err" role="alert" style="margin-top:var(--px-10)"><Icon name="warning" size={14} /><span>{error}</span></div>
          {/if}
        </div>

        <div class="um-dlg-foot">
          <span class="um-dlg-foot-note">{withPasswords ? 'Encrypted with AES-256' : 'No passwords in the file'}</span>
          <span class="um-spacer"></span>
          <span class="cfm-btn" onclick={close} onkeydown={(e) => e.key === 'Enter' && close()} role="button" tabindex="0">Cancel</span>
          <span
            class="cfm-btn primary"
            onclick={() => void doExport()}
            onkeydown={(e) => e.key === 'Enter' && void doExport()}
            role="button"
            tabindex="0"
            aria-disabled={!canExport}
          >{busy ? (withPasswords ? 'Encrypting…' : 'Exporting…') : `Export ${chosen.length || ''} connection${chosen.length === 1 ? '' : 's'}`.replace('  ', ' ')}</span>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .xc-sec {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }
  .xc-count {
    font-weight: 500;
    text-transform: none;
    letter-spacing: 0;
    color: var(--muted);
  }
  .xc-tools {
    display: flex;
    align-items: center;
    gap: var(--px-8);
    margin-bottom: var(--px-6);
  }
  .xc-search {
    flex: 1;
  }
  .xc-list {
    max-height: var(--px-240);
    overflow: auto;
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-8);
    background: var(--surface);
  }
  .xc-row {
    display: flex;
    align-items: center;
    gap: var(--px-9);
    padding: var(--px-7) var(--px-10);
    border-bottom: var(--px-1) solid var(--border);
    cursor: pointer;
  }
  .xc-row:last-child {
    border-bottom: 0;
  }
  .xc-row:hover {
    background: var(--row-hover);
  }
  .xc-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .xc-name {
    font-weight: 500;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .xc-sub {
    font-size: var(--px-11);
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .xc-empty {
    padding: var(--px-14);
    color: var(--muted);
    text-align: center;
  }
  .xc-done {
    display: flex;
    gap: var(--px-14);
    align-items: flex-start;
  }
  .xc-done p {
    margin: var(--px-6) 0 0;
    color: var(--text2);
    line-height: 1.5;
  }
  .xc-done-icon {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--px-40);
    height: var(--px-40);
    border-radius: 50%;
    color: var(--success);
    background: color-mix(in srgb, var(--success) 14%, transparent);
  }
</style>
