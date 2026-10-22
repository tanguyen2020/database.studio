// "Open message #N" on a JetStream stream: check the number before asking the
// server, and turn the server's terse refusal into a sentence.

export interface SeqRange {
  first?: number
  last?: number
}

const rangeText = (r: SeqRange) =>
  r.first && r.last && r.last >= r.first ? `${r.first.toLocaleString('en-US')}–${r.last.toLocaleString('en-US')}` : ''

/** The sequence typed by the user, or why it cannot be one. */
export function parseSeq(input: string, r: SeqRange = {}): { seq: number } | { error: string } {
  const t = input.trim().replace(/^#/, '').replace(/[,\s]/g, '')
  if (!t) return { error: 'Type a sequence number.' }
  if (!/^\d+$/.test(t)) return { error: 'A sequence is a whole number, like 1042.' }
  const seq = Number(t)
  if (!Number.isSafeInteger(seq) || seq < 1) return { error: 'Sequences start at 1.' }
  if (r.last !== undefined && r.last > 0 && seq > r.last) {
    return { error: `The newest message is #${r.last.toLocaleString('en-US')}.` }
  }
  return { seq }
}

/** What to tell the user when the server could not return message #seq. */
export function peekErrorText(err: unknown, stream: string, seq: number, r: SeqRange = {}): string {
  const raw = String(err)
  if (/no message found|not found|10037/i.test(raw)) {
    const range = rangeText(r)
    return `There is no message #${seq.toLocaleString('en-US')} in ${stream}. It was deleted or expired by the stream's limits${range ? `; the stream holds ${range}` : ''}.`
  }
  return `Could not read message #${seq.toLocaleString('en-US')}: ${raw.replace(/^Error:\s*/, '')}`
}

/** "1–1,000" for the hint under the box ('' when the stream is empty or unknown). */
export const seqRangeHint = (r: SeqRange) => {
  const range = rangeText(r)
  return range ? `This stream holds ${range}` : ''
}
