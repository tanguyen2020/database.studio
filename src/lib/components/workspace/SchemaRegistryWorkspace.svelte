<script lang="ts">
  import Icon from '$lib/components/Icon.svelte'
  import { dbIcon } from '$lib/explorer/icons'
  // Kafka Schema Registry (Phase 4 · T7) — port dòng 928-958 của prototype.
  // Trái: danh sách subjects (fmt badge + name + v{latest} · compat). Phải:
  // header (name + fmt + version toggles) + pre schema + footer compat/id.
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import { toasts } from '$lib/stores/toast.svelte'
  import type { TabState } from '$lib/types'

  interface Props {
    tab: TabState
  }
  let { tab }: Props = $props()

  let subjects = $state<ipc.SrSubject[]>([])
  let sel = $state<string | null>(null)
  let versions = $state<number[]>([])
  let schema = $state<ipc.SrSchema | null>(null)
  let loading = $state(false)
  let error = $state<string | null>(null)

  async function load() {
    if (!tab.connectionId) return
    loading = true
    error = null
    try {
      subjects = await ipc.kafkaSrSubjects(tab.connectionId)
      if (subjects.length && !sel) await select(subjects[0].name)
    } catch (e) {
      error = String(e)
    } finally {
      loading = false
    }
  }

  async function select(name: string) {
    if (!tab.connectionId) return
    sel = name
    try {
      versions = await ipc.kafkaSrVersions(tab.connectionId, name)
      const latest = versions.length ? versions[versions.length - 1] : 1
      await showVersion(latest)
    } catch (e) {
      toasts.error(`${e}`)
    }
  }

  async function showVersion(v: number) {
    if (!tab.connectionId || !sel) return
    try {
      schema = await ipc.kafkaSrSchema(tab.connectionId, sel, v)
    } catch (e) {
      toasts.error(`${e}`)
    }
  }

  $effect(() => {
    void tab.connectionId
    untrack(() => void load())
  })
</script>

<div class="ds-ws">
  {#if error}
    <div style="flex:none;padding:var(--px-8) var(--px-18);background:var(--danger-soft);color:var(--danger-text);font-size:var(--px-12);border-bottom:var(--px-1) solid var(--border)">{error}</div>
  {/if}
  <div style="flex:1;display:flex;min-height:0">
    <!-- Subjects -->
    <div class="sr-side">
      <div class="sr-side-head">
        <span>Subjects</span>
        <span class="ds-count" style="margin-left:var(--px-6)">{subjects.length}</span>
        <span onclick={load} onkeydown={(e) => e.key === 'Enter' && load()} role="button" tabindex="0" title="Reload subjects" class="sr-icon-btn"><Icon name="refresh" size={12} /></span>
      </div>
      <div style="flex:1;overflow:auto;min-height:0;padding:var(--px-4) var(--px-8) var(--px-8)">
        {#each subjects as s (s.name)}
          <div onclick={() => select(s.name)} onkeydown={(e) => e.key === 'Enter' && select(s.name)} role="button" tabindex="0" class="sr-item" class:on={sel === s.name}>
            <span class="sr-fmt">{s.fmt}</span>
            <div style="min-width:0">
              <div class="sr-name" title={s.name}>{s.name}</div>
              <div class="sr-meta">v{s.latest} · {s.compat}</div>
            </div>
          </div>
        {/each}
        {#if !loading && subjects.length === 0}
          <div class="ds-empty" style="padding:var(--px-20) var(--px-10)">No subjects yet.</div>
        {/if}
      </div>
    </div>
    <!-- Selected schema -->
    <div style="flex:1;min-width:0;display:flex;flex-direction:column;min-height:0">
      {#if schema}
        <div class="ds-ws-head">
          <span class="ds-ws-icon" style="color:var(--sacc-purple);background:color-mix(in srgb, var(--sacc-purple) 13%, transparent)" aria-hidden="true">{@html dbIcon('udt', 18)}</span>
          <div class="ds-ws-titles">
            <span class="ds-ws-title" title={sel}>{sel}</span>
            <span class="ds-ws-sub">{schema.fmt} schema · compatibility {schema.compat} · id {schema.id}</span>
          </div>
          <div class="ds-ws-actions">
            <div class="ds-seg" role="group" aria-label="Versions">
              {#each versions as v (v)}
                <span onclick={() => showVersion(v)} onkeydown={(e) => e.key === 'Enter' && showVersion(v)} role="button" tabindex="0" aria-pressed={schema.version === v}>v{v}</span>
              {/each}
            </div>
          </div>
        </div>
        <div class="ds-body">
          <pre class="selectable mono sr-schema">{schema.schema}</pre>
        </div>
        <div class="ds-toolbar" style="border-bottom:none;border-top:var(--px-1) solid var(--border)">
          <span class="ds-meta">Compatibility: <b>{schema.compat}</b> · Schema ID <b>{schema.id}</b></span>
        </div>
      {:else}
        <div class="ds-empty" style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center">
          {#if loading}Loading…{:else}<b>No schema selected</b>Select a subject on the left to view its schema.{/if}
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .sr-side {
    width: var(--px-240);
    flex: none;
    border-right: var(--px-1) solid var(--border);
    background: var(--surface);
    display: flex;
    flex-direction: column;
  }
  .sr-side-head {
    flex: none;
    display: flex;
    align-items: center;
    padding: var(--px-12) var(--px-16) var(--px-8);
    font-size: var(--px-13);
    font-weight: 600;
    color: var(--text);
  }
  .sr-icon-btn {
    margin-left: auto;
    width: var(--px-24);
    height: var(--px-24);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--px-6);
    color: var(--muted);
    cursor: pointer;
  }
  .sr-icon-btn:hover {
    background: var(--hover);
    color: var(--text);
  }
  .sr-item {
    display: flex;
    align-items: center;
    gap: var(--px-10);
    padding: var(--px-8) var(--px-10);
    border-radius: var(--px-8);
    cursor: pointer;
  }
  .sr-item:hover {
    background: var(--hover);
  }
  .sr-item.on {
    background: color-mix(in srgb, var(--primary) 12%, transparent);
  }
  .sr-fmt {
    flex: none;
    font-size: var(--px-10);
    font-weight: 700;
    border-radius: var(--px-5);
    padding: var(--px-2) var(--px-6);
    color: var(--sacc-purple);
    background: color-mix(in srgb, var(--sacc-purple) 13%, transparent);
  }
  .sr-name {
    font-size: var(--px-13);
    font-weight: 500;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sr-item.on .sr-name {
    color: var(--primary);
    font-weight: 600;
  }
  .sr-meta {
    font-size: var(--px-11_5);
    color: var(--muted);
  }
  .sr-schema {
    margin: 0;
    font-size: var(--px-12);
    line-height: 1.6;
    color: var(--text);
    white-space: pre-wrap;
    background: var(--surface);
    border: var(--px-1) solid var(--border2);
    border-radius: var(--px-10);
    padding: var(--px-14) var(--px-16);
    box-shadow: var(--shadow-xs);
  }
</style>
