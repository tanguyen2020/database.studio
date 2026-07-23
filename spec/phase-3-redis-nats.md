# Phase 3 — Redis + NATS

> ⚠️ **Deprecated — checklist kế hoạch lịch sử.** Trạng thái `[ ]`/`[x]` không phản ánh hiện trạng (vd Redis
> CLI console đã bị thay bằng RedisExplorer key-browser). Nguồn sự thật: **code** + `SPEC-INDEX.md` + `CLAUDE.md`.

**Mục tiêu:** Hỗ trợ Redis và NATS — key browser, real-time messaging, JetStream cơ bản. SSL cho tất cả connections. Tab groups.
**Thời gian ước tính:** ~~3–4 tuần~~ → **1.5–2 tuần** (vibe coding)
**Yêu cầu:** Phase 2 hoàn thành

---

## Checklist

### 1. SSL / TLS cho tất cả connections
- [ ] UI: toggle SSL trong connection form, upload CA cert / client cert / client key
- [ ] Driver PG: `sqlx` TLS mode
- [ ] Driver MySQL: `sqlx` TLS mode
- [ ] Driver MSSQL: `tiberius` TLS mode
- [ ] Lưu cert paths (không copy file, chỉ lưu path)

### 2. Connection Manager — Redis
- [ ] Form kết nối Redis: host, port, password (optional), DB index (0–15)
- [ ] SSH tunnel cho Redis
- [ ] SSL/TLS cho Redis (redis-rs TLS)
- [ ] Test connection
- [ ] Badge `[RE]` màu `#D82C20`

### 3. Redis Key Explorer
- [ ] Tree view phân cấp theo prefix separator `:`
  - Ví dụ: `user:1`, `user:2` → node `user` → children `1`, `2`
- [ ] Icon phân biệt theo type: String `S`, Hash `H`, List `L`, Set `S`, ZSet `Z`, Stream `X`
- [ ] TTL badge bên phải: `42s`, `∞` (không expire), `expired` (đỏ)
- [ ] Search keys theo pattern (dùng `SCAN` cursor-based, không `KEYS *`)
- [ ] DB selector: dropdown switch DB 0–15
- [ ] Refresh tree

### 4. Redis Key Viewer / Editor
Mở tab `redis-key` khi click key trong explorer:
- [ ] **String**: plain text, JSON auto-detect + formatter, edit + Save
- [ ] **Hash**: table view (field / value), thêm field, sửa value, xóa field
- [ ] **List**: ordered list, push left/right, pop, set by index, xóa element
- [ ] **Set**: member list, add member, remove member
- [ ] **ZSet**: member + score table, sort by score, add, remove, update score
- [ ] **Stream**: message list (ID + fields), add entry, read by ID range, xóa entry
- [ ] TTL editor: input số giây → SET, nút Remove TTL, hiện remaining
- [ ] Delete key với xác nhận

### 5. Redis CLI Console
- [ ] Tab `redis-cli` — input prompt gõ raw commands
- [ ] Syntax highlight output (RESP format)
- [ ] Command history (↑ ↓ trong input)
- [ ] Autocomplete Redis commands

### 6. Redis Pub/Sub Monitor
- [ ] Tab `redis-pubsub`: subscribe 1 hoặc nhiều channels / patterns
- [ ] Messages hiện real-time dạng stream (timestamp · channel · payload)
- [ ] Pause / Resume stream
- [ ] Clear messages
- [ ] Publish message test ngay trong tab

### 7. Redis — bổ sung
- [ ] Memory usage per key: hiện `MEMORY USAGE` khi hover key
- [ ] Flush DB: button + dialog xác nhận (gõ tên DB để confirm)

### 8. Connection Manager — NATS
- [ ] Form kết nối NATS: server URL (`nats://host:4222`)
- [ ] Auth: Username/Password, NKey file (chọn file), JWT + NKey
- [ ] SSL/TLS
- [ ] SSH tunnel
- [ ] Test connection
- [ ] Badge `[NT]` màu `#27AE60`

### 9. NATS Core (không JetStream)
- [ ] Connection info tab: server version, cluster name, uptime, connections count
- [ ] **Subject subscriber**: nhập subject / wildcard (`>`, `*`), Subscribe → stream messages real-time
  - Hiển thị: timestamp · subject · reply-to · headers · payload
  - Decode payload: raw bytes / UTF-8 / JSON (auto-detect)
  - Pause / Resume / Clear
- [ ] **Publish**: form nhập subject, reply-to (optional), headers (key-value), payload → Publish
- [ ] **Request/Reply**: nhập subject + payload, timeout configurable → hiện reply hoặc timeout message
- [ ] Account info: limits, usage stats

### 10. NATS JetStream (cơ bản)
- [ ] **Streams**: list streams, xem config (subjects, retention, storage type, limits)
- [ ] **Consumers**: list consumers của stream, xem config (deliver policy, filter subject, ack policy)
- [ ] **Messages**: peek message by sequence number

### 11. Multi-Tab — Tab Groups (split view)
- [ ] Kéo tab ra khỏi tab bar → tạo split view (2 cột)
- [ ] Toggle top/bottom split
- [ ] Mỗi pane có tab bar riêng
- [ ] Sidebar Object Explorer dùng chung cho tất cả panes
- [ ] Tối đa 2 panes (2×1 hoặc 1×2)

---

## Definition of Done
- Kết nối Redis → browse keys theo prefix tree, xem và sửa tất cả 6 types
- Subscribe NATS subject → nhận messages real-time
- Publish NATS message + Request/Reply hoạt động
- JetStream: list streams và consumers
- SSL hoạt động cho PG / MySQL / MariaDB / MSSQL / Redis
- Split view: 2 tabs SQL editor cùng mở song song

### Test (bắt buộc)
- Unit test đầy đủ cho toàn bộ logic phase này (prefix tree builder, RESP highlight, pattern glob→regex, TTL logic...)
- Integration test đầy đủ cho **từng hệ trong phase** qua **testcontainers**: Redis (6 types + TTL + Pub/Sub + SCAN), NATS (pub/sub + Request/Reply + JetStream cơ bản); SSL test cho các driver đã bật

### UI đối chiếu 1:1 với `Database Studio.dc.html` (bắt buộc)
- Token màu/spacing/font grep trực tiếp từ HTML, không phỏng đoán
- Icon SVG copy nguyên vẹn từ HTML
- Bảng đối chiếu số đo các thành phần của phase (key browser, Pub/Sub monitor, split view...) — không còn dòng lệch
- Snapshot/DOM test cho các component UI mới của phase
