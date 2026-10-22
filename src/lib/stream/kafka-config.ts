// Topic settings in plain language (SPEC-KAFKA-WORKSPACE.md §3b): the Configuration
// page is a short form grouped by purpose, not a key/value dump. Every key keeps its
// real name in small print and the full list stays behind "Advanced".

import type { KafkaConfigEntry } from '$lib/ipc'
import { formatBytes, humanDuration } from './humanize'

export type FieldKind = 'duration' | 'bytes' | 'choice' | 'count'

export interface ConfigField {
  key: string
  label: string
  help: string
  kind: FieldKind
  options?: { value: string; label: string }[]
  /** `-1` means "no limit" / "forever" for this key */
  unlimited?: boolean
}

export interface ConfigGroup {
  id: string
  title: string
  description: string
  fields: ConfigField[]
}

export const TOPIC_CONFIG_GROUPS: ConfigGroup[] = [
  {
    id: 'retention',
    title: 'Retention',
    description: 'How long and how much Kafka keeps before old messages are removed.',
    fields: [
      { key: 'retention.ms', label: 'Keep messages for', kind: 'duration', unlimited: true, help: 'Messages older than this are removed (when old messages are deleted).' },
      { key: 'retention.bytes', label: 'Size limit per partition', kind: 'bytes', unlimited: true, help: 'When a partition grows past this size, its oldest messages are removed.' },
    ],
  },
  {
    id: 'cleanup',
    title: 'Cleanup',
    description: 'What happens to messages that are no longer kept.',
    fields: [
      {
        key: 'cleanup.policy',
        label: 'Old messages',
        kind: 'choice',
        help: 'Delete: remove messages past retention. Keep latest per key: keep only the newest message of each key.',
        options: [
          { value: 'delete', label: 'Delete old messages' },
          { value: 'compact', label: 'Keep latest value per key' },
          { value: 'compact,delete', label: 'Keep latest per key, then delete old' },
        ],
      },
    ],
  },
  {
    id: 'limits',
    title: 'Limits & safety',
    description: 'The largest message accepted and how many copies must confirm a write.',
    fields: [
      { key: 'max.message.bytes', label: 'Largest message accepted', kind: 'bytes', help: 'Producers sending a bigger message get an error.' },
      { key: 'min.insync.replicas', label: 'Copies that must confirm a write', kind: 'count', help: 'With acks=all, a write succeeds only when at least this many up-to-date copies have it.' },
    ],
  },
]

export const KNOWN_CONFIG_KEYS = new Set(TOPIC_CONFIG_GROUPS.flatMap((g) => g.fields.map((f) => f.key)))

/** A setting's value as a person reads it: "7 days", "5 GB", "No limit", "Keep latest value per key". */
export function readableValue(field: ConfigField, value: string | null | undefined): string {
  if (value == null || value === '') return '—'
  if (field.kind === 'choice') return field.options?.find((o) => o.value === value)?.label ?? value
  const n = Number(value)
  if (!Number.isFinite(n)) return value
  if (field.unlimited && n < 0) return field.kind === 'duration' ? 'Forever' : 'No limit'
  if (field.kind === 'duration') return humanDuration(n)
  if (field.kind === 'bytes') return formatBytes(n)
  return n.toLocaleString('en-US')
}

export function sourceLabel(source: KafkaConfigEntry['source']): string {
  return source === 'topic' ? 'Set on this topic' : source === 'broker' ? 'From the broker' : 'Default'
}

export const DURATION_UNITS = [
  { value: 'minutes', label: 'minutes', ms: 60_000 },
  { value: 'hours', label: 'hours', ms: 3_600_000 },
  { value: 'days', label: 'days', ms: 86_400_000 },
] as const
export const BYTE_UNITS = [
  { value: 'KB', label: 'KB', bytes: 1024 },
  { value: 'MB', label: 'MB', bytes: 1024 ** 2 },
  { value: 'GB', label: 'GB', bytes: 1024 ** 3 },
] as const

export interface FieldDraft {
  unlimited: boolean
  amount: string | number | null
  unit: string
}

/** Split a stored value into what the form edits ("7" + "days"). */
export function toDraft(field: ConfigField, value: string | null | undefined): FieldDraft {
  const n = Number(value)
  if (field.kind === 'choice') return { unlimited: false, amount: value ?? '', unit: '' }
  if (value == null || !Number.isFinite(n)) return { unlimited: false, amount: value ?? '', unit: field.kind === 'duration' ? 'days' : field.kind === 'bytes' ? 'MB' : '' }
  if (field.unlimited && n < 0) return { unlimited: true, amount: '', unit: field.kind === 'duration' ? 'days' : 'GB' }
  if (field.kind === 'duration') {
    const u = [...DURATION_UNITS].reverse().find((u) => n % u.ms === 0) ?? DURATION_UNITS[0]
    return { unlimited: false, amount: String(n / u.ms), unit: u.value }
  }
  if (field.kind === 'bytes') {
    const u = [...BYTE_UNITS].reverse().find((u) => n >= u.bytes && n % u.bytes === 0) ?? { value: 'B', bytes: 1 }
    return { unlimited: false, amount: String(n / u.bytes), unit: u.value }
  }
  return { unlimited: false, amount: String(n), unit: '' }
}

/** The value to send for a draft, or an error a person can act on. */
export function fromDraft(field: ConfigField, d: FieldDraft): { value: string } | { error: string } {
  if (field.kind === 'choice') {
    return field.options?.some((o) => o.value === d.amount) ? { value: String(d.amount) } : { error: `Pick one of the options for “${field.label}”.` }
  }
  if (field.unlimited && d.unlimited) return { value: '-1' }
  // a number input bound with bind:value hands back a number (or null when empty)
  const raw = String(d.amount ?? '').trim()
  const amount = Number(raw)
  if (raw === '' || !Number.isFinite(amount) || amount <= 0) return { error: `“${field.label}” needs a number greater than 0.` }
  if (field.kind === 'duration') {
    const u = DURATION_UNITS.find((x) => x.value === d.unit) ?? DURATION_UNITS[2]
    return { value: String(Math.round(amount * u.ms)) }
  }
  if (field.kind === 'bytes') {
    const u = BYTE_UNITS.find((x) => x.value === d.unit) ?? { bytes: 1 }
    return { value: String(Math.round(amount * u.bytes)) }
  }
  if (!Number.isInteger(amount)) return { error: `“${field.label}” needs a whole number.` }
  return { value: String(amount) }
}
