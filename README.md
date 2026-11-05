# Database Studio

Ứng dụng desktop để làm việc với nhiều loại cơ sở dữ liệu và hệ thống streaming trong cùng một cửa sổ: duyệt schema, viết và chạy query, sửa dữ liệu, so sánh schema, phân quyền user, backup/restore, xem message của Kafka/NATS/RabbitMQ, duyệt key Redis…

Xây dựng bằng **Tauri 2** (backend Rust) và **Svelte 5** (frontend), chạy trên Windows, Linux và macOS.

> **Trạng thái:** beta (`0.1.0-beta.x`). Dùng được hằng ngày, nhưng vẫn có thể còn lỗi. Bản macOS chưa được ký.

---

## Hệ thống hỗ trợ

| Nhóm | Engine |
|---|---|
| Quan hệ | PostgreSQL · MySQL · MariaDB · SQL Server · Oracle · SQLite · DuckDB · ClickHouse |
| Document / wide-column | MongoDB · FerretDB · Amazon DocumentDB · Cassandra · ScyllaDB |
| Tìm kiếm | Elasticsearch · OpenSearch |
| Cache | Redis · Valkey |
| Streaming | Kafka · Redpanda · NATS (JetStream) · RabbitMQ |

ScyllaDB, FerretDB, DocumentDB, Valkey, OpenSearch và Redpanda dùng chung driver với engine gốc (Cassandra, MongoDB, Redis, Elasticsearch, Kafka). App tự nhận ra loại server khi bạn bấm **Test connection**.

---

## Cài đặt (người dùng)

1. Vào trang **[Releases](../../releases)** của repo và tải bản cài cho máy:
   - **Windows:** file `.exe` (NSIS)
   - **Ubuntu / Debian:** file `.deb` hoặc `.AppImage`. Xem thêm [INSTALL-UBUNTU.md](INSTALL-UBUNTU.md)
   - **macOS:** file `.dmg` (bản universal)
2. **macOS:** vì app chưa được ký, lần mở đầu tiên cần chạy:
   ```bash
   xattr -cr "/Applications/Database Studio.app"
   ```
3. **Tự cập nhật:** khi có bản mới, app tự hỏi lúc khởi động (hoặc vào **Settings → Updates → Check for updates**). Trên Linux chỉ bản AppImage tự cập nhật được, bản `.deb` phải cài lại bằng tay.

Bản cài đã kèm sẵn các công cụ dùng cho Backup & Restore (`pg_dump`, `mariadb-dump`, `mongodump`, Oracle Data Pump…), nên bạn không cần cài thêm gì.

---

## Hướng dẫn sử dụng nhanh

### Kết nối
- Bấm **New connection** (hoặc `Ctrl+Shift+N`), chọn engine, điền host, port, user và password, rồi bấm **Test connection** → **Connect**.
- Có hỗ trợ **SSH tunnel** (password hoặc private key) và **SSL/TLS**.
- Có thể gắn nhãn môi trường **PROD / STG / DEV / LOCAL** cho connection. Với connection PROD, app yêu cầu xác nhận trước những thao tác nguy hiểm.

### Explorer
- Double-click database/schema để mở ra. Double-click tên database để mở tab **Objects** (danh sách bảng kèm số dòng và dung lượng).
- Chuột phải lên từng mục để thấy các thao tác: Open Data, New Query, Design Table, Generate Scripts, Import/Export, Backup & Restore, Drop/Rename…
- Nút ở thanh tiêu đề cho phép đổi bố cục: **Connections | Explorer** (2 panel) hoặc **One sidebar** (cây nằm ngay dưới từng connection).

### Query Editor
| Phím | Tác dụng |
|---|---|
| `F5` | Chạy toàn bộ script |
| `Ctrl+Enter` | Chạy câu lệnh tại con trỏ |
| `Ctrl+Shift+E` | Explain (xem query plan) |
| `Ctrl+Shift+F` | Định dạng SQL |
| `Ctrl+Space` | Gợi ý bảng / cột / hàm |
| `Ctrl+S` | Lưu ra file `.sql` |
| `Esc` | Huỷ query đang chạy |

- Mỗi tab dùng một connection riêng, nên một query chạy lâu không làm treo các tab khác.
- Script có nhiều câu: chỉ câu trả về dữ liệu mới mở tab kết quả. INSERT/UPDATE/DELETE/DDL được gom vào tab **Messages**.
- Kết quả của câu `SELECT` từ một bảng có khoá chính thì sửa được ngay trên lưới.

### Lưới dữ liệu (Open Data / Result Grid)
- Double-click ô để sửa, chọn dòng ở cột `#` để xoá, rồi bấm **Execute** để lưu (**Preview diff** để xem trước câu lệnh). Chưa bấm Execute thì chưa có gì được ghi.
- Chuột phải lên lưới để copy dưới dạng CSV, JSON, SQL INSERT/UPDATE, Markdown, XML.
- **Export** ra CSV (UTF-8 có BOM), JSON, SQL, XML, Excel (`.xlsx`).

### Công cụ khác
- **Table Designer**: các tab Fields, Indexes, Foreign Keys, Uniques, Checks, Triggers, Partitioning.
- **Schema Compare**: so sánh 2 database, xem từng khác biệt, sinh script đồng bộ rồi áp vào target.
- **ER Diagram**: vẽ quan hệ giữa các bảng, kéo thả để tạo foreign key, xuất SVG/PNG.
- **Users & Privileges**: tạo user/role và phân quyền theo đúng mô hình của từng engine.
- **Backup & Restore**: có trong menu chuột phải của mọi database. Có thanh tiến trình và nút Stop.
- **Streaming** (Kafka · NATS · RabbitMQ · Redis): chọn connection là mở workspace riêng với Overview, danh sách topic/stream/queue/key, xem và gửi message, consumer group, cấu hình.
- **Command Palette** (`Ctrl+P`): tìm nhanh connection, bảng, lệnh.

---

## Chạy từ mã nguồn (developer)

### Yêu cầu
| Công cụ | Ghi chú |
|---|---|
| **Node.js 20+** | |
| **Rust** (stable, cài qua [rustup](https://rustup.rs)) | |
| **CMake** | Cần để build `librdkafka` (Kafka). Trên Windows, CMake có sẵn trong Visual Studio 2022. |
| **Windows** | Visual Studio 2022 Build Tools với workload "Desktop development with C++" |
| **Ubuntu** | `sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev libcurl4-openssl-dev build-essential file patchelf` |
| **macOS** | Xcode Command Line Tools (`xcode-select --install`) |

> **Lần build Rust đầu tiên mất khoảng 20–30 phút**, vì phải biên dịch DuckDB (C++) và librdkafka. Những lần sau chỉ mất vài phút.

### Chạy app desktop
```bash
npm install
npm run tauri dev        # chạy từ thư mục gốc của repo
```

### Chạy giao diện trong trình duyệt (không cần Rust)
```bash
npm install
npm run dev              # mở http://localhost:5173
```
Trong trình duyệt, app chạy ở **chế độ demo**: mọi lệnh backend được giả lập bởi `src/lib/demo.ts`, có sẵn dữ liệu mẫu. Chế độ này tiện để sửa giao diện nhanh, và cũng là chế độ mà các test Vitest/Playwright chạy.

### Windows: PATH cho cargo
Nếu dùng Git Bash, `cargo` và CMake có thể không có trong PATH:
```bash
export PATH="$PATH:$HOME/.cargo/bin:/c/Program Files/Microsoft Visual Studio/2022/Community/Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin"
```

### Công cụ backup đóng gói (tuỳ chọn)
Bản cài kèm sẵn `pg_dump`, `mariadb-dump`, `mongodump`, Oracle Instant Client… Khi chạy từ source, nếu muốn có các công cụ này:
```bash
npm run tools:fetch      # tải, kiểm SHA-256 và giải nén vào src-tauri/resources/
```
Không chạy bước này thì Backup & Restore sẽ dùng công cụ đã cài sẵn trên máy (nếu có).

---

## Kiểm tra trước khi commit

```bash
npm run check            # svelte-check + tsc — phải 0 lỗi / 0 cảnh báo
npx vitest run           # unit test frontend
npx playwright test      # test giao diện (tự khởi động vite)
npm run tokens:check     # không cho dùng màu/spacing viết cứng trong component
```

Test phía Rust:
```bash
cd src-tauri
cargo test --lib                                   # unit test (không cần database)
cargo test --test drivers_integration <tên_test>   # integration — cần Docker
```
Integration test dùng **testcontainers** để chạy database thật trong Docker. Container Cassandra, SQL Server và ClickHouse khởi động chậm (1–3 phút). Test Oracle cần Oracle Instant Client.

---

## Cấu trúc dự án

```
src/                      Frontend Svelte 5
  lib/ipc.ts              Cửa ngõ gọi backend (Tauri thật, hoặc demo trong trình duyệt)
  lib/demo.ts             Backend giả lập cho trình duyệt và test
  lib/stores/             State (runes): connections, tabs, results, explorer, ui…
  lib/components/         Giao diện: explorer, workspace, dialog, grid…
  lib/sql/                Logic thuần: tách câu lệnh, sinh DDL, autocomplete…
src-tauri/                Backend Rust
  src/drivers/            Một module cho mỗi engine, gom trong enum LiveConnection (mod.rs)
  src/commands/           Các #[tauri::command] (phải đăng ký trong lib.rs)
  src/connections/        Registry connection, SSH tunnel, huỷ query, keepalive
  src/storage/            SQLite nội bộ: profile connection (mật khẩu mã hoá AES-256-GCM), tab, lịch sử
  tests/                  Integration test với database thật
tests/visual/             Playwright e2e
tools/fetch-dump-tools/   Công cụ tải client tools đóng gói khi build
spec/                     Prototype thiết kế giao diện (nguồn chuẩn cho UI)
```

Một vài quy ước quan trọng:
- **Thêm command backend mới** thì phải đăng ký trong `invoke_handler!` (`src-tauri/src/lib.rs`), **và** thêm case tương ứng trong `src/lib/demo.ts`, nếu không thì test trình duyệt sẽ hỏng.
- **Thêm engine mới** gồm: module mới trong `drivers/`, variant mới trong `LiveConnection`, và arm mới trong mọi `match` của `drivers/mod.rs`.
- **Giao diện** lấy màu và spacing từ token (`src/lib/tokens.css`, `src/lib/theme.css`), không viết hex cứng trong component.

Tài liệu chi tiết hơn: [CLAUDE.md](CLAUDE.md) (kiến trúc + nhật ký từng đợt thay đổi), các file `SPEC-*.md` (đặc tả từng tính năng), [SPEC-INDEX.md](SPEC-INDEX.md).

---

## Phát hành bản mới

```bash
npm run beta:bump                      # tăng số beta trong package.json + tauri.conf.json
git commit -am "chore: bump v0.1.0-beta.N"
git tag v0.1.0-beta.N && git push --follow-tags
```
Đẩy tag `v*` sẽ chạy workflow [build-beta.yml](.github/workflows/build-beta.yml): build cho Windows, Ubuntu và macOS, tạo GitHub Release, ký bản cập nhật và sinh `latest.json` cho auto-update. Repo cần secret **`TAURI_SIGNING_PRIVATE_KEY`**, thiếu secret này thì build sẽ fail.
