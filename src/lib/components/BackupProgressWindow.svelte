<script lang="ts">
  // The progress window of a backup / restore job. Opens when Back up / Restore
  // is pressed (the configuration dialog closes): percent, a determinate bar, the
  // step and the object being worked on, rate, elapsed and time left, Stop. It
  // stays open until the job ends (only Stop ends it early), then turns into its
  // result with what to do next. The backdrop never closes it (rule for dialogs);
  // Escape / × close it once the job has ended.
  import { onDestroy } from 'svelte'
  import * as ipc from '$lib/ipc'
  import { IS_TAURI } from '$lib/demo'
  import { backupJobs, type BackupJob } from '$lib/stores/backupJobs.svelte'
  import { backupWizard } from '$lib/stores/backup.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { progressView } from '$lib/backup/progress'
  import { fileName, formatDuration, sizeLabel } from '$lib/backup/plan'
  import { systemMeta } from '$lib/systems'
  import Icon from '$lib/components/Icon.svelte'
  import SystemIcon from '$lib/components/SystemIcon.svelte'
  import '$lib/components/workspace/users/um.css'

  const job = $derived(backupJobs.shown)
  const pv = $derived(progressView(job?.progress ?? null, job?.samples ?? []))

  // elapsed time ticks while the shown job runs
  let now = $state(Date.now())
  let tick: ReturnType<typeof setInterval> | null = null
  $effect(() => {
    const live = job?.status === 'running'
    if (live && !tick) tick = setInterval(() => (now = Date.now()), 500)
    else if (!live && tick) {
      clearInterval(tick)
      tick = null
    }
  })
  onDestroy(() => tick && clearInterval(tick))

  let showDetails = $state(false)
  $effect(() => {
    void job?.id
    showDetails = false
  })

  function title(j: BackupJob): string {
    const what = j.target || 'the database'
    if (j.status === 'running') {
      if (j.stopping) return 'Stopping…'
      return j.kind === 'backup' ? `Backing up ${what}` : `Restoring into ${what}`
    }
    const noun = j.kind === 'backup' ? 'Backup' : 'Restore'
    if (j.status === 'done') return `${noun} complete`
    if (j.status === 'stopped') return `${noun} stopped`
    return `${noun} failed`
  }

  /** × / Escape: closes the window once the job has ended. */
  function dismiss() {
    if (!job || job.status === 'running') return
    backupJobs.dismiss(job.id)
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation()
      dismiss()
    }
  }
  function act(e: KeyboardEvent, f: () => void) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      f()
    }
  }
  async function reveal(path: string) {
    if (!IS_TAURI) return
    await ipc.revealPath(path).catch((e) => toasts.error(String(e)))
  }
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      toasts.success('Copied')
    } catch {
      /* clipboard denied */
    }
  }
  function restoreFrom(j: BackupJob) {
    if (!j.restoreFrom) return
    const r = j.restoreFrom
    backupJobs.dismiss(j.id)
    backupWizard.show(j.connId, j.system, { tab: 'restore', src: r.path, database: r.database })
  }
  /** Put focus in the window when it opens, so Escape reaches it. */
  function focusOnMount(node: HTMLElement) {
    node.focus()
  }
</script>

{#if job}
  <div class="um-backdrop" role="presentation" onkeydown={onKey}>
    <div
      class="um-dlg bp-dlg"
      data-status={job.status}
      role="dialog"
      aria-modal="true"
      aria-label={`${job.kind === 'backup' ? 'Backup' : 'Restore'} of ${job.target || 'the database'}`}
      tabindex="-1"
      onkeydown={onKey}
      use:focusOnMount
    >
      <div class="um-dlg-head">
        <span class="bp-ico" class:live={job.status === 'running' && !job.stopping}>
          {#if job.status === 'running'}
            <Icon name={job.kind === 'backup' ? 'download' : 'upload'} size={18} />
          {:else if job.status === 'done'}
            <Icon name="check" size={18} />
          {:else}
            <Icon name="warning" size={18} />
          {/if}
        </span>
        <div class="um-dlg-title">
          <b>{title(job)}</b>
          <span class="bp-conn"><SystemIcon system={job.system} size={12} /> {job.connName || systemMeta(job.system).label}</span>
        </div>
        {#if job.status !== 'running'}
          <span class="um-dlg-x" role="button" tabindex="0" aria-label="Close dialog" title="Close" onclick={dismiss} onkeydown={(e) => act(e, dismiss)}><Icon name="close" size={16} /></span>
        {/if}
      </div>

      <div class="um-dlg-body bp-body">
        {#if job.status === 'running'}
          <div class="bp-pct-row">
            <span class="bp-pct mono">{pv.percent != null ? `${Math.floor(pv.percent)}%` : ''}</span>
            <span class="bp-stage">
              {job.stopping ? 'Ending the tool and removing the partial file' : pv.stage}{#if !job.stopping && pv.current}{' · '}<span class="mono" title={pv.current}>{pv.current}</span>{/if}
            </span>
          </div>
          <div
            class="bp-bar"
            class:det={pv.percent != null}
            role="progressbar"
            aria-label={job.kind === 'backup' ? 'Backup progress' : 'Restore progress'}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pv.percent != null ? Math.floor(pv.percent) : undefined}
            aria-valuetext={pv.amount || pv.stage}
          >
            <span style={pv.percent != null ? `width:${pv.percent}%` : ''}></span>
          </div>
          <div class="bp-facts" aria-live="polite">
            {#if pv.amount}<span><b>{pv.amount}</b></span>{/if}
            {#if pv.rate}<span>{pv.rate}</span>{/if}
            <span>{formatDuration(now - job.started)} elapsed</span>
            {#if pv.eta}<span>{pv.eta}</span>{/if}
          </div>
          <div class="bp-hint">
            {#if job.canStop}
              Stop ends the job and keeps nothing half-written.
            {:else}
              Cannot be stopped once SQL Server starts restoring — stopping half-way would leave the database unusable (RESTORING).
            {/if}
          </div>
        {:else if job.status === 'done' && job.outcome}
          {@const r = job.outcome}
          <div class="bp-msg">{r.message}</div>
          <div class="bp-kv">
            <span>File</span><span class="mono selectable" title={r.path}>{r.server_side ? r.path : fileName(r.path)}</span>
            {#if r.bytes != null}<span>Size</span><span>{sizeLabel(r.bytes)}</span>{/if}
            <span>Took</span><span>{formatDuration(r.duration_ms)}</span>
            {#if r.items != null}<span>{job.system === 'redis' ? 'Keys' : 'Items'}</span><span>{r.items.toLocaleString()}</span>{/if}
          </div>
          {#each r.notes as n (n)}<div class="bp-note"><Icon name="info" size={13} /> {n}</div>{/each}
          <div class="bp-links">
            {#if !r.server_side && IS_TAURI}<span class="bp-link" role="button" tabindex="0" onclick={() => reveal(r.path)} onkeydown={(e) => act(e, () => void reveal(r.path))}>Show in folder</span>{/if}
            <span class="bp-link" role="button" tabindex="0" onclick={() => copy(r.path)} onkeydown={(e) => act(e, () => void copy(r.path))}>Copy path</span>
            {#if r.log}<span class="bp-link" role="button" tabindex="0" onclick={() => (showDetails = !showDetails)} onkeydown={(e) => act(e, () => (showDetails = !showDetails))}>{showDetails ? 'Hide' : 'Show'} tool output</span>{/if}
          </div>
          {#if showDetails && r.log}<pre class="um-sql selectable bp-pre">{r.log}</pre>{/if}
        {:else if job.error}
          {@const head = job.error.split('\n')[0]}
          {@const body = job.error.split('\n').slice(1).join('\n').trim()}
          <div class="bp-msg">{head}</div>
          {#if job.status === 'stopped'}<div class="bp-note"><Icon name="info" size={13} /> Nothing half-written was kept.</div>{/if}
          {#if body}<pre class="um-sql selectable bp-pre">{body}</pre>{/if}
          <div class="bp-links">
            <span class="bp-link" role="button" tabindex="0" onclick={() => copy(job?.error ?? '')} onkeydown={(e) => act(e, () => void copy(job?.error ?? ''))}>Copy error</span>
          </div>
        {/if}
      </div>

      <div class="um-dlg-foot">
        {#if job.status === 'running'}
          <span class="um-spacer"></span>
          {#if job.canStop}
            <span class="cfm-btn danger" role="button" tabindex="0" aria-disabled={job.stopping} title="Stop the job — nothing half-written is kept" onclick={() => job && backupJobs.stop(job.id)} onkeydown={(e) => act(e, () => job && void backupJobs.stop(job.id))}>
              <Icon name="close" size={12} /> {job.stopping ? 'Stopping…' : 'Stop'}
            </span>
          {/if}
        {:else}
          <span class="um-spacer"></span>
          {#if job.status === 'done' && job.restoreFrom}
            <span class="cfm-btn" role="button" tabindex="0" onclick={() => job && restoreFrom(job)} onkeydown={(e) => act(e, () => job && restoreFrom(job))}>Restore from this file…</span>
          {/if}
          <span class="cfm-btn primary" role="button" tabindex="0" onclick={dismiss} onkeydown={(e) => act(e, dismiss)}>Close</span>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .bp-dlg {
    width: var(--px-520);
  }
  .bp-body {
    gap: var(--px-12);
  }
  .bp-ico {
    width: var(--px-34);
    height: var(--px-34);
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--px-9);
    color: var(--primary);
    background: color-mix(in srgb, var(--primary) 12%, var(--surface));
  }
  .bp-dlg[data-status='done'] .bp-ico {
    color: var(--success);
    background: color-mix(in srgb, var(--success) 12%, var(--surface));
  }
  .bp-dlg[data-status='failed'] .bp-ico {
    color: var(--error);
    background: color-mix(in srgb, var(--error) 12%, var(--surface));
  }
  .bp-dlg[data-status='stopped'] .bp-ico {
    color: var(--warn2);
    background: color-mix(in srgb, var(--warn2) 12%, var(--surface));
  }
  .bp-ico.live :global(svg) {
    animation: bp-pulse 1.4s ease-in-out infinite;
  }
  @keyframes bp-pulse {
    50% {
      transform: translateY(var(--px-2));
    }
  }
  .bp-conn {
    display: inline-flex;
    align-items: center;
    gap: var(--px-5);
  }
  .bp-pct-row {
    display: flex;
    align-items: baseline;
    gap: var(--px-12);
    min-width: 0;
  }
  .bp-pct {
    flex: none;
    font-size: var(--px-24);
    font-weight: 600;
    color: var(--primary);
    font-variant-numeric: tabular-nums;
    min-width: var(--px-60);
  }
  .bp-stage {
    flex: 1;
    min-width: 0;
    color: var(--text2);
    font-size: var(--px-12_5);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .bp-bar {
    height: var(--px-8);
    border-radius: var(--px-4);
    background: var(--panel);
    border: var(--px-1) solid var(--border);
    overflow: hidden;
    position: relative;
  }
  .bp-bar span {
    position: absolute;
    inset: 0 auto 0 0;
    width: 35%;
    border-radius: var(--px-4);
    background: var(--primary);
    animation: bp-indet 1.3s ease-in-out infinite;
  }
  .bp-bar.det span {
    animation: none;
    transition: width 0.2s ease;
  }
  @keyframes bp-indet {
    from {
      left: -35%;
    }
    to {
      left: 100%;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .bp-bar span,
    .bp-ico.live :global(svg) {
      animation: none;
    }
  }
  .bp-facts {
    display: flex;
    flex-wrap: wrap;
    gap: var(--px-4) var(--px-16);
    color: var(--muted);
    font-size: var(--px-12);
    font-variant-numeric: tabular-nums;
  }
  .bp-facts b {
    color: var(--text);
    font-weight: 600;
  }
  .bp-hint {
    color: var(--muted);
    font-size: var(--px-11_5);
    line-height: 1.45;
  }
  .bp-msg {
    color: var(--text);
    font-size: var(--px-13);
    overflow-wrap: anywhere;
  }
  .bp-kv {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: var(--px-4) var(--px-14);
    font-size: var(--px-12);
  }
  .bp-kv > :nth-child(odd) {
    color: var(--muted);
  }
  .bp-kv > :nth-child(even) {
    color: var(--text);
    overflow-wrap: anywhere;
  }
  .bp-note {
    display: flex;
    align-items: flex-start;
    gap: var(--px-6);
    color: var(--text2);
    font-size: var(--px-12);
  }
  .bp-links {
    display: flex;
    flex-wrap: wrap;
    gap: var(--px-4) var(--px-14);
  }
  .bp-link {
    color: var(--primary);
    cursor: pointer;
    font-weight: 500;
    font-size: var(--px-12);
  }
  .bp-link:hover {
    text-decoration: underline;
  }
  .bp-link:focus-visible {
    outline: var(--px-2) solid var(--primary);
    border-radius: var(--px-3);
  }
  .bp-pre {
    max-height: var(--px-220);
    overflow: auto;
  }
</style>
