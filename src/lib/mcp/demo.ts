// Demo stand-in for the MCP server commands (browser / Playwright). The real
// server runs in Rust; here we keep a small in-memory config so Settings → MCP and
// the approval popup can be exercised without a backend.

import type { McpApprovalRequest, McpAuditEntry, McpConfigInput, McpStatus } from '../ipc'

interface DemoProfile {
  id: string
  name: string
  system: string
}

const state: {
  enabled: boolean
  port: number
  rowCap: number
  approvalMode: McpConfigInput['approvalMode']
  connections: Record<string, { read: boolean; write: boolean }>
  token: string
  audit: McpAuditEntry[]
} = {
  enabled: false,
  port: 4319,
  rowCap: 1000,
  approvalMode: 'ask-on-write',
  connections: {},
  token: 'demo-mcp-token-0000000000000000',
  audit: [
    { at: `${Math.floor(Date.now() / 1000) - 60}`, tool: 'list_tables', connection: 'c1', outcome: 'ok', detail: '6 tables' },
    { at: `${Math.floor(Date.now() / 1000) - 30}`, tool: 'run_query', connection: 'c1', sql: 'SELECT * FROM students LIMIT 1000', outcome: 'ok', detail: '3 row(s)' },
  ],
}

function status(profiles: DemoProfile[]): McpStatus {
  return {
    enabled: state.enabled,
    running: state.enabled,
    port: state.port,
    url: `http://127.0.0.1:${state.port}/mcp`,
    token: state.token,
    rowCap: state.rowCap,
    approvalMode: state.approvalMode,
    connections: profiles.map((p) => ({
      id: p.id,
      name: p.name,
      engine: p.system,
      read: state.connections[p.id]?.read ?? false,
      write: state.connections[p.id]?.write ?? false,
    })),
  }
}

export function mcpDemo(cmd: string, args: Record<string, unknown>, profiles: DemoProfile[]): Promise<unknown> | undefined {
  switch (cmd) {
    case 'mcp_status':
      return Promise.resolve(status(profiles))
    case 'mcp_set_config': {
      const c = args.config as McpConfigInput
      state.enabled = c.enabled
      state.port = c.port || 4319
      state.rowCap = c.rowCap || 1000
      state.approvalMode = c.approvalMode
      state.connections = c.connections ?? {}
      return Promise.resolve(status(profiles))
    }
    case 'mcp_rotate_token':
      state.token = 'demo-mcp-token-' + Math.random().toString(16).slice(2).padEnd(16, '0')
      return Promise.resolve(state.token)
    case 'mcp_audit_list':
      return Promise.resolve([...state.audit].reverse())
    case 'mcp_clear_audit':
      state.audit = []
      return Promise.resolve(undefined)
    case 'mcp_approve':
      return Promise.resolve(undefined)
  }
  return undefined
}

// ---- approval popup (browser) ----------------------------------------------

type ApprovalCb = (r: McpApprovalRequest) => void
const listeners = new Set<ApprovalCb>()

export function mcpDemoApprovalListen(cb: ApprovalCb): () => void {
  listeners.add(cb)
  // Test seam: `?mcpApprove=1` fires one sample approval request shortly after mount.
  if (typeof window !== 'undefined') {
    const w = window as unknown as { __mcpFireApproval?: (r?: Partial<McpApprovalRequest>) => void }
    w.__mcpFireApproval = (r) =>
      cb({
        id: 'demo-approval-1',
        connection: 'c1',
        system: 'postgres',
        sql: 'UPDATE students SET status = 1 WHERE id = 42',
        write: true,
        production: false,
        ...r,
      })
    if (new URLSearchParams(window.location.search).get('mcpApprove') === '1') {
      setTimeout(() => w.__mcpFireApproval?.(), 300)
    }
  }
  return () => listeners.delete(cb)
}
