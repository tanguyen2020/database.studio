// check-hardcoded-styles.mjs — cưỡng chế quy tắc "cấm gõ tay giá trị token".
// Quét src/**/*.svelte: mọi màu hex/rgba và mọi giá trị px literal đều bị cấm —
// component phải tham chiếu biến trong src/lib/tokens.css (sinh từ HTML gốc).
// Vi phạm → exit 1 (chạy trong CI/test qua `npm run tokens:check`).

import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, 'src')

// File sinh tự động / file không phải UI được miễn
const EXEMPT = new Set(['tokens.css', 'systems.gen.ts'])
// shadcn-svelte primitives (stack đã chốt) — style mặc định của thư viện,
// mọi chỗ DÙNG chúng trong app đều override bằng token
const EXEMPT_DIRS = [path.join('components', 'ui') + path.sep]

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) yield* walk(p)
    else yield p
  }
}

const violations = []
for (const file of walk(SRC)) {
  const base = path.basename(file)
  if (EXEMPT.has(base)) continue
  if (EXEMPT_DIRS.some((d) => file.includes(d))) continue
  if (!/\.(svelte|css)$/.test(file)) continue

  const rel = path.relative(ROOT, file)
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, i) => {
    if (line.includes('token-exempt')) return // lối thoát có chủ đích, phải giải thích trong PR
    const t = line.trim()
    // bỏ qua comment (JS/TS/CSS/HTML) — chỉ bắt giá trị trong code/markup thật
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('<!--')) return
    for (const re of [
      /#[0-9a-fA-F]{3,8}\b/g, // màu hex
      /rgba?\([^)]*\)/g, // màu rgb/rgba
      /(?<![\w-])\d+(?:\.\d+)?px\b/g, // kích thước px literal
    ]) {
      for (const m of line.matchAll(re)) {
        // bỏ qua khi nằm trong var(--...) fallback hoặc là id/anchor href
        const before = line.slice(0, m.index)
        if (/url\(#$|href="#?$/.test(before)) continue
        violations.push(`${rel}:${i + 1}  ${m[0]}  |  ${line.trim().slice(0, 100)}`)
      }
    }
  })
}

if (violations.length) {
  console.error(`✗ ${violations.length} giá trị hardcode trong component (phải dùng token):`)
  for (const v of violations) console.error('  ' + v)
  process.exit(1)
}
console.log('✓ Không có giá trị màu/px hardcode ngoài tokens.css')
