// Opening the RabbitMQ cluster workspace (SPEC-RABBITMQ-WORKSPACE.md §3): every
// former "queue tab" / "exchange tab" entry now lands in the one workspace tab of
// the connection, on the right section, focused on the item, in the right vhost.

import { tabs } from '$lib/stores/tabs.svelte'
import { DEFAULT_EXCHANGE_LABEL, exchangeLabel } from '$lib/rabbitmq/format'
import type { TabState } from '$lib/types'

export type RabbitSection = 'overview' | 'queues' | 'exchanges' | 'connections' | 'nodes' | 'access'

export interface RabbitWorkspaceState {
  section?: string
  focus?: string
  /** vhost the Queues / Exchanges sections list */
  vhost?: string
  /** sub-tab of the queue / exchange details */
  sub?: string
  /** one-shot request from the sidebar: open the create form */
  create?: 'queue' | 'exchange'
  /** set on a freshly opened tab: pick the first queue once the list has loaded */
  autoPick?: boolean
}

export function openRabbitWorkspace(connId: string, section: RabbitSection, focus?: string, vhost?: string, extra: Partial<RabbitWorkspaceState> = {}): TabState {
  const t = tabs.openStreamWorkspace(connId, section, focus)
  const patch: Record<string, unknown> = { ...extra }
  if (vhost) patch.vhost = vhost
  if (Object.keys(patch).length) tabs.patchState(t.id, patch)
  return t
}

export const openRabbitQueue = (connId: string, vhost: string, queue: string, sub?: string) =>
  openRabbitWorkspace(connId, 'queues', queue, vhost, sub ? { sub } : {})

/** The default exchange is named '' — an empty focus would read as "nothing
 *  selected", so it is focused by its display label instead. */
export const exchangeFocusKey = (name: string) => exchangeLabel(name)
export const exchangeFromFocus = (focus: string) => (focus === DEFAULT_EXCHANGE_LABEL ? '' : focus)

export const openRabbitExchange = (connId: string, vhost: string, exchange: string) =>
  openRabbitWorkspace(connId, 'exchanges', exchangeFocusKey(exchange), vhost)
