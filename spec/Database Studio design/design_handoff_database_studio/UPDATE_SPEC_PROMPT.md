# Prompt — Update the Database Studio spec

Copy-paste this whenever `Database Studio.dc.html` has changed and you want the spec
documents brought back in sync.

---

## Prompt (copy below)

Bạn là người viết tài liệu kỹ thuật. Hãy **cập nhật lại bộ tài liệu spec** cho dự án
**Database Studio** để khớp 100% với trạng thái HIỆN TẠI của file thiết kế.

**Nguồn sự thật (source of truth):** `Database Studio.dc.html` — đọc kỹ cả phần markup
(template) lẫn phần logic (`class Component`). Khi tài liệu mâu thuẫn với file này, file
này luôn đúng.

**Tài liệu cần cập nhật:**
1. `design_handoff_database_studio/README.md` — bản spec handoff cho Claude Code (chính).
2. `design_handoff_database_studio/overview.md` — bản product spec tổng quan (chỉ sửa phần
   nào đã lỗi thời so với implementation; giữ nguyên phần tầm nhìn/roadmap nếu vẫn đúng).
3. Copy lại `Database Studio.dc.html` mới nhất vào thư mục `design_handoff_database_studio/`.

**Quy trình bắt buộc:**
1. Đọc `Database Studio.dc.html` và liệt kê (cho riêng bạn) tất cả: connection types trong
   `SYS`, màu sắc/badge từng loại, các CSS token trong `.ds` / `.ds-light`, các tab type,
   các modal (Connection Manager, Generate Scripts, Compare/DDL Diff, command palette…),
   các context menu (table/schema/folder/dictionary/view/column/tab/connection/grid) cùng
   các action thực sự gọi gì, và mọi hành vi (toolbar gating, Run selection-aware,
   save-before-close, pagination > 50 rows, menu fit-on-screen, ClickHouse engines/DDL/
   mutations/partition ops…).
2. So sánh với `README.md` hiện có. Cập nhật mọi chỗ sai lệch: **giá trị màu, token, port,
   tên action, điều kiện bật/tắt, số liệu** phải lấy chính xác từ code, không phỏng đoán.
3. Giữ nguyên cấu trúc các mục của README (Overview, About the Design Files, Fidelity,
   Layout, Color Identity System, Screens/Views, Context Menus, Interactions, State
   Management, ClickHouse specifics, Design Tokens, Assets, Files). Thêm mục mới nếu có
   tính năng mới; xoá mô tả của tính năng đã bị gỡ.
4. Mọi màu/token trích trong tài liệu phải **đối chiếu lại với code** (grep token thật,
   đừng chép từ tài liệu cũ).
5. Ghi rõ: các file HTML là **bản tham chiếu thiết kế**, nhiệm vụ là **dựng lại trong
   codebase thật** (Tauri 2 + Svelte 5 + TypeScript nếu làm mới), không ship HTML.
6. Tài liệu phải **tự đủ**: một dev chưa từng đọc hội thoại vẫn implement được chỉ từ
   README + file `.dc.html`.

**Không làm:** không đổi thiết kế, không thêm tính năng, không sửa `Database Studio.dc.html`
— đây chỉ là việc viết lại tài liệu. Sau khi xong, tóm tắt NGẮN GỌN những thay đổi chính
trong spec so với bản trước.

---

## (Tuỳ chọn) Thêm vào cuối prompt nếu muốn kèm ảnh

Chụp screenshot các màn hình chính (workspace, Connection Manager, Generate Scripts,
Compare/DDL Diff, ClickHouse explorer) vào `design_handoff_database_studio/screenshots/`
và liệt kê chúng trong mục **Assets** của README.
