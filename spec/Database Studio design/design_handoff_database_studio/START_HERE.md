# START HERE — Database Studio Handoff

Gói bàn giao đầy đủ để **vibe code** Database Studio dựa trên design đã dựng.
Một dev chưa từng đọc hội thoại vẫn implement được chỉ từ folder này.

---

## Đọc theo thứ tự

1. **`DATABASE_STUDIO_SPEC_v2.md`** ← bắt đầu ở đây.
   Spec đầy đủ + **nhãn trạng thái từng tính năng** (✅ REAL / 🟡 NEEDS-REAL-IO / 🟠 MOCK-UI /
   🔴 SHELL / ⛔ HARDCODED). Cho biết cái nào chỉ cần nối backend, cái nào phải viết lại.
2. **`SPEC_UPDATE.md`** — bản delta ngắn, chỉ tập trung "cái nào thật / cái nào giả" (nếu cần bản gọn).
3. **`README.md`** — handoff kỹ thuật chi tiết: design tokens, bảng màu chính xác, layout từng màn hình,
   context menu, state fields, tab types, ClickHouse specifics.
4. **`overview.md`** — product spec gốc: tầm nhìn, tech stack (Tauri 2 + Svelte 5), roadmap theo phase,
   chi tiết UX từng khu vực (Explorer, Redis/Kafka/NATS, ER Diagram…).

## Design source of truth

- **`Database Studio.dc.html`** — prototype hi-fi đầy đủ. Đây là **nguồn chuẩn về visual + hành vi**.
  Mở trực tiếp trong trình duyệt (cần `support.js` + `selftest.js` + `assets/` cùng thư mục — đã kèm).
  Khi tài liệu mâu thuẫn với file này, **file này đúng**.
- ⚠️ HTML là **bản tham chiếu thiết kế**, KHÔNG phải code để ship. Dựng lại trong codebase thật
  (Tauri 2 + Svelte 5 + TS nếu làm mới, hoặc theo stack sẵn có).

## Kiểm chứng "thật/giả" ngay trong prototype

Mở `Database Studio.dc.html` → DevTools (F12) → Console → gõ:

```js
runSelfTest()
```

Sẽ in bảng *Tính năng | Input test | Output thật | Kỳ vọng | PASS/FAIL/CANNOT-VERIFY* cho 10 loại
connection + Import/Export/Backup/Grant/Structure-Compare + các nút toolbar. Đây là căn cứ cho các nhãn
trạng thái trong spec (ví dụ Structure Compare = FAIL vì hardcode). Sau khi code backend, port lại các
assertion này thành integration test và kỳ vọng chúng chuyển sang PASS.

## Screenshots

`screenshots/` — chart mode, ClickHouse explorer, Structure Compare, connection-drop dialog, Group By,
icon set, workspace chính.

## Assets

`assets/` — logo raster PG/MySQL/MSSQL. Các icon khác là inline SVG trong `Database Studio.dc.html`.

---

## TL;DR ưu tiên code

1. Driver/network layer + connection registry → bật `execSql` thật (giữ shape trả về).
2. **Structure Compare** (đang hardcode — rủi ro cao nhất) → đọc schema thật + diff thật.
3. Backup/Restore + Export → nối dump tool/stream thật.
4. Bỏ các SHELL: Grant, Test Connection, Download Backup.
5. Redis/Kafka/NATS client riêng.
6. Import → transaction thật; editable grid → commit thật; persist tabs vào SQLite.
7. Security: parameterized queries, ẩn credential, phân quyền migration/restore.
