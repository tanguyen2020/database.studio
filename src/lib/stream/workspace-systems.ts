/**
 * Engines whose connection opens straight into its workspace tab.
 *
 * Redis, Kafka, NATS and RabbitMQ have a full cluster workspace (Overview, the
 * object lists and their details, every action), so they show no object tree:
 * picking the connection opens the tab, in the one sidebar and in the two-panel
 * layout alike — where the Explorer panel is hidden while one of them is selected.
 */
export const WORKSPACE_SYSTEMS = ['redis', 'kafka', 'nats', 'rabbitmq'] as const

export type WorkspaceSystem = (typeof WORKSPACE_SYSTEMS)[number]

/**
 * The section a workspace opens on: the one where you read messages / keys, not the
 * Overview — a new tab lands on the list and picks its first item (see `autoPick`).
 */
export function messagesSection(system: string | null | undefined): string {
  switch (system) {
    case 'kafka':
      return 'topics'
    case 'nats':
      return 'streams'
    case 'rabbitmq':
      return 'queues'
    case 'redis':
      return 'browser'
    default:
      return 'overview'
  }
}

/** First name in the list's default (A→Z) order, or null when the list is empty. */
export function firstByName(names: string[]): string | null {
  return names.length ? [...names].sort((a, b) => a.localeCompare(b))[0] : null
}

export function opensWorkspace(system: string | null | undefined): system is WorkspaceSystem {
  return !!system && (WORKSPACE_SYSTEMS as readonly string[]).includes(system)
}
