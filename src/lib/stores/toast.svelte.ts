// Toast/flash store. Border-left carries the originating connection's accent
// color (Color Identity rule §2.6) — pass the system key when relevant.

import { systemMeta } from '$lib/systems'

export interface Toast {
  id: number
  message: string
  accent: string
  kind: 'info' | 'success' | 'error'
}

let nextId = 1

class ToastStore {
  items = $state<Toast[]>([])

  show(message: string, opts?: { system?: string; kind?: Toast['kind']; duration?: number }) {
    const id = nextId++
    const accent = opts?.system ? systemMeta(opts.system).accent : 'var(--primary)'
    const kind = opts?.kind ?? 'info'
    this.items.push({ id, message, accent, kind })
    setTimeout(() => this.dismiss(id), opts?.duration ?? 3500)
  }

  error(message: string, system?: string) {
    this.show(message, { system, kind: 'error', duration: 6000 })
  }

  success(message: string, system?: string) {
    this.show(message, { system, kind: 'success' })
  }

  dismiss(id: number) {
    this.items = this.items.filter((t) => t.id !== id)
  }
}

export const toasts = new ToastStore()
