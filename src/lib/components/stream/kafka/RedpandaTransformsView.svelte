<script lang="ts">
  // Redpanda data transforms (SPEC-REDPANDA.md R11): WebAssembly functions running
  // inside the brokers, reading one topic and writing others. Listed with their state
  // per partition; removable here. They are switched off by default — the page says so
  // and can switch them on (the brokers then need a restart). Deploying a new transform
  // is done with `rpk transform deploy` (it builds a .wasm file), so it is out of scope.
  import { untrack } from 'svelte'
  import Icon from '$lib/components/Icon.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { autofocus } from '$lib/actions/autofocus'
  import { fullCount, plural } from '$lib/stream/humanize'
  import { parseTransforms, rp, rpErrorText, transformsDisabled, type RpTransform } from '$lib/redpanda/admin'
  import { rpCall, rpMessage, rpSend } from '$lib/redpanda/client'
  import '$lib/components/workspace/users/um.css'

  let { connId, onOpenTopic }: { connId: string; onOpenTopic: (topic: string) => void } = $props()

  let list = $state<RpTransform[]>([])
  let disabled = $state(false)
  let error = $state<string | null>(null)
  let loading = $state(false)

  async function load() {
    loading = true
    error = null
    try {
      const r = await rpSend(connId, rp.transforms())
      disabled = transformsDisabled(r)
      if (disabled) list = []
      else if (!r.ok) error = rpErrorText(r)
      else list = parseTransforms(r.json)
    } catch (e) {
      error = rpMessage(e)
    } finally {
      loading = false
    }
  }
  $effect(() => {
    void connId
    untrack(() => void load())
  })

  let enabling = $state(false)
  let enabled = $state(false)
  async function enable() {
    if (enabling) return
    enabling = true
    try {
      await rpCall(connId, rp.setConfig({ data_transforms_enabled: true }, []))
      enabled = true
      toasts.success('Data transforms switched on — restart the brokers to start them')
    } catch (e) {
      toasts.error(rpMessage(e))
    } finally {
      enabling = false
    }
  }

  let removeFor = $state<RpTransform | null>(null)
  let busy = $state(false)
  let removeError = $state<string | null>(null)
  async function remove() {
    if (!removeFor || busy) return
    busy = true
    removeError = null
    try {
      await rpCall(connId, rp.deleteTransform(removeFor.name))
      toasts.success(`Removed transform ${removeFor.name}`)
      removeFor = null
      await load()
    } catch (e) {
      removeError = rpMessage(e)
    } finally {
      busy = false
    }
  }
  const stateOf = (t: RpTransform) =>
    t.errored ? { label: `${t.errored} failing`, tone: 'bad' } : t.running ? { label: 'Running', tone: 'ok' } : { label: 'Not running', tone: 'muted' }
</script>

<div class="rt">
  <div class="rt-tools">
    <span class="rt-dim">Transforms are deployed with <span class="mono">rpk transform deploy</span>.</span>
    <span class="rt-grow"></span>
    <button type="button" class="eg-btn" onclick={load} disabled={loading}><Icon name="refresh" size={12} /> Refresh</button>
  </div>

  {#if error}
    <div class="um-callout danger" role="alert"><Icon name="warning" size={15} /><span><b>Could not read the transforms.</b> {error}</span></div>
  {:else if disabled}
    <div class="rt-off">
      <span class="rt-off-icon"><Icon name="zap" size={22} /></span>
      <b>Data transforms are switched off</b>
      <span>They run WebAssembly functions inside the brokers — for example to filter, mask or reshape messages from one topic into another.</span>
      {#if enabled}
        <span class="um-callout warn"><Icon name="warning" size={15} /><span>Switched on. <b>Restart the brokers</b>, then refresh this page.</span></span>
      {:else}
        <button type="button" class="cfm-btn primary" onclick={enable} disabled={enabling}>{enabling ? 'Switching on…' : 'Switch on data transforms'}</button>
        <span class="rt-dim">Sets <span class="mono">data_transforms_enabled</span>; takes effect after a restart.</span>
      {/if}
    </div>
  {:else if list.length === 0}
    <div class="ds-empty">{#if loading}Reading transforms…{:else}<b>No transforms deployed</b>Deploy one with <span class="mono">rpk transform deploy</span>; it appears here with its state.{/if}</div>
  {:else}
    <table class="ds-table" aria-label="Transforms">
      <thead><tr><th>Transform</th><th>Reads</th><th>Writes</th><th>State</th><th class="r">Behind</th><th class="r"></th></tr></thead>
      <tbody>
        {#each list as t (t.name)}
          {@const st = stateOf(t)}
          <tr>
            <td><span class="ds-name">{t.name}</span>{#if t.env.length}<span class="rt-dim rt-env" title={t.env.map((e) => `${e.key}=${e.value}`).join('\n')}>{plural(t.env.length, 'variable')}</span>{/if}</td>
            <td><button type="button" class="rt-topic" onclick={() => onOpenTopic(t.input)}>{t.input}</button></td>
            <td>{#each t.outputs as o, i (o)}{#if i}, {/if}<button type="button" class="rt-topic" onclick={() => onOpenTopic(o)}>{o}</button>{/each}</td>
            <td><span class="rt-state {st.tone}">{st.label}</span> <span class="rt-dim">on {plural(t.running + t.errored, 'partition')}</span></td>
            <td class="r ds-num" class:rt-warn={t.lag > 0}>{t.lag === 0 ? 'Up to date' : fullCount(t.lag)}</td>
            <td class="r"><button type="button" class="eg-btn um-ghost-danger" onclick={() => { removeError = null; removeFor = t }}>Remove…</button></td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

{#if removeFor}
  <div class="um-backdrop" role="presentation" onkeydown={(e) => e.key === 'Escape' && !busy && (removeFor = null)}>
    <div class="um-dlg sm" role="dialog" aria-modal="true" aria-label="Remove transform" tabindex="-1" use:autofocus>
      <div class="um-dlg-head">
        <span class="um-dlg-icon danger"><Icon name="trash" size={18} /></span>
        <div class="um-dlg-title"><b>Remove transform {removeFor.name}?</b><span>It stops reading {removeFor.input}. Messages already written stay.</span></div>
      </div>
      {#if removeError}<div class="um-dlg-body"><div class="um-callout danger" role="alert"><Icon name="warning" size={15} /><span>{removeError}</span></div></div>{/if}
      <div class="um-dlg-foot">
        <button type="button" class="cfm-btn" onclick={() => (removeFor = null)} disabled={busy}>Cancel</button>
        <button type="button" class="cfm-btn danger" onclick={remove} disabled={busy}>{busy ? 'Removing…' : 'Remove transform'}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .rt {
    display: flex;
    flex-direction: column;
    gap: var(--px-12);
    padding: var(--px-14) var(--px-16);
    overflow: auto;
    flex: 1;
    min-height: 0;
  }
  .rt-tools {
    display: flex;
    align-items: center;
    gap: var(--px-8);
  }
  .rt-grow {
    flex: 1;
  }
  .rt-dim {
    font-size: var(--px-12);
    color: var(--muted);
  }
  .rt-env {
    margin-left: var(--px-8);
  }
  .rt-off {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: var(--px-10);
    max-width: var(--px-520);
    margin: var(--px-30) auto;
    font-size: var(--px-13);
    color: var(--text2);
    line-height: 1.5;
  }
  .rt-off b {
    font-size: var(--px-15);
    color: var(--text);
  }
  .rt-off-icon {
    display: inline-flex;
    padding: var(--px-12);
    border-radius: var(--px-12);
    background: var(--panel);
    color: var(--muted);
  }
  .rt-topic {
    border: 0;
    background: transparent;
    padding: 0;
    font-family: var(--font-mono);
    font-size: var(--px-12_5);
    color: var(--text);
    cursor: pointer;
  }
  .rt-topic:hover {
    text-decoration: underline;
  }
  .rt-state {
    font-size: var(--px-11_5);
    font-weight: 600;
    padding: var(--px-1) var(--px-8);
    border-radius: var(--px-9);
    background: var(--panel);
    color: var(--text2);
  }
  .rt-state.ok {
    background: color-mix(in srgb, var(--success) 14%, transparent);
    color: var(--text);
  }
  .rt-state.bad {
    background: var(--danger-soft);
    color: var(--danger-text);
  }
  .rt-warn {
    color: var(--sacc-amber);
  }
</style>
