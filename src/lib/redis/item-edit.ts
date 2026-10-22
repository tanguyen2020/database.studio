// Redis Browser — editing one item of a collection key (hash field, list item, set
// member, sorted-set member + score). Pure: the panel collects a draft, this turns it
// into the single atomic edit op the backend runs (drivers/redis.rs ITEM scripts), or
// a plain-language reason the draft cannot be saved.

import type { RedisEditOp } from '$lib/ipc'

export type ItemKind = 'hash' | 'list' | 'set' | 'zset' | 'stream'

/** One item exactly as it was read from the server. */
export interface ItemRef {
  kind: ItemKind
  /** hash field · set/zset member · stream entry id (list items have no name) */
  name?: string
  /** list position */
  index?: number
  /** hash value · list item · (set/zset: the member again) */
  value: string
  /** sorted-set score */
  score?: number
}

export interface ItemDraft {
  name: string
  value: string
  score: string
}

/** Stream entries are immutable in Redis: they can be removed, never changed. */
export const itemEditable = (kind: ItemKind) => kind !== 'stream'

export function draftOf(ref: ItemRef): ItemDraft {
  return {
    name: ref.kind === 'list' ? '' : (ref.name ?? ''),
    value: ref.kind === 'hash' || ref.kind === 'list' ? ref.value : '',
    score: ref.score == null ? '' : String(ref.score),
  }
}

/** Dialog title + the labels of its inputs, in plain words. */
export function itemEditText(ref: ItemRef): { title: string; nameLabel: string | null; valueLabel: string | null; scoreLabel: string | null } {
  switch (ref.kind) {
    case 'hash':
      return { title: 'Edit field', nameLabel: 'Field', valueLabel: 'Value', scoreLabel: null }
    case 'list':
      return { title: `Edit item ${ref.index ?? 0}`, nameLabel: null, valueLabel: 'Value', scoreLabel: null }
    case 'set':
      return { title: 'Edit member', nameLabel: 'Member', valueLabel: null, scoreLabel: null }
    case 'zset':
      return { title: 'Edit member', nameLabel: 'Member', valueLabel: null, scoreLabel: 'Score' }
    default:
      return { title: 'Entry', nameLabel: null, valueLabel: null, scoreLabel: null }
  }
}

export type EditPlan = { op: RedisEditOp } | { error: string }

/** The op that saves `draft` over `ref`, or why it can't be saved. */
export function planItemEdit(ref: ItemRef, draft: ItemDraft): EditPlan {
  switch (ref.kind) {
    case 'hash': {
      const to = draft.name
      if (!to) return { error: 'Type a field name.' }
      if (to === ref.name && draft.value === ref.value) return { error: 'Nothing changed.' }
      return { op: { op: 'hReplace', from: ref.name ?? '', to, value: draft.value } }
    }
    case 'list':
      if (draft.value === ref.value) return { error: 'Nothing changed.' }
      return { op: { op: 'lSetAt', index: ref.index ?? 0, expected: ref.value, value: draft.value } }
    case 'set':
      if (draft.name === ref.name) return { error: 'Nothing changed.' }
      return { op: { op: 'sReplace', from: ref.name ?? '', to: draft.name } }
    case 'zset': {
      const raw = draft.score.trim()
      const score = Number(raw)
      if (!raw || !Number.isFinite(score)) return { error: 'The score must be a number, e.g. 42 or 3.5.' }
      if (draft.name === ref.name && score === ref.score) return { error: 'Nothing changed.' }
      return { op: { op: 'zReplace', from: ref.name ?? '', to: draft.name, score } }
    }
    default:
      return { error: 'Stream entries cannot be changed — add a new entry instead.' }
  }
}

/** The op that removes exactly this one item. */
export function itemDeleteOp(ref: ItemRef): RedisEditOp {
  switch (ref.kind) {
    case 'hash':
      return { op: 'hDel', field: ref.name ?? '' }
    case 'list':
      // by position — LREM by value would also drop every duplicate of it
      return { op: 'lDelAt', index: ref.index ?? 0, expected: ref.value }
    case 'set':
      return { op: 'sRem', member: ref.name ?? '' }
    case 'zset':
      return { op: 'zRem', member: ref.name ?? '' }
    default:
      return { op: 'xDel', id: ref.name ?? '' }
  }
}
