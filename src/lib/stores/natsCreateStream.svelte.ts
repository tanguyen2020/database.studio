// NATS "Add stream" dialog state. Opened from the NATS branch of the
// ObjectExplorer (＋ Add stream button). Creates a new JetStream stream with a
// name + one or more subjects.
class NatsCreateStreamStore {
  open = $state(false)
  connId = $state('')

  show(connId: string) {
    this.connId = connId
    this.open = true
  }

  close() {
    this.open = false
  }
}

export const natsCreateStream = new NatsCreateStreamStore()
