# Phase 6 — Polish

> ⚠️ **Deprecated — checklist kế hoạch lịch sử.** Trạng thái `[ ]`/`[x]` không phản ánh hiện trạng. Nguồn
> sự thật: **code** + `SPEC-INDEX.md` + `CLAUDE.md`.

**Mục tiêu:** Tối ưu performance, hoàn thiện UX, đóng gói installer, auto-update. App sẵn sàng dùng hàng ngày.
**Thời gian ước tính:** ~~2 tuần~~ → **1–1.5 tuần** (vibe coding)
**Yêu cầu:** Phase 5 hoàn thành

---

## Checklist

### 1. Performance

#### Result Grid
- [ ] Kiểm tra và benchmark grid với 1M rows: đảm bảo không lag khi scroll
- [ ] Pagination không fetch lại data đã có (cache pages)
- [ ] JSON mode: không parse lại khi switch về Grid mode

#### Kafka Consumer
- [ ] High-throughput topic (>1000 msg/s): đảm bảo UI không freeze
- [ ] Ring buffer: giữ tối đa N messages trong UI, tự drop cũ (configurable)
- [ ] Throttle render: batch DOM updates mỗi 100ms

#### Object Explorer
- [ ] Lazy load: chỉ fetch children khi expand node (không fetch toàn bộ schema khi connect)
- [ ] Cache schema: chỉ refetch khi user bấm Refresh hoặc sau X phút

#### Connection Pool
- [ ] Pool size configurable per connection
- [ ] Idle connection timeout
- [ ] Reconnect tự động khi mất kết nối

### 2. Keyboard Shortcuts hoàn chỉnh

| Shortcut | Action |
|---|---|
| `F5` | Run query (tab đang focus) |
| `Ctrl+Enter` | Run statement tại cursor |
| `Ctrl+F5` / `Esc` | Cancel query |
| `Ctrl+Shift+F` | Format SQL |
| `Ctrl+Shift+E` | Explain query |
| `Ctrl+T` | New tab |
| `Ctrl+W` | Đóng tab |
| `Ctrl+Shift+T` | Restore tab vừa đóng |
| `Ctrl+Tab` | Tab kế tiếp |
| `Ctrl+Shift+Tab` | Tab trước |
| `Ctrl+1..9` | Jump tab theo số |
| `Ctrl+P` | Command palette |
| `Ctrl+F` | Tìm trong sidebar / JSON viewer |
| `Ctrl+Alt+G` | Result: Grid mode |
| `Ctrl+Alt+J` | Result: JSON mode |
| `Ctrl+Alt+R` | Result: Single Row mode |
| `Ctrl+Shift+C` | Copy result as JSON |
| `Ctrl+,` | Mở Settings |

- [ ] Kiểm tra tất cả shortcuts trên Windows / macOS / Linux
- [ ] Không conflict với OS shortcuts
- [ ] Hiển thị shortcuts trong tooltip của buttons

### 3. Settings / Preferences UI
- [ ] Mở bằng `Ctrl+,`
- [ ] Sections:
  - **Appearance**: theme (dark/light/system), font size editor, font family
  - **Editor**: tab size, word wrap, format on save, autocomplete delay
  - **Query**: default page size, continue on error, long-running warning threshold
  - **Connections**: default SSH timeout, connection pool size
  - **Data**: datetime format, timezone display (local/UTC), null display text
  - **Kafka**: max messages buffer, render throttle interval
  - **Shortcuts**: xem danh sách (chưa cần edit)
- [ ] Settings lưu vào SQLite
- [ ] Reset to defaults button per section

### 4. Auto-update
- [ ] Tích hợp Tauri updater plugin
- [ ] Check update khi khởi động (silent, không chặn)
- [ ] Notification khi có bản mới: "Version X.Y.Z available · [Update now] [Later]"
- [ ] Update download progress bar
- [ ] Restart để apply update

### 5. Installer & Packaging
- [ ] Windows: `.msi` installer + `.exe` portable
- [ ] macOS: `.dmg` với app bundle
- [ ] Linux: `.AppImage` + `.deb`
- [ ] Code signing (Windows + macOS)
- [ ] App icon đầy đủ các size

### 6. Error Handling & Stability
- [ ] Global error boundary: crash 1 tab không crash toàn bộ app
- [ ] Tauri panic handler: log lỗi Rust ra file, hiện dialog thay vì crash im lặng
- [ ] Connection error messages rõ ràng: "Connection refused", "Authentication failed", "SSL handshake failed"
- [ ] Query timeout configurable, hiện lỗi rõ khi timeout

### 7. Onboarding
- [ ] Welcome screen khi chưa có connection nào
- [ ] Quick start: nút "Add first connection" → form kết nối
- [ ] Tooltip hint lần đầu dùng các tính năng chính

### 8. Final QA Checklist
- [ ] Kết nối **đủ 10 hệ**: PG / MySQL / MariaDB / MSSQL / SQLite / ClickHouse / Cassandra / Redis / Kafka / NATS — tất cả hoạt động
- [ ] SSH tunnel + SSL — hoạt động đồng thời
- [ ] Multi-tab: mở 10 tabs, đóng app, mở lại — restore đúng
- [ ] Force delete connection → orphaned tabs không crash
- [ ] Editable grid: edit + apply → row cập nhật đúng trong DB (ClickHouse: route sang mutation async, không commit kiểu OLTP)
- [ ] Cassandra: CQL editor chặn JOIN, ALLOW FILTERING có cảnh báo, paging state hoạt động
- [ ] SQLite: đủ 3 mode (RW/RO/In-Memory), PRAGMA panel hoạt động
- [ ] Execute Plan: đủ 10 hệ (6 SQL + Cassandra tracing; Redis/Kafka/NATS disabled đúng)
- [ ] Index Scanner: health flags đúng trên từng hệ
- [ ] Import CSV 100k rows — không timeout
- [ ] Export 500k rows to Excel — file mở được
- [ ] Command palette: tìm kiếm 50+ items — không lag
- [ ] Dark / Light mode: tất cả components render đúng màu — đủ 10 bộ màu system + orphan

---

## Definition of Done
- App đóng gói thành installer chạy được trên Windows
- Auto-update hoạt động: nhận thông báo version mới, download và restart
- Settings lưu persist qua app restart
- Tất cả keyboard shortcuts hoạt động đúng
- Không có crash trong normal usage flows
- Final QA checklist (mục 8) pass trên **đủ 10 hệ**

### Test (bắt buộc)
- Unit test đầy đủ cho toàn bộ logic phase này (settings persist, error boundary, updater flow...)
- Integration test đầy đủ chạy lại trên **từng hệ trong cả 10 hệ** qua **testcontainers** (SQLite trên file thật) — regression suite toàn app xanh

### UI đối chiếu 1:1 với `Database Studio.dc.html` (bắt buộc)
- Token màu/spacing/font grep trực tiếp từ HTML (`.ds` / `.ds-light`), không phỏng đoán — kiểm cả dark lẫn light theme
- Icon SVG copy nguyên vẹn từ HTML
- Bảng đối chiếu số đo toàn app (rà lại tổng) — không còn dòng lệch
- Snapshot/DOM test cho các component UI của phase (Settings, Welcome screen, toast...)
