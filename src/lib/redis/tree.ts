// Redis Key Explorer — dựng cây phân cấp theo separator ':' (port hành vi tree
// của prototype: user:1, user:2 → folder 'user' → con '1','2'). Hàm thuần để
// unit-test; component flatten theo tập expanded.

export interface RedisKeyInfo {
  name: string
  key_type: string
  /** giây; -1 = không hết hạn, -2 = không tồn tại */
  ttl: number
}

export interface RedisTreeNode {
  segment: string
  /** đường dẫn tích lũy (prefix) tới node này */
  path: string
  children: RedisTreeNode[]
  /** set nếu path này CHÍNH LÀ một key (leaf hoặc prefix trùng key) */
  key?: RedisKeyInfo
}

/**
 * Key names living under a folder `prefix` in the tree: the prefix itself when it is
 * also a key, plus every key beginning with `prefix:`. Used by the Explorer's folder
 * "Delete" (delete every key under a prefix). A key one level up that merely *starts*
 * with the same text (e.g. `userdata` vs folder `user`) is NOT included.
 */
export function keysUnderPrefix(keys: RedisKeyInfo[], prefix: string): string[] {
  return keys.map((k) => k.name).filter((n) => n === prefix || n.startsWith(`${prefix}:`))
}

/**
 * Gộp thêm key của một lượt SCAN vào danh sách đã có, bỏ trùng theo tên.
 * Redis SCAN chỉ bảo đảm "key tồn tại suốt vòng sẽ xuất hiện ít nhất một lần" — nó
 * ĐƯỢC PHÉP trả lại cùng một key ở nhiều vòng, nên "Scan more" (tiếp tục từ cursor
 * đang dở) phải dedupe. Bản ghi mới thắng (type/TTL tươi hơn), thứ tự xuất hiện đầu
 * tiên được giữ để cây không nhảy chỗ khi nạp thêm.
 */
export function mergeRedisKeys(existing: RedisKeyInfo[], incoming: RedisKeyInfo[]): RedisKeyInfo[] {
  const byName = new Map<string, RedisKeyInfo>()
  for (const k of existing) byName.set(k.name, k)
  for (const k of incoming) byName.set(k.name, k)
  return [...byName.values()]
}

/** Dựng rừng cây từ danh sách key, sort segment theo alphabet ở mọi cấp. */
export function buildRedisTree(keys: RedisKeyInfo[]): RedisTreeNode[] {
  const root: RedisTreeNode = { segment: '', path: '', children: [] }
  // Tra node theo `path` bằng Map thay vì `children.find(...)`: path là duy nhất nên
  // kết quả y hệt, nhưng thoát O(n²) khi hàng nghìn key nằm cùng một cấp.
  const byPath = new Map<string, RedisTreeNode>()
  for (const k of keys) {
    const segs = k.name.split(':')
    let node = root
    let path = ''
    for (const seg of segs) {
      path = path ? `${path}:${seg}` : seg
      let child = byPath.get(path)
      if (!child) {
        child = { segment: seg, path, children: [] }
        byPath.set(path, child)
        node.children.push(child)
      }
      node = child
    }
    node.key = k
  }
  const sortRec = (n: RedisTreeNode) => {
    n.children.sort((a, b) => a.segment.localeCompare(b.segment))
    n.children.forEach(sortRec)
  }
  sortRec(root)
  return root.children
}

export interface RedisFlatRow {
  kind: 'folder' | 'key'
  segment: string
  path: string
  depth: number
  expanded: boolean
  key?: RedisKeyInfo
  /** số key con (đệ quy) — chỉ folder */
  count: number
}

/**
 * Đếm số key (node có .key) trong nhánh, kể cả chính node.
 * Memo theo node: flatten gọi hàm này cho MỌI folder nên nếu không cache thì mỗi
 * lần mở/đóng folder lại quét lại cả cây. WeakMap → tự thu hồi khi cây được dựng lại.
 */
const countCache = new WeakMap<RedisTreeNode, number>()
function countKeys(n: RedisTreeNode): number {
  const hit = countCache.get(n)
  if (hit !== undefined) return hit
  const total = (n.key ? 1 : 0) + n.children.reduce((s, c) => s + countKeys(c), 0)
  countCache.set(n, total)
  return total
}

/**
 * Flatten cây thành danh sách hàng để render, tôn trọng tập `expanded` (chứa
 * path các folder đang mở). Folder = có children; đồng thời có thể là key.
 */
export function flattenRedisTree(
  nodes: RedisTreeNode[],
  expanded: Set<string>,
  depth = 0,
): RedisFlatRow[] {
  const out: RedisFlatRow[] = []
  for (const n of nodes) {
    const isFolder = n.children.length > 0
    const open = expanded.has(n.path)
    out.push({
      kind: isFolder ? 'folder' : 'key',
      segment: n.segment,
      path: n.path,
      depth,
      expanded: open,
      key: n.key,
      count: isFolder ? countKeys(n) : 0,
    })
    if (isFolder && open) {
      out.push(...flattenRedisTree(n.children, expanded, depth + 1))
    }
  }
  return out
}
