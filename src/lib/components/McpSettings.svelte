<script lang="ts">
  // Settings → MCP server. Lets external AI agents explore schemas and run
  // read-only queries through the app's saved connections. Off by default;
  // opt-in per connection; localhost + bearer token; approval before writes.
  import * as ipc from '$lib/ipc'
  import type { McpApprovalMode, McpAuditEntry, McpConnRow, McpStatus } from '$lib/ipc'
  import { toasts } from '$lib/stores/toast.svelte'

  let status = $state<McpStatus | null>(null)
  let audit = $state<McpAuditEntry[]>([])
  let busy = $state(false)
  let showToken = $state(false)

  async function load() {
    status = await ipc.mcpStatus()
    audit = await ipc.mcpAuditList()
  }
  load()

  function connMap(rows: McpConnRow[]): Record<string, { read: boolean; write: boolean }> {
    const m: Record<string, { read: boolean; write: boolean }> = {}
    for (const r of rows) m[r.id] = { read: r.read, write: r.write }
    return m
  }

  // Push the current UI state to the backend (starts/stops the server too).
  async function apply(next: McpStatus) {
    if (busy) return
    busy = true
    try {
      status = await ipc.mcpSetConfig({
        enabled: next.enabled,
        port: next.port,
        rowCap: next.rowCap,
        approvalMode: next.approvalMode,
        connections: connMap(next.connections),
      })
      audit = await ipc.mcpAuditList()
    } catch (e) {
      toasts.error(`MCP: ${e}`)
      await load() // reflect reality (server may have failed to start)
    } finally {
      busy = false
    }
  }

  function toggleEnabled() {
    if (!status) return
    void apply({ ...status, enabled: !status.enabled })
  }
  function setReadable(id: string, on: boolean) {
    if (!status) return
    const connections = status.connections.map((c) =>
      c.id === id ? { ...c, read: on, write: on ? c.write : false } : c,
    )
    void apply({ ...status, connections })
  }
  function setWritable(id: string, on: boolean) {
    if (!status) return
    const connections = status.connections.map((c) =>
      c.id === id ? { ...c, write: on, read: on ? true : c.read } : c,
    )
    void apply({ ...status, connections })
  }
  function setApprovalMode(mode: McpApprovalMode) {
    if (!status) return
    void apply({ ...status, approvalMode: mode })
  }
  function setRowCap(v: number) {
    if (!status || !Number.isFinite(v)) return
    void apply({ ...status, rowCap: Math.max(1, Math.min(100000, Math.floor(v))) })
  }
  function setPort(v: number) {
    if (!status || !Number.isFinite(v)) return
    void apply({ ...status, port: Math.max(1024, Math.min(65535, Math.floor(v))) })
  }

  async function rotateToken() {
    if (busy) return
    busy = true
    try {
      const t = await ipc.mcpRotateToken()
      if (status) status.token = t
      toasts.success('New token generated — update your agent')
    } finally {
      busy = false
    }
  }
  async function clearAudit() {
    await ipc.mcpClearAudit()
    audit = []
  }

  function copy(text: string, label: string) {
    try {
      void navigator.clipboard.writeText(text)
      toasts.success(`${label} copied`)
    } catch {
      toasts.error('Could not copy')
    }
  }

  const readableCount = $derived(status ? status.connections.filter((c) => c.read).length : 0)
  const snippet = $derived(
    status
      ? `{
  "mcpServers": {
    "database-studio": {
      "url": "${status.url}",
      "headers": { "Authorization": "Bearer ${showToken ? status.token : '<your-token>'}" }
    }
  }
}`
      : '',
  )

  function when(at: string): string {
    const n = Number(at)
    if (!Number.isFinite(n)) return at
    return new Date(n * 1000).toLocaleString()
  }
</script>

{#if status}
  <!-- Enable -->
  <label class="set-row">
    <span>
      <span style="font-weight:600;color:var(--text)">MCP server</span>
      <span style="display:block;font-size:var(--px-11);color:var(--muted)">
        Let AI agents explore schemas and run queries through your saved connections.
      </span>
    </span>
    <input type="checkbox" checked={status.enabled} onchange={toggleEnabled} disabled={busy} />
  </label>

  {#if status.enabled}
    <div class="mcp-note {status.running ? 'ok' : 'warn'}">
      {status.running ? `Running at ${status.url}` : 'Not running'}
      {#if status.running}
        <button class="mcp-mini" onclick={() => copy(status!.url, 'URL')}>Copy URL</button>
      {/if}
    </div>

    {#if readableCount === 0}
      <div class="mcp-note warn">
        No connection is shared yet. Turn on <strong>Readable</strong> for a connection below so an
        agent can use it.
      </div>
    {/if}

    <!-- Token -->
    <div class="set-row" style="align-items:flex-start">
      <span>
        <span>Access token</span>
        <span style="display:block;font-size:var(--px-11);color:var(--muted)">
          Agents send this as a bearer token. Keep it secret.
        </span>
      </span>
      <div style="display:flex;gap:var(--px-6);align-items:center">
        <input class="set-inp mono" style="width:var(--px-220)" readonly
          value={showToken ? status.token : '•'.repeat(24)} />
        <button class="mcp-mini" onclick={() => (showToken = !showToken)}>{showToken ? 'Hide' : 'Show'}</button>
        <button class="mcp-mini" onclick={() => copy(status!.token, 'Token')}>Copy</button>
        <button class="mcp-mini" onclick={rotateToken} disabled={busy}>Regenerate</button>
      </div>
    </div>

    <!-- Port + row cap + approval -->
    <label class="set-row">Port
      <input class="set-inp" type="number" min="1024" max="65535" value={status.port}
        onchange={(e) => setPort((e.currentTarget as HTMLInputElement).valueAsNumber)} disabled={busy} />
    </label>
    <label class="set-row" title="Largest number of rows a single query may return to an agent.">Row limit
      <input class="set-inp" type="number" min="1" max="100000" value={status.rowCap}
        onchange={(e) => setRowCap((e.currentTarget as HTMLInputElement).valueAsNumber)} disabled={busy} />
    </label>
    <label class="set-row">Approval
      <select class="set-inp" style="width:var(--px-170)" value={status.approvalMode}
        onchange={(e) => setApprovalMode((e.currentTarget as HTMLSelectElement).value as McpApprovalMode)} disabled={busy}>
        <option value="auto">Run everything automatically</option>
        <option value="ask-on-write">Ask before writes</option>
        <option value="ask-on-everything">Ask before every query</option>
      </select>
    </label>

    <!-- Per-connection access -->
    <div style="font-size:var(--px-12);color:var(--text2);font-weight:600;margin-top:var(--px-4)">
      Connections
    </div>
    {#if status.connections.length === 0}
      <div style="font-size:var(--px-12);color:var(--muted)">No saved connections.</div>
    {:else}
      <table class="mcp-conns">
        <thead>
          <tr><th>Connection</th><th>Engine</th><th title="Agent may read schema and run SELECTs">Readable</th><th title="Agent may run INSERT/UPDATE/DELETE (still needs approval)">Allow writes</th></tr>
        </thead>
        <tbody>
          {#each status.connections as c (c.id)}
            <tr>
              <td style="color:var(--text)">{c.name}</td>
              <td style="color:var(--muted)">{c.engine}</td>
              <td><input type="checkbox" checked={c.read} disabled={busy}
                onchange={(e) => setReadable(c.id, (e.currentTarget as HTMLInputElement).checked)} /></td>
              <td><input type="checkbox" checked={c.write} disabled={busy || !c.read}
                onchange={(e) => setWritable(c.id, (e.currentTarget as HTMLInputElement).checked)} /></td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}

    <!-- How to connect -->
    <div style="font-size:var(--px-12);color:var(--text2);font-weight:600;margin-top:var(--px-4)">
      How to connect
      <button class="mcp-mini" style="float:right" onclick={() => copy(snippet, 'Config')}>Copy config</button>
    </div>
    <pre class="mcp-snippet mono">{snippet}</pre>

    <!-- Activity -->
    <div style="font-size:var(--px-12);color:var(--text2);font-weight:600;margin-top:var(--px-4);display:flex;align-items:center">
      Recent activity
      {#if audit.length}<button class="mcp-mini" style="margin-left:auto" onclick={clearAudit}>Clear</button>{/if}
    </div>
    {#if audit.length === 0}
      <div style="font-size:var(--px-12);color:var(--muted)">Nothing yet.</div>
    {:else}
      <div class="mcp-audit">
        {#each audit as a (a.at + a.tool)}
          <div class="mcp-arow" class:bad={a.outcome !== 'ok'}>
            <span class="mono" style="color:var(--muted)">{when(a.at)}</span>
            <span style="color:var(--text)">{a.tool}</span>
            {#if a.connection}<span style="color:var(--text2)">· {a.connection}</span>{/if}
            <span style="margin-left:auto;color:{a.outcome === 'ok' ? 'var(--text2)' : 'var(--error)'}">{a.outcome}{a.detail ? ` — ${a.detail}` : ''}</span>
          </div>
        {/each}
      </div>
    {/if}
  {/if}
{:else}
  <div style="font-size:var(--px-12);color:var(--muted)">Loading…</div>
{/if}

<style>
  :global(.mcp-note) {
    font-size: var(--px-11_5);
    border-radius: var(--px-6);
    padding: var(--px-6) var(--px-10);
    display: flex;
    align-items: center;
    gap: var(--px-8);
  }
  :global(.mcp-note.ok) {
    color: var(--success);
    background: color-mix(in srgb, var(--success) 12%, transparent);
  }
  :global(.mcp-note.warn) {
    color: var(--text2);
    background: var(--panel);
    border: var(--px-1) solid var(--border);
  }
  :global(.mcp-mini) {
    font-size: var(--px-11);
    color: var(--text2);
    background: var(--raised);
    border: var(--px-1) solid var(--border2);
    border-radius: var(--px-5);
    padding: var(--px-2) var(--px-8);
    cursor: pointer;
  }
  :global(.mcp-mini:hover) {
    border-color: var(--primary);
  }
  :global(.mcp-conns) {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--px-12);
  }
  :global(.mcp-conns th) {
    text-align: left;
    color: var(--text2);
    font-weight: 600;
    padding: var(--px-4) var(--px-8);
    border-bottom: var(--px-1) solid var(--border);
  }
  :global(.mcp-conns th:nth-child(3)),
  :global(.mcp-conns th:nth-child(4)),
  :global(.mcp-conns td:nth-child(3)),
  :global(.mcp-conns td:nth-child(4)) {
    text-align: center;
    width: var(--px-90);
  }
  :global(.mcp-conns td) {
    padding: var(--px-4) var(--px-8);
    border-bottom: var(--px-1) solid var(--border);
  }
  :global(.mcp-snippet) {
    font-size: var(--px-11);
    color: var(--text);
    background: var(--panel);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-6);
    padding: var(--px-10);
    overflow: auto;
    white-space: pre;
    margin: 0;
  }
  :global(.mcp-audit) {
    display: flex;
    flex-direction: column;
    gap: var(--px-2);
    max-height: var(--px-170);
    overflow: auto;
  }
  :global(.mcp-arow) {
    display: flex;
    align-items: center;
    gap: var(--px-8);
    font-size: var(--px-11_5);
    padding: var(--px-3) var(--px-8);
    border-radius: var(--px-4);
  }
  :global(.mcp-arow:nth-child(odd)) {
    background: var(--surface);
  }
</style>
