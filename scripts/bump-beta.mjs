// Bump the beta build number so each build installs OVER the previous one.
//
// Scheme: X.Y.Z-beta.N  (e.g. 0.1.0-beta.1 → 0.1.0-beta.2). NSIS (Windows) and
// dpkg/apt (Ubuntu) both compare versions to upgrade in place, removing the old
// build automatically. Only tauri.conf.json + package.json are touched (NOT
// Cargo.toml — that would force a full recompile); Tauri reads the bundle
// version from tauri.conf.json.
//
// Usage: `node scripts/bump-beta.mjs`  (or `npm run beta:bump`)
// A plain `X.Y.Z` (no -beta) becomes `X.Y.Z-beta.1`.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const confPath = join(root, 'src-tauri', 'tauri.conf.json')
const pkgPath = join(root, 'package.json')

/** Next beta version: bump N, or start at beta.1 for a plain release version. */
function nextVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/.exec(v)
  if (!m) throw new Error(`unexpected version "${v}" (want X.Y.Z or X.Y.Z-beta.N)`)
  const [, maj, min, pat, beta] = m
  const n = beta ? Number(beta) + 1 : 1
  return `${maj}.${min}.${pat}-beta.${n}`
}

/** Rewrite only the first `"version": "..."` field, preserving all other
 *  formatting (a full JSON reserialize would churn package.json's whole diff). */
function setVersionField(path, next) {
  const src = readFileSync(path, 'utf8')
  const out = src.replace(/("version"\s*:\s*")[^"]*(")/, `$1${next}$2`)
  if (out === src) throw new Error(`no "version" field found in ${path}`)
  writeFileSync(path, out)
}

const current = /"version"\s*:\s*"([^"]*)"/.exec(readFileSync(confPath, 'utf8'))?.[1]
if (!current) throw new Error(`no version in ${confPath}`)
const next = nextVersion(current)

setVersionField(confPath, next)
setVersionField(pkgPath, next)

console.log(`${current} -> ${next}`)
