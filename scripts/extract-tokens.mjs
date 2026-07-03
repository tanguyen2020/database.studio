// extract-tokens.mjs — sinh token TỰ ĐỘNG từ Database Studio.dc.html.
// Nguồn duy nhất của mọi giá trị màu/spacing/font trong app. CẤM sửa tay
// src/lib/tokens.css và src/lib/systems.gen.ts — thiếu token thì bổ sung
// vào script này rồi chạy `npm run tokens`.
//
// Trích 4 nguồn trong HTML prototype:
//   1. Khối <style>       → theme vars .ds (dark) / .ds-light (light) + font stacks
//   2. Map SYS            → 10 hệ + orphan (accent/bg/border/fg/badge/label)
//   3. Map ENV            → env tag PROD/STG/DEV/LOCAL (label/bg/fg)
//   4. Toàn bộ inline style → mọi giá trị px và mọi màu hex/rgba xuất hiện
//      trong markup → token --px-* / --hex-* / --rgba-* để component tham chiếu.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HTML_PATH = path.join(
  ROOT,
  'spec',
  'Database Studio design',
  'design_handoff_database_studio',
  'Database Studio.dc.html',
)

const html = readFileSync(HTML_PATH, 'utf8')
const sourceHash = createHash('sha256').update(html).digest('hex').slice(0, 12)

// --- 1. Theme vars từ khối <style> -----------------------------------------

function parseVarBlock(selectorRe) {
  const m = html.match(selectorRe)
  if (!m) throw new Error(`không tìm thấy block ${selectorRe}`)
  const vars = {}
  for (const [, name, value] of m[1].matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    vars[name] = value.trim()
  }
  return vars
}

// .ds{ --bg:...; } — theme mặc định (dark). .ds.ds-light{...} — light.
const darkVars = parseVarBlock(/\.ds\{([\s\S]*?)\}/)
const lightVars = parseVarBlock(/\.ds\.ds-light\{([\s\S]*?)\}/)

const fontMain = (html.match(/\.ds\{[\s\S]*?font-family:([^;]+);/) || [])[1]?.trim()
const fontMono = (html.match(/\.mono\{font-family:([^}]+)\}/) || [])[1]?.trim()
if (!fontMain || !fontMono) throw new Error('không trích được font-family')

// --- 2. Map SYS --------------------------------------------------------------

const sysBlock = (html.match(/SYS\s*=\s*\{([\s\S]*?)\n\s*\};/) || [])[1]
if (!sysBlock) throw new Error('không tìm thấy map SYS')
const SYS = {}
const sysRe =
  /(\w+):\s*\{\s*accent:'([^']*)',\s*bg:'([^']*)',\s*border:'([^']*)',\s*fg:'([^']*)',\s*badge:'([^']*)',\s*label:'([^']*)'\s*\}/g
for (const [, key, accent, bg, border, fg, badge, label] of sysBlock.matchAll(sysRe)) {
  SYS[key] = { accent, bg, border, fg, badge, label }
}
const EXPECTED_SYSTEMS = [
  'postgres', 'mysql', 'mssql', 'redis', 'kafka', 'nats',
  'clickhouse', 'mariadb', 'cassandra', 'sqlite', 'orphan',
]
for (const k of EXPECTED_SYSTEMS) {
  if (!SYS[k]) throw new Error(`map SYS thiếu hệ: ${k}`)
}

// --- 3. Map ENV --------------------------------------------------------------

const envBlock = (html.match(/ENV\s*=\s*\{([\s\S]*?)\};/) || [])[1]
if (!envBlock) throw new Error('không tìm thấy map ENV')
const ENV = {}
for (const [, key, label, bg, fg] of envBlock.matchAll(
  /(\w+):\['([^']*)','([^']*)','([^']*)'\]/g,
)) {
  ENV[key] = { label, bg, fg }
}
if (Object.keys(ENV).length !== 4) throw new Error('map ENV phải có đúng 4 env')

// --- 4. Giá trị px + màu literal trong toàn bộ markup ------------------------

const pxValues = new Set()
for (const [, n] of html.matchAll(/(-?\d+(?:\.\d+)?)px/g)) pxValues.add(Number(n))
const pxSorted = [...pxValues].sort((a, b) => a - b)

const hexColors = new Set()
for (const [c] of html.matchAll(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![0-9a-fA-F])/g)) {
  hexColors.add(c.toLowerCase())
}
const rgbaColors = new Set()
for (const [c] of html.matchAll(/rgba?\([^)]*\)/g)) rgbaColors.add(c.replace(/\s+/g, ''))

const pxName = (n) => `--px-${String(n).replace('-', 'neg').replace('.', '_')}`
const hexName = (c) => `--hex-${c.slice(1)}`
// tên biến CSS chỉ được chứa ident chars: '.' → '_', bỏ prefix rgba trùng lặp
const rgbaName = (c) =>
  `--rgba-${c
    .replace(/^rgba?\(/, '')
    .replace(/\)$/, '')
    .replace(/\./g, '_')
    .replace(/[^0-9a-z_]/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')}`

// --- Emit tokens.css ---------------------------------------------------------

const banner = `/*
 * GENERATED — do not edit by hand.
 * Sinh bởi scripts/extract-tokens.mjs từ "Database Studio.dc.html" (sha256 ${sourceHash}).
 * Chạy lại: npm run tokens
 */`

const emitVars = (vars, indent = '  ') =>
  Object.entries(vars).map(([k, v]) => `${indent}--${k}: ${v};`).join('\n')

let css = `${banner}

/* Theme — .ds (dark, mặc định của prototype) & .ds-light. App dùng :root = light, .dark = dark. */
:root {
${emitVars(lightVars)}
  --font-main: ${fontMain};
  --font-mono: ${fontMono};
}

.dark {
${emitVars(darkVars)}
}

/* Color Identity — map SYS (10 hệ + orphan), giống nhau ở cả 2 theme */
:root {
`
for (const [key, s] of Object.entries(SYS)) {
  css += `  --sys-${key}-accent: ${s.accent};\n`
  css += `  --sys-${key}-bg: ${s.bg};\n`
  css += `  --sys-${key}-border: ${s.border};\n`
  css += `  --sys-${key}-fg: ${s.fg};\n`
}
css += `
/* Env tags — map ENV */
`
for (const [key, e] of Object.entries(ENV)) {
  css += `  --env-${key}-bg: ${e.bg};\n  --env-${key}-fg: ${e.fg};\n`
}
css += `
/* Mọi giá trị px xuất hiện trong prototype (${pxSorted.length} giá trị) */
`
for (const n of pxSorted) css += `  ${pxName(n)}: ${n}px;\n`
css += `
/* Mọi màu hex literal trong prototype (${hexColors.size} màu) */
`
for (const c of [...hexColors].sort()) css += `  ${hexName(c)}: ${c};\n`
css += `
/* Mọi màu rgba() trong prototype (${rgbaColors.size} màu) */
`
for (const c of [...rgbaColors].sort()) css += `  ${rgbaName(c)}: ${c};\n`
css += `}\n`

// --- Emit systems.gen.ts -----------------------------------------------------

const ts = `${banner.replace(/^\/\*|\*\/$/g, '').split('\n').map((l) => `//${l.replace(/^ \*? ?/, ' ')}`).join('\n')}

export interface SysGenEntry {
  accent: string
  bg: string
  border: string
  fg: string
  badge: string
  label: string
}

export const SYS_GEN = ${JSON.stringify(SYS, null, 2)} as const

export type SysGenKey = keyof typeof SYS_GEN

export const ENV_GEN = ${JSON.stringify(ENV, null, 2)} as const

export type EnvGenKey = keyof typeof ENV_GEN
`

mkdirSync(path.join(ROOT, 'src', 'lib'), { recursive: true })
writeFileSync(path.join(ROOT, 'src', 'lib', 'tokens.css'), css)
writeFileSync(path.join(ROOT, 'src', 'lib', 'systems.gen.ts'), ts)

console.log(
  `tokens.css: ${Object.keys(lightVars).length}+${Object.keys(darkVars).length} theme vars, ` +
    `${Object.keys(SYS).length} systems, ${Object.keys(ENV).length} envs, ` +
    `${pxSorted.length} px, ${hexColors.size} hex, ${rgbaColors.size} rgba (source ${sourceHash})`,
)
