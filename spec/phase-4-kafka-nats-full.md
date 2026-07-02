# Phase 4 — Kafka + NATS JetStream đầy đủ

**Mục tiêu:** Hỗ trợ Apache Kafka đầy đủ — topic browser, consume/produce messages, consumer groups. NATS JetStream hoàn chỉnh với KV Store và Object Store.
**Thời gian ước tính:** ~~3–4 tuần~~ → **2–3 tuần** (vibe coding — rdkafka phức tạp hơn các driver khác)
**Yêu cầu:** Phase 3 hoàn thành

---

## Checklist

### 1. Connection Manager — Kafka
- [ ] Form kết nối Kafka: bootstrap servers (comma-separated `host:port,host:port`)
- [ ] Auth: None, SASL/PLAIN, SASL/SCRAM-SHA-256, SASL/SCRAM-SHA-512
- [ ] SSL/TLS: CA cert, client cert/key
- [ ] Schema Registry URL (optional): endpoint + auth (Basic / Bearer)
- [ ] SSH tunnel
- [ ] Test connection (kết nối tới broker, lấy metadata)
- [ ] Badge `[KF]` màu `#8B5CF6`

### 2. Kafka Cluster Overview
- [ ] Tab `kafka-cluster`: hiển thị
  - Broker list: broker ID, host:port, rack, controller flag
  - Cluster ID, controller broker ID
  - Kafka version
  - Tổng số topics, partitions
- [ ] Refresh cluster info

### 3. Kafka Topic Browser
- [ ] List topics: tên, partition count, replication factor, internal flag
- [ ] Search / filter topics theo tên
- [ ] Expand topic → partition list:
  - Partition ID, leader broker, replicas, ISR
  - Earliest offset, latest offset, lag (latest - earliest)
- [ ] Create topic (tên, partitions, replication factor)
- [ ] Delete topic với xác nhận
- [ ] Right-click topic → Open Consumer / Open Producer / View Config / Delete

### 4. Kafka Message Consumer
Tab `kafka-consumer` mở khi chọn topic + "Open Consumer":
- [ ] Start position selector: Earliest / Latest / Specific offset / Timestamp
- [ ] Partition selector: All / chọn partition cụ thể
- [ ] Consume button → stream messages real-time
- [ ] Message list (virtualized):
  - Partition · Offset · Timestamp · Key · Value · Headers
- [ ] Decode value: Raw bytes / UTF-8 / JSON (auto-pretty) / Avro (nếu có Schema Registry)
- [ ] Decode key: Raw / UTF-8
- [ ] Filter messages: by key pattern (regex) / by value content (text search)
- [ ] Pause / Resume / Stop consuming
- [ ] Clear message list
- [ ] Max messages buffer (configurable, default 500 — tránh OOM)
- [ ] Copy message (JSON format)
- [ ] Export messages to JSON / CSV

### 5. Kafka Producer
Tab `kafka-producer`:
- [ ] Chọn topic từ dropdown
- [ ] Input Key (optional, UTF-8)
- [ ] Input Value: plain text editor với toggle JSON / raw
- [ ] Headers: key-value table, add/remove rows
- [ ] Partition: Auto / chọn cụ thể
- [ ] Produce button → gửi message
- [ ] Response: partition + offset message đã land
- [ ] Lưu lịch sử messages đã gửi (reuse lại)

### 6. Kafka Consumer Groups
- [ ] Tab `kafka-consumer-groups`: list tất cả consumer groups
- [ ] Columns: Group ID, State (Stable / Rebalancing / Dead / Empty), Members count, Protocol
- [ ] Expand group → member list: member ID, client ID, host, assignment (topics + partitions)
- [ ] Expand group → lag per partition:
  - Topic · Partition · Current offset · Latest offset · Lag
  - Highlight lag > threshold màu đỏ/vàng
- [ ] Reset offset: chọn group + topic + partition(s) → Earliest / Latest / Specific offset / Timestamp
- [ ] Reset offset hiện preview SQL-like diff trước khi confirm

### 7. Schema Registry
- [ ] List schemas (subjects)
- [ ] Xem schema definition: Avro JSON hoặc JSON Schema
- [ ] Version history cho mỗi subject
- [ ] Avro decode trong Consumer: tự động fetch schema từ Registry theo schema ID trong message

### 8. Kafka ACL (read-only)
- [ ] List ACLs: principal · resource type · resource name · operation · permission

### 9. NATS JetStream — đầy đủ

#### Streams
- [ ] List streams: tên, subjects, retention policy, storage type, state (messages/bytes/consumers)
- [ ] Create stream: form config (subjects, retention, storage, replicas, limits)
- [ ] Edit stream config
- [ ] Purge stream (xóa toàn bộ messages) với xác nhận
- [ ] Delete stream với xác nhận
- [ ] Stream detail: xem config + state realtime

#### Consumers
- [ ] List consumers của stream
- [ ] Columns: tên, type (push/pull), deliver policy, filter subject, ack policy, pending/ack counts
- [ ] Create consumer
- [ ] Delete consumer
- [ ] Peek next message của consumer

#### Messages
- [ ] Get message by sequence
- [ ] Get message by subject + sequence
- [ ] Delete specific message by sequence

#### Key-Value Store
- [ ] List buckets (KV streams)
- [ ] Create bucket: tên, TTL, replicas, max value size
- [ ] Delete bucket
- [ ] Browse keys trong bucket: tên, revision, delta, created, expires
- [ ] Get value của key: decode UTF-8 / JSON
- [ ] Put key-value
- [ ] Delete key
- [ ] Purge key (xóa history)
- [ ] Watch key: stream updates realtime

#### Object Store
- [ ] List buckets
- [ ] Create / delete bucket
- [ ] List objects trong bucket: tên, size, chunks, digest
- [ ] Upload file → object
- [ ] Download object → file
- [ ] Delete object
- [ ] Get object info

---

## Definition of Done
- Kết nối Kafka cluster, browse topics và partitions
- Consume messages từ đầu topic, xem decode JSON và Avro
- Produce message vào topic, nhận partition + offset confirm
- Xem consumer group lag, biết partition nào đang chậm
- NATS JetStream: tạo/xóa stream, get message by sequence
- NATS KV: get/put/watch keys
- NATS Object Store: upload/download file
