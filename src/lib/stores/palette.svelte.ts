// Command Palette (Phase 5 · T6) — Ctrl+P fuzzy launcher.
// Chỉ giữ open/query/selected + recent searches; danh sách action do component
// dựng từ các store (connections/tabs/ui/explorer) tại thời điểm mở.

class PaletteStore {
  open = $state(false)
  query = $state('')
  selected = $state(0)
  recent = $state<string[]>([])

  show() {
    this.open = true
    this.query = ''
    this.selected = 0
  }

  close() {
    this.open = false
  }

  toggle() {
    if (this.open) this.close()
    else this.show()
  }

  /** Ghi lại 1 truy vấn đã chọn (dedupe, tối đa 5) cho gợi ý gần đây. */
  remember(q: string) {
    const t = q.trim()
    if (!t) return
    this.recent = [t, ...this.recent.filter((r) => r !== t)].slice(0, 5)
  }
}

export const palette = new PaletteStore()

/** Fuzzy subsequence match: mọi ký tự query xuất hiện đúng thứ tự trong text.
 *  Trả điểm (cao hơn = khớp tốt hơn) hoặc null nếu không khớp. Ưu tiên khớp
 *  liên tiếp + khớp đầu từ. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase()
  if (!q) return 0
  const t = text.toLowerCase()
  let qi = 0
  let score = 0
  let streak = 0
  let prevIdx = -1
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      // liên tiếp → thưởng; khớp đầu chuỗi / sau khoảng trắng → thưởng
      if (prevIdx === i - 1) streak += 1
      else streak = 0
      score += 1 + streak * 2 + (i === 0 || t[i - 1] === ' ' || t[i - 1] === '.' ? 3 : 0)
      prevIdx = i
      qi++
    }
  }
  return qi === q.length ? score : null
}
