// Folder grouping cho Connection tree (Section 8). Tách thành hàm thuần để
// unit-test được — component chỉ gọi lại. Nhóm theo field `group` do user đặt;
// group rỗng → "Ungrouped" (xếp cuối). Trong mỗi folder, sort theo thứ tự hệ
// rồi tên để hiển thị ổn định.

import type { ProfilePublic } from '$lib/types'

export interface Folder {
  name: string
  items: ProfilePublic[]
}

export function groupByFolder(profiles: ProfilePublic[], systemOrder: readonly string[]): Folder[] {
  const map = new Map<string, ProfilePublic[]>()
  for (const p of profiles) {
    const key = p.group?.trim() || 'Ungrouped'
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(p)
  }
  const rank = (s: string) => {
    const i = systemOrder.indexOf(s)
    return i === -1 ? systemOrder.length : i
  }
  const out: Folder[] = [...map.entries()].map(([name, items]) => ({
    name,
    items: [...items].sort((a, b) => rank(a.system) - rank(b.system) || a.name.localeCompare(b.name)),
  }))
  out.sort((a, b) => (a.name === 'Ungrouped' ? 1 : b.name === 'Ungrouped' ? -1 : a.name.localeCompare(b.name)))
  return out
}
