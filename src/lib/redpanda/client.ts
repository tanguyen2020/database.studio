// Sending the `rp.*` calls (admin.ts) through the backend's generic Admin API command.
import * as ipc from '$lib/ipc'
import { rpErrorText, type RpCall } from './admin'

export class RpError extends Error {
  constructor(
    message: string,
    readonly response: ipc.RpResponse,
  ) {
    super(message)
  }
}

/** The raw answer — for screens that read a non-2xx answer themselves. */
export function rpSend(connId: string, c: RpCall): Promise<ipc.RpResponse> {
  return ipc.redpandaAdminRequest(connId, c.method, c.path, c.body ?? null)
}

/** The JSON body of a successful answer; a failed one throws Redpanda's message. */
export async function rpCall<T = unknown>(connId: string, c: RpCall): Promise<T> {
  const r = await rpSend(connId, c)
  if (!r.ok) throw new RpError(rpErrorText(r), r)
  return (r.json ?? null) as T
}

/** Readable text for anything thrown by rpCall / the IPC layer. */
export function rpMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}
