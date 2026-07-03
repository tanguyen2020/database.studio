<script lang="ts">
  // JSON mode — port dòng 500-502 (pre mono colorized) + spec §4 controls
  // (Pretty/Compact, Wrap, Copy, Search). Colorize theo jsonColorize (dòng 3935):
  // key #61afef, string #98c379, number #d19a66, null #e06c75.
  import { toasts } from '$lib/stores/toast.svelte'
  import type { QueryResultSet } from '$lib/types'

  interface Props {
    data: QueryResultSet
  }

  let { data }: Props = $props()
  let pretty = $state(true)
  let wrap = $state(false)
  let search = $state('')

  const objects = $derived(data.rows)
  const text = $derived(pretty ? JSON.stringify(objects, null, 2) : JSON.stringify(objects))

  // tách token để tô màu (port regex dòng 3937)
  const parts = $derived.by(() => {
    const re = /("(?:[^"\\]|\\.)*"\s*:)|("(?:[^"\\]|\\.)*")|(\b\d+(?:\.\d+)?\b)|(\bnull\b)/g
    const out: { t: string; color: string | null }[] = []
    let last = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      if (m.index > last) out.push({ t: text.slice(last, m.index), color: null })
      const s = m[0]
      let color: string | null = null
      if (m[1]) color = 'var(--hex-61afef)'
      else if (m[2]) color = 'var(--hex-98c379)'
      else if (m[3]) color = 'var(--hex-d19a66)'
      else if (m[4]) color = 'var(--hex-e06c75)'
      out.push({ t: s, color })
      last = re.lastIndex
    }
    if (last < text.length) out.push({ t: text.slice(last), color: null })
    return out
  })

  async function copyAll() {
    await navigator.clipboard.writeText(text)
    toasts.success('Đã copy JSON')
  }
</script>

<div style="display:flex;flex-direction:column;height:100%;min-height:0">
  <!-- controls -->
  <div style="flex:none;display:flex;align-items:center;gap:var(--px-8);padding:var(--px-5) var(--px-16);border-bottom:var(--px-1) solid var(--border);font-size:var(--px-11_5)">
    <span class="jv-btn" style="background:{pretty ? 'var(--hover)' : 'var(--panel)'}" onclick={() => (pretty = true)} onkeydown={(e) => e.key === 'Enter' && (pretty = true)} role="button" tabindex="0">Pretty</span>
    <span class="jv-btn" style="background:{!pretty ? 'var(--hover)' : 'var(--panel)'}" onclick={() => (pretty = false)} onkeydown={(e) => e.key === 'Enter' && (pretty = false)} role="button" tabindex="0">Compact</span>
    <span class="jv-btn" style="background:{wrap ? 'var(--hover)' : 'var(--panel)'}" onclick={() => (wrap = !wrap)} onkeydown={(e) => e.key === 'Enter' && (wrap = !wrap)} role="button" tabindex="0">Wrap</span>
    <div style="display:flex;align-items:center;gap:var(--px-6);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-3) var(--px-8)">
      <span style="color:var(--muted)">⌕</span>
      <input bind:value={search} placeholder="Search…" style="border:none;background:transparent;color:var(--text);font-size:var(--px-11_5);outline:none;width:var(--px-130);font-family:inherit" />
    </div>
    <span class="jv-btn" style="margin-left:auto" onclick={copyAll} onkeydown={(e) => e.key === 'Enter' && copyAll()} role="button" tabindex="0">Copy</span>
  </div>
  <!-- colorized JSON — dòng 501 -->
  <pre class="mono selectable" style="flex:1;margin:0;padding:var(--px-14) var(--px-16);font-size:var(--px-12);line-height:1.55;color:var(--text);white-space:{wrap ? 'pre-wrap' : 'pre'};overflow:auto">{#each parts as p, i (i)}{#if search && p.color === null}{p.t}{:else}<span style={p.color ? `color:${p.color}` : ''} class:jv-hit={search && p.t.toLowerCase().includes(search.toLowerCase())}>{p.t}</span>{/if}{/each}</pre>
</div>

<style>
  .jv-btn {
    font-size: var(--px-11_5);
    color: var(--text2);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-6);
    padding: var(--px-3) var(--px-10);
    cursor: pointer;
  }
  .jv-btn:hover {
    background: var(--hover);
  }
  .jv-hit {
    background: var(--rgba-240-160-32-_18);
  }
</style>
