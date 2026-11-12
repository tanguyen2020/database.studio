// Browser/demo stand-in for Export / Import Connections. Same shapes as the
// backend (src-tauri/src/commands/transfer.rs); the sealing is real (WebCrypto
// PBKDF2 + AES-GCM) so a wrong password really fails here too. The REAL file
// format and crypto (Argon2id) are the backend's and are tested in Rust.
//
// Demo "saved passwords" are `demo-pw-<id>` (and `demo-ssh-<id>`), so e2e can
// check that an import carried them: `window.__importedSecrets[name]`.

import type { ProfilePublic } from '$lib/types'

const RUNTIME = ['has_password', 'connected', 'latency_ms', 'ephemeral'] as const
const enc = new TextEncoder()
const dec = new TextDecoder()

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u))
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

async function keyFor(pw: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 50_000, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

function portable(p: ProfilePublic) {
  const c: Record<string, unknown> = { ...p, id: '', password_enc: '', ssh: { ...p.ssh, password_enc: '' } }
  for (const k of RUNTIME) delete c[k]
  return c
}

/** Profiles added by an import in this page (the demo list is otherwise static). */
const imported: ProfilePublic[] = []
let seq = 0

function missingFiles(p: Record<string, unknown>): string[] {
  const ssh = p.ssh as { enabled?: boolean; auth?: string; key_path?: string } | undefined
  const out: string[] = []
  // In the browser no file exists — report the key the profile points at, like a new machine would.
  if (ssh?.enabled && ssh.auth === 'key' && ssh.key_path) out.push(ssh.key_path)
  return out
}

type Parsed = { sealed: boolean; entries: { profile: Record<string, unknown>; secret: { password: string; ssh_password: string } | null }[] }

async function parse(content: string, passphrase: string | null): Promise<Parsed | 'needs' | 'wrong'> {
  let root: unknown
  try {
    root = JSON.parse(content.replace(/^﻿/, ''))
  } catch {
    throw 'This is not a Database Studio connections file (it is not valid JSON).'
  }
  const r = root as Record<string, unknown>
  if (r && typeof r === 'object' && typeof r.format === 'string' && r.format !== 'database-studio-connections')
    throw `This is a '${r.format}' file, not a connections file.`
  if (r && typeof r === 'object' && r.encrypted) {
    if (!passphrase) return 'needs'
    const e = r.encrypted as { salt: string; nonce: string; data: string }
    try {
      const key = await keyFor(passphrase, unb64(e.salt))
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(e.nonce) }, key, unb64(e.data))
      const payload = JSON.parse(dec.decode(plain)) as { profiles: Record<string, unknown>[]; secrets: { password: string; ssh_password: string }[] }
      return { sealed: true, entries: payload.profiles.map((profile, i) => ({ profile, secret: payload.secrets[i] })) }
    } catch {
      return 'wrong'
    }
  }
  const list = Array.isArray(root) ? root : (r?.profiles as unknown[] | undefined)
  if (!Array.isArray(list)) throw 'This is not a Database Studio connections file (no connections in it).'
  return { sealed: false, entries: list.map((p) => ({ profile: { ...(p as object), id: '' } as Record<string, unknown>, secret: null })) }
}

/** Returns a Promise for the transfer commands, `undefined` for anything else. */
export function transferDemo(cmd: string, args: Record<string, unknown>, saved: ProfilePublic[]): Promise<unknown> | undefined {
  const all = () => [...saved, ...imported]
  switch (cmd) {
    case 'export_connections':
      return (async () => {
        const ids = (args.ids as string[]) ?? []
        const pw = (args.passphrase as string | null) ?? null
        const picked = ids.map((id) => all().find((p) => p.id === id)).filter((p): p is ProfilePublic => !!p)
        if (picked.length === 0) throw 'Pick at least one connection to export.'
        const env: Record<string, unknown> = {
          format: 'database-studio-connections',
          version: 2,
          exported_at: new Date().toISOString(),
          count: picked.length,
        }
        if (pw) {
          if ([...pw].length < 8) throw 'The file password must be at least 8 characters.'
          const salt = crypto.getRandomValues(new Uint8Array(16))
          const nonce = crypto.getRandomValues(new Uint8Array(12))
          const payload = {
            profiles: picked.map(portable),
            secrets: picked.map((p) => ({
              password: p.has_password ? `demo-pw-${p.id}` : '',
              ssh_password: p.ssh?.enabled && p.ssh.auth === 'password' ? `demo-ssh-${p.id}` : '',
            })),
          }
          const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, await keyFor(pw, salt), enc.encode(JSON.stringify(payload)))
          env.encrypted = { kdf: 'demo-pbkdf2', salt: b64(salt), nonce: b64(nonce), data: b64(new Uint8Array(ct)) }
        } else {
          env.profiles = picked.map(portable)
        }
        return JSON.stringify(env, null, 2)
      })()
    case 'inspect_connections_file':
      return (async () => {
        const r = await parse(String(args.content ?? ''), (args.passphrase as string | null) ?? null)
        if (r === 'needs') return { status: 'needs_passphrase' }
        if (r === 'wrong') return { status: 'wrong_passphrase' }
        return {
          status: 'ok',
          sealed: r.sealed,
          items: r.entries.map((e) => ({
            profile: e.profile,
            has_password: !!e.secret?.password,
            has_ssh_password: !!e.secret?.ssh_password,
            missing_files: missingFiles(e.profile),
          })),
        }
      })()
    case 'import_connections':
      return (async () => {
        const r = await parse(String(args.content ?? ''), (args.passphrase as string | null) ?? null)
        if (r === 'needs' || r === 'wrong') throw 'Wrong password — or the file was changed after it was exported.'
        const out: ProfilePublic[] = []
        const secrets: Record<string, string> = {}
        for (const c of (args.choices as { index: number; action: string; target_id?: string; name?: string }[]) ?? []) {
          const e = r.entries[c.index]
          if (!e) throw `The file has no connection #${c.index + 1}`
          const id = c.action === 'replace' ? String(c.target_id) : `demo-imp-${++seq}`
          const prev = all().find((p) => p.id === id)
          const p = {
            ...(e.profile as unknown as ProfilePublic),
            id,
            name: c.name || String(e.profile.name),
            has_password: !!e.secret?.password || !!prev?.has_password,
            connected: prev?.connected ?? false,
          }
          if (e.secret?.password) secrets[p.name] = e.secret.password
          if (c.action === 'add') imported.push(p)
          out.push(p)
        }
        if (typeof window !== 'undefined') {
          const w = window as unknown as { __importedSecrets?: Record<string, string> }
          w.__importedSecrets = { ...(w.__importedSecrets ?? {}), ...secrets }
        }
        return out
      })()
    case 'read_text_file':
      return Promise.reject('Reading files by path needs the desktop app')
    case 'find_dbeaver_sources':
      return Promise.resolve([]) // no filesystem in the browser/demo
  }
  return undefined
}
