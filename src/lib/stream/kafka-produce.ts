// "Copy to Produce": a message read on the Messages screen becomes a filled-in
// Produce form. Only what Produce can send is copied (key + value); what it cannot
// (headers, exact binary bytes) is counted so the form can say so instead of
// silently sending something different.
import type { KafkaMsg } from '$lib/ipc'

export interface ProduceDraft {
  key: string
  value: string
  /** where the copied message came from — shown, not reused (the partition stays auto) */
  from: { partition: number; offset: number }
  /** headers on the original message (Produce does not send headers) */
  headers: number
  /** the value is not valid UTF-8: sending it as text changes its bytes */
  binary: boolean
}

export function produceDraftFrom(m: KafkaMsg): ProduceDraft {
  return {
    key: m.key,
    value: m.value,
    from: { partition: m.partition, offset: m.offset },
    headers: m.headers.length,
    binary: !!m.value_b64,
  }
}
