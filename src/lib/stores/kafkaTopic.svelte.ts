// Kafka "Add topic" dialog state. Opened from the Kafka branch of the
// ObjectExplorer (＋ Add topic button, below the topic filter). Creates a new
// topic with a name + partition count + replication factor.
class KafkaTopicStore {
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

export const kafkaTopicWizard = new KafkaTopicStore()
