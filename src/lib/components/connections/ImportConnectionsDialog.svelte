<script lang="ts">
  // Import Connections — pick a file, unlock it with its file password when it
  // carries passwords, review what will be added / replaced / skipped, import.
  // The file is read and every secret handled in the backend; this dialog only
  // ever sees profiles without passwords.
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import { IS_TAURI } from '$lib/demo'
  import { connTransfer } from '$lib/stores/connTransfer.svelte'
  import { connections } from '$lib/stores/connections.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { brandKey } from '$lib/brand'
  import { planImport, renameAdded, targetLabel, type ImportAction, type ImportRow } from '$lib/connections/transfer'
  import { parseDbeaver, toConnectionsFile, type SkippedSource } from '$lib/connections/dbeaver'
  import Icon from '$lib/components/Icon.svelte'
  import SystemIcon from '$lib/components/SystemIcon.svelte'
  import '$lib/components/workspace/users/um.css'

  let dlgOpen = $state(false)
  $effect(() => {
    dlgOpen = connTransfer.mode === 'import'
  })

  type Step = 'source' | 'file' | 'dbeaver' | 'locked' | 'review' | 'done'
  let step = $state<Step>('source')
  let importSource = $state<'ds' | 'dbeaver'>('ds')
  let skipped = $state<SkippedSource[]>([])
  let fileName = $state('')
  let content = $state('')
  let passphrase = $state('')
  let showPw = $state(false)
  let sealed = $state(false)
  let rows = $state<ImportRow[]>([])
  let busy = $state(false)
  let error = $state<string | null>(null)
  let wrongPw = $state(false)
  let result = $state<{ added: number; replaced: number; skipped: number; withPassword: number; withoutPassword: number } | null>(null)
  let fileInput = $state<HTMLInputElement | null>(null)

  $effect(() => {
    if (!dlgOpen) return
    untrack(() => {
      step = 'source'
      importSource = 'ds'
      skipped = []
      fileName = ''
      content = ''
      passphrase = ''
      showPw = false
      sealed = false
      rows = []
      busy = false
      error = null
      wrongPw = false
      result = null
    })
  })

  const existingNames = $derived(connections.profiles.filter((p) => !p.ephemeral).map((p) => p.name))
  const counts = $derived({
    add: rows.filter((r) => r.action === 'add').length,
    replace: rows.filter((r) => r.action === 'replace').length,
    skip: rows.filter((r) => r.action === 'skip').length,
  })
  const toImport = $derived(counts.add + counts.replace)

  function close() {
    if (!busy) connTransfer.close()
  }

  function pickSource(s: 'ds' | 'dbeaver') {
    importSource = s
    error = null
    skipped = []
    step = s === 'ds' ? 'file' : 'dbeaver'
  }

  async function chooseFile() {
    error = null
    if (IS_TAURI) {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const path = await open({ multiple: false, filters: [{ name: 'Connections file', extensions: ['json'] }] })
      if (!path || Array.isArray(path)) return
      try {
        const text = await ipc.readTextFile(path)
        const name = path.split(/[\\/]/).pop() ?? path
        if (importSource === 'dbeaver') await loadDbeaver(text, name)
        else await loadText(text, name)
      } catch (e) {
        error = String(e)
      }
    } else {
      fileInput?.click()
    }
  }

  async function onFilePicked(e: Event) {
    const input = e.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    if (importSource === 'dbeaver') await loadDbeaver(await file.text(), file.name)
    else await loadText(await file.text(), file.name)
  }

  async function loadText(text: string, name: string) {
    content = text
    fileName = name
    passphrase = ''
    wrongPw = false
    await inspect(null)
  }

  /** DBeaver source: parse its data-sources.json → profiles (no secrets) → wrap in
   *  a Database Studio file → feed the normal review path. */
  async function loadDbeaver(text: string, name: string) {
    try {
      const { profiles, skipped: sk } = parseDbeaver(text)
      skipped = sk
      if (profiles.length === 0) {
        error = sk.length ? 'Every connection in this file uses an engine Database Studio does not support.' : 'This DBeaver file has no connections.'
        step = 'dbeaver'
        return
      }
      content = toConnectionsFile(profiles)
      fileName = name
      passphrase = ''
      wrongPw = false
      await inspect(null)
    } catch (e) {
      error = String((e as Error)?.message ?? e)
      step = 'dbeaver'
    }
  }

  async function autoDetectDbeaver() {
    error = null
    busy = true
    try {
      const paths = await ipc.findDbeaverSources()
      if (paths.length === 0) {
        error = 'No DBeaver workspace was found on this computer. Use “Choose file…” to point to its data-sources.json.'
        return
      }
      const texts = await Promise.all(paths.map((p) => ipc.readTextFile(p)))
      const profiles: ReturnType<typeof parseDbeaver>['profiles'] = []
      const sk: SkippedSource[] = []
      for (const t of texts) {
        try {
          const r = parseDbeaver(t)
          profiles.push(...r.profiles)
          sk.push(...r.skipped)
        } catch {
          /* skip an unreadable workspace file */
        }
      }
      skipped = sk
      if (profiles.length === 0) {
        error = 'DBeaver was found, but none of its connections use a supported engine.'
        return
      }
      content = toConnectionsFile(profiles)
      fileName = paths.length === 1 ? 'DBeaver workspace' : `${paths.length} DBeaver workspaces`
      passphrase = ''
      wrongPw = false
      await inspect(null)
    } catch (e) {
      error = String((e as Error)?.message ?? e)
    } finally {
      busy = false
    }
  }

  async function inspect(pw: string | null) {
    busy = true
    error = null
    try {
      const r = await ipc.inspectConnectionsFile(content, pw)
      if (r.status === 'needs_passphrase') {
        step = 'locked'
      } else if (r.status === 'wrong_passphrase') {
        step = 'locked'
        wrongPw = true
      } else {
        sealed = r.sealed
        rows = planImport(r.items, connections.profiles.filter((p) => !p.ephemeral))
        step = 'review'
        if (r.items.length === 0) error = 'This file has no connections in it.'
      }
    } catch (e) {
      error = String(e)
      step = 'file'
    } finally {
      busy = false
    }
  }

  function unlock() {
    if (!passphrase || busy) return
    wrongPw = false
    void inspect(passphrase)
  }

  function setAction(index: number, action: ImportAction) {
    rows = renameAdded(
      rows.map((r) => (r.index === index ? { ...r, action } : r)),
      existingNames,
    )
  }

  async function doImport() {
    if (busy || toImport === 0) return
    busy = true
    error = null
    try {
      const choices: ipc.ImportChoice[] = rows
        .filter((r) => r.action !== 'skip')
        .map((r) =>
          r.action === 'replace'
            ? { index: r.index, action: 'replace', target_id: r.match?.id ?? null, name: r.match?.name ?? null }
            : { index: r.index, action: 'add', name: r.name },
        )
      const saved = await ipc.importConnections(content, sealed ? passphrase : null, choices)
      connections.applyImported(saved)
      const imported = rows.filter((r) => r.action !== 'skip')
      result = {
        added: counts.add,
        replaced: counts.replace,
        skipped: counts.skip,
        withPassword: imported.filter((r) => r.item.has_password).length,
        withoutPassword: imported.filter((r) => !r.item.has_password && !embedded(r)).length,
      }
      step = 'done'
      toasts.success(`Imported ${saved.length} connection${saved.length === 1 ? '' : 's'}`)
      if (saved[0] && counts.add > 0) connections.selectedId = saved.find((s) => !rows.some((r) => r.match?.id === s.id))?.id ?? connections.selectedId
    } catch (e) {
      error = String(e)
    } finally {
      busy = false
    }
  }

  /** The file-password field appears inside an already-open dialog — autofocus does not fire there. */
  function focusOnMount(node: HTMLElement) {
    queueMicrotask(() => node.focus())
  }

  function embedded(r: ImportRow) {
    return r.item.profile.system === 'sqlite' || r.item.profile.system === 'duckdb'
  }
</script>

<!-- the browser path picks the file with a plain file input -->
<input bind:this={fileInput} type="file" accept="application/json,.json" onchange={onFilePicked} style="display:none" aria-label="Connections file" />

{#if dlgOpen}
  <!-- backdrop click does NOT close (rule for every form dialog); × / Cancel / Escape do -->
  <div onkeydown={(e) => e.key === 'Escape' && close()} role="presentation" class="um-backdrop">
    <div
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.key === 'Escape' && close()}
      role="dialog"
      aria-modal="true"
      aria-label="Import connections"
      tabindex="-1"
      class="um-dlg"
      style="width:var(--px-680);max-width:calc(100vw - var(--px-40))"
    >
      <div class="um-dlg-head">
        <span class="um-dlg-icon"><Icon name="download" size={18} /></span>
        <div class="um-dlg-title">
          <b>Import connections</b>
          <span>{fileName ? fileName : importSource === 'dbeaver' || step === 'dbeaver' ? 'From DBeaver' : 'From Database Studio or DBeaver'}</span>
        </div>
        <span class="um-dlg-x" onclick={close} onkeydown={(e) => e.key === 'Enter' && close()} role="button" tabindex="0" aria-label="Close" title="Close"><Icon name="close" size={16} /></span>
      </div>

      <div class="um-dlg-body">
        {#if step === 'source'}
          <p class="ic-lead">Where are the connections coming from?</p>
          <div class="ic-sources">
            <button class="ic-source" onclick={() => pickSource('ds')}>
              <SystemIcon system="postgres" size={22} />
              <div><b>Database Studio file</b><span>A .json made with Export connections… — carries passwords.</span></div>
            </button>
            <button class="ic-source" onclick={() => pickSource('dbeaver')} data-source="dbeaver">
              <Icon name="database" size={22} />
              <div><b>DBeaver</b><span>Its workspace or data-sources.json — host, port, database, SSH (no passwords).</span></div>
            </button>
          </div>
        {:else if step === 'file'}
          <div class="ic-drop">
            <Icon name="file" size={26} />
            <p>Choose the <b>.json</b> file made with <b>Export connections…</b> on the other computer.</p>
            <span class="cfm-btn primary" onclick={() => void chooseFile()} onkeydown={(e) => e.key === 'Enter' && void chooseFile()} role="button" tabindex="0" aria-disabled={busy}>{busy ? 'Reading…' : 'Choose file…'}</span>
          </div>
        {:else if step === 'dbeaver'}
          <div class="um-callout" style="margin:0 0 var(--px-12)">
            <Icon name="info" size={15} />
            <span>Database Studio reads DBeaver's <b>host, port, database, SSH and SSL</b>. DBeaver keeps the <b>username and password encrypted separately</b>, so you'll be asked for them on first connect.</span>
          </div>
          <div class="ic-drop">
            <Icon name="database" size={26} />
            <p>Auto-detect your DBeaver workspace, or choose its <b>data-sources.json</b> (inside <span class="mono">.dbeaver</span>).</p>
            <div class="ic-drop-btns">
              <span class="cfm-btn primary" onclick={() => void autoDetectDbeaver()} onkeydown={(e) => e.key === 'Enter' && void autoDetectDbeaver()} role="button" tabindex="0" aria-disabled={busy}>{busy ? 'Looking…' : 'Auto-detect'}</span>
              <span class="cfm-btn" onclick={() => void chooseFile()} onkeydown={(e) => e.key === 'Enter' && void chooseFile()} role="button" tabindex="0" aria-disabled={busy}>Choose file…</span>
            </div>
          </div>
        {:else if step === 'locked'}
          <div class="um-callout" style="margin:0 0 var(--px-12)">
            <Icon name="lock" size={15} />
            <span>This file carries passwords and is encrypted. Enter the <b>file password</b> chosen when it was exported.</span>
          </div>
          <label class="um-field">File password
            <div class="um-pw">
              <input
                type={showPw ? 'text' : 'password'}
                bind:value={passphrase}
                use:focusOnMount
                class="um-input"
                class:invalid={wrongPw}
                autocomplete="off"
                aria-label="File password"
                onkeydown={(e) => e.key === 'Enter' && unlock()}
              />
              <span class="eg-btn" onclick={() => (showPw = !showPw)} onkeydown={(e) => e.key === 'Enter' && (showPw = !showPw)} role="button" tabindex="0" title={showPw ? 'Hide password' : 'Show password'} aria-label={showPw ? 'Hide password' : 'Show password'}><Icon name={showPw ? 'eye-off' : 'eye'} size={13} /></span>
            </div>
          </label>
          {#if wrongPw}
            <div class="um-field-err" role="alert">Wrong password — or the file was changed after it was exported.</div>
          {/if}
        {:else if step === 'review'}
          <div class="ic-summary">
            {#if sealed}<span class="ic-lock"><Icon name="lock" size={12} />Unlocked</span>{/if}
            <span>{rows.length} connection{rows.length === 1 ? '' : 's'} in the file</span>
            <span class="ic-dot">·</span>
            <span><b>{counts.add}</b> to add</span>
            {#if counts.replace}<span class="ic-dot">·</span><span><b>{counts.replace}</b> to update</span>{/if}
            {#if counts.skip}<span class="ic-dot">·</span><span><b>{counts.skip}</b> skipped</span>{/if}
          </div>
          {#if skipped.length}
            <div class="ic-skipped" role="note"><Icon name="warning" size={12} /><span>{skipped.length} connection{skipped.length === 1 ? '' : 's'} in the file could not be imported: {skipped.map((s) => `${s.name} (${s.reason})`).join(', ')}</span></div>
          {/if}
          <div class="ic-list" role="list" aria-label="Connections in the file">
            {#each rows as r (r.index)}
              {@const p = r.item.profile}
              <div class="ic-row" class:skip={r.action === 'skip'} role="listitem" data-import-row={p.name}>
                <SystemIcon system={brandKey(p)} size={18} />
                <div class="ic-text">
                  <div class="ic-name">
                    <span>{r.action === 'add' ? r.name : p.name}</span>
                    {#if r.action === 'add' && r.name !== p.name}<span class="ic-renamed">renamed from “{p.name}”</span>{/if}
                  </div>
                  <div class="ic-sub mono" title={targetLabel(p)}>{targetLabel(p)}</div>
                  <div class="ic-facts">
                    {#if embedded(r)}
                      <span class="ic-fact">No password needed</span>
                    {:else if r.item.has_password}
                      <span class="ic-fact ok" data-pw="included"><Icon name="key" size={11} />Password included</span>
                    {:else}
                      <span class="ic-fact" data-pw="missing">No password — asked when you connect</span>
                    {/if}
                    {#if r.item.has_ssh_password}<span class="ic-fact ok"><Icon name="key" size={11} />SSH password included</span>{/if}
                    {#if r.match}<span class="ic-fact info">Already here as “{r.match.name}”</span>{/if}
                  </div>
                  {#each r.item.missing_files as f (f)}
                    <div class="ic-missing" title={f}><Icon name="warning" size={11} />Not on this computer: <span class="mono">{f}</span></div>
                  {/each}
                </div>
                <div class="um-seg ic-seg" role="group" aria-label={`What to do with ${p.name}`}>
                  {#if r.match}
                    <span role="button" tabindex="0" aria-pressed={r.action === 'skip'} onclick={() => setAction(r.index, 'skip')} onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setAction(r.index, 'skip'))} title="Keep the connection you already have">Keep mine</span>
                    <span role="button" tabindex="0" aria-pressed={r.action === 'replace'} onclick={() => setAction(r.index, 'replace')} onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setAction(r.index, 'replace'))} title={`Overwrite “${r.match.name}” with the one in the file`}>Update</span>
                    <span role="button" tabindex="0" aria-pressed={r.action === 'add'} onclick={() => setAction(r.index, 'add')} onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setAction(r.index, 'add'))} title="Add it as another connection">Add copy</span>
                  {:else}
                    <span role="button" tabindex="0" aria-pressed={r.action === 'add'} onclick={() => setAction(r.index, 'add')} onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setAction(r.index, 'add'))}>Add</span>
                    <span role="button" tabindex="0" aria-pressed={r.action === 'skip'} onclick={() => setAction(r.index, 'skip')} onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setAction(r.index, 'skip'))}>Skip</span>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        {:else if step === 'done' && result}
          <div class="ic-done" role="status">
            <span class="ic-done-icon"><Icon name="check" size={22} /></span>
            <div>
              <b>{result.added + result.replaced} connection{result.added + result.replaced === 1 ? '' : 's'} imported</b>
              <p>
                {result.added} added{result.replaced ? `, ${result.replaced} updated` : ''}{result.skipped ? `, ${result.skipped} skipped` : ''}.
                {#if result.withPassword}{result.withPassword} came with {result.withPassword === 1 ? 'its password' : 'their passwords'} — saved on this computer, encrypted.{/if}
              </p>
              {#if result.withoutPassword}
                <p>{result.withoutPassword} {result.withoutPassword === 1 ? 'has' : 'have'} no password yet — open {result.withoutPassword === 1 ? 'it' : 'each'} with <b>Edit connection</b> and type it.</p>
              {/if}
            </div>
          </div>
        {/if}

        {#if error}
          <div class="um-err" role="alert" style="margin-top:var(--px-10)"><Icon name="warning" size={14} /><span>{error}</span></div>
        {/if}
      </div>

      <div class="um-dlg-foot">
        {#if step === 'file' || step === 'dbeaver'}
          <span class="eg-btn" onclick={() => (step = 'source')} onkeydown={(e) => e.key === 'Enter' && (step = 'source')} role="button" tabindex="0">Back</span>
        {:else if step === 'review' || step === 'locked'}
          <span class="eg-btn" onclick={() => !busy && void chooseFile()} onkeydown={(e) => e.key === 'Enter' && !busy && void chooseFile()} role="button" tabindex="0">Other file…</span>
        {/if}
        <span class="um-spacer"></span>
        {#if step === 'done'}
          <span class="cfm-btn primary" onclick={close} onkeydown={(e) => e.key === 'Enter' && close()} role="button" tabindex="0">Done</span>
        {:else}
          <span class="cfm-btn" onclick={close} onkeydown={(e) => e.key === 'Enter' && close()} role="button" tabindex="0">Cancel</span>
          {#if step === 'locked'}
            <span class="cfm-btn primary" onclick={unlock} onkeydown={(e) => e.key === 'Enter' && unlock()} role="button" tabindex="0" aria-disabled={!passphrase || busy}>{busy ? 'Unlocking…' : 'Unlock'}</span>
          {:else if step === 'review'}
            <span class="cfm-btn primary" onclick={() => void doImport()} onkeydown={(e) => e.key === 'Enter' && void doImport()} role="button" tabindex="0" aria-disabled={busy || toImport === 0}>{busy ? 'Importing…' : `Import ${toImport} connection${toImport === 1 ? '' : 's'}`}</span>
          {/if}
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .ic-lead {
    margin: 0 0 var(--px-10);
    color: var(--text2);
    font-size: var(--px-13);
  }
  .ic-sources {
    display: flex;
    flex-direction: column;
    gap: var(--px-10);
  }
  .ic-source {
    display: flex;
    align-items: flex-start;
    gap: var(--px-12);
    padding: var(--px-12) var(--px-14);
    border: var(--px-1) solid var(--border2);
    border-radius: var(--px-10);
    background: var(--surface);
    cursor: pointer;
    text-align: left;
    color: var(--text);
  }
  .ic-source:hover {
    border-color: var(--primary);
    background: color-mix(in srgb, var(--primary) 8%, var(--surface));
  }
  .ic-source div {
    display: flex;
    flex-direction: column;
    gap: var(--px-2);
  }
  .ic-source b {
    font-size: var(--px-13);
  }
  .ic-source span {
    font-size: var(--px-12);
    color: var(--muted);
  }
  .ic-drop-btns {
    display: flex;
    gap: var(--px-8);
  }
  .ic-skipped {
    display: flex;
    align-items: flex-start;
    gap: var(--px-6);
    margin-bottom: var(--px-10);
    font-size: var(--px-12);
    color: var(--sacc-amber);
  }
  .ic-drop {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--px-10);
    padding: var(--px-24) var(--px-16);
    border: var(--px-1) dashed var(--border2);
    border-radius: var(--px-10);
    color: var(--muted);
    text-align: center;
  }
  .ic-drop p {
    margin: 0;
    color: var(--text2);
  }
  .ic-summary {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--px-6);
    margin-bottom: var(--px-8);
    color: var(--text2);
  }
  .ic-dot {
    color: var(--muted);
  }
  .ic-lock {
    display: inline-flex;
    align-items: center;
    gap: var(--px-4);
    padding: var(--px-1) var(--px-7);
    border-radius: var(--px-10);
    background: color-mix(in srgb, var(--success) 14%, transparent);
    color: var(--success);
    font-weight: 600;
  }
  .ic-list {
    max-height: var(--px-420);
    overflow: auto;
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-8);
    background: var(--surface);
  }
  .ic-row {
    display: flex;
    align-items: flex-start;
    gap: var(--px-10);
    padding: var(--px-9) var(--px-10);
    border-bottom: var(--px-1) solid var(--border);
  }
  .ic-row:last-child {
    border-bottom: 0;
  }
  .ic-row.skip .ic-text {
    opacity: 0.55;
  }
  .ic-text {
    flex: 1;
    min-width: 0;
  }
  .ic-name {
    display: flex;
    align-items: baseline;
    gap: var(--px-6);
    font-weight: 500;
    color: var(--text);
  }
  .ic-renamed {
    font-size: var(--px-11);
    font-weight: 400;
    color: var(--muted);
  }
  .ic-sub {
    font-size: var(--px-11);
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ic-facts {
    display: flex;
    flex-wrap: wrap;
    gap: var(--px-6);
    margin-top: var(--px-4);
  }
  .ic-fact {
    display: inline-flex;
    align-items: center;
    gap: var(--px-4);
    font-size: var(--px-11);
    color: var(--muted);
  }
  .ic-fact.ok {
    color: var(--success);
  }
  .ic-fact.info {
    color: var(--text2);
  }
  .ic-missing {
    display: flex;
    align-items: center;
    gap: var(--px-4);
    margin-top: var(--px-3);
    font-size: var(--px-11);
    color: var(--warn);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .ic-seg {
    flex: none;
  }
  /* the chosen action must read at a glance in both themes */
  .ic-seg > [aria-pressed='true'] {
    color: var(--primary);
    background: color-mix(in srgb, var(--primary) 12%, var(--surface));
    box-shadow: inset 0 0 0 var(--px-1) color-mix(in srgb, var(--primary) 45%, transparent);
  }
  .ic-done {
    display: flex;
    gap: var(--px-14);
    align-items: flex-start;
  }
  .ic-done p {
    margin: var(--px-6) 0 0;
    color: var(--text2);
    line-height: 1.5;
  }
  .ic-done-icon {
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
