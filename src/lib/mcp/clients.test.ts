import { describe, expect, it } from 'vitest'
import { BRIDGE_FLAG, mcpClientSnippets, tomlString } from './clients'

const WIN = String.raw`C:\Users\me\AppData\Local\Database Studio\database-studio.exe`
const input = { url: 'http://127.0.0.1:4319/mcp', token: 'tok123', bridgePath: WIN }
const byId = (id: string) => mcpClientSnippets(input).find((s) => s.id === id)!

describe('mcpClientSnippets', () => {
  it('offers every major client once', () => {
    const ids = mcpClientSnippets(input).map((s) => s.id)
    expect(ids).toEqual(['claude-code', 'claude-desktop', 'cursor', 'vscode', 'gemini', 'codex', 'windsurf', 'other'])
  })

  it('JSON snippets are valid JSON and keep the Windows path intact', () => {
    for (const id of ['claude-desktop', 'cursor', 'vscode', 'gemini', 'windsurf']) {
      const v = JSON.parse(byId(id).snippet)
      expect(v).toBeTruthy()
    }
    const desktop = JSON.parse(byId('claude-desktop').snippet)
    expect(desktop.mcpServers['database-studio']).toEqual({ command: WIN, args: [BRIDGE_FLAG] })
  })

  it('HTTP snippets carry the url and bearer token; stdio ones carry no secret', () => {
    const cursor = JSON.parse(byId('cursor').snippet).mcpServers['database-studio']
    expect(cursor).toEqual({ url: input.url, headers: { Authorization: 'Bearer tok123' } })
    const gemini = JSON.parse(byId('gemini').snippet).mcpServers['database-studio']
    expect(gemini.httpUrl).toBe(input.url)
    expect(byId('claude-code').snippet).toBe(
      'claude mcp add --transport http --scope user database-studio http://127.0.0.1:4319/mcp --header "Authorization: Bearer tok123"',
    )
    for (const s of mcpClientSnippets(input)) {
      expect(s.snippet.includes('tok123')).toBe(s.hasToken)
    }
  })

  it('VS Code asks for the token instead of storing it', () => {
    const v = JSON.parse(byId('vscode').snippet)
    expect(v.servers['database-studio']).toEqual({
      type: 'http',
      url: input.url,
      headers: { Authorization: 'Bearer ${input:ds-token}' },
    })
    expect(v.inputs[0]).toMatchObject({ id: 'ds-token', password: true })
  })

  it('Codex TOML uses a literal string so backslashes need no escaping', () => {
    expect(byId('codex').snippet).toBe(`[mcp_servers.database-studio]\ncommand = '${WIN}'\nargs = ["--mcp-stdio"]`)
    expect(tomlString("C:\\it's\\x.exe")).toBe('"C:\\\\it\'s\\\\x.exe"')
    expect(tomlString('/Applications/Database Studio.app/Contents/MacOS/database-studio')).toBe(
      "'/Applications/Database Studio.app/Contents/MacOS/database-studio'",
    )
  })
})
