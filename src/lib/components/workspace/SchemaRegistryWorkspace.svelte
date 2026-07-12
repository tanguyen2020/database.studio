<script lang="ts">
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

<div style="flex:1;display:flex;flex-direction:column;min-height:0;background:var(--bg)">
  {#if error}
    <div style="flex:none;padding:var(--px-8) var(--px-14);background:#3a1e1e;color:#ff9b9b;font-size:var(--px-12)">{error}</div>
  {/if}
  <div style="flex:1;display:flex;min-height:0">
    <!-- Subjects -->
    <div style="width:var(--px-240);flex:none;border-right:var(--px-1) solid var(--border);background:var(--surface);display:flex;flex-direction:column">
      <div style="flex:none;padding:var(--px-10) var(--px-14);border-bottom:var(--px-1) solid var(--border);font-size:var(--px-10);font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);display:flex;align-items:center">
        <span>Subjects</span>
        <span onclick={load} onkeydown={(e) => e.key === 'Enter' && load()} role="button" tabindex="0" style="margin-left:auto;color:var(--muted);cursor:pointer;font-size:var(--px-12)">⟳</span>
      </div>
      <div style="flex:1;overflow:auto;min-height:0">
        {#each subjects as s (s.name)}
          <div onclick={() => select(s.name)} onkeydown={(e) => e.key === 'Enter' && select(s.name)} role="button" tabindex="0" style="display:flex;align-items:center;gap:var(--px-8);padding:var(--px-8) var(--px-14);cursor:pointer;background:{sel === s.name ? 'var(--hover)' : 'transparent'}">
            <span style="font-size:var(--px-9);font-weight:700;border-radius:var(--px-3);padding:var(--px-1) var(--px-5);background:#1e1a2e;color:#c4b5fd;border:var(--px-1) solid #3d2f6b">{s.fmt}</span>
            <div style="min-width:0">
              <div class="mono" style="font-size:var(--px-12);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{s.name}</div>
              <div class="mono" style="font-size:var(--px-9_5);color:var(--muted)">v{s.latest} · {s.compat}</div>
            </div>
          </div>
        {/each}
        {#if !loading && subjects.length === 0}
          <div style="padding:var(--px-14);color:var(--muted);font-size:var(--px-12)">No subjects.</div>
        {/if}
      </div>
    </div>
    <!-- Selected schema -->
    <div style="flex:1;min-width:0;display:flex;flex-direction:column;min-height:0">
      {#if schema}
        <div style="flex:none;display:flex;align-items:center;gap:var(--px-10);padding:var(--px-10) var(--px-14);border-bottom:var(--px-1) solid var(--border);background:var(--surface)">
          <span style="width:var(--px-3);height:var(--px-18);border-radius:var(--px-2);background:#8B5CF6"></span>
          <span class="mono" style="font-size:var(--px-13);font-weight:600">{sel}</span>
          <span style="font-size:var(--px-10);font-weight:700;border-radius:var(--px-3);padding:var(--px-1) var(--px-6);background:#1e1a2e;color:#c4b5fd">{schema.fmt}</span>
          <div style="margin-left:auto;display:flex;gap:var(--px-5)">
            {#each versions as v (v)}
              <span onclick={() => showVersion(v)} onkeydown={(e) => e.key === 'Enter' && showVersion(v)} role="button" tabindex="0" class="mono" style="font-size:var(--px-11);border-radius:var(--px-5);padding:var(--px-3) var(--px-9);cursor:pointer;background:{schema.version === v ? '#8B5CF6' : 'var(--panel)'};color:{schema.version === v ? 'var(--hex-fff)' : 'var(--text2)'};border:var(--px-1) solid var(--border)">v{v}</span>
            {/each}
          </div>
        </div>
        <div style="flex:1;overflow:auto;min-height:0;padding:var(--px-14) var(--px-16)">
          <pre class="selectable mono" style="margin:0;font-size:var(--px-12);line-height:1.55;color:var(--text);white-space:pre-wrap">{schema.schema}</pre>
        </div>
        <div style="flex:none;border-top:var(--px-1) solid var(--border);background:var(--surface);padding:var(--px-8) var(--px-14);font-size:var(--px-11);color:var(--muted)">Compatibility: <span style="color:var(--text2)">{schema.compat}</span> · Schema ID <span class="mono" style="color:var(--text2)">{schema.id}</span></div>
      {:else}
        <div style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:var(--px-12_5)">{loading ? 'Loading…' : 'Select a subject to view its schema.'}</div>
      {/if}
    </div>
  </div>
</div>
