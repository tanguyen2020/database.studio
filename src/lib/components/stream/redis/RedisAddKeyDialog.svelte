<script lang="ts">
  // stream-workspace:redis — "+ Add key" of the Browser (SPEC-REDIS-BROWSER.md §1):
  // pick the data type in words, a name, the value and an optional expiry. A form
  // dialog: the backdrop does not close it; Escape / Cancel do. Existing keys are
  // never overwritten — the name is checked first.
  import * as ipc from '$lib/ipc'
  import Icon from '$lib/components/Icon.svelte'
  import { autofocus } from '$lib/actions/autofocus'
  import { connections } from '$lib/stores/connections.svelte'
  import { brandLabel } from '$lib/brand'
  import { typeHelp, typeLabel, expirySentence } from '$lib/stream/redis-keys'
  import '$lib/components/workspace/users/um.css'

  interface Props {
    connId: string
    db: number
    onClose: () => void
    onCreated: (key: string) => void
  }
  let { connId, db, onClose, onCreated }: Props = $props()
  // Redis or Valkey (SPEC-VALKEY.md) — the name every sentence uses
  const product = $derived(brandLabel(connections.byId(connId) ?? { system: 'redis' }))

  type Kind = 'string' | 'hash' | 'list' | 'set' | 'zset' | 'stream'
  const KINDS: Kind[] = ['string', 'hash', 'list', 'set', 'zset', 'stream']
  let kind = $state<Kind>('string')
  let name = $state('')
  let data = $state('')
  let ttl = $state('')
  let busy = $state(false)
  let error = $state<string | null>(null)

  const HINT: Record<Kind, string> = {
    string: 'The value, e.g. text or JSON.',
    hash: 'One field per line as field=value.',
    list: 'One item per line, in order.',
    set: 'One member per line; duplicates are ignored.',
    zset: 'One member per line as member=score (a number).',
    stream: 'The first entry: one field per line as field=value.',
  }
  const PLACEHOLDER: Record<Kind, string> = {
    string: '{"hello":"world"}',
    hash: 'name=Ada\nrole=admin',
    list: 'first\nsecond',
    set: 'red\ngreen',
    zset: 'alice=10\nbob=7',
    stream: 'event=signup\nuser=42',
  }
  const PRESETS: [string, string][] = [
    ['Never', ''],
    ['1 hour', '3600'],
    ['1 day', '86400'],
    ['1 week', '604800'],
  ]

  function pairs(text: string): [string, string][] {
    return text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const i = l.indexOf('=')
        return i >= 0 ? [l.slice(0, i).trim(), l.slice(i + 1).trim()] : [l, '']
      })
  }

  async function create() {
    const key = name.trim()
    error = null
    if (!key) {
      error = 'Give the key a name.'
      return
    }
    const lines = data.split('\n').filter((l) => l.trim().length)
    if (kind !== 'string' && lines.length === 0) {
      error = `A ${typeLabel(kind).toLowerCase()} needs at least one ${kind === 'hash' || kind === 'stream' ? 'field' : 'item'} — ${product} does not keep empty collections.`
      return
    }
    if (kind === 'zset' && pairs(data).some(([, s]) => s === '' || !Number.isFinite(Number(s)))) {
      error = 'Every sorted-set member needs a numeric score, e.g. alice=10.'
      return
    }
    const secs = ttl.trim() ? Number(ttl) : 0
    if (ttl.trim() && (!Number.isInteger(secs) || secs <= 0)) {
      error = 'Expiry must be a whole number of seconds, or empty for never.'
      return
    }
    busy = true
    try {
      const exists = await ipc.redisCommand(connId, ['EXISTS', key])
      if (/\(integer\) [1-9]/.test(exists)) {
        error = `A key named “${key}” already exists in Database ${db}. Pick another name, or open that key to edit it.`
        return
      }
      if (kind === 'string') await ipc.redisEdit(connId, key, { op: 'setString', value: data })
      else if (kind === 'hash') for (const [field, value] of pairs(data)) await ipc.redisEdit(connId, key, { op: 'hSet', field, value })
      else if (kind === 'list') for (const value of lines) await ipc.redisEdit(connId, key, { op: 'rPush', value })
      else if (kind === 'set') for (const member of lines.map((l) => l.trim())) await ipc.redisEdit(connId, key, { op: 'sAdd', member })
      else if (kind === 'zset') for (const [member, score] of pairs(data)) await ipc.redisEdit(connId, key, { op: 'zAdd', member, score: Number(score) })
      else await ipc.redisEdit(connId, key, { op: 'xAdd', fields: pairs(data) })
      if (secs > 0) await ipc.redisSetTtl(connId, key, secs)
      onCreated(key)
    } catch (e) {
      error = String(e)
    } finally {
      busy = false
    }
  }
</script>

<div class="um-backdrop" role="presentation">
  <div class="um-dlg" role="dialog" aria-modal="true" aria-label="Add key" tabindex="-1" onkeydown={(e) => e.key === 'Escape' && !busy && onClose()}>
    <div class="um-dlg-head">
      <span class="um-dlg-icon"><Icon name="plus" size={18} /></span>
      <div class="um-dlg-title"><b>Add key</b><span>to Database {db}</span></div>
    </div>
    <div class="um-dlg-body">
      <div class="um-field">
        Data type
        <div class="ak-types" role="radiogroup" aria-label="Data type">
          {#each KINDS as k (k)}
            <button type="button" role="radio" aria-checked={kind === k} class="ak-type" class:on={kind === k} title={typeHelp(k)} onclick={() => (kind = k)}>{typeLabel(k)}</button>
          {/each}
        </div>
        <span class="um-field-hint">{typeHelp(kind)}</span>
      </div>
      <label class="um-field">
        Key name
        <input class="um-input mono" use:autofocus bind:value={name} placeholder="e.g. user:42" spellcheck="false" aria-label="Key name" />
        <span class="um-field-hint">Use “:” to group keys, e.g. <span class="mono">user:42</span> shows under <span class="mono">user</span> in the tree.</span>
      </label>
      <label class="um-field">
        {kind === 'string' ? 'Value' : kind === 'stream' ? 'First entry' : 'Content'}
        <textarea class="um-input mono ak-data" bind:value={data} placeholder={PLACEHOLDER[kind]} spellcheck="false" aria-label="Key value"></textarea>
        <span class="um-field-hint">{HINT[kind]}</span>
      </label>
      <div class="um-field">
        Expires
        <div class="ak-ttl">
          {#each PRESETS as [label, v] (label)}
            <button type="button" class="ak-type" class:on={ttl === v} aria-pressed={ttl === v} onclick={() => (ttl = v)}>{label}</button>
          {/each}
          <input class="um-input mono ak-secs" bind:value={ttl} inputmode="numeric" placeholder="seconds" aria-label="Expiry in seconds" />
        </div>
        <span class="um-field-hint">{ttl.trim() && Number(ttl) > 0 ? `Redis deletes the key automatically — ${expirySentence(Number(ttl)).toLowerCase()}.` : 'The key stays until someone deletes it.'}</span>
      </div>
      {#if error}<div class="ak-err" role="alert">{error}</div>{/if}
    </div>
    <div class="um-dlg-foot">
      <span class="ak-grow"></span>
      <button type="button" class="cfm-btn" onclick={onClose} disabled={busy}>Cancel</button>
      <button type="button" class="cfm-btn primary" onclick={create} disabled={busy}>{busy ? 'Creating…' : 'Create key'}</button>
    </div>
  </div>
</div>

<style>
  .ak-types,
  .ak-ttl {
    display: flex;
    flex-wrap: wrap;
    gap: var(--px-6);
    align-items: center;
  }
  .ak-type {
    border: var(--px-1) solid var(--border2);
    background: var(--raised);
    color: var(--text2);
    border-radius: var(--px-14);
    padding: var(--px-4) var(--px-12);
    font-family: var(--font-main);
    font-size: var(--px-12_5);
    cursor: pointer;
  }
  .ak-type:hover {
    border-color: color-mix(in srgb, var(--primary) 45%, var(--border2));
    color: var(--text);
  }
  .ak-type.on {
    border-color: var(--primary);
    color: var(--text);
    font-weight: 600;
    background: color-mix(in srgb, var(--primary) 12%, var(--raised));
  }
  .ak-data {
    min-height: var(--px-110);
    resize: vertical;
    line-height: 1.5;
  }
  .ak-secs {
    width: var(--px-110);
  }
  .ak-err {
    padding: var(--px-10) var(--px-12);
    border-radius: var(--px-8);
    background: var(--danger-soft);
    color: var(--danger-text);
    font-size: var(--px-12_5);
  }
  .ak-grow {
    flex: 1;
  }
</style>
