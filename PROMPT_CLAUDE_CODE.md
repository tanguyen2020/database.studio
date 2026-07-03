# Prompt cho Claude Code — Database Studio (bản hoàn chỉnh)

> Cấu trúc Tauri chuẩn: `src-tauri/` (Rust) + `src/` (Svelte). Làm TUẦN TỰ hết 6 phase
> + 10 hệ, UI giống Database Studio.dc.html 1:1.

---

Bạn sẽ vibe code dự án Database Studio (SQL/NoSQL client desktop). Nhiệm vụ: dựng lại
TOÀN BỘ tính năng, với UI GIỐNG HỆT file thiết kế "Database Studio.dc.html". Đọc tài
liệu, rồi làm TUẦN TỰ từng phase, dừng xin duyệt ở mỗi mốc.

============================================================
CẤU TRÚC REPO (Tauri chuẩn — dùng đúng src-tauri/ và src/)
============================================================
- src-tauri/  = Tauri 2 + Rust. Chứa Cargo.toml, tauri.conf.json, src/ với module
                connections, drivers, commands, storage.
- src/        = Svelte 5 + Vite + TypeScript. Components, stores, lib.
- spec/       = toàn bộ tài liệu (chỉ đọc).
- .claude/    = config, để nguyên.
KHÔNG dùng folder backend/ hay frontend/. Nếu repo còn 2 folder đó thì bỏ, dùng đúng
layout Tauri chuẩn src-tauri/ + src/ như phase-1 mục 1 đã ghi.

============================================================
THỨ TỰ ĐỌC (tài liệu ở spec/, thư mục design:
spec/Database Studio design/design_handoff_database_studio/)
============================================================
1. DATABASE_STUDIO_SPEC_v2.md — spec đầy đủ + nhãn trạng thái từng tính năng.
2. overview.md — product spec, tech stack, UX từng khu vực.
3. README.md — design tokens, bảng màu, layout, context menu, state fields.
4. (SPEC_UPDATE.md đã gộp vào SPEC_v2 §4-§15 và bị xóa — thông tin REAL/SHELL/HARDCODED
   nay đọc ở SPEC_v2 §4-§15.)
5. phase-1..phase-6 + phase-4b-cassandra.md (ở spec/) — checklist + Definition of Done từng phase.
6. CASSANDRA_SPEC_ADDENDUM.md + CLICKHOUSE_SPEC_ADDENDUM.md — GHI ĐÈ spec cho 2 hệ đó.
7. EXECUTE_PLAN_AND_INDEX_SCAN_ADDENDUM.md — Execute Plan (chuẩn hóa) + Index Scan (Phase 5).
   (Chỗ nào file này ghi "backend/src/drivers/" thì hiểu là "src-tauri/src/drivers/".)
8. QUERY_EDITOR_ERROR_HANDLING_ADDENDUM.md — bắt lỗi editor theo dialect (Phase 1-2).
(Trùng tên: ưu tiên bản trong design_handoff_database_studio/.)

============================================================
SOURCE OF TRUTH & KHỚP DESIGN 1:1 (BẮT BUỘC — ưu tiên cao nhất)
============================================================
"Database Studio.dc.html" là CHUẨN TUYỆT ĐỐI về visual + hành vi. Khi bất kỳ tài liệu
nào mâu thuẫn với file HTML, HTML đúng. HTML chỉ tham chiếu, KHÔNG ship — dựng lại bằng
Svelte 5, nhưng kết quả phải NHÌN GIỐNG HỆT.

Quy tắc ép khớp, áp dụng cho MỌI thành phần UI:
- TOKEN (màu hex, CSS variable, font-family, font-size, line-height, spacing, padding,
  margin, border-radius, border-width, box-shadow, z-index, transition timing): GREP
  TRỰC TIẾP từ Database Studio.dc.html và tạo src/lib/tokens.css (+ tailwind config)
  từ CHÍNH các giá trị đó. KHÔNG chép từ README, KHÔNG lấy từ trí nhớ, KHÔNG tự chọn
  màu/spacing. README mâu thuẫn HTML -> HTML thắng.
- LAYOUT: cấu trúc panel, tỉ lệ kích thước, vị trí từng vùng (sidebar Connections,
  Explorer, tab bar, editor, result grid, status bar, Properties panel) phải khớp HTML.
- ICON / SVG: COPY NGUYÊN chuỗi inline SVG từ HTML, KHÔNG tự vẽ lại. Logo raster lấy
  từ assets/. Badge 2 ký tự + màu từng hệ lấy đúng từ HTML.
- ĐÂY LÀ DỰNG LẠI 1:1, KHÔNG REDESIGN. Cấm tự đổi màu/spacing/font/bố cục/icon, cấm
  thêm/bớt element, cấm thêm animation hay "cải thiện" UX. Mọi khác biệt thị giác so
  với HTML là BUG phải sửa, không phải sáng tạo.
- QUY TRÌNH ĐỐI CHIẾU TỪNG MÀN HÌNH (bắt buộc, tự động bằng Playwright pixel diff):
  dựng xong 1 màn hình -> dùng Playwright render CẢ HAI (mở Database Studio.dc.html gốc
  và bản Svelte đang chạy) ở CÙNG viewport/kích thước -> chụp screenshot cả hai ->
  so ảnh pixel (Playwright toHaveScreenshot / pixelmatch), sinh ảnh diff highlight vùng
  lệch -> nếu vượt ngưỡng cho phép thì sửa tới khi dưới ngưỡng -> MỚI sang màn tiếp.
  Đối chiếu thêm với screenshots/ trong thư mục design. Đính ảnh diff + số % lệch vào
  báo cáo cuối phase.
  Ngưỡng: mục tiêu 0 pixel lệch cho layout/màu/spacing/icon/text. Cho phép sai số RẤT
  nhỏ chỉ ở anti-aliasing font (threshold pixelmatch ~0.1, maxDiffPixelRatio rất thấp);
  mọi lệch vượt ngưỡng là BUG phải sửa, KHÔNG nới ngưỡng để cho qua.
- Hành vi (hover, transition, toolbar gating, Run selection-aware, save-before-close,
  pagination, menu fit-on-screen...) cũng phải khớp HTML; đọc cả phần logic (class
  Component) trong HTML, không chỉ markup.

ÉP UI BÁM .HTML/.JS (cơ chế cưỡng chế, không chỉ thiện chí):
1. TOKEN TỰ ĐỘNG, CẤM SỬA TAY: viết script trích token TỰ ĐỘNG từ Database Studio.dc.html
   (đọc <style> + inline style + biến trong class Component) xuất ra src/lib/tokens.css +
   tailwind theme. Token trong app CHỈ sinh từ script này. Cấm gõ tay giá trị màu/spacing/
   font ở bất kỳ component nào — mọi giá trị phải tham chiếu biến token. Thiếu token thì
   bổ sung vào script extraction rồi chạy lại, KHÔNG hardcode trong component.
2. .JS LÀ ĐẶC TẢ HÀNH VI: trước khi code mỗi tính năng, MỞ support.js + phần class
   Component trong HTML, đọc đúng hàm xử lý tương ứng (tên handler, điều kiện bật/tắt,
   thứ tự thao tác, state field) và TÁI HIỆN ĐÚNG logic đó sang Svelte. Không tự nghĩ
   hành vi mới. Ghi chú trong code: "// port từ <tên hàm> trong .dc.html / support.js"
   để truy vết.
3. ĐỐI CHIẾU BẰNG SỐ ĐO, KHÔNG BẰNG MẮT: với mỗi màn hình, trích danh sách phần tử +
   thuộc tính đo được từ HTML gốc (thứ tự phần tử, class, text, kích thước, màu computed).
   Dựng bảng đối chiếu HTML-gốc vs Svelte, đánh dấu từng dòng KHỚP/LỆCH. Màn hình chỉ đạt
   khi bảng không còn dòng LỆCH. Đính bảng vào báo cáo cuối phase.
4. SNAPSHOT/DOM TEST CHO UI: mỗi component UI có snapshot/DOM test (Vitest) — render rồi
   so cấu trúc DOM + class + text với kỳ vọng lấy từ HTML gốc. Snapshot đổi ngoài ý muốn
   = test fail = phải giải thích, KHÔNG tự cập nhật snapshot bừa để qua.
5. PHỦ HẾT DANH MỤC MÀN HÌNH: liệt kê ĐẦY ĐỦ mọi màn hình/modal/context-menu/tab-type/
   state trong HTML (workspace, Connection Manager, Generate Scripts, Compare/DDL Diff,
   command palette, ClickHouse explorer, Ring, TTL Viewer, các context menu table/schema/
   column/tab/connection/grid...). Mỗi mục phải được dựng + đối chiếu. KHÔNG bỏ mục nào
   vì "không thấy nhắc trong phase".

============================================================
QUYẾT ĐỊNH ĐÃ CHỐT (ghi đè mọi mâu thuẫn)
============================================================
- Stack: Tauri 2 + Svelte 5 + TypeScript + Vite + Tailwind + shadcn-svelte.
  Grid: TanStack Table. ER diagram: @xyflow/svelte + dagre. SQL editor: CodeMirror 6.
- Backend: Rust. Driver Rust: sqlx (PG/MySQL/MariaDB), tiberius (MSSQL), rusqlite
  (SQLite), clickhouse (ClickHouse), scylla (Cassandra), redis (Redis), rdkafka
  (Kafka), async-nats (NATS). SSH: russh.
  BỎ QUA mọi tên package Node còn sót trong tài liệu (pg, mysql2, tedious,
  better-sqlite3, cassandra-driver) — đây là app Rust, chỉ dùng driver Rust ở trên.

============================================================
VÁ QUAN TRỌNG — 6 HỆ -> 10 HỆ
============================================================
phase-1..6 viết theo spec CŨ 6 hệ (PG, MySQL, MSSQL, Redis, Kafka, NATS). Danh sách
CHUẨN là 10 hệ (SPEC_v2 mục 2). Bổ sung 4 hệ, KHÔNG bỏ sót:
- MariaDB  -> Phase 1-2 (relational), dùng chung sqlx với MySQL. Badge MA #C0765A.
- SQLite   -> Phase 1-2, rusqlite. Badge SL #0F80CC, file picker + mode RW/RO/In-Memory,
             cây file, PRAGMA panel. TÁCH BẠCH: rusqlite làm STORAGE NỘI BỘ vs SQLite
             là DB người dùng kết nối — không gộp.
- ClickHouse -> basics Phase 2, nâng cao (engine badge, TTL Viewer, partition ops,
             mutations, MV/Dictionary) Phase 5. Badge CH #FFCC00, port 8123, backtick.
             Theo CLICKHOUSE_SPEC_ADDENDUM.md — KHÔNG phải OLTP, UPDATE/DELETE là
             mutation async, key không unique, không transaction.
- Cassandra -> PHASE RIÊNG giữa Phase 4 và Phase 5. scylla. Badge CS #1287B1, port 9042.
             CQL editor + keyspace tree + Ring Topology. Theo CASSANDRA_SPEC_ADDENDUM.md
             — CQL KHÔNG phải SQL: không JOIN, WHERE chỉ trên partition/clustering key.
Cập nhật Color Identity System (phase-1 mục 2) từ 6 lên 10 badge/màu; Final QA
(phase-6) từ 6 lên 10 hệ. Màu badge lấy đúng từ HTML.

============================================================
TÍNH NĂNG XUYÊN HỆ & BẮT LỖI
============================================================
- Execute Plan (Phase 5): mỗi hệ cơ chế khác nhau (PG EXPLAIN JSON, MySQL/MariaDB
  EXPLAIN/ANALYZE, MSSQL SHOWPLAN XML, SQLite EXPLAIN QUERY PLAN, ClickHouse EXPLAIN,
  Cassandra TRACING) nhưng adapter MAP VỀ CÙNG struct PlanNode chuẩn để 1 visualizer
  dùng chung. Giữ raw. Redis/Kafka/NATS: not_applicable. Theo addendum #7.
- Index Scan (Phase 5): quét index toàn schema theo catalog từng hệ; output struct
  IndexInfo rõ tên/bảng/cột(thứ tự)/type/unique/primary/size/usage + cờ sức khỏe
  (unused/redundant/fragmented/invalid/anti_pattern) + summary + gợi ý missing. Tab
  "Index Scanner/Analyzer". Theo addendum #7.
- Bắt lỗi editor theo dialect (Phase 1-2, addendum #8): tầng 1 lint lúc gõ (advisory,
  KHÔNG chặn Run) + tầng 2 lỗi thực thi chuẩn hóa QueryError trỏ đúng dòng/cột theo
  khả năng từng hệ. Luôn giữ raw error sau nút View raw.

============================================================
NHÃN TRẠNG THÁI + SỬA LỖI
============================================================
- REAL = chỉ nối backend, giữ shape { ok, result?:{cols:[[name,type]],rows,total}, error? }.
- NEEDS-REAL-IO / MOCK-UI / SHELL / HARDCODED = viết lại (xem SPEC_v2 §4-§15).
- Structure Compare (HARDCODED) rủi ro cao nhất — chưa động tới cho đến khi driver
  layer + execSql thật đã chạy.
- SỬA NHÃN: Cassandra Query Engine bị đánh REAL là DƯƠNG TÍNH GIẢ (giả lập CQL như SQL
  in-memory). Coi như phải viết lại theo CQL thật.

============================================================
KIỂM THỬ BẮT BUỘC MỖI PHASE (unit + integration, không được thiếu)
============================================================
Không phase nào được coi là xong nếu chưa có unit test VÀ integration test đầy đủ,
chạy PASS. Test là một phần của Definition of Done, không phải việc làm sau.

UNIT TEST (không cần DB thật — logic thuần):
- Rust: #[cfg(test)] trong src-tauri/. Bắt buộc test: statement splitter (tách theo ;),
  chuẩn hóa PlanNode (map từ mỗi format sang struct chung), map IndexInfo, chuẩn hóa
  QueryError + ánh xạ vị trí, phát hiện redundant/unused index, rule pack lint từng
  dialect (vd cql.no_join, danger.update_without_where), mã hóa/giải mã password.
- Frontend: Vitest + @testing-library/svelte. Bắt buộc test: SystemBadge (10 hệ đúng
  màu/ký tự), tab store (mở/đóng/reorder/persist), grid render (NULL vs empty, datetime
  local), lint extension hiển thị squiggle đúng, view-mode toggle.

INTEGRATION TEST (chạy với DB thật qua container):
- Rust: src-tauri/tests/. Dùng testcontainers (hoặc docker-compose) để bật DB thật cho
  từng hệ trong phase đang làm: connect + test connection, execSql shape đúng, CRUD,
  transaction/rollback, introspection schema, ánh xạ lỗi (vd PG position, Cassandra
  WHERE không key -> lỗi). SQLite dùng in-memory.
- Tauri command: test round-trip Rust <-> lớp gọi (invoke) cho các command chính của phase.
- E2E (từ Phase 5-6 hoặc khi luồng đủ chín): Playwright/tauri-driver cho luồng chính
  (kết nối -> chạy query -> xem grid; editable grid apply; command palette).
- VISUAL REGRESSION (bắt buộc, mọi phase có UI): Playwright pixel diff giữa bản Svelte
  và Database Studio.dc.html gốc cho từng màn hình/modal/menu. Lưu baseline từ HTML gốc;
  test fail khi lệch vượt ngưỡng (chỉ nới cho anti-aliasing font). Chạy trong bộ test,
  không phải kiểm bằng mắt.

QUY ĐỊNH:
- Mỗi tính năng có logic PHẢI có unit test tương ứng; mỗi hệ trong phase PHẢI có
  integration test tương ứng. Thiếu test = phase chưa xong.
- Port dần assertion trong selftest.js thành integration test thật (Structure Compare
  FAIL->PASS, SHELL có side-effect, Cassandra trả lỗi đúng khi WHERE sai). Trạng thái
  REAL/SHELL/HARDCODED tham chiếu SPEC_v2 §4-§15.
- CI-friendly: `cargo test` và test frontend chạy được bằng 1 lệnh; test cần DB dùng
  container tự bật/tắt, không phụ thuộc DB cài sẵn trên máy.
- Không đạt coverage hợp lý cho logic cốt lõi thì chưa commit phase.

============================================================
QUY TRÌNH TUẦN TỰ (bắt buộc)
============================================================
Đơn vị công việc = từng checkbox trong file phase. KHÔNG có user story riêng —
Definition of Done cuối mỗi phase là tiêu chí nghiệm thu.

Thứ tự CỐ ĐỊNH, chạy hết đến khi xong toàn bộ:
  Phase 1 -> 2 -> 3 -> 4 -> Cassandra -> Phase 5 -> Phase 6.
Không bắt đầu phase sau khi phase trước chưa đạt Definition of Done. Trong 1 phase,
làm đúng thứ tự các mục đánh số (mục sau phụ thuộc mục trước).

Vòng lặp MỖI phase:
1. Đọc file phase + phần liên quan SPEC_v2/README/HTML. Liệt kê checkbox thành danh
   sách task. Phase relational: chèn thêm task MariaDB + SQLite (+ ClickHouse basics
   ở Phase 2) đúng mục. Liệt kê luôn danh sách unit test + integration test sẽ viết.
2. TÓM TẮT kế hoạch phase (task + kế hoạch test) + DỪNG cho tôi duyệt TRƯỚC KHI code.
3. Sau khi duyệt: code lần lượt từng task + VIẾT TEST đi kèm (unit cho logic, integration
   cho từng hệ). Task UI theo quy trình đối chiếu 1:1 với HTML. Tick [x] khi xong.
4. Hết phase: chạy TOÀN BỘ test (cargo test + test frontend + integration container +
   Playwright visual regression). Tất cả phải PASS. Kiểm lại Definition of Done, build
   và chạy app. Báo cáo: từng dòng DoD đạt/chưa, kết quả test (số pass/fail + coverage
   logic cốt lõi), ảnh diff Playwright + % lệch từng màn hình còn lại.
5. Commit "Phase N: <tóm tắt> (tests pass)". DỪNG chờ tôi review. KHÔNG tự sang phase kế.

Task không rõ hoặc mâu thuẫn tài liệu: DỪNG và hỏi, không tự suy diễn.
Session mới: đọc lại prompt này + SPEC_v2, xem phase nào đã commit để biết đang ở đâu.
Sau khi có backend: port assertion trong selftest.js thành integration test; kỳ vọng
Structure Compare FAIL->PASS, các SHELL có side-effect thật, Cassandra trả lỗi đúng
khi WHERE không hợp lệ.

============================================================
DO NOT
============================================================
- KHÔNG lệch UI so với Database Studio.dc.html — mọi khác biệt thị giác là bug.
- KHÔNG tự chọn màu/spacing/font/icon — grep token thật từ HTML, copy SVG nguyên.
- KHÔNG hardcode giá trị màu/spacing/font trong component — chỉ tham chiếu token sinh từ script.
- KHÔNG tự nghĩ hành vi mới — port đúng hàm trong .dc.html/support.js, ghi chú truy vết.
- KHÔNG coi màn hình đạt khi bảng đối chiếu số đo còn dòng LỆCH.
- KHÔNG nới ngưỡng Playwright pixel diff để cho qua — chỉ anti-aliasing font được sai nhỏ.
- KHÔNG tự cập nhật snapshot UI để làm test pass mà không giải thích.
- KHÔNG redesign, không thêm animation/"cải thiện" ngoài HTML.
- KHÔNG dùng folder backend/ hay frontend/ — chỉ src-tauri/ + src/ (Tauri chuẩn).
- KHÔNG nhảy phase / làm song song — tuần tự, dừng đúng mốc.
- KHÔNG tự thêm dependency ngoài stack đã chốt. KHÔNG dùng driver Node.
- KHÔNG nối chuỗi tham số vào query — luôn prepared/parameterized.
- KHÔNG nhúng password vào connection string khi copy.
- KHÔNG tin nhãn REAL của self-test máy móc (Cassandra là ví dụ).
- KHÔNG bê ngữ nghĩa hệ này sang hệ khác (SQL->CQL, OLTP->OLAP).
- KHÔNG chặn nút Run vì lint; KHÔNG đoán vị trí lỗi khi driver không cho.
- KHÔNG chạy actual plan (EXPLAIN ANALYZE / STATISTICS XML) mà không báo side-effect.
- KHÔNG tự DROP index/deploy/push production; không sửa code ngoài phạm vi phase.
- KHÔNG commit/đánh dấu phase xong khi thiếu unit test hoặc integration test, hoặc còn test fail.
- KHÔNG viết test giả (assert true, bỏ trống, skip) để qua mặt — test phải kiểm tra hành vi thật.
- KHÔNG bỏ integration test của bất kỳ hệ nào trong phase vì "khó dựng DB" — dùng testcontainers.

============================================================
BẮT ĐẦU NGAY
============================================================
Đọc hết tài liệu + Database Studio.dc.html + support.js. Thực hiện Bước 1 + 2 của Phase
1: liệt kê task (kèm MariaDB + SQLite chèn vào đâu; kế hoạch khởi tạo Tauri chuẩn
src-tauri/ + src/; script trích token từ HTML dựng src/lib/tokens.css; setup Playwright
+ cơ chế pixel diff so với HTML gốc; danh mục đầy đủ màn hình/modal/menu cần đối chiếu;
kế hoạch unit + integration + visual regression test) và DỪNG chờ tôi duyệt kế hoạch
trước khi viết dòng code đầu tiên.
