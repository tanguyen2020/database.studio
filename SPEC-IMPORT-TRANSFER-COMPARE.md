# SPEC — Import connections · Data Transfer · Data Compare

> Trạng thái (2026-11-11): **(B) Data Transfer ✅**, **(C) Data Compare ✅**, **(A) Import từ DBeaver ✅**
> (metadata-only, Hướng 1) — xem log chi tiết trong CLAUDE.md. **CÒN**: (A) Navicat + DataGrip; Hướng 2
> (migrate mật khẩu) chưa phê duyệt. Spec gốc (forward-looking) giữ nguyên bên dưới làm tham chiếu.
>
> Ba tính năng người dùng nêu thiếu:
> (A) Import connection từ DBeaver / Navicat / DataGrip, (B) Data transfer giữa các DB, (C) Data compare.
> Khuôn: additive-only như mọi engine/feature trước (xem `oracle-spec-rigor` trong memory). Nguồn sự thật
> cuối cùng là **code**; spec này điều hướng + chốt quyết định cần user duyệt trước khi code.
>
> **Bằng chứng đã đo trên máy dev (2026-11-10)** — không suy diễn:
> - DBeaver (có cài): `%APPDATA%/DBeaverData/workspace6/General/.dbeaver/data-sources.json` +
>   `credentials-config.json` — cấu trúc đọc được, xác nhận ở §A2.
> - Navicat Premium 16 (có cài): connection nằm trong **registry** `HKCU\Software\PremiumSoft\<product>\Servers\<name>`
>   (product = `Navicat`, `NavicatMONGODB`, `NavicatMSSQL`, …) — danh sách value name xác nhận ở §A3.
> - DataGrip: **không cài trên máy này** (chỉ có IntelliJ IDEA) → cấu trúc `.idea/dataSources.xml` theo tài
>   liệu JetBrains, **phải kiểm trên DataGrip thật trước khi chốt** (§A4, đánh dấu [CẦN XÁC MINH]).

---

## PHẦN A — Import connections từ DBeaver / Navicat / DataGrip

### A0. Phạm vi & quyết định chốt

**Bài toán**: dev chuyển từ công cụ cũ sang Database Studio có sẵn 30–50 connection (host/port/user/db + SSH
tunnel + SSL). Nhập tay từng cái là rào cản chuyển đổi.

**Nguyên tắc (giống Export/Import Connections đã làm)**: app import **metadata** (host, port, database, user,
môi trường, SSH, SSL — đều là plaintext trong file/registry của công cụ cũ) và tạo connection như tạo tay.
Mật khẩu là phần nhạy cảm, tách riêng ở §A5.

**ĐÃ CÓ NỀN** (đừng làm lại): tính năng **Export / Import Connections** (file v2, Argon2id + AES-256-GCM) +
`connections.applyImported` + màn review (Add / Update / Keep mine, chống trùng theo `targetKey`) + nút toolbar
Import/Export. Import-from-tool **tái dùng toàn bộ màn review + applyImported**; chỉ thêm *nguồn đọc* mới.

**Ràng buộc §A0.1 (cách ly)**: chỉ thêm module đọc file công cụ ngoài + 1 bước nguồn trong dialog Import.
KHÔNG đụng đường export/import nội bộ, KHÔNG đổi `ConnectionProfile`, KHÔNG đổi `applyImported`.

### A1. Luồng người dùng

Menu Import connections (đã có) → bước 1 chọn **nguồn**:
- **A Database Studio file** (đường cũ, giữ nguyên).
- **DBeaver** — Auto-detect (dò thư mục workspace mặc định) HOẶC Choose folder/files (`.dbeaver` hoặc 2 file
  JSON chép từ máy khác).
- **Navicat** — Auto-detect (đọc registry trên Windows; macOS: `~/Library/Application Support/PremiumSoft CyberTech/`
  — [CẦN XÁC MINH khi có macOS]) HOẶC Choose a Navicat `.ncx` export file.
- **DataGrip / JetBrains IDE** — Auto-detect (quét `%APPDATA%/JetBrains/*/` tìm project có `dataSources.xml`,
  hoặc `~/.config/JetBrains` trên Linux) HOẶC Choose a `dataSources.xml`.

Sau khi đọc nguồn → **cùng màn review** của Import Connections (mỗi dòng: engine · target · trạng thái mật khẩu ·
Add/Update/Keep mine) → Import → `applyImported`.

### A2. DBeaver — cấu trúc đã xác nhận trên máy

`data-sources.json` (JSON, plaintext):
```
{ folders{}, connections{ <id>: {
    provider, driver, name, save-password,
    configuration: { host, port, database, url, configurationType, type,
                     auth-model, config-profile,
                     handlers: { ssh_tunnel: { type, enabled, save-password,
                                 properties?: {host,port,authType,keyPath,…} } } } } },
  network-profiles{ <id>: { name, handlers{ ssh_tunnel{ properties{host,port,authType,keyPath,…} } } } } }
```
- `provider` → `SystemType` qua bảng map (`postgresql→postgres`, `mysql→mysql`, `mariaDB→mariadb`,
  `mssql/sqlserver→mssql`, `sqlite→sqlite`, `oracle→oracle`, `clickhouse→clickhouse`, `mongodb→mongodb`,
  `cassandra→cassandra`, `redis→redis`). Provider lạ → bỏ qua dòng + ghi "unsupported engine".
- Khi `configurationType = URL` và chỉ có `url` (JDBC) → parse `url` ra host/port/db; parse thất bại → giữ dòng
  nhưng đánh dấu "needs host" (import vẫn được, user sửa sau).
- SSH: `handlers.ssh_tunnel` inline HOẶC trỏ `network-profiles[config-profile]` → map sang `ssh{enabled,host,port,user,auth,key_path}`.
- `credentials-config.json`: **đã mã hoá AES** bằng một khoá cố định dùng chung mọi bản DBeaver (không gắn máy →
  file chép sang máy khác vẫn mở được). Xem §A5 về chính sách.

### A3. Navicat — cấu trúc đã xác nhận (registry Windows)

`HKCU\Software\PremiumSoft\<product>\Servers\<name>` — product tách theo engine (`Navicat` = MySQL/MariaDB/PG/…,
`NavicatMSSQL`, `NavicatMONGODB`, `NavicatPG`, `NavicatORA`, `NavicatSQLITE`…). Value name xác nhận:
- Chung: `ServiceProvider` (vd `spDefault`), `Host`, `Port`, `UserName`, `Pwd`, `AskPassword`, `Codepage`.
- SSL: `UseSSL`, `ClientKey`, `ClientCert`, `CACert`, `VerifyCACert`, `AllowInvalidHostName`, `PGSSLMode`.
- SSH: `UseSSH`, `SSH_Host`, `SSH_Port`, `SSH_UserName`, `SSH_AuthenMethod` (`saPassword`/`saPublicKey`),
  `SSH_PrivateKey`, `SSH_Password`, `SSH_Passphrase`.
- HTTP tunnel: `UseHTTP`, `HTTP_URL` (Database Studio chưa hỗ trợ HTTP tunnel → bỏ qua + ghi chú).
- MongoDB (product `NavicatMONGODB`): `UseSRVRecord`, `ReplicaSetName`, `AuthSource`, `AuthMechanism`,
  `ReadPreference`, `RetryWrites` → map sang option Mongo.
- Map engine theo product + `ServiceProvider`. `Pwd`/`SSH_Password` xem §A5.
- Navicat cũng có **file export `.ncx`** (XML người dùng tự xuất) — nhận cả đường này cho macOS/Linux + chuyển máy.

### A4. DataGrip / JetBrains — [CẦN XÁC MINH trên DataGrip thật]

Theo tài liệu JetBrains: `<project>/.idea/dataSources.xml` (+ `dataSources.local.xml`) — XML:
```
<data-source name uuid>
  <driver-ref>postgresql</driver-ref>
  <jdbc-url>jdbc:postgresql://host:5432/db</jdbc-url>
  <user-name>…</user-name>
  <ssh-properties>…</ssh-properties>
</data-source>
```
- Metadata import được (parse `jdbc-url`). **Mật khẩu KHÔNG nằm trong file** — DataGrip cất trong OS credential
  store (Windows Credential Manager / macOS Keychain) hoặc KeePass `c.kdbx`. → §A5: DataGrip luôn prompt-on-connect.
- Máy dev không có DataGrip → phải cài bản thử + lưu vài connection để kiểm trước khi code phần này.

### A5. Mật khẩu — chính sách (QUYẾT ĐỊNH CẦN USER DUYỆT)

Đây là mục nhạy cảm nhất. Hai hướng, user chốt:

**Hướng 1 (mặc định đề xuất — an toàn, làm ngay được): metadata-only + prompt-on-connect.**
- Import đủ host/port/user/db/SSH/SSL. Mật khẩu để trống.
- Lần Connect đầu tiên → hộp hỏi mật khẩu (tính năng **"hộp nhập mật khẩu khi kết nối"** đã nằm trong lộ trình
  Export/Import, dùng chung — có checkbox "Save password" vào keychain hoặc chỉ dùng cho phiên).
- Màn review ghi rõ mỗi dòng: "Password: will ask on connect".
- Ưu điểm: không đọc/giải mã kho mật khẩu của app khác; không rủi ro pháp lý/bảo mật; dùng được cho cả 3 tool.

**Hướng 2 (opt-in, cần security review riêng): migrate cả mật khẩu đã lưu.**
- Chỉ bật khi user tick rõ "Also import saved passwords" trong dialog.
- DBeaver: khả thi (khoá cố định, file portable). Navicat/DataGrip: phụ thuộc kho mật khẩu của hệ điều hành/
  master password → không chắc, có máy hỏi quyền.
- **Spec này KHÔNG mô tả thuật toán/khoá giải mã** — đó là hạng mục tách riêng, làm sau khi user chốt Hướng 2
  và review bảo mật. Ghi lại: safety classifier đã chặn việc dò thuật toán Navicat trong phiên review → coi
  Hướng 2 là **chưa phê duyệt** cho tới khi có quyết định rõ ràng của user.

**Chốt mặc định: Hướng 1.** Import-from-tool v1 = metadata-only; dòng nào tool cũ có mật khẩu thì vẫn chỉ hiện
"will ask on connect". File SSH key / TLS cert: chỉ chép **đường dẫn** (như Export/Import đã làm); báo nếu
đường dẫn không tồn tại trên máy này.

### A6. Backend / Frontend

- **Backend** `commands/import_tools.rs` (mới): `detect_external_sources()` → `[{tool, label, path, count}]`
  (dò workspace DBeaver, registry Navicat, project JetBrains); `read_external_source(tool, path)` →
  `Vec<ImportItem>` **không mật khẩu** (cùng shape `ImportItem` của Import Connections: profile +
  has_password:false + missing_files). Registry Navicat đọc qua crate `winreg` (Windows-only, `#[cfg(windows)]`).
  Parse DBeaver JSON / DataGrip XML thuần Rust (serde_json / một XML reader nhẹ). Đăng ký ở `lib.rs`.
- **Frontend**: dialog Import thêm bước chọn nguồn + gọi `detect`/`read`; phần còn lại (review + applyImported)
  dùng lại. Pure `src/lib/connections/import-dbeaver.ts` / `import-navicat.ts` / `import-datagrip.ts`
  (map provider→SystemType + parse URL) unit-test được bằng fixture JSON/XML/registry-dump.

### A7. Kiểm thử

- Unit: map provider→SystemType đủ 3 tool; parse JDBC URL (có/không port/db, có tham số); SSH inline vs
  network-profile (DBeaver); value DWORD→bool (Navicat); dòng engine lạ bị bỏ + ghi lý do.
- Fixture thật (ẩn giá trị nhạy cảm): chép cấu trúc `data-sources.json` của máy dev (host/user thay bằng
  placeholder) + registry dump Navicat (value name, không value) + `dataSources.xml` mẫu.
- e2e: nguồn demo (`?importSource=dbeaver`) trả 3 connection → review → Import → cả 3 vào danh sách với
  "will ask on connect".
- **CÒN LẠI**: Hướng 2 (mật khẩu) chưa làm; DataGrip chưa kiểm máy thật; macOS/Linux path chưa kiểm.

---

## PHẦN B — Data Transfer giữa các DB

### B0. Phạm vi & nền đã có

**Bài toán**: chép dữ liệu từ bảng/schema/truy vấn ở connection này sang connection khác (cùng hoặc khác engine):
di trú (MySQL→PG), nhân bản staging→local, gộp dữ liệu.

**ĐÃ CÓ**: `CopyTableDialog.svelte` + `copy/types.ts` (**Copy Table to…**, T25) — chép **MỘT bảng** cross-connection:
`classifyType`→family→`mapColumnType` theo dialect đích, `buildCopyDdl` (genCreate dịch kiểu), đọc paged
`buildExportSelect` (PAGE=2000) + ghi `buildInsert`, progress + Cancel + verify `count(*)` ở đích. Frontend-
orchestrated qua 2 connection (không cần backend copy command).

**Data Transfer = mở rộng Copy Table thành wizard nhiều bảng + nhiều lựa chọn**, KHÔNG viết lại. Tái dùng
`copy/types.ts`, `export/query.ts::buildExportSelect`, `import/plan.ts::buildInsert`.

### B1. Luồng người dùng (wizard)

1. **Nguồn**: connection + chọn **nhiều bảng** (cả schema, hoặc 1 truy vấn SQL tuỳ ý → 1 bảng đích).
2. **Đích**: connection + schema/database. Cùng connection cũng được (chép giữa 2 schema).
3. **Cách tạo đích mỗi bảng**: Create (DDL dịch kiểu) / Create if not exists / Append (bảng có sẵn) /
   Replace (truncate rồi chèn) — mặc định "Create if not exists + Append".
4. **Tuỳ chọn**: on-conflict (reuse `import/plan.ts`: PG `ON CONFLICT DO NOTHING`, MySQL `INSERT IGNORE`,
   SQLite `INSERT OR IGNORE`); batch size; "Copy data" on/off (chỉ tạo cấu trúc); WHERE cho từng bảng; thứ tự
   bảng theo phụ thuộc FK (tạo cha trước — reuse `sql/scripts.ts::orderObjects` đã có).
5. **Preview**: DDL đích + số bảng + ước lượng dòng (COUNT per bảng).
6. **Run**: progress toàn cục (bảng i/N + dòng) + Stop + log từng bảng (copied / verify count / lỗi) — theo
   đúng khuôn **cửa sổ tiến trình Backup** (BackupProgressWindow) để đồng nhất.

### B2. Thiết kế

- **Frontend-orchestrated** như Copy Table (2 connection, không backend command mới). Store
  `transferWizard.svelte.ts` + `DataTransferDialog.svelte`. Pure `copy/plan.ts` (mới): từ danh sách bảng nguồn
  + lựa chọn → danh sách bước `{srcTable, destTable, mode, ddl, where, order}`; dùng `orderObjects` cho thứ tự FK.
- Mỗi bước: (tạo DDL nếu cần) → vòng paged `buildExportSelect`→`buildInsert` (PAGE 2000, Stop giữa chừng, bỏ
  file dở) → `count(*)` verify. Lỗi 1 bảng → dừng hoặc "continue on error" (tuỳ chọn), ghi vào log, không rollback
  các bảng đã xong (nói rõ với user — không có transaction xuyên bảng/xuyên connection).
- **Giới hạn kiểu dữ liệu cross-engine** (đã biết từ Copy Table follow-up): bytea/blob, json, array, geometry,
  enum — map "coarse family" nên có thể mất kiểu chính xác. Preview cảnh báo cột nào bị map lỏng. FK/index/
  default KHÔNG tự carry (chỉ cột + dữ liệu) — nhắc user dùng Generate Scripts nếu cần cấu trúc đầy đủ.
- **Streaming**: v1 giữ paged-in-memory (PAGE 2000) như Copy Table. Follow-up: đường streaming backend
  (`export.rs` đã có `stream_export` cho PG) để tránh buffer khi bảng cực lớn.

### B3. Lối vào

- Explorer: menu schema node → "Transfer data to…" (nhiều bảng); menu bảng → vẫn "Copy to…" (1 bảng, giữ nguyên).
- Có thể gộp: "Copy to…" mở cùng wizard với 1 bảng chọn sẵn.

### B4. Kiểm thử

- Unit `copy/plan.ts` (thứ tự FK, mode→DDL/insert, WHERE, skip-data). `copy/types.ts` đã có unit.
- Integration container thật: PG→PG (3 bảng có FK, thứ tự đúng, count khớp), MySQL→PG (map kiểu, count khớp),
  Append vào bảng có sẵn + on-conflict (reuse pattern `sqlite_accepts_copy_mapped_types` + import integration).
- e2e: wizard chọn 2 bảng demo → preview DDL → Run → progress → "copied N rows, verified".
- **CÒN LẠI**: streaming cho bảng rất lớn; carry FK/index (chỉ cột+data ở v1); geometry/enum map lỏng.

---

## PHẦN C — Data Compare (so dữ liệu từng dòng)

### C0. Phạm vi — đây là tính năng MỚI hoàn toàn

**Đã có `SchemaCompare`** (so **cấu trúc**: table/column/index/routine/trigger qua `compare/diff.ts` +
`compare/snapshot.ts` + `SchemaCompare.svelte`, sinh migration DDL). **Data Compare KHÁC hẳn**: so **nội dung
hàng** của 2 bảng (cùng/khác connection) → tìm dòng chỉ-có-ở-nguồn / chỉ-ở-đích / khác-giá-trị, rồi sinh SQL
đồng bộ (INSERT/UPDATE/DELETE). Grep xác nhận: chưa có module data-compare nào.

**Bài toán**: so staging vs prod một bảng, kiểm sau khi migrate/transfer, tìm drift dữ liệu.

### C1. Luồng người dùng

1. Chọn **bảng nguồn** (connection + schema + table) và **bảng đích** (connection + schema + table) — khác
   connection được.
2. Chọn **key columns** (mặc định = primary key của nguồn; cho sửa) + **cột so sánh** (mặc định tất cả cột
   chung; bỏ tick cột bỏ qua như `updated_at`).
3. Run → bảng kết quả 3 nhóm: **Only in source** (sẽ INSERT vào đích) · **Only in target** (sẽ DELETE ở đích) ·
   **Different** (sẽ UPDATE ở đích) + **Same** (đếm). Mỗi dòng Different mở được diff cột-by-cột (Source|Target).
4. Chọn nhóm/dòng → **Sync script** (INSERT/UPDATE/DELETE theo key) hoặc **Apply to target** (chạy ngay, có
   xác nhận + cảnh báo DELETE).

### C2. Thiết kế thuật toán (so sánh KHÔNG kéo cả 2 bảng vào RAM)

Vấn đề cốt lõi: bảng triệu dòng không thể buffer cả hai. Ba chiến lược, chọn theo kích thước:

- **C2a — Keyed hash merge (mặc định)**: cả 2 bên `SELECT <key>, <hash của cột so sánh> FROM t ORDER BY <key>`
  (hash = `md5(concat_ws(...))` per-dialect; PG `md5`, MySQL `MD5`, MSSQL `HASHBYTES`, SQLite `không có md5`→
  fallback kéo giá trị). Hai con trỏ chạy song song theo key đã sort → phân loại chỉ bằng (key, hash), chỉ giữ
  **key + hash** trong RAM (nhẹ), không giữ giá trị. Dòng Different cần hiển thị diff → lazy fetch 2 dòng theo key.
- **C2b — Full-value (bảng nhỏ, < ngưỡng N dòng)**: kéo cả 2, so trực tiếp — có sẵn giá trị cho diff.
- **C2c — Chunked by key range** (bảng cực lớn): chia theo khoảng key, so từng chunk — follow-up.

Pure `compare/data-diff.ts`: `classifyRows(srcKeyed, tgtKeyed)` → `{onlySrc[], onlyTgt[], different[], same}`
(merge 2 danh sách đã sort theo key) + `buildDataSync(diff, keyCols, system)` → INSERT/UPDATE/DELETE (reuse
`sql/rows.ts::sqlLiteral` + `import/plan.ts::buildInsert`). Backend chỉ cần `exec` sẵn có (SELECT hash + SELECT
theo key); không cần command mới nếu md5 làm ở SQL.

### C3. Ràng buộc / cảnh báo

- Key phải định danh duy nhất — nếu nguồn không có PK, bắt user chọn cột key, cảnh báo nếu trùng.
- Khác engine: hash phải so được → chuẩn hoá cách build hash 2 bên (cùng thứ tự cột, cùng cách nối, cùng
  xử lý NULL). Kiểu khác nhau (số 1 vs "1") có thể lệch hash → v1 hỗ trợ **cùng-engine chắc chắn**, cross-engine
  đánh dấu "beta" + so theo giá trị đã chuẩn hoá chuỗi.
- DELETE ở đích là thao tác phá huỷ → Apply bắt xác nhận, connection production bắt gõ tên bảng (như Drop/Backup).
- Mặc định **không** tự chọn DELETE (chỉ Only-in-source=INSERT + Different=UPDATE được tick sẵn; Only-in-target
  để user chủ động).

### C4. Backend / Frontend

- Backend: không command mới ở v1 (SELECT hash + SELECT theo key qua `exec_statement`/`exec_params`). Nếu cần
  nhanh hơn: command `table_row_hashes(conn, schema, table, keyCols, cmpCols)` stream (key,hash) — follow-up.
- Frontend: tab mới `data-compare` (types.ts + `tabs.openDataCompare` + nhánh App.svelte — đúng "3 chỗ" của
  recipe) + `DataCompareView.svelte` (reuse khung master–detail của SchemaCompare). Pure `compare/data-diff.ts`.

### C5. Kiểm thử

- Unit `data-diff.ts`: merge 2 danh sách keyed (onlySrc/onlyTgt/different/same đúng), key nhiều cột, NULL trong
  key, buildDataSync ra INSERT/UPDATE/DELETE đúng theo key + literal đúng dialect.
- Integration container thật: PG seed 2 bảng lệch 3 dòng (1 thêm/1 xoá/1 sửa) → classify đúng → apply sync →
  so lại bằng nhau; cross-engine MySQL↔PG (cùng dữ liệu → same; lệch → phát hiện).
- e2e: demo 2 bảng lệch → 3 nhóm hiện đúng số → chọn → Sync script có INSERT/UPDATE/DELETE → Apply (có xác nhận).
- **CÒN LẠI**: chunked-by-key cho bảng cực lớn; cross-engine chuẩn hoá hash (v1 beta); so theo khoảng thời gian/
  điều kiện WHERE.

---

## Thứ tự đề xuất (chờ user chốt)

1. **Data Transfer** (B) — nền Copy Table đã mạnh, mở rộng nhanh, giá trị cao.
2. **Data Compare** (C) — tính năng mới, thuật toán rõ, không cần backend mới ở v1.
3. **Import connections** (A) — làm DBeaver trước (metadata-only, kiểm được trên máy dev), rồi Navicat, rồi
   DataGrip (cần cài để kiểm). Mật khẩu: Hướng 1 (prompt-on-connect) trừ khi user chốt Hướng 2.
