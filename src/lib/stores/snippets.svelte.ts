// Saved Queries (snippets) store — persist qua storage nội bộ (IPC).

import * as ipc from '$lib/ipc'
import type { Snippet } from '$lib/ipc'

function uuid(): string {
  return crypto.randomUUID()
}

class SnippetsStore {
  items = $state<Snippet[]>([])
  loaded = $state(false)

  async load() {
    if (this.loaded) return
    try {
      this.items = await ipc.listSnippets()
    } catch {
      this.items = []
    } finally {
      this.loaded = true
    }
  }

  async refresh() {
    this.items = await ipc.listSnippets()
  }

  async save(name: string, sql: string, system: string | null): Promise<Snippet> {
    const snippet: Snippet = { id: uuid(), name, sql, system, updated_at: '' }
    await ipc.saveSnippet(snippet)
    await this.refresh()
    return snippet
  }

  async remove(id: string) {
    await ipc.deleteSnippet(id)
    this.items = this.items.filter((s) => s.id !== id)
  }
}

export const snippets = new SnippetsStore()
