/**
 * NATS subject matching: tokens are separated by ".", "*" matches exactly one token,
 * ">" matches one or more tokens and may only be the last token.
 * `subjectMatches('orders.>', 'orders.eu.paid')` → true.
 */
export function subjectMatches(filter: string, subject: string): boolean {
  const f = filter.split('.')
  const s = subject.split('.')
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '>') return i === f.length - 1 && s.length > i
    if (i >= s.length) return false
    if (f[i] === '*') continue
    if (f[i] !== s[i]) return false
  }
  return f.length === s.length
}

/** Why a subject typed to listen on is not valid, in words — or null when it is fine. */
export function subjectProblem(subject: string): string | null {
  const s = subject.trim()
  if (!s) return 'Type a subject to listen on, e.g. orders.> or orders.*.paid'
  if (/\s/.test(s)) return 'A subject cannot contain spaces'
  const tokens = s.split('.')
  if (tokens.some((t) => t === '')) return 'A subject cannot start or end with "." or contain ".."'
  const gt = tokens.indexOf('>')
  if (gt !== -1 && gt !== tokens.length - 1) return '">" can only be the last part of a subject'
  if (tokens.some((t) => t !== '*' && t !== '>' && /[*>]/.test(t))) return '"*" and ">" must stand alone between dots'
  return null
}

/** A subject to publish to must be concrete: no wildcards. */
export function publishProblem(subject: string): string | null {
  const s = subject.trim()
  if (!s) return 'Type the subject to send to'
  const p = subjectProblem(s)
  if (p) return p
  if (/[*>]/.test(s)) return 'Send to a concrete subject — wildcards (* and >) are only for listening'
  return null
}
