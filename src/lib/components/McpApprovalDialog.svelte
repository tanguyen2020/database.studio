<script lang="ts">
  // Popup the MCP server raises before an agent runs a write (or, in
  // ask-on-everything mode, any query). The agent is blocked until the person
  // answers here. Shows the exact SQL — it is data an outside agent produced,
  // never trusted instructions.
  import * as ipc from '$lib/ipc'
  import type { McpApprovalRequest } from '$lib/ipc'
  import { onMount } from 'svelte'

  let queue = $state<McpApprovalRequest[]>([])
  const current = $derived(queue[0] ?? null)

  onMount(() => {
    let off: (() => void) | undefined
    void ipc.onMcpApproval((r) => {
      queue = [...queue, r]
    }).then((f) => (off = f))
    return () => off?.()
  })

  function answer(allow: boolean, session = false) {
    const r = current
    if (!r) return
    void ipc.mcpApprove(r.id, allow, r.connection, session)
    queue = queue.slice(1)
  }
</script>

{#if current}
  <!-- backdrop does NOT close — the agent is waiting on a real answer -->
  <div class="mcp-ap-back" role="presentation"
    onkeydown={(e) => e.key === 'Escape' && answer(false)}>
    <div class="mcp-ap" role="dialog" aria-modal="true" aria-label="MCP approval" tabindex="-1">
      <div class="mcp-ap-head">
        <span class="mcp-ap-icon {current.production ? 'prod' : current.write ? 'write' : 'read'}">
          {current.write ? '✎' : '👁'}
        </span>
        <div>
          <div style="font-weight:700;font-size:var(--px-14)">
            An AI agent wants to {current.write ? 'change data' : 'run a query'}
          </div>
          <div style="font-size:var(--px-11_5);color:var(--muted)">
            on <strong style="color:var(--text2)">{current.connection}</strong> · {current.system}
          </div>
        </div>
      </div>

      {#if current.production}
        <div class="mcp-ap-warn">⚠ This is a production connection.</div>
      {/if}

      <div style="font-size:var(--px-11);color:var(--muted)">Statement (from the agent):</div>
      <pre class="mcp-ap-sql mono">{current.sql}</pre>

      <div class="mcp-ap-foot">
        <button class="cfm-btn" onclick={() => answer(false)}>Deny</button>
        <span style="flex:1"></span>
        {#if current.write}
          <button class="cfm-btn" onclick={() => answer(true, true)}>Allow for session</button>
        {/if}
        <button class="cfm-btn primary" onclick={() => answer(true)}>Allow once</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .mcp-ap-back {
    position: fixed;
    inset: 0;
    background: var(--rgba-0-0-0-_5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 70;
  }
  .mcp-ap {
    width: var(--px-520);
    max-width: 92vw;
    background: var(--surface);
    border: var(--px-1) solid var(--border2);
    border-radius: var(--px-12);
    box-shadow: var(--shadow-lg);
    padding: var(--px-18);
    display: flex;
    flex-direction: column;
    gap: var(--px-10);
  }
  .mcp-ap-head {
    display: flex;
    gap: var(--px-12);
    align-items: flex-start;
  }
  .mcp-ap-icon {
    width: var(--px-34);
    height: var(--px-34);
    border-radius: var(--px-8);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: var(--px-16);
    flex: none;
  }
  .mcp-ap-icon.read {
    background: color-mix(in srgb, var(--primary) 16%, transparent);
    color: var(--primary);
  }
  .mcp-ap-icon.write {
    background: color-mix(in srgb, var(--warn2, var(--primary)) 18%, transparent);
    color: var(--warn2, var(--primary));
  }
  .mcp-ap-icon.prod {
    background: color-mix(in srgb, var(--error) 16%, transparent);
    color: var(--error);
  }
  .mcp-ap-warn {
    font-size: var(--px-12);
    color: var(--error);
    background: color-mix(in srgb, var(--error) 10%, transparent);
    border-radius: var(--px-6);
    padding: var(--px-6) var(--px-10);
    font-weight: 600;
  }
  .mcp-ap-sql {
    font-size: var(--px-12);
    color: var(--text);
    background: var(--panel);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-6);
    padding: var(--px-10);
    margin: 0;
    max-height: var(--px-220);
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .mcp-ap-foot {
    display: flex;
    align-items: center;
    gap: var(--px-8);
    margin-top: var(--px-2);
  }
</style>
