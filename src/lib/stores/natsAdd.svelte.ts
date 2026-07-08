// NATS "Add subject / Add message" dialog state. Reused by the ObjectExplorer
// (stream context menu → Add subject…) and the subject-messages grid (＋ Add).
// `newSubject` = adding a brand-new subject to the stream (subject field editable
// and empty) vs. adding another message to an existing subject (subject prefilled).
class NatsAddStore {
  open = $state(false)
  connId = $state('')
  stream = $state('')
  subject = $state('')
  newSubject = $state(false)

  show(connId: string, stream: string, subject: string, newSubject: boolean) {
    this.connId = connId
    this.stream = stream
    this.subject = subject
    this.newSubject = newSubject
    this.open = true
  }

  close() {
    this.open = false
  }
}

export const natsAddWizard = new NatsAddStore()
