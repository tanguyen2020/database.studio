<script lang="ts">
  // What a streaming / cache workspace tab shows while its connection is not open:
  // connecting (with how long it has been trying), why it failed (in words, with
  // what to check and the server's own message), or simply "not connected".
  // Redis · Kafka · NATS · RabbitMQ have no object tree, so this tab is the only
  // place the state of their connection can be seen.
  import { onDestroy } from 'svelte'
  import type { ProfilePublic } from '$lib/types'
  import { connections } from '$lib/stores/connections.svelte'
  import { ui } from '$lib/stores/ui.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { brandKey, brandLabel } from '$lib/brand'
  import { explainConnectError } from '$lib/connection/connect-error'
  import SystemIcon from '$lib/components/SystemIcon.svelte'
  import Icon from '$lib/components/Icon.svelte'

  let { profile }: { profile: ProfilePublic } = $props()

  const connecting = $derived(connections.connecting.has(profile.id))
  const error = $derived(connections.connectErrors[profile.id] ?? null)
  const phase = $derived<'connecting' | 'failed' | 'idle'>(connecting ? 'connecting' : error ? 'failed' : 'idle')
  const address = $derived(profile.host ? (profile.port ? `${profile.host}:${profile.port}` : profile.host) : '')
  const viaSsh = $derived(!!profile.ssh?.enabled)
  const failure = $derived(
    error
      ? explainConnectError({ system: profile.system, host: profile.host, port: profile.port, ssh: profile.ssh }, error)
      : null,
  )

  // how long the current attempt has been running
  let startedAt = $state(0)
  let now = $state(Date.now())
  let timer: ReturnType<typeof setInterval> | null = null
  $effect(() => {
    if (connecting) {
      startedAt = Date.now()
      now = startedAt
      timer = setInterval(() => (now = Date.now()), 500)
      return () => {
        if (timer) clearInterval(timer)
        timer = null
      }
    }
  })
  onDestroy(() => timer && clearInterval(timer))
  const elapsed = $derived(Math.max(0, Math.floor((now - startedAt) / 1000)))

  let showDetails = $state(false)

  function connect() {
    // a previous failure (or a lost connection) may have left derived connections
    // behind: reconnect drops them; a first open only needs connect
    if (error) void connections.reconnect(profile.id)
    else void connections.connect(profile.id)
  }
  function edit() {
    ui.formProfile = { ...profile }
  }
  async function copyError() {
    try {
      await navigator.clipboard.writeText(failure?.message ?? '')
      toasts.success('Error copied')
    } catch {
      toasts.error('Could not copy')
    }
  }
</script>

<div class="scs" data-conn-state={phase} aria-live="polite">
  <div class="scs-card" role="status" aria-busy={phase === 'connecting'}>
    <div class="scs-head">
      <span class="scs-logo" aria-hidden="true">
        <SystemIcon system={brandKey(profile)} size={30} />
      </span>
      <div class="scs-id">
        <div class="scs-name">{profile.name}</div>
        <div class="scs-sub">
          {brandLabel(profile)}{#if address}<span class="scs-dot">·</span><bdi class="mono">{address}</bdi>{/if}
          {#if viaSsh}<span class="scs-dot">·</span>via SSH{#if profile.ssh?.host}&nbsp;<bdi class="mono">{profile.ssh.host}</bdi>{/if}{/if}
        </div>
      </div>
    </div>

    {#if phase === 'connecting'}
      <div class="scs-title"><span class="scs-spin" aria-hidden="true"></span>Connecting…</div>
      <p class="scs-text">
        {viaSsh ? 'Opening the SSH tunnel and contacting the server.' : 'Contacting the server.'}
        {#if elapsed >= 1}<span class="scs-elapsed">{elapsed}s</span>{/if}
      </p>
      <div class="scs-bar" aria-hidden="true"><span></span></div>
      {#if elapsed >= 10}
        <p class="scs-note" data-testid="conn-slow">
          Still trying — the server is slow to answer, or a firewall is dropping the connection.
        </p>
      {/if}
    {:else if phase === 'failed' && failure}
      <div class="scs-title bad"><Icon name="warning" size={16} />{failure.title}</div>
      <p class="scs-text">{failure.detail}</p>
      {#if failure.tips.length}
        <div class="scs-tips">
          <div class="scs-tips-h">What to check</div>
          <ul>
            {#each failure.tips as t (t)}<li>{t}</li>{/each}
          </ul>
        </div>
      {/if}
      <button type="button" class="scs-link" aria-expanded={showDetails} onclick={() => (showDetails = !showDetails)}>
        {showDetails ? 'Hide details' : 'Show details'}
      </button>
      {#if showDetails}
        <div class="scs-raw">
          <pre class="mono selectable">{failure.message}</pre>
          <button type="button" class="eg-btn" onclick={copyError}><Icon name="copy" size={12} />Copy error</button>
        </div>
      {/if}
    {:else}
      <div class="scs-title">Not connected</div>
      <p class="scs-text">Open the connection to see its {brandLabel(profile)} workspace.</p>
    {/if}

    {#if phase !== 'connecting'}
      <div class="scs-actions">
        <button type="button" class="cfm-btn primary" onclick={connect}>
          <Icon name="refresh" size={12} />{phase === 'failed' ? 'Retry' : 'Connect'}
        </button>
        <button type="button" class="cfm-btn" onclick={edit}><Icon name="edit" size={12} />Edit connection</button>
      </div>
    {/if}
  </div>
</div>

<style>
  .scs {
    height: 100%;
    overflow: auto;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: var(--px-60) var(--px-16) var(--px-24);
    background: var(--bg);
  }
  .scs-card {
    width: 100%;
    max-width: var(--px-520);
    background: var(--surface);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-12);
    box-shadow: var(--shadow-sm);
    padding: var(--px-24);
    display: flex;
    flex-direction: column;
    gap: var(--px-10);
  }
  .scs-head {
    display: flex;
    align-items: center;
    gap: var(--px-14);
    margin-bottom: var(--px-6);
  }
  .scs-logo {
    position: relative;
    flex: none;
    width: var(--px-48);
    height: var(--px-48);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--px-12);
    background: var(--panel);
    border: var(--px-1) solid var(--border);
  }
  .scs-spin {
    width: var(--px-14);
    height: var(--px-14);
    flex: none;
    box-sizing: border-box;
    border-radius: 50%;
    border: var(--px-2) solid color-mix(in srgb, var(--primary) 25%, transparent);
    border-top-color: var(--primary);
    animation: scs-spin 0.8s linear infinite;
  }
  @keyframes scs-spin {
    to {
      transform: rotate(360deg);
    }
  }
  .scs-id {
    min-width: 0;
  }
  .scs-name {
    font-size: var(--px-16);
    font-weight: 600;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .scs-sub {
    font-size: var(--px-12);
    color: var(--muted);
    margin-top: var(--px-2);
    overflow-wrap: anywhere;
  }
  .scs-dot {
    margin: 0 var(--px-6);
  }
  .scs-title {
    display: flex;
    align-items: center;
    gap: var(--px-8);
    font-size: var(--px-15);
    font-weight: 600;
    color: var(--text);
  }
  .scs-title.bad {
    color: var(--error);
  }
  .scs-text {
    margin: 0;
    font-size: var(--px-13);
    line-height: 1.55;
    color: var(--text2);
  }
  .scs-elapsed {
    margin-left: var(--px-6);
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .scs-bar {
    position: relative;
    height: var(--px-4);
    border-radius: var(--px-4);
    background: var(--panel);
    overflow: hidden;
  }
  .scs-bar span {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 35%;
    border-radius: var(--px-4);
    background: var(--primary);
    animation: scs-slide 1.3s ease-in-out infinite;
  }
  @keyframes scs-slide {
    from {
      left: -35%;
    }
    to {
      left: 100%;
    }
  }
  .scs-note {
    margin: 0;
    font-size: var(--px-12);
    color: var(--muted);
  }
  .scs-tips {
    background: var(--panel);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-8);
    padding: var(--px-10) var(--px-14);
  }
  .scs-tips li::marker {
    color: var(--muted);
  }
  .scs-tips-h {
    font-size: var(--px-12);
    font-weight: 600;
    color: var(--text);
    margin-bottom: var(--px-4);
  }
  .scs-tips ul {
    margin: 0;
    padding-left: var(--px-18);
    list-style: disc;
    font-size: var(--px-12_5);
    line-height: 1.6;
    color: var(--text2);
  }
  .scs-link {
    align-self: flex-start;
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    font-size: var(--px-12);
    color: var(--primary);
    cursor: pointer;
  }
  .scs-link:hover {
    text-decoration: underline;
  }
  .scs-raw {
    display: flex;
    flex-direction: column;
    gap: var(--px-8);
    align-items: flex-start;
  }
  .scs-raw pre {
    margin: 0;
    width: 100%;
    box-sizing: border-box;
    padding: var(--px-10) var(--px-12);
    border-radius: var(--px-8);
    background: var(--panel);
    border: var(--px-1) solid var(--border);
    font-size: var(--px-12);
    color: var(--text2);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: var(--px-200);
    overflow: auto;
  }
  .scs-actions {
    display: flex;
    gap: var(--px-8);
    margin-top: var(--px-6);
  }
  .scs-actions :global(button) {
    display: inline-flex;
    align-items: center;
    gap: var(--px-6);
  }
  @media (prefers-reduced-motion: reduce) {
    .scs-spin,
    .scs-bar span {
      animation-duration: 3s;
    }
  }
</style>
