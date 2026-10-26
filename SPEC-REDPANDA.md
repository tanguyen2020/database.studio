# SPEC-REDPANDA — Hỗ trợ Redpanda (biến thể của engine Kafka)

> Trạng thái: **đã implement, chưa commit** (2026-10-26). Mọi khẳng định dưới đây đã được **đo trên container
> `redpandadata/redpanda:latest` (Redpanda v26.2.6, dev-container)** — không suy diễn. Khuôn:
> `SPEC-OPENSEARCH.md` (biến thể của engine có sẵn). Thước đo "không thiếu tính năng": Redpanda
> Console (Overview · Topics · Consumer groups · Schema Registry · Security · Cluster config ·
> Transforms · Brokers/maintenance).

## 0. Kết luận & phạm vi

**Redpanda KHÔNG là `SystemType` mới** — flavor `redpanda` của engine `kafka`: cùng giao thức Kafka,
cùng driver rdkafka, cùng workspace (topics, messages, produce, consumer groups, đổi vị trí đọc,
settings topic, Schema Registry). Thêm phần riêng của Redpanda qua **Admin API** (cổng 9644) và
**Kafka ACL** (giao thức Kafka — dùng được cho cả Kafka thường).

Ngoài phạm vi: Redpanda Connect (connectors), Tiered Storage / Cloud storage, debug bundle, self-test,
partition reassignment thủ công, client quotas, HTTP Proxy (pandaproxy), deploy data transform từ file
WASM (chỉ liệt kê / xoá / xem trạng thái).

## 1. Khác biệt đã đo (Redpanda v26.2.6)

| # | Tính năng | Đo được | Xử lý |
|---|---|---|---|
| R1 | Nhận diện | Kafka API không nói là Redpanda; Admin API `GET /v1/brokers` → `version: "v26.2.6 - <git sha>"` | flavor + phiên bản thật từ Admin API |
| R2 | Sức khoẻ cluster | `GET /v1/cluster/health_overview` → `is_healthy`, `unhealthy_reasons`, `nodes_down`, `leaderless_count`, `under_replicated_count`, `high_disk_usage_nodes` | thẻ Overview |
| R3 | Broker | `/v1/brokers`: `is_alive`, `membership_status`, `num_cores`, `disk_space[{free,total}]`, `maintenance_status.draining` | cột Brokers |
| R4 | Bảo trì broker | `PUT/DELETE /v1/brokers/{id}/maintenance`; 1 node → 400 "Maintenance mode may not be used on a single node cluster" | nút + lỗi nguyên văn |
| R5 | Cấu hình cluster | `GET /v1/cluster_config` (+`include_defaults`), `GET /v1/cluster_config/schema` (mô tả, kiểu, mặc định), `PUT /v1/cluster_config {upsert,remove}` → `{config_version}`; `?dry_run=true` sai kiểu → 400 `{"key":"expected type integer"}`; `GET /v1/cluster_config/status` (`restart`, `invalid`, `unknown`) | trang Configuration |
| R6 | Partition balancer | `GET /v1/cluster/partition_balancer/status` | Overview |
| R7 | License | `GET /v1/features/license` → `{loaded, license:{org,type,expires}}` | Overview |
| R8 | SASL users | `GET/POST /v1/security/users`, `PUT/DELETE /v1/security/users/{u}` `{username,password,algorithm:SCRAM-SHA-256|512}` | Security · Users |
| R9 | Roles (RBAC) | `POST /v1/security/roles {role}`, `GET`, `/members {add,remove}`, principal ACL `RedpandaRole:<name>` | Security · Roles |
| R10 | ACL | qua **giao thức Kafka** (rpk): principal `User:bob`, resource TOPIC/GROUP/CLUSTER/TRANSACTIONAL_ID, LITERAL/PREFIXED, operation, ALLOW/DENY | Security · ACLs (librdkafka) |
| R11 | Data transforms | `GET /v1/transform`; tắt mặc định → 400 "data transforms disabled - use `rpk cluster config set data_transforms_enabled true`" (cần restart) | trang Transforms |
| R12 | Schema Registry | dựng sẵn ở cổng 8081 (`GET /subjects` → `[]`) | URL mặc định khi để trống |

Đo thêm khi làm (v26.2.6, container thật):
- tạo **role rỗng** lần nữa → 201 (idempotent); role **đã có member** → 409 với `message` là JSON lồng (`{"message":"{\"message\":\"Role already exists\",…}"}`); thêm member vào role chưa có cũng tạo role;
- tạo **user trùng tên cùng mật khẩu** → 200 (idempotent); khác mật khẩu → **500** "Unexpected cluster error: User already exists";
- xoá role/transform không tồn tại vẫn 204/200; GET `/v1/transform` khi đã bật (sau restart) → `[]`;
- Apache Kafka 3.x **không có authorizer**: DescribeAcls trả **danh sách rỗng, không lỗi**; CreateAcls bị từ chối "No Authorizer is configured on the broker." → app nói rõ cần `authorizer.class.name`.

Thông báo lỗi được bóc ra cho dễ đọc (backend `describe_admin_error` + frontend `rpErrorText`, cùng luật). UI kiểm trùng tên user/role trước khi gửi nên không dựa vào lỗi server.

## 2. Thiết kế

- **Profile**: trường mới `admin_url` (tuỳ chọn; trống = `http(s)://<host đầu tiên>:9644`), flavor trong `cassandra_flavor`
  (trường "server flavor" chung): Kafka = `"" | "kafka" | "redpanda"`. Admin API dùng Basic auth bằng user/password SASL
  chỉ khi profile có cơ chế SASL. Schema Registry trống + flavor redpanda → `<host đầu tiên>:8081`.
- **Backend**: `drivers/redpanda.rs` (client Admin API, `request` generic — non-2xx trả nguyên, không ném lỗi; `server_info`
  nhận diện qua `GET /v1/brokers`), `drivers/kafka_acl.rs` (Describe/Create/Delete ACL qua librdkafka FFI, resource CLUSTER =
  `kafka-cluster`), commands `redpanda_admin_request`, `redpanda_server_info` (lưu flavor vào profile), `kafka_acls`,
  `kafka_create_acls`, `kafka_delete_acls`. Test connection ghi "Redpanda v26.2.6 · …" khi Admin API trả lời (3 s).
- **Frontend**: brand `redpanda` (logo chính thức từ `@redpanda-data/ui`), thẻ picker, form 2 thẻ Apache Kafka/Redpanda +
  ô Admin API URL. Module thuần `src/lib/redpanda/admin.ts` (mọi request builder `rp.*`, parser theo shape đã đo, cấu hình
  theo nhóm, ACL bằng lời) + `client.ts`. Workspace Kafka (`KafkaClusterView`) khi là Redpanda:
  - **Overview**: tình trạng do Redpanda tự đánh giá (lý do bằng lời, broker nào down) + thẻ Version (cảnh báo khi các
    broker khác phiên bản), Fullest disk, Partition balancer, License (còn bao nhiêu ngày).
  - **Brokers**: thêm Status (Running / In maintenance / Down…), Version, Disk used (thanh), nút **Maintenance…** có hộp
    xác nhận; lỗi Redpanda (1 broker mỗi lúc, cluster 1 node) hiện trong hộp. Broker down vẫn có dòng (không có trong
    metadata Kafka).
  - **Security** (cả Apache Kafka): Users (tạo + Generate password + SCRAM-SHA-256/512 + thêm vào role → mở ngay "Grant
    access"; đổi mật khẩu; xoá kèm ACL), Roles (thành viên, quyền của role bằng lời, xoá kèm ACL), ACLs (bảng Who /
    Allow-Deny / Action / On / Host, lọc, chọn nhiều để xoá). Apache Kafka chỉ có ACLs + ghi chú user do hệ thống Kafka quản lý.
  - **Grant access**: chọn User/Role/Everyone, Allow/Deny, "Common task" (Consume / Produce / Manage a topic) hoặc "Exact
    permissions" (loại resource + tên + Exact/Starts with + các quyền đúng với loại đó), giới hạn host; mọi binding sắp tạo
    hiện thành câu trước khi gửi. Đổi loại resource không tự tick quyền nào.
  - **Configuration**: toàn bộ thuộc tính từ schema của server, theo nhóm (Storage & retention, Topics, Kafka API, Replication,
    Security, Tiered storage, HTTP services, Transforms, Audit, Other), tìm kiếm, "Only changed", "Show advanced" (tunable);
    giá trị bằng lời (7 days, 5 GB, On, Not set, hidden cho secret); sửa theo kiểu (switch, enum, list), preview "= 2 days",
    lỗi nhập ngay tại dòng; Save = **dry run rồi mới ghi**; badge Restart / Enterprise; banner "Restart needed" từ
    `/v1/cluster_config/status`.
  - **Transforms**: danh sách, trạng thái theo partition, độ trễ, biến môi trường, Remove (xác nhận); tắt → giải thích + nút
    bật (`data_transforms_enabled`, cần restart).
- Demo opt-in `?redpanda=1` (`src/lib/redpanda/demo.ts`, có trạng thái); seam `?redpanda=down`, `?redpandaTransforms=off`.

## 3. Kiểm thử

- Vitest `src/lib/redpanda/admin.test.ts` (parser theo shape đo được, cấu hình, ACL bằng lời) + **fixture**
  `src-tauri/tests/fixtures/redpanda-requests.json` sinh từ chính builder của app (`WRITE_RP_FIXTURE=1`).
- Rust unit `drivers::redpanda::tests` (URL, phiên bản, lỗi lồng) + `drivers::kafka_acl` (ánh xạ tên).
- Integration `tests/redpanda_integration.rs` (container `redpandadata/redpanda:v26.2.6`, `DS_RP_TAG` để đổi): nhận diện +
  Test connection, Admin URL/Schema Registry mặc định qua Registry, **phát lại từng bước fixture**, Kafka workspace trên
  Redpanda (topic, produce, đọc theo trang, AlterConfigs giữ giá trị cũ), ACL tạo/đọc/lọc/xoá đúng 1 binding, principal
  `RedpandaRole:`, Schema Registry dựng sẵn.
- e2e `tests/visual/redpanda.spec.ts` (picker/form, overview, broker down, maintenance, users + grant, roles + xoá ACL,
  configuration, transforms, Apache Kafka chỉ có ACL).

## 4. Còn lại (ngoài phạm vi hoặc chưa làm)

- Admin API đi thẳng tới host của profile — **không qua SSH tunnel** (Kafka thì có); cluster sau bastion cần mở 9644 hoặc
  điền Admin API URL tới được.
- Deploy transform từ file WASM, Redpanda Connect, Tiered Storage, debug bundle, partition reassignment thủ công, quotas.
