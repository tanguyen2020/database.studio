<script lang="ts">
  // Grant access with Kafka ACLs (SPEC-REDPANDA.md R10) — works on Apache Kafka and
  // Redpanda alike. Pick who, then either a common task ("Consume from a topic") or
  // exact permissions; every binding that will be created is listed in words before
  // anything is sent.
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import Icon from '$lib/components/Icon.svelte'
  import { autofocus } from '$lib/actions/autofocus'
  import {
    ACL_PRESETS,
    ACL_RESOURCES,
    OPERATIONS_FOR,
    aclBindings,
    aclSentence,
    grantProblem,
    operationText,
    type AclResource,
  } from '$lib/redpanda/admin'
  import '$lib/components/workspace/users/um.css'

  let {
    connId,
    users = [],
    roles = [],
    topics = [],
    groups = [],
    rolesSupported = false,
    principal: initialPrincipal = '',
    onClose,
    onDone,
  }: {
    connId: string
    users?: string[]
    roles?: string[]
    topics?: string[]
    groups?: string[]
    /** Redpanda roles exist (`RedpandaRole:<name>` principals) */
    rolesSupported?: boolean
    /** "User:alice" / "RedpandaRole:readers" to start with */
    principal?: string
    onClose: () => void
    onDone: (created: number) => void
  } = $props()

  const start = untrack(() => (initialPrincipal.includes(':') ? initialPrincipal.split(':') : ['User', initialPrincipal]))
  let kind = $state<'User' | 'RedpandaRole'>(start[0] === 'RedpandaRole' ? 'RedpandaRole' : 'User')
  let who = $state(start.slice(1).join(':'))
  let everyone = $state(false)
  let permission = $state<'ALLOW' | 'DENY'>('ALLOW')
  let mode = $state<'preset' | 'custom'>('preset')
  let preset = $state(ACL_PRESETS[0].id)
  let resourceType = $state<AclResource>('TOPIC')
  let resourceName = $state('')
  let pattern = $state<'LITERAL' | 'PREFIXED'>('LITERAL')
  let group = $state('')
  let ops = $state<string[]>(['READ'])
  let host = $state('*')
  let busy = $state(false)
  let error = $state<string | null>(null)

  const principalName = $derived(everyone ? '*' : who.trim())
  const principal = $derived(`${everyone ? 'User' : kind}:${principalName}`)
  const nameChoices = $derived(kind === 'RedpandaRole' ? roles : users)
  const presetDef = $derived(ACL_PRESETS.find((p) => p.id === preset) ?? ACL_PRESETS[0])
  const allowedOps = $derived(OPERATIONS_FOR[resourceType])
  const resourceChoices = $derived(resourceType === 'TOPIC' ? topics : resourceType === 'GROUP' ? groups : [])

  // keep only the operations that make sense for the picked resource
  $effect(() => {
    const ok = OPERATIONS_FOR[resourceType]
    const kept = ops.filter((o) => ok.includes(o))
    // never tick something silently: what no longer applies is dropped, nothing added
    if (kept.length !== ops.length) ops = kept
  })

  const items = $derived(
    mode === 'preset'
      ? presetDef.build(resourceName.trim(), pattern, group.trim())
      : ops.map((operation) => ({ resource_type: resourceType, resource_name: resourceName.trim(), pattern_type: resourceType === 'CLUSTER' ? 'LITERAL' : pattern, operation })),
  )
  const bindings = $derived(aclBindings(principal, host.trim(), permission, items))
  const problem = $derived(grantProblem(principalName, resourceName, mode === 'preset' ? 'TOPIC' : resourceType, mode === 'preset' ? ['x'] : ops))

  function toggleOp(o: string) {
    ops = ops.includes(o) ? ops.filter((x) => x !== o) : [...ops, o]
  }

  async function create() {
    if (problem || busy) return
    busy = true
    error = null
    try {
      const n = await ipc.kafkaCreateAcls(connId, bindings)
      onDone(n)
    } catch (e) {
      error = String(e)
    } finally {
      busy = false
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && !busy) {
      e.stopPropagation()
      onClose()
    }
  }
</script>

<div class="um-backdrop" role="presentation" onkeydown={onKey}>
  <div class="um-dlg acl" role="dialog" aria-modal="true" aria-label="Grant access" tabindex="-1" use:autofocus onkeydown={onKey}>
    <div class="um-dlg-head">
      <span class="um-dlg-icon"><Icon name="shield" size={18} /></span>
      <div class="um-dlg-title">
        <b>Grant access</b>
        <span>Creates Kafka ACLs — what a user or role may do on topics, groups and the cluster</span>
      </div>
      <span class="um-dlg-x" onclick={() => !busy && onClose()} onkeydown={(e) => e.key === 'Enter' && !busy && onClose()} role="button" tabindex="0" aria-label="Close dialog" title="Close"><Icon name="close" size={16} /></span>
    </div>

    <div class="um-dlg-body">
      <div class="um-group">
        <div class="um-group-title">1 · Who</div>
        <div class="acl-who">
          {#if rolesSupported}
            <div class="um-seg" role="group" aria-label="Principal type">
              <span role="button" tabindex="0" aria-pressed={kind === 'User' && !everyone} onclick={() => { kind = 'User'; everyone = false }} onkeydown={(e) => e.key === 'Enter' && (kind = 'User')}><Icon name="user" size={13} /> User</span>
              <span role="button" tabindex="0" aria-pressed={kind === 'RedpandaRole' && !everyone} onclick={() => { kind = 'RedpandaRole'; everyone = false }} onkeydown={(e) => e.key === 'Enter' && (kind = 'RedpandaRole')}><Icon name="users" size={13} /> Role</span>
            </div>
          {/if}
          <input
            class="um-input mono acl-name"
            list="acl-names"
            bind:value={who}
            disabled={everyone}
            placeholder={kind === 'RedpandaRole' ? 'Role name' : 'User name'}
            aria-label={kind === 'RedpandaRole' ? 'Role name' : 'User name'}
            spellcheck="false"
          />
          <datalist id="acl-names">{#each nameChoices as n (n)}<option value={n}></option>{/each}</datalist>
          <label class="um-checkline"><input type="checkbox" bind:checked={everyone} /> Everyone</label>
        </div>
        <div class="um-seg" role="group" aria-label="Permission">
          <span role="button" tabindex="0" aria-pressed={permission === 'ALLOW'} onclick={() => (permission = 'ALLOW')} onkeydown={(e) => e.key === 'Enter' && (permission = 'ALLOW')}>Allow</span>
          <span role="button" tabindex="0" class="um-seg-danger" aria-pressed={permission === 'DENY'} onclick={() => (permission = 'DENY')} onkeydown={(e) => e.key === 'Enter' && (permission = 'DENY')}>Deny</span>
        </div>
        {#if permission === 'DENY'}<div class="um-field-hint">A Deny always wins over an Allow for the same action.</div>{/if}
      </div>

      <div class="um-group">
        <div class="um-group-title">2 · What</div>
        <div class="um-seg" role="group" aria-label="How to choose permissions">
          <span role="button" tabindex="0" aria-pressed={mode === 'preset'} onclick={() => (mode = 'preset')} onkeydown={(e) => e.key === 'Enter' && (mode = 'preset')}>Common task</span>
          <span role="button" tabindex="0" aria-pressed={mode === 'custom'} onclick={() => (mode = 'custom')} onkeydown={(e) => e.key === 'Enter' && (mode = 'custom')}>Exact permissions</span>
        </div>

        {#if mode === 'preset'}
          <div class="um-levels" role="radiogroup" aria-label="Task">
            {#each ACL_PRESETS as p (p.id)}
              <label class="um-level" class:on={preset === p.id}>
                <input type="radio" name="acl-preset" value={p.id} bind:group={preset} class="acl-radio" />
                <span><span class="um-level-name">{p.label}</span><br /><span class="um-level-desc">{p.description}</span></span>
              </label>
            {/each}
          </div>
        {:else}
          <div class="acl-res" role="radiogroup" aria-label="Resource type">
            {#each ACL_RESOURCES as r (r.value)}
              <label class="acl-res-opt" class:on={resourceType === r.value} title={r.hint}>
                <input type="radio" name="acl-res" value={r.value} bind:group={resourceType} class="acl-radio" />{r.label}
              </label>
            {/each}
          </div>
        {/if}

        {#if mode === 'preset' || resourceType !== 'CLUSTER'}
          <div class="um-inline">
            <label class="um-field acl-grow">
              {mode === 'preset' || resourceType === 'TOPIC' ? 'Topic' : resourceType === 'GROUP' ? 'Consumer group' : 'Transactional ID'}
              <input class="um-input mono" list="acl-resources" bind:value={resourceName} placeholder="name, or * for all" aria-label="Resource name" spellcheck="false" />
              <datalist id="acl-resources">{#each mode === 'preset' ? topics : resourceChoices as n (n)}<option value={n}></option>{/each}</datalist>
            </label>
            <div class="um-seg" role="group" aria-label="Name match">
              <span role="button" tabindex="0" aria-pressed={pattern === 'LITERAL'} onclick={() => (pattern = 'LITERAL')} onkeydown={(e) => e.key === 'Enter' && (pattern = 'LITERAL')}>Exact name</span>
              <span role="button" tabindex="0" aria-pressed={pattern === 'PREFIXED'} onclick={() => (pattern = 'PREFIXED')} onkeydown={(e) => e.key === 'Enter' && (pattern = 'PREFIXED')}>Starts with</span>
            </div>
          </div>
        {:else}
          <div class="um-field-hint">Cluster permissions apply to the whole cluster (resource <span class="mono">kafka-cluster</span>).</div>
        {/if}

        {#if mode === 'preset' && preset === 'consume'}
          <label class="um-field">
            Consumer group
            <input class="um-input mono" list="acl-groups" bind:value={group} placeholder="* — any group" aria-label="Consumer group" spellcheck="false" />
            <datalist id="acl-groups">{#each groups as n (n)}<option value={n}></option>{/each}</datalist>
            <span class="um-field-hint">Readers commit their position in a group; leave empty to allow any group.</span>
          </label>
        {/if}

        {#if mode === 'custom'}
          <div class="acl-ops" role="group" aria-label="Operations">
            {#each allowedOps as o (o)}
              <label class="acl-op" class:on={ops.includes(o)}>
                <input type="checkbox" checked={ops.includes(o)} onchange={() => toggleOp(o)} />
                <span>{operationText(o)}</span>
                <span class="mono acl-op-key">{o}</span>
              </label>
            {/each}
          </div>
        {/if}

        <details class="acl-adv">
          <summary>Limit by client address</summary>
          <label class="um-field">
            Host
            <input class="um-input mono" bind:value={host} placeholder="*" aria-label="Host" spellcheck="false" />
            <span class="um-field-hint">An IP address, or * for any address.</span>
          </label>
        </details>
      </div>

      <div class="um-group">
        <div class="um-group-title">3 · Will be created ({bindings.length})</div>
        {#if problem}
          <div class="acl-empty">{problem}</div>
        {:else}
          <ul class="acl-list" aria-label="ACLs to create">
            {#each bindings as b, i (i)}
              <li class:deny={b.permission === 'DENY'}>{aclSentence(b)}</li>
            {/each}
          </ul>
        {/if}
        {#if error}<div class="um-callout danger" role="alert"><Icon name="warning" size={15} /><span>{error}</span></div>{/if}
      </div>
    </div>

    <div class="um-dlg-foot">
      <span class="um-dlg-foot-note">Takes effect immediately for new requests.</span>
      <button type="button" class="cfm-btn" onclick={onClose} disabled={busy}>Cancel</button>
      <button type="button" class="cfm-btn" class:primary={permission === 'ALLOW'} class:danger={permission === 'DENY'} onclick={create} disabled={!!problem || busy}>
        {busy ? 'Granting…' : permission === 'DENY' ? `Deny ${bindings.length === 1 ? 'access' : `${bindings.length} permissions`}` : `Grant ${bindings.length === 1 ? 'access' : `${bindings.length} permissions`}`}
      </button>
    </div>
  </div>
</div>

<style>
  .acl {
    width: min(var(--px-640), 94vw);
  }
  .acl-who {
    display: flex;
    align-items: center;
    gap: var(--px-8);
    flex-wrap: wrap;
  }
  .acl-name {
    flex: 1 1 var(--px-200);
  }
  .acl-grow {
    flex: 1 1 var(--px-240);
  }
  .acl-radio {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }
  .acl-res {
    display: flex;
    gap: var(--px-6);
    flex-wrap: wrap;
  }
  .acl-res-opt {
    position: relative;
    padding: var(--px-6) var(--px-12);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-8);
    font-size: var(--px-12_5);
    color: var(--text2);
    cursor: pointer;
    background: var(--surface);
  }
  .acl-res-opt.on {
    border-color: var(--primary);
    color: var(--text);
    font-weight: 600;
    box-shadow: 0 0 0 var(--px-1) var(--primary);
  }
  .acl-ops {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(var(--px-180), 1fr));
    gap: var(--px-6);
  }
  .acl-op {
    display: flex;
    align-items: center;
    gap: var(--px-8);
    padding: var(--px-6) var(--px-10);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-8);
    font-size: var(--px-12_5);
    color: var(--text);
    cursor: pointer;
  }
  .acl-op.on {
    border-color: color-mix(in srgb, var(--primary) 55%, var(--border));
    background: color-mix(in srgb, var(--primary) 6%, var(--surface));
  }
  .acl-op-key {
    margin-left: auto;
    font-size: var(--px-10_5);
    color: var(--muted);
  }
  .acl-adv summary {
    font-size: var(--px-12);
    color: var(--muted);
    cursor: pointer;
    margin-bottom: var(--px-6);
  }
  .acl-list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: var(--px-4);
  }
  .acl-list li {
    padding: var(--px-6) var(--px-10);
    border-radius: var(--px-7);
    background: var(--panel);
    font-size: var(--px-12_5);
    color: var(--text);
  }
  .acl-list li.deny {
    color: var(--danger-text);
    background: var(--danger-soft);
  }
  .acl-empty {
    font-size: var(--px-12_5);
    color: var(--muted);
  }
</style>
