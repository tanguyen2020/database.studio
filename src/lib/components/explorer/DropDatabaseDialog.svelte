<script lang="ts">
  import Icon from '$lib/components/Icon.svelte'
  // Drop Database — confirm, run, and when the server refuses because OTHER
  // sessions hold the database, list those sessions right here so they can be
  // killed (one by one, or all at once followed by the drop) instead of leaving
  // the user with "database is being accessed by other users" and no way out.
  // Backdrop click does NOT close (rule chung for form/confirm popups).
  import * as ipc from '$lib/ipc'
  import { canKillDatabaseSessions, inUseExplanation, toDbSessions, type DbSession } from '$lib/sql/db-sessions'

  interface Props {
    connId: string
    system: string
    db: string
    sql: string
    /** Closes the sessions THIS app holds on the database before each attempt. */
    beforeDrop: () => Promise<void>
    onDropped: () => void | Promise<void>
    onClose: () => void
  }
  let { connId, system, db, sql, beforeDrop, onDropped, onClose }: Props = $props()

  type Phase = 'confirm' | 'dropping' | 'in-use' | 'killing'
  let phase = $state<Phase>('confirm')
  let error = $state<string | null>(null)
  let sessions = $state<DbSession[]>([])
  let sessionsError = $state<string | null>(null)
  let killingPid = $state<number | null>(null)
  /** Drops attempted after a kill — >0 means sessions came back (a pool reconnecting). */
  let retries = $state(0)

  const busy = $derived(phase === 'dropping' || phase === 'killing' || killingPid !== null)
  const mysqlLike = $derived(system === 'mysql' || system === 'mariadb')
  const canKill = $derived(canKillDatabaseSessions(system))

  function autofocus(node: HTMLElement) {
    queueMicrotask(() => node.focus())
  }

  async function loadSessions() {
    sessionsError = null
    try {
      const r = await ipc.databaseSessions(connId, db)
      sessions = toDbSessions(r.rows)
    } catch (e) {
      sessions = []
      sessionsError = String(e)
    }
  }

  async function drop() {
    if (phase === 'dropping') return
    phase = 'dropping'
    error = null
    try {
      await beforeDrop()
      const r = await ipc.dropDatabase(connId, sql)
      if (r.dropped) {
        await onDropped()
        return
      }
      error = r.error?.message ?? 'The server refused to drop the database.'
      if (r.in_use && canKill) {
        await loadSessions()
        phase = 'in-use'
        return
      }
      phase = sessions.length ? 'in-use' : 'confirm'
    } catch (e) {
      error = String(e)
      phase = sessions.length ? 'in-use' : 'confirm'
    }
  }

  async function killOne(pid: number) {
    if (busy) return
    killingPid = pid
    error = null
    try {
      await ipc.killSession(connId, pid)
    } catch (e) {
      error = `Could not kill session ${pid}: ${String(e)}`
    }
    await loadSessions()
    killingPid = null
  }

  async function killAllAndDrop() {
    if (busy || !sessions.length) return
    phase = 'killing'
    error = null
    const failed: string[] = []
    for (const s of sessions) {
      try {
        await ipc.killSession(connId, s.pid)
      } catch (e) {
        failed.push(`${s.pid}: ${String(e)}`)
      }
    }
    retries += 1
    phase = 'in-use'
    await drop()
    if (failed.length) {
      error = `Could not kill ${failed.length} session(s) — ${failed.join('; ')}${error ? `\n${error}` : ''}`
    }
  }

  function close() {
    if (!busy) onClose()
  }

  function since(s: DbSession): string {
    if (s.started) return s.started
    return s.seconds !== null ? `${s.seconds}s` : ''
  }
</script>

<div
  onkeydown={(e) => { if (e.key === 'Escape') close() }}
  role="presentation"
  class="dd-backdrop"
>
  <div role="dialog" aria-modal="true" aria-label="Drop database" tabindex="-1" class="dd-panel" class:wide={phase === 'in-use' || phase === 'killing'}>
    <div class="dd-title">{phase === 'in-use' || phase === 'killing' ? 'Database in use' : 'Drop database'}</div>

    {#if phase === 'in-use' || phase === 'killing'}
      <div class="dd-body">
        {#if sessions.length}
          {inUseExplanation(system, db, sessions.length)}
          Kill them to drop it — their connections are closed and any uncommitted work is rolled back.
        {:else}
          The server still reports <span class="mono dd-strong">{db}</span> as in use, but this login
          cannot see any other session on it.
          {#if sessionsError}
            Listing them failed.
          {:else}
            It may lack the right to view other sessions
            {#if system === 'postgres'}(pg_read_all_stats){:else if system === 'mssql'}(VIEW SERVER STATE){:else if system === 'oracle'}(SELECT on V$SESSION){:else}(PROCESS){/if},
            or the only session left is this connection itself.
          {/if}
        {/if}
        {#if retries > 0 && sessions.length}
          <div class="dd-note">Still in use after killing — clients (e.g. a connection pool) reconnected. Kill again, or stop those clients first.</div>
        {/if}
      </div>

      {#if sessions.length}
        <div class="dd-table-wrap">
          <table class="dd-table" aria-label="Sessions holding the database">
            <thead>
              <tr>
                <th>PID</th>
                <th>User</th>
                <th>Client</th>
                <th>Program</th>
                <th>State</th>
                <th>{mysqlLike ? 'Time' : 'Since'}</th>
                {#if mysqlLike}<th>Lock</th>{/if}
                <th></th>
              </tr>
            </thead>
            <tbody>
              {#each sessions as s (s.pid)}
                <tr title={s.query || undefined}>
                  <td class="mono">{s.pid}</td>
                  <td>{s.username}</td>
                  <td class="mono">{s.client}</td>
                  <td>{s.program}</td>
                  <td>{s.state}</td>
                  <td class="mono">{since(s)}</td>
                  {#if mysqlLike}
                    <td>{#if s.holdsLock}<span class="dd-lock">holds lock</span>{/if}</td>
                  {/if}
                  <td class="dd-act">
                    <button
                      type="button"
                      class="dd-btn small"
                      aria-label={`Kill session ${s.pid}`}
                      disabled={busy}
                      onclick={() => killOne(s.pid)}
                    >{killingPid === s.pid ? 'Killing…' : 'Kill'}</button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    {:else}
      <div class="dd-body">
        Drop database <span class="mono dd-strong">{db}</span>? Every schema, table and row it holds is deleted.
        This cannot be undone.
      </div>
    {/if}

    <div class="mono dd-sql">{sql}</div>

    {#if phase === 'dropping' && mysqlLike}
      <div class="dd-note">Waiting up to a few seconds for other sessions to release their locks…</div>
    {/if}
    {#if error}
      <div class="dd-error" role="alert">{error}</div>
    {/if}

    <div class="dd-actions">
      <button type="button" class="dd-btn" use:autofocus disabled={busy} onclick={close}>Cancel</button>
      {#if phase === 'in-use' || phase === 'killing'}
        <button type="button" class="dd-btn" disabled={busy} onclick={loadSessions}><Icon name="refresh" size={12} /> Refresh list</button>
        {#if sessions.length}
          <button type="button" class="dd-btn danger" disabled={busy} onclick={killAllAndDrop}>
            {phase === 'killing' ? 'Killing…' : `Kill ${sessions.length} session${sessions.length === 1 ? '' : 's'} & drop`}
          </button>
        {:else}
          <button type="button" class="dd-btn danger" disabled={busy} onclick={drop}>Try drop again</button>
        {/if}
      {:else}
        <button type="button" class="dd-btn danger" disabled={busy} onclick={drop}>
          {phase === 'dropping' ? 'Dropping…' : 'Drop'}
        </button>
      {/if}
    </div>
  </div>
</div>

<style>
  .dd-backdrop {
    position: fixed;
    inset: 0;
    background: var(--rgba-0-0-0-_5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 90;
  }
  .dd-panel {
    background: var(--surface);
    border: var(--px-1) solid var(--border2);
    border-radius: var(--px-14);
    padding: var(--px-18);
    min-width: var(--px-340);
    max-width: var(--px-480);
    max-height: 90vh;
    overflow: auto;
    box-shadow: 0 var(--px-24) var(--px-60) var(--rgba-0-0-0-_55);
  }
  .dd-panel.wide {
    max-width: var(--px-740);
    width: calc(100vw - var(--px-40));
  }
  .dd-title {
    font-size: var(--px-14);
    font-weight: 600;
    color: var(--text);
    margin-bottom: var(--px-8);
  }
  .dd-body {
    font-size: var(--px-12_5);
    color: var(--text2);
    line-height: 1.45;
    margin-bottom: var(--px-12);
  }
  .dd-strong {
    color: var(--text);
  }
  .dd-note {
    font-size: var(--px-11_5);
    color: var(--sacc-amber);
    margin: var(--px-6) 0 var(--px-10);
  }
  .dd-sql {
    font-size: var(--px-11_5);
    color: var(--text);
    background: var(--panel);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-6);
    padding: var(--px-8);
    margin-bottom: var(--px-12);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .dd-error {
    font-size: var(--px-11_5);
    color: var(--error);
    margin-bottom: var(--px-12);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .dd-table-wrap {
    max-height: var(--px-240);
    overflow: auto;
    border: var(--px-1) solid var(--border2);
    border-radius: var(--px-6);
    margin-bottom: var(--px-12);
  }
  .dd-table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--px-12);
    color: var(--text);
  }
  .dd-table th {
    position: sticky;
    top: 0;
    background: var(--header);
    color: var(--text2);
    font-weight: 600;
    text-align: left;
    padding: var(--px-5) var(--px-8);
    border-bottom: var(--px-1) solid var(--border2);
    white-space: nowrap;
  }
  .dd-table td {
    padding: var(--px-4) var(--px-8);
    border-bottom: var(--px-1) solid var(--border);
    white-space: nowrap;
    max-width: var(--px-180);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .dd-table tbody tr:nth-child(odd) {
    background: var(--tbl-zebra);
  }
  .dd-table tbody tr:hover {
    background: var(--tbl-hover);
  }
  .dd-act {
    text-align: right;
  }
  .dd-lock {
    font-size: var(--px-10_5);
    font-weight: 600;
    color: var(--tbl-alert);
  }
  .dd-actions {
    display: flex;
    gap: var(--px-8);
    justify-content: flex-end;
  }
  .dd-btn {
    font-size: var(--px-12);
    color: var(--text);
    background: var(--raised);
    border: var(--px-1) solid var(--border2);
    border-radius: var(--px-6);
    padding: var(--px-5) var(--px-14);
    cursor: pointer;
  }
  .dd-btn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--primary) 12%, var(--raised));
  }
  .dd-btn:focus-visible {
    outline: var(--px-2) solid var(--primary);
    outline-offset: var(--px-1);
  }
  .dd-btn:disabled {
    opacity: 0.55;
    cursor: default;
  }
  .dd-btn.small {
    padding: var(--px-2) var(--px-10);
    font-size: var(--px-11_5);
    color: var(--error);
    border-color: color-mix(in srgb, var(--error) 45%, var(--border2));
  }
  .dd-btn.danger {
    color: var(--hex-fff);
    background: var(--danger-solid);
    border-color: var(--danger-solid);
    font-weight: 600;
  }
  .dd-btn.danger:hover:not(:disabled) {
    background: var(--danger-solid-hover);
    border-color: var(--danger-solid-hover);
    box-shadow: 0 0 0 var(--px-3) var(--danger-ring);
  }
  .dd-btn.danger:active:not(:disabled) {
    background: var(--danger-solid-active);
  }
</style>
