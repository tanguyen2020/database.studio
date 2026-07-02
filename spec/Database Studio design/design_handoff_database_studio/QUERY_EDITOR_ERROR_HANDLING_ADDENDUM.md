# Query Editor — Bắt lỗi theo từng hệ (Dialect-aware Error Handling) — Spec Addendum

> Bổ sung cho `phase-1` (SQL Editor) và `phase-2` (SQL Editor bổ sung + autocomplete).
> Định nghĩa cách query editor **phát hiện và hiển thị lỗi theo đúng dialect từng hệ**:
> lỗi lúc gõ (trước khi chạy) và lỗi khi thực thi (chuẩn hóa + trỏ đúng vị trí). Khi mâu
> thuẫn về xử lý lỗi editor, file này ghi đè.

---

## 0. Nguyên tắc — 2 tầng, không lẫn lộn

Có 2 tầng bắt lỗi, vai trò khác nhau, KHÔNG được gộp:

- **Tầng 1 — Lint lúc gõ (advisory / cảnh báo):** best-effort, chạy client/near-client theo
  debounce. Chỉ để gợi ý sớm. **KHÔNG bao giờ chặn nút Run** vì lint có thể dương tính giả.
- **Tầng 2 — Lỗi khi thực thi (authoritative / chính xác):** lỗi thật do DB trả về khi chạy.
  Đây là nguồn đúng cuối cùng, được **chuẩn hóa** về một struct chung và trỏ về đúng vị trí
  trong editor.

Quy tắc vàng: lint chỉ vẽ squiggle/cảnh báo; quyết định đúng/sai cuối cùng thuộc về DB. Nếu
lint và DB mâu thuẫn, DB thắng, và phải hạ độ nhạy lint để bớt báo nhầm.

---

## 1. TẦNG 1 — Lint lúc gõ theo dialect

### 1.1. Kiểm tra cú pháp (syntax)
- Backend dùng **sqlparser-rs** (crate `sqlparser`) với đúng dialect cho nhóm SQL:
  Generic/PostgreSQL/MySQL/MSSQL/SQLite/ClickHouse. Gọi qua Tauri command theo debounce
  (~400ms sau khi ngừng gõ), parse-only (KHÔNG chạy DB), trả về vị trí token lỗi nếu có.
- Cassandra (CQL) và các đặc thù mà sqlparser không cover: dùng **rule pack** riêng (mục 1.2),
  không ép qua parser SQL.
- Parser lỗi/không chắc → im lặng, KHÔNG vẽ squiggle đỏ (tránh báo nhầm). Chỉ báo khi chắc.

### 1.2. Rule pack đặc thù từng hệ (semantic lint)
Ngoài cú pháp, mỗi hệ có bộ luật cảnh báo riêng (dựa trên spec + 2 addendum Cassandra/ClickHouse):

| Hệ | Cảnh báo lint đặc thù |
|---|---|
| PostgreSQL | dùng backtick thay `"`; `LIMIT` ok; kiểu `SERIAL` khi ALTER; RETURNING gợi ý |
| MySQL/MariaDB | quoting bằng backtick; `LIMIT` ok; cảnh báo `ONLY_FULL_GROUP_BY` (cột không trong GROUP BY) |
| MSSQL | dùng `TOP` thay `LIMIT` (cảnh báo nếu gõ LIMIT); `[ ]` cho định danh; cần `;` trước CTE |
| SQLite | ít kiểu dữ liệu (dynamic typing); cảnh báo dùng RIGHT/FULL JOIN ở bản cũ |
| ClickHouse | **không** `OFFSET` kiểu SQL; `UPDATE/DELETE` phải là `ALTER TABLE ... UPDATE/DELETE` (cảnh báo mutation async); không transaction; gợi ý `FINAL` cho ReplacingMergeTree |
| Cassandra (CQL) | **không JOIN / subquery** (báo lỗi rõ); `WHERE` chỉ trên partition/clustering key; nếu WHERE cột khác → cảnh báo cần index hoặc `ALLOW FILTERING`; không `OFFSET` |
| Redis/Kafka/NATS | editor này không dùng SQL — nếu là tab lệnh riêng, lint theo cú pháp lệnh tương ứng, không parse SQL |

### 1.3. Cảnh báo dựa trên schema (tái dùng cache autocomplete)
- Tên bảng/cột không tồn tại trong schema cache → squiggle vàng "Unknown table/column"
  (cảnh báo, không phải lỗi cứng — schema cache có thể cũ).
- Gợi ý sửa gần đúng (fuzzy) khi tên gần giống một object có thật.

### 1.4. Cảnh báo thao tác nguy hiểm
- `UPDATE`/`DELETE` **thiếu `WHERE`** → cảnh báo nổi bật (dễ xóa/sửa toàn bảng).
- `DROP`/`TRUNCATE`/`ALTER ... DROP` → cảnh báo cần xác nhận khi chạy.
- ClickHouse/Cassandra: cảnh báo theo ngữ nghĩa async/anti-pattern ở mục 1.2.

### 1.5. Output tầng 1
```
LintDiagnostic {
  severity: "error" | "warning" | "info",
  message: string,
  from: { line: number, col: number },   // 1-based, theo toàn bộ nội dung editor
  to:   { line: number, col: number },
  rule: string,                          // ví dụ: "cql.no_join", "danger.update_without_where"
  quickfix?: { title: string, replacement?: string }
}
```

---

## 2. TẦNG 2 — Lỗi khi thực thi (chuẩn hóa + trỏ vị trí)

### 2.1. Struct chuẩn (dùng chung mọi hệ)
```
QueryError {
  system: string,
  statement_index?: number,   // #N trong multi-statement, để gắn đúng sub-tab
  code?: string,              // mã lỗi native (SQLSTATE / errno / CH code / CQL type)
  message: string,            // message đã làm gọn, dễ đọc
  position?: { line: number, col: number },  // ánh xạ về TOÀN BỘ editor (đã cộng offset statement)
  hint?: string,              // gợi ý xử lý (nếu suy được từ mã lỗi)
  severity: "error" | "warning",
  raw: string                 // nguyên văn lỗi từ driver
}
```

### 2.2. Nguồn lỗi & khả năng lấy vị trí theo hệ

| Hệ | Mã lỗi | Vị trí lỗi | Ghi chú |
|---|---|---|---|
| PostgreSQL | SQLSTATE (vd 42P01 undefined_table, 42601 syntax) | **có** `position` (offset ký tự 1-based) → map ra line/col | chính xác nhất |
| MySQL | errno (1064 syntax, 1146 no table...) | không có offset; message có "near '...'" → best-effort | map statement-level nếu không parse được near |
| MariaDB | tương tự MySQL | tương tự | |
| MSSQL | error number + `Line L` | **có line** trong batch → cộng offset statement | không có col |
| SQLite | message text | thi thoảng có offset | phần lớn statement-level |
| ClickHouse | code + message | message thường kèm ngữ cảnh/vị trí | parse best-effort |
| Cassandra | loại exception (SyntaxError, InvalidRequest, Unauthorized, ReadTimeout...) | thường không có vị trí | statement-level + map loại lỗi sang message rõ |
| Redis/Kafka/NATS | lỗi lệnh/giao thức riêng | n/a | hiển thị message thô đã gọn |

### 2.3. Quy tắc ánh xạ vị trí
- Editor tách statement theo `;`. Mỗi statement có offset dòng đầu trong toàn bộ document.
  Khi driver trả line/position **trong 1 statement**, cộng offset để ra line/col **toàn document**,
  rồi highlight đúng chỗ.
- Không lấy được vị trí chính xác → gắn lỗi ở đầu statement tương ứng (`statement_index`), KHÔNG
  đoán bừa vị trí.
- Có `code` → tra bảng gợi ý `hint` (vd PG 42P01 → "Bảng không tồn tại. Kiểm tra schema hiện tại
  hoặc tên bảng."). Bảng hint theo từng hệ, mở rộng dần.

---

## 3. UI

- **Inline trong editor (CodeMirror lint extension):** squiggle đỏ cho error, vàng cho warning.
  Hover → tooltip message + rule + quickfix (nếu có). Gutter marker ở dòng lỗi.
- **Sau khi chạy:** lỗi tầng 2 vẽ squiggle đỏ tại `position`; nếu chỉ có statement-level thì
  highlight cả statement.
- **Messages tab / Error panel:** liệt kê lỗi từng statement (`#N`), mỗi dòng: severity · code ·
  message · (line:col). **Click → nhảy tới đúng vị trí** trong editor.
- **Multi-statement:** sub-tab `#N ✗ error` (đã có ở phase-1) liên kết với đúng `statement_index`;
  click sub-tab lỗi cũng nhảy tới statement đó.
- **Nút "View raw error":** mở nguyên văn lỗi driver (`raw`) cho người cần chi tiết.
- Lint (tầng 1) và execution error (tầng 2) phân biệt màu/nguồn rõ: lint là advisory, execution
  error là thật.

---

## 4. Slot vào phase

- **Phase 1:** khi làm SQL Editor, thêm hiển thị lỗi thực thi (tầng 2) ở mức cơ bản: chuẩn hóa
  QueryError + highlight statement lỗi + Messages tab click-to-jump (PG/MySQL/MSSQL).
- **Phase 2:** thêm **lint lúc gõ (tầng 1)** đầy đủ: sqlparser-rs debounce, rule pack per dialect,
  cảnh báo schema-aware (tái dùng cache autocomplete), cảnh báo thao tác nguy hiểm; và hoàn thiện
  ánh xạ vị trí (PG position, MSSQL line).
- Khi thêm ClickHouse/Cassandra (theo 2 addendum kia): bổ sung rule pack + mapping lỗi cho 2 hệ đó.

---

## 5. Definition of Done

- Gõ SQL sai cú pháp theo đúng dialect → squiggle đỏ hiện trong lúc gõ (best-effort), không chặn Run.
- Gõ `SELECT ... JOIN ...` ở connection Cassandra → lint báo "CQL không hỗ trợ JOIN".
- Gõ `LIMIT` ở MSSQL → lint gợi ý dùng `TOP`.
- `UPDATE`/`DELETE` thiếu `WHERE` → cảnh báo nổi bật.
- Chạy query lỗi trên PG → lỗi chuẩn hóa, highlight ĐÚNG vị trí (dùng position của PG).
- Chạy lỗi trên MSSQL → nhảy đúng dòng (dùng Line của MSSQL).
- Multi-statement: statement thứ 3 lỗi → sub-tab `#3 ✗`, click nhảy tới statement 3.
- Nút View raw hiện nguyên văn lỗi driver.
- Redis/Kafka/NATS: không parse SQL, không squiggle SQL nhầm.

---

## 6. Do NOT

- KHÔNG chặn nút Run vì lint tầng 1 (chỉ cảnh báo). DB là nguồn đúng cuối cùng.
- KHÔNG chỉ hiện lỗi thô của driver — luôn chuẩn hóa về QueryError; raw để sau nút View raw.
- KHÔNG đoán vị trí lỗi khi driver không cung cấp — gắn statement-level thay vì highlight sai chỗ.
- KHÔNG ép CQL/ClickHouse qua parser SQL chung rồi báo lỗi nhầm — dùng rule pack riêng.
- KHÔNG parse SQL cho tab Redis/Kafka/NATS.
- KHÔNG nối chuỗi khi gọi câu kiểm tra/validate — parse-only, không chạy câu của người dùng ở tầng 1.
