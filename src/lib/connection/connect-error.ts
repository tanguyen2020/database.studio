// Turning a failed "connect" into words a person can act on.
//
// Redis · Kafka · NATS · RabbitMQ open straight into their workspace tab (no
// object tree), so that tab is where a failed connect has to be explained — the
// raw driver text ("driver error: … (os error 10061)") says what broke but not
// what to check. The raw text is always kept for "Show details"; this only adds
// a title, one sentence and a short checklist.

export type ConnectFailureKind =
  | 'refused'
  | 'timeout'
  | 'dns'
  | 'auth'
  | 'tls'
  | 'ssh'
  | 'lost'
  | 'vhost'
  | 'brokers'
  | 'other'

export interface ConnectFailure {
  kind: ConnectFailureKind
  title: string
  detail: string
  tips: string[]
  /** the server/driver text without transport prefixes */
  message: string
}

export interface ConnectTarget {
  system: string
  host?: string | null
  port?: number | null
  ssh?: { enabled?: boolean; host?: string | null; port?: number | null } | null
}

const PREFIXES = /^(?:error:\s*|driver error:\s*|connection error:\s*|ssh tunnel error:\s*|ssh error:\s*|io error:\s*)+/i

/** Drop the transport prefixes our error types add, keep the server's own words. */
export function cleanConnectMessage(raw: unknown): string {
  return String(raw ?? '').trim().replace(PREFIXES, '').trim()
}

const has = (l: string, ...needles: string[]) => needles.some((n) => l.includes(n))

function classify(system: string, l: string): ConnectFailureKind {
  if (has(l, 'connection lost', 'connection_lost', 'connection was closed', 'connection reset by peer', 'forcibly closed'))
    return 'lost'
  if (has(l, 'ssh', 'tunnel', 'russh')) return 'ssh'
  if (system === 'rabbitmq' && has(l, 'virtual host')) return 'vhost'
  if (has(l, 'wrongpass', 'noauth', 'authorization violation', 'authentication', 'auth failed', 'invalid password',
    'invalid username', 'access denied', 'access refused', 'not authorized', 'unauthorized', 'sasl', 'permission denied'))
    return 'auth'
  if (has(l, 'certificate', 'tls', 'ssl', 'handshake', 'x509', 'unknownissuer')) return 'tls'
  if (has(l, 'failed to lookup', 'no such host', 'name or service not known', 'nodename nor servname', 'name resolution',
    'os error 11001', 'dns'))
    return 'dns'
  if (has(l, 'refused', 'os error 10061', 'os error 111', 'econnrefused')) return 'refused'
  if (system === 'kafka' && has(l, 'all brokers down', 'brokertransportfailure', 'meta data fetch', 'metadata', 'broker'))
    return 'brokers'
  if (has(l, 'timed out', 'timeout', 'os error 10060', 'os error 110', 'deadline')) return 'timeout'
  return 'other'
}

function where(t: ConnectTarget): string {
  if (t.host && t.port) return `${t.host}:${t.port}`
  return t.host || 'the server'
}

/** Engine-specific port hint: the most common wrong-port mistakes. */
function portHint(system: string): string | null {
  switch (system) {
    case 'rabbitmq':
      return 'RabbitMQ is reached through its management API — usually port 15672 (15671 with TLS), not the AMQP port 5672.'
    case 'redis':
      return 'Redis normally listens on port 6379.'
    case 'nats':
      return 'NATS normally listens on port 4222 (8222 is the monitoring port, not the client port).'
    case 'kafka':
      return 'Kafka normally listens on port 9092. Use the address the brokers advertise to clients.'
    default:
      return null
  }
}

/** Title + one sentence + what to check, for a failed connect of `target`. */
export function explainConnectError(target: ConnectTarget, raw: unknown): ConnectFailure {
  const message = cleanConnectMessage(raw)
  const system = target.system
  // classify on the raw text: the prefix ("ssh error:") is itself a signal
  const kind = classify(system, String(raw ?? '').toLowerCase())
  const at = where(target)
  const viaSsh = !!target.ssh?.enabled
  const tips: string[] = []
  let title: string
  let detail: string

  switch (kind) {
    case 'refused':
      title = 'Nothing answered at this address'
      detail = viaSsh
        ? `The SSH tunnel opened, but nothing is listening at ${at} as seen from the SSH server.`
        : `The server at ${at} refused the connection — the service is stopped or listening on another port.`
      tips.push('Check that the server is running.')
      { const p = portHint(system); if (p) tips.push(p) }
      if (viaSsh) tips.push('With SSH, the host is resolved on the SSH server — use the address the database has there (often localhost).')
      break
    case 'timeout':
      title = 'The server did not answer'
      detail = `No reply from ${at} in time. A firewall may be dropping the connection, or the address is not reachable from this computer.`
      tips.push('Check the host name and port.', 'Check that a firewall or VPN allows the connection.')
      if (!viaSsh) tips.push('If the server is only reachable inside a private network, connect through SSH.')
      break
    case 'dns':
      title = 'Host not found'
      detail = `The name "${target.host ?? ''}" could not be resolved to an address.`
      tips.push('Check the spelling of the host name.', 'Check that this computer can reach the network the server is on (VPN).')
      break
    case 'auth':
      title = 'Sign-in was rejected'
      detail = 'The server is reachable, but it did not accept the user name or password.'
      tips.push('Check the user name and password in the connection settings.')
      if (system === 'redis') tips.push('Redis 6+ uses ACL users — leave the user empty to sign in as "default".')
      if (system === 'nats') tips.push('NATS may expect a token, a user/password or credentials — check what the server is configured for.')
      if (system === 'kafka') tips.push('Check the SASL mechanism (PLAIN / SCRAM) matches the broker.')
      if (system === 'rabbitmq') tips.push('The user needs the "management" tag to use the management API.')
      break
    case 'tls':
      title = 'Secure connection (TLS) failed'
      detail = 'The server and this app could not agree on a secure connection.'
      tips.push('Turn SSL/TLS on or off to match the server.', 'If the server uses a private certificate authority, choose its CA file.')
      break
    case 'ssh':
      title = 'Could not open the SSH tunnel'
      detail = `The connection goes through SSH${target.ssh?.host ? ` (${target.ssh.host})` : ''}, and that step failed.`
      tips.push('Check the SSH host, port, user and password or private key.', 'Check that this computer can reach the SSH server.')
      break
    case 'lost':
      title = 'Connection lost'
      detail = 'The connection was open, then the server or the network closed it.'
      tips.push('Retry to open it again.', 'If it keeps happening, the server may be restarting or closing idle connections.')
      break
    case 'vhost':
      title = 'Virtual host not found'
      detail = 'The server answered, but the virtual host in the connection settings does not exist.'
      tips.push('Leave Virtual host empty to use the first one you can access, or pick one that exists.')
      break
    case 'brokers':
      title = 'Could not reach the Kafka brokers'
      detail = `The first contact with ${at} did not lead to a working broker connection.`
      tips.push(
        'Check the bootstrap address and port.',
        'Brokers hand out the address in advertised.listeners — it must be reachable from this computer (or use SSH).',
      )
      break
    default:
      title = 'Could not connect'
      detail = `Connecting to ${at} failed.`
      { const p = portHint(system); if (p) tips.push(p) }
      tips.push('See the details below for the server message.')
  }
  return { kind, title, detail, tips, message }
}
