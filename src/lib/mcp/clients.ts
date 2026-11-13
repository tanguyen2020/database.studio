// Ready-to-paste MCP configuration for each AI client. Pure (unit-tested): the
// Settings → MCP panel renders these and the Copy button puts the real token in.
//
// Two ways in:
//  • HTTP — the client talks to http://127.0.0.1:<port>/mcp with the bearer token.
//  • stdio — the client launches this app's own executable with `--mcp-stdio`
//    (src-tauri/src/mcp/stdio.rs). The bridge reads the token from the app for
//    the same OS user, so the config holds no secret. Used for clients whose HTTP
//    support is missing or cannot send an Authorization header.

export interface McpClientInput {
  url: string
  token: string
  /** Absolute path of the Database Studio executable (the stdio bridge). */
  bridgePath: string
}

export interface McpClientSnippet {
  id: string
  label: string
  /** Where the snippet goes (file / terminal). */
  where: string
  snippet: string
  /** True when the snippet contains the token (shown masked unless revealed). */
  hasToken: boolean
  note?: string
}

export const BRIDGE_FLAG = '--mcp-stdio'
export const SERVER_NAME = 'database-studio'

/** A TOML string for a path: a literal '…' string when possible (no escaping of
 *  Windows backslashes), else a basic "…" string with JSON-compatible escapes. */
export function tomlString(s: string): string {
  if (!s.includes("'") && !/[\r\n]/.test(s)) return `'${s}'`
  return JSON.stringify(s)
}

const json = (v: unknown) => JSON.stringify(v, null, 2)

function stdioJson(bridgePath: string, key: 'mcpServers' | 'servers' = 'mcpServers', extra: Record<string, unknown> = {}) {
  return json({ [key]: { [SERVER_NAME]: { ...extra, command: bridgePath, args: [BRIDGE_FLAG] } } })
}

export function mcpClientSnippets({ url, token, bridgePath }: McpClientInput): McpClientSnippet[] {
  const bearer = `Bearer ${token}`
  return [
    {
      id: 'claude-code',
      label: 'Claude Code',
      where: 'Run once in a terminal — also used by the Claude extension in VS Code and JetBrains',
      snippet: `claude mcp add --transport http --scope user ${SERVER_NAME} ${url} --header "Authorization: ${bearer}"`,
      hasToken: true,
      note: 'Then start a new conversation and type /mcp to check it is connected.',
    },
    {
      id: 'claude-desktop',
      label: 'Claude Desktop',
      where: 'claude_desktop_config.json — Windows: %APPDATA%\\Claude · macOS: ~/Library/Application Support/Claude',
      snippet: stdioJson(bridgePath),
      hasToken: false,
      note: 'No token in the file: the bridge reads it from Database Studio. Quit Claude Desktop from the tray and reopen it after saving.',
    },
    {
      id: 'cursor',
      label: 'Cursor',
      where: '~/.cursor/mcp.json (all projects) or .cursor/mcp.json (one project)',
      snippet: json({ mcpServers: { [SERVER_NAME]: { url, headers: { Authorization: bearer } } } }),
      hasToken: true,
      note: 'Do not commit a project-level .cursor/mcp.json — it holds the token.',
    },
    {
      id: 'vscode',
      label: 'VS Code · Copilot',
      where: 'Command Palette → "MCP: Open User Configuration" (or .vscode/mcp.json)',
      snippet: json({
        inputs: [{ type: 'promptString', id: 'ds-token', description: 'Database Studio MCP token', password: true }],
        servers: {
          [SERVER_NAME]: { type: 'http', url, headers: { Authorization: 'Bearer ${input:ds-token}' } },
        },
      }),
      hasToken: false,
      note: 'Click Start above the server name; VS Code asks for the token once and stores it securely. Use Agent mode in Copilot Chat.',
    },
    {
      id: 'gemini',
      label: 'Gemini CLI',
      where: '~/.gemini/settings.json (merge into the existing file)',
      snippet: json({ mcpServers: { [SERVER_NAME]: { httpUrl: url, headers: { Authorization: bearer } } } }),
      hasToken: true,
      note: 'Use "httpUrl" (Streamable HTTP), not "url" (old SSE transport). Check with /mcp inside gemini.',
    },
    {
      id: 'codex',
      label: 'OpenAI Codex',
      where: '~/.codex/config.toml — Codex CLI and the Codex IDE extension',
      snippet: `[mcp_servers.${SERVER_NAME}]\ncommand = ${tomlString(bridgePath)}\nargs = ["${BRIDGE_FLAG}"]`,
      hasToken: false,
      note: 'Codex starts the bridge itself; no token needed. Check with /mcp inside codex.',
    },
    {
      id: 'windsurf',
      label: 'Windsurf',
      where: '~/.codeium/windsurf/mcp_config.json',
      snippet: stdioJson(bridgePath),
      hasToken: false,
      note: 'Press Refresh in Windsurf → Settings → MCP servers after saving.',
    },
    {
      id: 'other',
      label: 'Other',
      where: 'Any MCP client — Cline, Continue, Zed, LM Studio, JetBrains AI…',
      snippet: [
        '# stdio (works with every client):',
        `command:  ${bridgePath}`,
        `args:     ${BRIDGE_FLAG}`,
        '',
        '# or Streamable HTTP:',
        `url:      ${url}`,
        `header:   Authorization: ${bearer}`,
      ].join('\n'),
      hasToken: true,
      note: 'Optional for stdio: DS_MCP_TOKEN / DS_MCP_URL environment variables override what the bridge reads from the app.',
    },
  ]
}

/** Cloud assistants cannot reach a server on this computer. */
export const CLOUD_NOTE =
  'ChatGPT, Gemini on the web, and the OpenAI / Gemini APIs run in the cloud and cannot reach a server on 127.0.0.1. Use a client that runs on this computer — Codex and Gemini CLI are the local tools from OpenAI and Google.'
