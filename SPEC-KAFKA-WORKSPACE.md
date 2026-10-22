# SPEC — Kafka workspace

> Viết 2026-10-21. Trạng thái: **Đã code W1 (chưa commit).** Đợt **W1** (sau `SPEC-STREAM-SHELL.md`).
> **Cập nhật 2026-10-22** — đã code, chưa commit. Các quyết định sau ngày viết spec được ghi ở bảng §0 (cột "Ai chốt") và mục Lối vào (§3–§4); phần nào mâu thuẫn với chúng thì phần mới thắng.
> Bản phác thảo: màn hình 3 (Overview), 4 (Topic › Messages), 5 (Consumer groups) —
> https://claude.ai/artifact/KYsTkPaP7QczcFiZowTJgt
> Nguyên tắc chung (additive, không bịa số liệu, định nghĩa xong): `SPEC-STREAM-SHELL.md` §1.
> Mọi `file:line` đọc ở commit `f702b6a`.

---

## 0. Quyết định đã chốt

| # | Quyết định | Ai chốt |
|---|---|---|
| K1 | **Hoãn giải mã Avro** (đọc message theo Schema Registry) — ô "Value as" chỉ có JSON/String/Hex | Người dùng |
| K2 | Bỏ khỏi thiết kế vì rdkafka không cung cấp: dung lượng đĩa từng broker, phiên bản Kafka/KRaft, coordinator của group | Người dùng duyệt bản phác thảo đã sửa |
| K3 | Nút "Re-send" đổi thành "Copy to Produce" — **đã làm**: icon trên mỗi dòng message + nút trong popup xem message; mở tab Produce đã điền key + value, partition để tự động; ghi rõ header không gửi được và giá trị nhị phân sẽ gửi dạng text | như trên |
| K4 | Bảng Topics **bỏ cột Copies / Up to date**; topic thiếu bản sao có dấu ⚠ cạnh tên (tooltip "N of M partitions missing copies") | Người dùng (2026-10-22) |
| K5 | **Không còn tab theo topic:** chi tiết topic có 5 tab con Messages · Partitions · Consumers · Settings · Produce | Người dùng |

---

## 1. Mục và nguồn dữ liệu

| Mục | Nội dung | Nguồn |
|---|---|---|
| Overview | Thẻ: brokers online, topics, partitions, **under-replicated** (partition có `isr.len < replicas.len`), offline (leader < 0), tổng lag; bảng Brokers (ID, host, controller, leader for, replicas, not in sync); nhóm theo lag; topic lớn nhất | `kafka_cluster`, `kafka_topics`, `kafka_consumer_groups`, `kafka_group_lag` (có sẵn) |
| Brokers | Bảng như trên, đầy đủ | có sẵn |
| Topics | `StreamTable` (tên, partitions, RF, in sync, messages, retention, cleanup) → chi tiết: **Messages · Partitions · Consumers · Configuration · Produce** | `kafka_topics`; Messages = nhúng `KafkaConsumer`; Produce = `KafkaProducer`; Configuration = **mới** |
| Consumer groups | Bảng (group, state, members, topics, lag) → chi tiết lag theo partition + Reset offsets + **Delete group** | `kafka_consumer_groups`, `kafka_group_lag`, `kafka_reset_offset`; delete = **mới** |
| Schema Registry | Nhúng `SchemaRegistryWorkspace` | có sẵn |

Dữ liệu sẵn có trong code: `KafkaCluster` (brokers, `controller_id`), `KafkaPartition` (`leader`, `replicas`,
`isr`, `low`, `high`), `KafkaGroup` (`state`, `protocol`, `members`, `topics`) — `drivers/kafka.rs:928-1020`.

## 2. Backend mới (`drivers/kafka.rs`, `commands/kafka.rs`)

| Lệnh | API rdkafka | Ghi chú |
|---|---|---|
| `kafka_topic_configs(topic)` | `AdminClient::describe_configs(ResourceSpecifier::Topic)` | Trả `name, value, source, is_default, is_read_only, is_sensitive` |
| `kafka_alter_topic_configs(topic, entries)` | `alter_configs` | Chỉ gửi key người dùng đổi; lỗi broker trả nguyên văn |
| `kafka_delete_group(group)` | `delete_groups` | Broker từ chối khi group còn thành viên → báo rõ |
| `kafka_fetch_page(…, from_time?)` | `offsets_for_times` | Field **optional** thêm vào lệnh có sẵn (`kafka.rs:443`) → caller cũ không đổi |

**Kiểm trước khi code:** xác nhận rdkafka 0.38 có đủ `describe_configs` / `alter_configs` / `delete_groups`.

Mỗi lệnh: case trong `demo.ts`, wrapper `ipc.ts`, đăng ký `lib.rs`.

## 3. Lối vào

- Không có cây Explorer (`SPEC-STREAM-SHELL.md` D4): chọn connection Kafka = mở workspace ở mục Topics, tự chọn
  topic đầu A→Z và mở tab con Messages.
- `openKafkaTool` mở `openStreamWorkspace(conn, 'topics', topic)` + tab con; **tab `kafka`, `kafka-consumer`,
  `kafka-producer`, `kafka-schema-registry` đã xoá** (tab cũ đã lưu khôi phục thành mục tương ứng).

## 3a. Còn chưa làm

- Cột "Keep messages for" / "Cleanup" trong bảng Topics (hiện xem trong tab Settings của topic).
- **Đã làm (2026-10-22):** K3 Copy to Produce; Decode **Hex** (lưới hiện các byte đầu, popup có view Hex dạng dump
  offset · 16 byte · ASCII). Backend gửi kèm `value_b64` (byte gốc) **chỉ khi** value không phải UTF-8 hợp lệ, nên
  Hex luôn đúng byte thật; message nhị phân luôn hiện dạng hex (không hiện chữ vỡ).

## 3b. Từ ngữ hiển thị (theo `SPEC-STREAM-SHELL.md` §1b)

| Khái niệm Kafka | Hiển thị | Tooltip / ghi chú |
|---|---|---|
| Under-replicated partitions | **Missing copies** | Partitions with fewer up-to-date copies than configured |
| Offline partitions | **Unavailable partitions** | No broker is serving them; reads and writes fail |
| Replication factor (RF) | **Copies** | How many brokers keep this topic |
| ISR | **Up-to-date copies** "10 of 12 partitions" | Advanced: in-sync replicas |
| Lag | **Behind** "8,120 messages" | Messages the group has not read yet |
| Offset | **Position** (cột phụ, mono) | — |
| Partition | Partition (giữ) | A slice of the topic; order is kept within a partition |
| Group state Stable / Empty / PreparingRebalance | **Running / Stopped / Rebalancing** | — |
| `retention.ms`, `retention.bytes` | **Keep messages for** 7 days · **Size limit** 5 GB | Config key thật hiện nhỏ phía dưới, trong *Advanced* |
| `cleanup.policy` delete / compact | **Delete old messages** / **Keep latest value per key** | — |
| Leader for N | **Leads N partitions** | — |

Configuration của topic hiện dạng **form theo nhóm** (Retention · Cleanup · Size limits · Advanced), không
phải bảng key/value thô; danh sách đầy đủ key nằm trong *Advanced*. Reset offsets là wizard 3 bước (Chọn
topic → Chọn vị trí: earliest / latest / mốc thời gian / dịch N → **Xem trước Before → After** từng partition).

## 4. Test

- **Integration** (container Kafka sẵn có): đọc config mặc định → đổi `retention.ms` → đọc lại đúng; xoá group
  rỗng OK, group còn thành viên bị từ chối; `from_time` trả message có timestamp ≥ mốc.
- **E2e:** Overview đếm under-replicated từ demo; mở topic → Configuration sửa được; Groups → Delete có confirm.
- Spec cũ phải chuyển: `kafka-workspace`, `kafka-partitions`, `message-consumers`, `message-actions`,
  `payload-viewer`, `streaming-explorer` (phần Kafka).

## 5. Ngoài phạm vi

Avro (K1), Kafka ACL (cần broker có authorizer), các số liệu ở K2.

## 6. Ước tính

7–8 ngày làm việc.
