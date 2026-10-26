# SPEC-FERRETDB-DOCUMENTDB — FerretDB và Amazon DocumentDB (biến thể của engine MongoDB)

> Trạng thái: **đã implement, chưa commit** (2026-10-26). FerretDB: mọi khẳng định dưới đây **đo trên container
> `ghcr.io/ferretdb/ferretdb-eval:2` (FerretDB v2.7.0 + PostgreSQL/DocumentDB extension)**. Amazon DocumentDB là dịch vụ
> chỉ có trên AWS — **không chạy được ở máy**, phần của nó dựa trên tài liệu chính thức của AWS và chỉ được kiểm bằng unit
> test (xem §4).

## 0. Kết luận & phạm vi

Cả hai **không là `SystemType` mới** — flavor `ferretdb` / `documentdb` của engine `mongodb` (cùng giao thức MongoDB, cùng
driver, cùng màn hình). Phần riêng: nhận diện server, logo/nhóm sidebar, URI kết nối (DocumentDB), giải thích những gì server
không hỗ trợ, User Manager thích ứng (FerretDB không áp dụng role), explain của FerretDB.

## 1. FerretDB v2.7.0 — khác biệt đã đo

| # | Tính năng | Đo được | Xử lý |
|---|---|---|---|
| F1 | Nhận diện | `buildInfo.version` = `7.0.77` (số **tương thích**, không phải phiên bản thật); `buildInfo.ferretdb.version` = `v2.7.0`; `serverStatus.process` = `ferretdb` | flavor + "FerretDB v2.7.0 (MongoDB 7.0 compatible)" |
| F2 | Role | `createUser` nhận role nhưng **lưu cố định `readWriteAnyDatabase` + `clusterAdmin`**; user chỉ có `read` vẫn **ghi được mọi database**; `rolesInfo`, `grantRolesToUser`, `createRole` → "no such command" | User Manager: bỏ phần cấp role, nói rõ "không áp dụng role" |
| F3 | User nội bộ | `usersInfo` liệt kê `documentdb_bg_worker_role` (worker của extension) | ẩn khỏi danh sách |
| F4 | Explain | trả **plan PostgreSQL** dưới `queryPlanner.Plan` (Seq Scan / Bitmap Heap Scan…), bảng `documents_N`, filter dạng BSONHEX; `executionStats` không có số chạy thật | đọc bằng parser PostgreSQL, thay `documents_N` → tên collection, filter → câu query |
| F5 | Không hỗ trợ | `mapReduce`, `$where`, `$changeStream`, `killOp`, `top`, `profile`, `replSetGetStatus` → lỗi | gợi ý cách làm khác (aggregate, `$expr`) |
| F6 | **Âm thầm bỏ qua** | validator (`collMod`/`$jsonSchema`), capped (`max`), timeseries (không tạo), view (`create viewOn` thành collection rỗng) đều trả `ok:1` | ghi vào spec — app không tạo các loại này |
| F7 | serverStatus | thiếu `connections`/`opcounters`/`mem`/`network` | admin view vẫn chạy |
| F8 | Hoạt động bình thường | CRUD, aggregate (`$group/$lookup/$facet/$sample/$collStats`), distinct, findAndModify, index (kể cả text), listCollections/collStats/dbStats/validate/compact/reIndex, currentOp, startSession, mongodump/mongorestore | không cần xử lý |

## 2. Amazon DocumentDB — theo tài liệu AWS (không đo được)

- **Retryable writes không được hỗ trợ** → URI thêm `retryWrites=false` (trừ khi người dùng tự ghi trong connection string).
- **TLS mặc định** với CA của Amazon (`global-bundle.pem`) → chọn DocumentDB tự bật TLS + ghi chú chọn file CA.
- Cluster nằm trong VPC → qua SSH (EC2). Qua tunnel host là 127.0.0.1 nên thêm `tlsAllowInvalidHostnames=true` (chỉ khi có
  tunnel + TLS).
- Nhận diện: endpoint `*.docdb.amazonaws.com` / `*.docdb-elastic.amazonaws.com`, hoặc thẻ người dùng chọn (buildInfo không
  phân biệt được với MongoDB).
- Lỗi "Feature not supported" → gợi ý xem "Functional differences" của DocumentDB.

## 3. Thiết kế

- Profile: flavor ở `cassandra_flavor` (trường "server flavor" chung): MongoDB = `"" | "mongodb" | "ferretdb" | "documentdb"`.
- Backend: `MongoConnParams.flavor` + `tunneled`; `with_flavor_params` (URI DocumentDB); `server_identity` / `server_info` /
  `is_documentdb_host`; `MongoDriver.flavor` + `unsupported_hint` (gắn vào `hint` của lỗi query editor); `plan::parse_mongodb`
  nhận plan PostgreSQL của FerretDB (`parse_ferretdb_plan`); command `mongo_server_info` (lưu flavor). Test connection ghi tên
  thật ("FerretDB v2.7.0 (MongoDB 7.0 compatible)" / "Amazon DocumentDB 5.0.0").
- Frontend: brand `ferretdb` (logo simple-icons, CC0, navy theo `--brand-ferretdb-ink`) + `documentdb` (icon AWS từ svg-logos
  `aws-documentdb`, CC0 — ô gradient, id gradient riêng mỗi lần vẽ qua `BrandMark.defs`); token `ferretdb` (FD) /
  `documentdb` (#527FFF · DD); thẻ picker; form 3 thẻ MongoDB / FerretDB / Amazon DocumentDB (phím mũi tên chạy vòng),
  DocumentDB tự bật TLS + ghi chú; User Manager FerretDB (ẩn tab role, ẩn user nội bộ, ghi chú, tạo user không chọn role).
  Demo `?ferretdb=1`, `?documentdb=1`.

## 4. Kiểm thử

- Rust unit: `server_identity`, URI DocumentDB (TLS, tunnel, connection string của người dùng giữ nguyên), `unsupported_hint`,
  plan FerretDB (JSON đo được).
- Integration `tests/ferretdb_integration.rs` (container thật): nhận diện + Test connection; Explorer; query editor (find /
  aggregate / count / distinct / update / `$rename` / `$unset` / delete); explain đọc thành plan của collection; `$where` được
  giải thích; admin view server/sessions/users; user tạo / đăng nhập / đổi mật khẩu / xoá — **ghim: user `read` vẫn ghi được**;
  `grantRolesToUser` không có; Backup & Restore bằng mongodump/mongorestore đóng gói.
- Vitest brand + logo (đường dẫn nguyên văn, id gradient khác nhau giữa hai lần vẽ). e2e `ferretdb.spec.ts`.
- **DocumentDB: chưa kiểm trên cluster AWS thật** — cần một cluster để xác nhận nhận diện, TLS, retryWrites.

## 5. Còn lại

- Amazon DocumentDB: elastic clusters (sharding riêng), change streams (bật theo cluster), profiler/audit của AWS — chưa làm.
- FerretDB: không có gì để cấp quyền trong app (server không áp dụng role); quyền thật nằm ở PostgreSQL.
