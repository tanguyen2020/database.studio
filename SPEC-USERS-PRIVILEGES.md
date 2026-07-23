# SPEC — Users / Roles & Privileges Manager (per-engine)

> Trạng thái: **ĐÃ IMPLEMENT (U0–U7, 8/8 engine).** Phần lõi khớp code; các lệch/thiếu đã đối chiếu ở **§0.0** (đọc trước tiên). Phần thân dưới đây giữ nguyên làm tài liệu thiết kế chi tiết + tham chiếu extension.
> Phạm vi (user đã chốt): **8 engine** — PostgreSQL, MySQL, MariaDB, MSSQL, ClickHouse, Cassandra, MongoDB, Oracle. Mỗi engine có **UI riêng** vì mô hình phân quyền/tạo user/password khác nhau hoàn toàn.
> **NGOÀI PHẠM VI (user chốt 2026-07-15): Redis, Kafka, NATS — không làm.** SQLite không có hệ thống user (§13, chỉ ẩn entry point).
> Quy tắc viết spec: mọi câu lệnh/catalog ghi **chính xác nguyên văn**; chỗ chưa chắc chắn 100% đánh dấu **[CẦN XÁC MINH]** kèm cách xác minh; không mơ hồ vì đây là phần cốt lõi để grant permission.
> Quy tắc code (khi làm): **additive-only, cách ly tuyệt đối theo §1.0 — không được ảnh hưởng tính năng khác**; UI text English, token-only styles, popup backdrop KHÔNG đóng, confirm in-app cho thao tác destructive, Refresh theo rule chung (spin + guard + re-query).

---

## 0.0 ĐỐI CHIẾU CODE (cập nhật 2026-07-22 — nguồn sự thật cho các lệch spec↔code)

> Feature đã hiện thực xong (U0–U7). Phần thân spec (§1–§17) phần LÕI khớp code, nhưng có một số lệch
> **có chủ đích** + vài khoảng thiếu thật. Khi thân spec mâu thuẫn với khối này, **khối này đúng** (bám code).

### Kiến trúc thực tế (khớp — bằng chứng)
- Tab type `'user-manager'` (`src/lib/types.ts:239`); `tabs.openUserManager(connId, focus?)` singleton
  (`stores/tabs.svelte.ts:466`); `UserManagerView.svelte:119-132` dispatch theo `tab.systemType`.
- Component per-engine ở **`src/lib/components/workspace/users/*.svelte`** (`PgUserManager`, `MySqlUserManager`,
  `MssqlUserManager`, `ClickHouseUserManager`, `CassandraUserManager`, `MongoUserManager`, `OracleUserManager`).
- Backend: `commands/users_admin.rs` — `pub fn users_query(system, view, arg) -> Option<String>` (`:58`,
  pure builder per engine) + command `users_view(conn_id, view, arg)` (`:308`) qua `registry.exec_statement`;
  đăng ký `lib.rs:180`; wrapper `ipc.usersView` (`ipc.ts:596`) + demo case (`demo.ts:438`).
- Escaper backend `quote_ident`/`quote_str`/`mysql_account` (`users_admin.rs:23-53`) + unit test (`:349`).
- §1.4b đường thực thi (khớp): MSSQL `is_raw_batch` mở rộng GRANT/DENY/REVOKE (`drivers/mssql.rs:744`,
  chỉ token đầu, có unit test); MySQL/MariaDB TEXT-protocol tránh 1295 (`drivers/mysql.rs:83`); Oracle
  filter-by-grantee né cap 100 (`users_admin.rs:259`).
- 3 entry point (toolbar Explorer / context-menu connection / AdminView "Manage…") + node Security trong
  cây (`ObjectExplorer.svelte:199` `secFolders`).
- Integration 6-bước §1.9 EXIT=0 cho **8/8 engine**: `pg_/mysql_/mariadb_/mssql_/clickhouse_/cassandra_
  user_manager_end_to_end` (`drivers_integration.rs`), `mongo_…` (`mongo_integration.rs`), Oracle
  `u6_user_manager_end_to_end` (`oracle_o0.rs:261`, `#[ignore]` — cần Instant Client).

### Lệch có chủ đích (spec nói A, code làm B — KHÔNG mất chức năng)
- **`MariaDbUserManager.svelte` KHÔNG tồn tại** (§1.1 liệt kê). MySQL+MariaDB dùng chung `MySqlUserManager`
  adapt theo `systemType` (`UserManagerView.svelte:121`).
- **3 dialog MSSQL riêng (§5.3) → gộp 1 `MssqlCreateDialog.svelte`** (mode login/user/role).
- **`NoUserSystem.svelte` (§13) KHÔNG tồn tại** — đúng chủ đích §17.2 (ẩn hẳn entry cho SQLite).
- **Cây §1.2c**: MSSQL `Security→Users/Roles` và MongoDB `Users` render ở **CẤP CONNECTION**, CHƯA nest
  trong từng database node như sơ đồ (`ObjectExplorer.svelte:1453` comment "connection-level nodes").

### Khoảng THIẾU thật (TODO — spec mô tả nhưng code CHƯA có)
- **MongoDB custom-role builder (§8.1/§8.2)**: code chỉ có **7 command** (`mongo_users`, `mongo_roles`,
  `mongo_create_user`, `mongo_change_password`, `mongo_drop_user`, `mongo_grant_roles`, `mongo_revoke_roles`).
  `mongo_user_detail` + `mongo_create_role`/`mongo_update_role`/`mongo_drop_role` CHƯA làm.
- **View backend còn thiếu** (spec liệt kê, `users_query` chưa có nhánh): MySQL `column_privs`; ClickHouse
  `grants_for`/`row_policies`/`quotas`/`settings_profiles`; Oracle `col_privs`. Ảnh hưởng hiển thị
  partial/inherited đúng như §1.8.5.

### Code CÓ nhưng spec THIẾU (bổ sung UX sau khi chốt spec — cần đưa vào thân khi rảnh)
- **Grant Access wizard dùng chung** cross-engine: `stores/grantwizard.svelte.ts:124` (`GrantWizardStore`,
  `GrantActionKind = 'grant'|'deny'|'revoke'`) + `GrantAccessDialog.svelte` (3 bước Role→Scope→Level +
  live SQL preview). Grid ma trận chi tiết chuyển xuống "Advanced".
- **Builder wizard-action per engine**: `accessStatement`/`parseGrantLevel`/`parseScope` (mysql.ts:161,
  clickhouse.ts:136), `parseSecurable`/`accessStatement` (mssql.ts:178), `parseResource`/`resourceAccessStatement`
  (cassandra.ts:137), `objectAccessStatement`/`parseOwnerObject` (oracle.ts:134).
- **Tab "Access" per engine** (hiển thị principal thấy DB/schema nào + quyền gì) — không có trong §1.8.6.
- **PG Grant access multi-database** (scope2 Databases, `grantwizard.svelte.ts:25 GrantGroup`,
  apply qua `attach_database` sub-connection).
- **Grid-column constants** `PG_/MYSQL_/CH_/MSSQL_/CASS_GRID_COLUMNS` + `grantColumn`/`revokeColumn`/`denyColumn`.
- Chi tiết các bổ sung này: xem `CLAUDE.md` phần "USERS & PRIVILEGES" (các mục UX/Grant-wizard/Access-tab).

### Điểm mở rộng — thêm 1 engine mới vào User Manager
1. `src/lib/users/<engine>.ts` — pure builders (createUser/alterPassword/drop/grant/revoke/…), unit-test.
2. `commands/users_admin.rs::users_query` — thêm nhánh `("<engine>", view)` trả SQL introspection (hoặc
   dùng cơ chế riêng như Cassandra `cql_exec` / Mongo command nếu không SQL).
3. `src/lib/components/workspace/users/<Engine>UserManager.svelte` + dialog tạo (popup, §1.2 rule) + store.
4. `UserManagerView.svelte` — thêm nhánh dispatch `systemType`.
5. Command mới (nếu có) → đăng ký `lib.rs` + `ipc.ts` + `demo.ts`.
6. `ObjectExplorer.svelte` `secFolders` — thêm cấu hình node Security (thuật ngữ bản địa).
7. Integration `<engine>_user_manager_end_to_end` đủ 6 bước §1.9 trên container thật.

---

## 0. Hiện trạng & khoảng cách (đã verify trong code)

| Engine | Hiện có | File |
|---|---|---|
| postgres | View read-only `users` = `pg_roles` (5 cột) | `commands/admin.rs:63-66` |
| mysql/mariadb | View read-only `users` = `mysql.user` (user/host/super) | `admin.rs:68-72` |
| mssql | View read-only `users` = `sys.server_principals` (logins only) | `admin.rs:73-76` |
| clickhouse | View read-only `users` = `system.users` (name/storage/auth_type) | `admin.rs:114-116` |
| mongodb | View read-only `users` = `usersInfo: 1` qua driver | `admin.rs:194-207`, `drivers/mongo.rs:1233,1300` |
| oracle | View read-only `users` = `dba_users` | `admin.rs:136-139` |
| cassandra / sqlite | **Không có gì** | — |
| redis / kafka / nats | **NGOÀI PHẠM VI spec này** (user chốt không làm; Kafka ACL + NATS NKey-JWT vẫn giữ trạng thái Deferred từ T23) | — |

**Gap:** không engine nào có create/alter/drop user, đổi password, grant/revoke, quản lý role membership. Spec này bổ sung **User Manager** đầy đủ, giữ nguyên view read-only cũ trong AdminView (additive).

---

## 1. Kiến trúc chung (mọi engine dùng chung khung này)

### 1.0 RÀNG BUỘC CÁCH LY — chỉ thêm Users/Privileges, KHÔNG ảnh hưởng tính năng khác (user chốt 2026-07-15)

Toàn bộ feature là **additive-only**, khoanh vùng như precedent Cassandra C1–C5 / MongoDB M6 ("chỉ thêm match-arm/hàm/component mới; field mới trên type dùng chung là optional"):

**Được phép đụng file dùng chung — CHỈ theo kiểu thêm-dòng:**
| File | Kiểu sửa duy nhất được phép |
|---|---|
| `src-tauri/src/lib.rs` | Thêm dòng command mới vào `invoke_handler!` |
| `src/lib/ipc.ts` / `src/lib/demo.ts` | Thêm wrapper/case mới |
| `src/lib/types.ts` | Thêm `'user-manager'` vào union `TabContentType` |
| `src/App.svelte` | Thêm 1 nhánh `{:else if}` paneBody + mount dialog mới |
| `src/lib/stores/tabs.svelte.ts` | Thêm method `openUserManager` (không sửa method cũ) |
| `ObjectExplorer.svelte` | **Chỉ APPEND node Security mới** vào cuối các section hiện có (theo bảng §1.2c); KHÔNG sửa loop schema/table/foreign-db/streaming hiện hành, KHÔNG đổi key/expand state cũ |
| `storage/mod.rs` | Không đụng (spec này không còn bảng mới sau khi bỏ vault) |

**Cấm tuyệt đối:** refactor explorer loops; sửa `results.run`/exec path/registry; sửa `admin.rs` hiện có (`users_query` là MODULE MỚI `users_admin.rs`, AdminView giữ nguyên nguyên trạng); đổi CSS/token của component dùng chung; đổi hành vi tab/close/restore hiện có.

**Ngoại lệ duy nhất đụng hành vi dùng chung — MSSQL `is_raw_batch` (§1.4):** mở rộng regex routing sang `CREATE/ALTER/DROP LOGIN|USER|ROLE` + `GRANT/DENY/REVOKE` ảnh hưởng cả SQL editor path (statement cùng loại gõ tay cũng chuyển sang `simple_query`). Chấp nhận vì: các statement này không trả result set (raw batch tương đương ngữ nghĩa) và cùng lớp fix đã làm ở AUDIT-9 (CREATE OR ALTER PROC). Bù lại **bắt buộc**: unit test regex (không bắt nhầm `GRANTED`/tên bảng chứa "grant"…), chạy lại TOÀN BỘ integration MSSQL hiện có (`mssql_roundtrip`, `mssql_table_designer…`, `mssql_alter_and_execute_objects…`, `mssql_admin_sessions…`) EXIT=0 trước khi merge phase U3.

**Gate hồi quy mỗi phase (ngoài gate thường trực §15):** chạy **FULL suite** vitest + playwright (không chỉ spec mới — baseline hiện tại phải giữ nguyên số pass, 2 fail pre-existing kafka/nats-workspace không tăng); pixel-diff `phase2-regions` không đổi (node cây mới chỉ render khi connected — demo seed phải giữ trạng thái mặc định của các spec visual cũ); `cargo test --lib` toàn bộ (không chỉ module mới).

### 1.1 Tab & entry point

- Tab type mới `'user-manager'` (`src/lib/types.ts` `TabContentType`) + `tabs.openUserManager(connId)` (singleton per connection — mở lại thì activate) + nhánh `{:else if}` trong `App.svelte` `paneBody` (rule 3-edits của workspace tab).
- `UserManagerView.svelte` = shell dispatch theo `tab.systemType` → component per-engine:

| systemType | Component | Ghi chú |
|---|---|---|
| postgres | `users/PgUserManager.svelte` | |
| mysql | `users/MySqlUserManager.svelte` | |
| mariadb | `users/MariaDbUserManager.svelte` | Tách riêng khỏi MySQL (khác roles catalog, auth plugin, SET DEFAULT ROLE syntax — §3 vs §4) |
| mssql | `users/MssqlUserManager.svelte` | 2 tầng Login/User |
| clickhouse | `users/ClickHouseUserManager.svelte` | |
| cassandra | `users/CassandraUserManager.svelte` | |
| mongodb | `users/MongoUserManager.svelte` | |
| oracle | `users/OracleUserManager.svelte` | |
| redis / kafka / nats | — | **NGOÀI PHẠM VI** — không có component, entry point ẩn cho 3 hệ này |
| sqlite | — | Không có hệ thống user — entry point ẩn (§13) |

- Entry points: (a) nút "Users & privileges" trong Explorer toolbar (đang mở AdminView) → đổi thành mở `user-manager` **[QUYẾT ĐỊNH: đổi hẳn hay thêm nút mới? — đề xuất: đổi hẳn, AdminView vẫn còn tab Users read-only]**; (b) context menu connection "Users & Privileges…"; (c) trong AdminView tab Users thêm nút "Manage…".

### 1.2 Layout chuẩn per-engine (điều chỉnh theo mô hình từng engine)

```
┌────────────────────────────────────────────────────────────┐
│ [scope selector nếu engine có]        N principals  ⟳ Refresh │
├──────────────┬─────────────────────────────────────────────┤
│ Principals   │ Detail của principal đang chọn               │
│ (Users|Roles │  Tabs: General · Membership · Privileges ·   │
│  toggle nếu  │        [engine-specific]                     │
│  tách 2 loại)│                                              │
│ + New User   │  Mọi thao tác sửa → khối "Pending changes"   │
│ + New Role   │  hiện SQL/command preview (highlightSql)     │
│              │  [Execute] [Discard]                         │
└──────────────┴─────────────────────────────────────────────┘
```

- **Mọi mutation đều 2 bước**: build statement → hiện preview → user bấm Execute. Không chạy ngầm.
- **RULE: mọi action New/Create/Add (user, role, login, account, grant entry…) = POPUP DIALOG, KHÔNG mở tab** (user chốt 2026-07-15). Dialog theo đúng khuôn wizard sẵn có (ImportDialog/ExportDialog/CopyTableDialog: store wizard + component mount ở `App.svelte`, backdrop KHÔNG đóng, Escape/Cancel đóng, `$state`+`$effect` open-flag theo bẫy Svelte 5 đã ghi ở T31). Trong dialog có SQL/command preview + nút Execute; thành công → đóng dialog + refresh node cây/list liên quan. Tab User Manager chỉ dùng để **xem/sửa principal ĐÃ tồn tại** (Properties, grants, membership).

### 1.2b Tích hợp cây ObjectExplorer (thuật ngữ theo tool bản địa của từng engine — user đã chốt)

Ngoài tab User Manager, **cây Explorer có node Security per-engine**, đặt tên ĐÚNG thuật ngữ tool bản địa (SSMS/pgAdmin/Workbench/SQL Developer) để người dùng quen tay. Node lazy-load qua `users_query`; hành vi chung: single-click = select (publish Properties), **double-click principal = mở User Manager tab focus đúng principal đó**; context menu per node ghi ở bảng dưới. Chỉ render khi connected; ẩn hoàn toàn với sqlite/redis/kafka/nats.

| Engine | Vị trí & cấu trúc node trong cây | Context menu |
|---|---|---|
| **postgres** | Node **`Login/Group Roles`** ở **cấp connection, ngang hàng section Databases** (theo pgAdmin). Con = từng role; icon phân biệt **Login role** (person) vs **Group role** (2-person, `rolcanlogin=false`); badge SUPER | Node cha: `Create Login/Group Role…` · `Refresh`. Role con: `Properties…` (mở tab focus) · `Change Password…` · `Drop…` |
| **mssql** | **2 tầng đúng SSMS**: (a) node **`Security`** cấp connection → **`Logins`** + **`Server Roles`** (fixed, read-only list); (b) **trong mỗi database node** → **`Security`** → **`Users`** + **`Roles`** (Database Roles; fixed đánh dấu khoá) — schemas đã có sẵn trong cây, không lặp lại | `Logins`: `New Login…`; login con: `Properties…` · `Disable/Enable` · `Drop…`. `Users`: `New User…` (map từ Login); `Roles`: `New Role…`; member con: `Properties…` · `Drop…` |
| **mysql / mariadb** | Node **`Users and Privileges`** ở cấp connection (theo Workbench — MySQL không có tree per-DB cho user). Con = account `user@host`; MariaDB tách 2 folder con **`Users`** / **`Roles`** (nhờ cờ `is_role`) | Node cha: `Add Account…` · `Refresh`. Account con: `Properties…` · `Change Password…` · `Lock/Unlock` · `Drop…` |
| **oracle** | Node **`Other Users`** ở cấp connection (theo SQL Developer) — con = từng user (badge account_status: OPEN/LOCKED/EXPIRED); node **`Roles`** ngang hàng (list `dba_roles`) | `Other Users`: `Create User…`; user con: `Properties…` (dialog tabs §10.2b) · `Change Password…` · `Lock/Unlock` · `Drop…`. `Roles`: `Create Role…` / `Drop…` |
| **clickhouse** | Node **`Access (Users & Roles)`** cấp connection → 2 folder `Users` / `Roles` (khớp RBAC của CH) | `New User…` / `New Role…` / `Properties…` / `Drop…` |
| **cassandra** | Node **`Roles`** cấp connection (Cassandra chỉ có 1 loại principal) | `Create Role…` / `Properties…` / `Drop…` |
| **mongodb** | Node **`Users`** đặt **trong từng database node** (user thuộc authentication database — đúng mô hình Mongo) + folder `Roles` (custom roles của db đó) | `Add User…` / `Properties…` / `Change Password…` / `Drop…`; `Roles`: `Create Role…` / `Drop…` |

Mọi action mutation từ context menu đều đi qua **cùng builder + preview + confirm** của User Manager (không có đường tắt chạy thẳng). Mọi item `New…/Create…/Add…` trong bảng trên mở **popup dialog** (rule §1.2), KHÔNG mở tab; `Properties…`/double-click mới mở tab User Manager. e2e per engine phải cover: node hiện đúng tên/vị trí, double-click mở tab focus đúng principal, context menu đủ item, item New mở dialog (không sinh tab mới).

### 1.2c Sơ đồ cây per-engine (vị trí chính xác trong ObjectExplorer hiện tại)

Node mới đánh dấu `◄ NEW`. Cấu trúc cũ (databases/schemas/Tables…) giữ nguyên 100%.

**PostgreSQL** — `Login/Group Roles` cấp connection, ĐẶT SAU các database node (pgAdmin đặt ngang hàng Databases):
```
▾ 🐘 pg-prod (postgres)
   ▾ ● appdb  (current database)
      ▾ public
         ▸ Tables · Views · Stored Procedures · Functions · Triggers · Sequences
   ▸ analytics            (database khác — foreign-db subtree sẵn có)
   ▸ sales
   ▾ Login/Group Roles                                   ◄ NEW
      👤 postgres              [SUPER]                    (login role)
      👤 app_user
      👥 readonly_group                                   (group role — rolcanlogin=false)
      👥 admins               [CREATEROLE]
```

**MSSQL** — 2 tầng đúng SSMS: `Security` cấp server (sau databases) + `Security` TRONG từng database node:
```
▾ 🗄 mssql-prod (mssql)
   ▾ ● AppDb  (current database)
      ▾ dbo
         ▸ Tables · Views · …
      ▾ Security                                          ◄ NEW (per-database)
         ▾ Users
            app_user            (login: app_login · schema: dbo)
            report_user
         ▾ Roles
            🔒 db_owner · db_datareader · db_datawriter · …   (fixed — khoá, không drop)
            custom_audit_role
   ▸ SalesDb                    (foreign db — expand ra cũng có Security → Users/Roles trên sub-connection)
   ▾ Security                                             ◄ NEW (server-level)
      ▾ Logins
         sa                    [SQL]
         app_login             [SQL]
         DOMAIN\svc_etl        [Windows]
         old_login             [SQL · disabled]
      ▾ Server Roles           (fixed, read-only list — quản lý member qua Login Properties)
         sysadmin · serveradmin · securityadmin · dbcreator · …
```

**MySQL** — 1 node phẳng cấp connection (Workbench-style; account = `user@host`):
```
▾ 🐬 mysql-prod (mysql)
   ▸ appdb                     (schema-as-database nodes sẵn có)
   ▸ sales
   ▾ Users and Privileges                                 ◄ NEW
      👤 root@localhost
      👤 app@%
      👤 etl@10.0.0.%          [locked]
      👤 reporting@%                        (đang được grant như role — MySQL không có cờ is_role, xem §3)
```

**MariaDB** — như MySQL nhưng tách 2 folder chính xác nhờ `is_role`:
```
▾ 🦭 mariadb-prod (mariadb)
   ▸ appdb
   ▾ Users and Privileges                                 ◄ NEW
      ▾ Users
         root@localhost
         app@%
      ▾ Roles                              (is_role='Y' — không có host hiển thị)
         read_only
         dba_junior
```

**Oracle** — `Other Users` + `Roles` cấp connection (SQL Developer):
```
▾ 🔶 ora-prod (oracle · FREEPDB1)
   ▸ HR                        (schema nodes sẵn có)
   ▸ SALES
   ▾ Other Users                                          ◄ NEW
      SYSTEM                  [OPEN]
      APP_USER                [OPEN]
      OLD_SVC                 [LOCKED]
      TMP_USER                [EXPIRED]
   ▾ Roles                                                ◄ NEW
      CONNECT · RESOURCE · DBA
      APP_READ_ROLE
```

**ClickHouse** — `Access (Users & Roles)` cấp connection:
```
▾ ⚡ ch-prod (clickhouse)
   ▸ default                   (database nodes sẵn có)
   ▸ analytics
   ▾ Access (Users & Roles)                               ◄ NEW
      ▾ Users
         default              [users.xml — read-only]     (badge theo system.users.storage)
         app                  [local_directory]
      ▾ Roles
         readers
         writers
```

**Cassandra** — 1 node `Roles` cấp connection (chỉ 1 loại principal):
```
▾ 💠 cass-prod (cassandra)
   ▸ app_keyspace              (keyspace nodes sẵn có)
   ▾ Roles                                                ◄ NEW
      cassandra               [SUPER · LOGIN]
      app_role                [LOGIN]
      analysts                                            (group — LOGIN=false)
```

**MongoDB** — `Users` + `Roles` nằm TRONG từng database node (user thuộc authentication database):
```
▾ 🍃 mongo-prod (mongodb)
   ▾ appdb
      ▸ orders · customers     (collection nodes sẵn có)
      ▾ Users                                             ◄ NEW (per-database)
         app                  [readWrite@appdb]
         analyst              [read@appdb]
      ▾ Roles                                             ◄ NEW (custom roles của db này)
         reportRole
   ▾ admin
      ▾ Users
         root                 [root@admin]
```

Quy ước chung cho mọi sơ đồ trên: single-click principal = select (publish Properties panel); **double-click = mở User Manager tab focus principal đó** (chỉ principal ĐÃ tồn tại); right-click = context menu §1.2b — **mọi item `New…/Create…/Add…` mở POPUP dialog (rule §1.2), không bao giờ mở tab**; folder có `Refresh` theo Refresh rule chung; sqlite/redis/kafka/nats không render bất kỳ node nào ở trên.
- **Destructive** (DROP USER/ROLE, REVOKE ALL, dropUser…) → confirm dialog in-app (rule chung, backdrop không đóng, nút Cancel/Confirm).
- **Password**: input `type="password"` + nút reveal (chỉ lúc đang nhập); trong SQL preview mặc định thay bằng `•••` , toggle "Show password in preview" mới hiện thật. Toast/error message **không bao giờ** chứa password (precedent redact: `connections/aad.rs`). **Không lưu/không xem lại password sau khi tạo** (user chốt 2026-07-15 — server cũng chỉ lưu hash, không thể đọc lại).
- **Không ghi query history**: mọi statement user-management chạy qua `ipc.execStatement`/`cqlExec`/command riêng — các path này vốn không ghi history (history chỉ ghi trong `results.run`). Ghi rõ trong test: sau khi tạo user, `query_history` không chứa password.

### 1.3 Backend — reads (pattern `admin.rs` mở rộng)

Module mới `src-tauri/src/commands/users_admin.rs`:
- `pub fn users_query(system: &str, view: &str, arg: Option<&str>) -> Option<String>` — pure builder trả SQL per (system, view), unit-test được y hệt `admin_query` (`admin.rs:34`). `arg` = tên principal cho các view per-user (được escape bằng escaper backend §1.5).
- Command `#[tauri::command] users_view(conn_id, view, arg) -> QueryResultSet` — orchestration giống `admin_view` (`admin.rs:162`): resolve system → SQL → `registry.exec_statement`. MongoDB **không** đi qua đây (có command riêng §8).
- Đăng ký `invoke_handler!` trong `src-tauri/src/lib.rs` (command chết nếu thiếu) + wrapper `ipc.usersView` + case trong `demo.ts` (bắt buộc, nếu không vitest/playwright vỡ).

Danh sách `view` hợp lệ per engine ghi ở từng section §2–§10 (bảng "Introspection").

### 1.4 Frontend — mutations (SQL engines): pure builders + preview

- Module per-engine `src/lib/users/<engine>.ts` — **pure functions** sinh statement, unit-test bằng Vitest (theo precedent `sql/ddl.ts`, `sql/routines.ts`, `sql/indexes.ts`).
- Execute qua path sẵn có: `ipc.execStatement` (PG/MySQL/MariaDB/MSSQL/ClickHouse/Oracle), `ipc.cqlExec` (Cassandra). MongoDB dùng command backend riêng (§8) vì không phải SQL.
- **MSSQL routing (bắt buộc, driver fix)**: `mssql.rs` hiện route `CREATE/ALTER/DROP` DDL qua `simple_query` (`is_raw_batch`, AUDIT-9). Phải **mở rộng `is_raw_batch`** cover `CREATE LOGIN/USER/ROLE`, `ALTER LOGIN/ROLE/SERVER ROLE`, `DROP LOGIN/USER/ROLE`, và **`GRANT`/`DENY`/`REVOKE`** (sp_executesql chạy được GRANT nhưng để đồng nhất + tránh bẫy batch, route hết qua raw batch). Unit test regex + integration chứng minh.

### 1.4b ★ Đường thực thi per engine — statement PHẢI CHẠY THẬT (chống bẫy driver, đã verify code)

Đây là điểm dễ "im lặng không chạy" nhất — mỗi driver có cơ chế gửi lệnh khác nhau. Bảng dưới ghi **chính xác method + file:line đã verify** để CREATE USER / GRANT / REVOKE thực sự chạy được, không phải giả định.

| Engine | Statement user-mgmt chạy qua | Cơ chế thật (đã verify) | Bẫy đã chặn |
|---|---|---|---|
| **PostgreSQL** | `registry.exec_statement` → `PgDriver.exec` | sqlx simple query | CREATE ROLE là **cluster-level** (chạy trên connection nào cũng được); GRANT ON SCHEMA/TABLE là **per-database** → phải chạy trên sub-connection `{conn}::{db}` đúng DB (§1.8.3). Sai DB = grant vào nhầm catalog, "im lặng sai" |
| **MySQL / MariaDB** | `registry.exec_statement` → `MySqlDriver.exec` → **`fetch_all` (TEXT protocol / COM_QUERY)** | **verified `mysql.rs:83,514-523`** — comment sẵn: prepared protocol trả lỗi **1295** cho nhiều lệnh admin; Executor với `arguments=None` gửi COM_QUERY | **BẮT BUỘC KHÔNG dùng `exec_params`** cho user-mgmt (path đó prepare → `CREATE USER`/`GRANT`/`SET DEFAULT ROLE`/`CREATE ROLE` bị 1295 hoặc "not supported in prepared protocol"). Tất cả đi `exec_statement` (không tham số hoá). Test regression phải chứng minh |
| **MSSQL** | `registry.exec_statement` → `MssqlDriver` → **`simple_query` (raw batch)** | AUDIT-9 precedent; §1.4 mở rộng `is_raw_batch` cover LOGIN/USER/ROLE + GRANT/DENY/REVOKE | `execute()` = sp_executesql: `CREATE LOGIN`/`CREATE USER` phải **first-in-batch**, qua sp_executesql sẽ lỗi/không bền. Bắt buộc raw batch |
| **ClickHouse** | `registry.exec_statement` → `ChDriver` (HTTP/reqwest) | HTTP body | Password `IDENTIFIED WITH sha256_password BY '…'` đi trong HTTP body → cảnh báo nếu không TLS (§6.3). Gate `access_management` (§6.1) |
| **Cassandra** | **`ipc.cqlExec`** (KHÔNG `exec_statement`) → `exec_cql` | precedent C1 | `exec_statement` trả "not applicable" cho Cassandra → phải dùng cql_exec. Gate authenticator (§7.1) |
| **MongoDB** | **command riêng** `mongo_create_user`/… → `run_command` | §8.1 | Không phải SQL — không đi exec path |
| **Oracle** | `registry.exec_statement` → `OracleDriver.exec` → **`do_exec` → `conn.execute` (DDL)** | **verified `oracle.rs:576-586`** — non-SELECT → `conn.execute` trả Affected/Ok | CREATE USER/GRANT là DDL không trả rows → **KHÔNG dính cap 100-dòng** (cap chỉ ảnh hưởng phần đọc). Nhưng introspection §10.1 (dba_users…) nếu >100 user **BỊ cap** → xem §1.4c |

**Quy tắc chốt (không mơ hồ):** builder frontend luôn gọi đúng path ở cột 2. Frontend `ipc` wrapper cho user-mgmt SQL = **`execStatement`** (không bao giờ `execParams`) trừ Cassandra (`cqlExec`) và Mongo (command riêng). Đây là ràng buộc code, có test bắt.

### 1.4c Đọc introspection nhiều dòng — không được cắt cụt (Oracle cap 100)

Oracle driver hiện cap ~100 dòng khi fetch result (memory `oracle-rs-100-row-cap`). Server có >100 user/role/grant là bình thường → danh sách user bị thiếu = **sai nghiêm trọng cho tool phân quyền**. Xử lý:
- Introspection Oracle (§10.1 `users`/`sys_privs`/`tab_privs`…) phải **phân trang hoặc lọc theo principal đang chọn** (`WHERE grantee = :u`) thay vì kéo toàn bộ — mỗi principal thường <100 grant nên an toàn.
- Danh sách user tổng (`dba_users`): nếu driver không phân trang được → **[CẦN XÁC MINH đầu phase U6]** cap thật là bao nhiêu; nếu >100 user thì hiển thị cảnh báo "list truncated, use filter" + ô filter server-side (`WHERE username LIKE`). KHÔNG hiển thị danh sách cụt mà không báo.
- Các engine khác (PG/MySQL/MSSQL/CH/Cassandra/Mongo) không có cap này — không cần xử lý.

### 1.5 Escaping — bảng chuẩn per dialect (KHÔNG mơ hồ)

Tái dùng cái đã có, bổ sung chỗ thiếu:

| Engine | Identifier (db/schema/table/role name) | String literal (password, VALID UNTIL…) | Ghi chú đặc thù |
|---|---|---|---|
| PostgreSQL | `"…"`, `"`→`""` — dùng `quoteIdent('postgres', x)` sẵn có (`sql/dialect.ts:6`) | `'…'`, `'`→`''` | Role name là identifier (KHÔNG phải string): `CREATE ROLE "my role"` |
| MySQL / MariaDB | db/table: `` `…` ``, `` ` ``→```` `` ```` | Account name = **2 string literal** `'user'@'host'`: `'`→`''` **và** `\`→`\\` (backslash là escape trong string literal MySQL) | Cấm ký tự NUL trong tên (validate) |
| MSSQL | `[…]`, `]`→`]]` | `N'…'`, `'`→`''` | Login/user/role name là identifier `[…]` |
| ClickHouse | `` `…` `` hoặc `"…"` — dùng backtick, `` ` ``→``` \` ``` **[CẦN XÁC MINH: CH escape backtick bằng `\``, khác MySQL]** | `'…'`: `'`→`\'` và `\`→`\\` | User/role name là identifier |
| Cassandra | `"…"`, `"`→`""` (role name case-sensitive khi quote) | `'…'`, `'`→`''` | |
| Oracle | Nếu khớp `^[A-Za-z][A-Za-z0-9_$#]*$` → để trần (Oracle fold UPPER); ngược lại `"…"` (cấm chứa `"`) | `'…'`, `'`→`''` | Password: `IDENTIFIED BY "…"` (wrap double-quote, **cấm** password chứa `"` — validate + báo lỗi rõ) |
| MongoDB | N/A — BSON document qua driver, không string-build | N/A | |

- Privilege keywords (SELECT/INSERT/…), ON-clause object kind, WITH GRANT OPTION… đều là **enum whitelist trong builder** — không bao giờ nhận free text → injection-proof by construction. Free text duy nhất = tên principal + password + tên object (đều qua escaper trên).
- Backend escaper (cho `users_query` với `arg`): thêm `fn quote_ident(system, name)` + `fn quote_str(system, s)` trong `users_admin.rs`, cùng bảng trên, unit-test riêng (kể cả case tên chứa `'`, `"`, `` ` ``, `]`, `\`).

### 1.6 Quyền của chính connection đang dùng (hiển thị trước, không đoán)

Mỗi engine UI hiện banner nếu connection hiện tại **thiếu quyền quản trị user** (phát hiện bằng query nhẹ, liệt kê ở từng section). Banner nói rõ cần quyền gì. Lỗi engine trả về khi Execute surface **nguyên văn** (không nuốt, không dịch).

### 1.7 Tạo user/password — quy tắc password (KHÔNG lưu, KHÔNG xem lại)

- Tạo user kèm password: đầy đủ trong form per-engine (§2–§10). **App không lưu password đã đặt ở bất kỳ đâu** (không storage, không state, không log) — sau khi Execute, password chỉ tồn tại dưới dạng hash trên server (bản chất DBMS: PG SCRAM, MySQL caching_sha2, MSSQL salted hash, Cassandra bcrypt, Mongo SCRAM, Oracle verifier — không đọc lại được).
- Quên password → dùng **Change Password** (có ở mọi engine trong scope) đặt password mới.
- **Generate password**: nút `Generate` trong form tạo user/đổi password — sinh app-side (crypto RNG, 20 ký tự [A-Za-z0-9!@#%^*], tự loại ký tự cấm per engine §1.5, vd `"` cho Oracle); user tự copy trước khi Execute (hint: "Copy this password now — it cannot be retrieved later.").

### 1.9 ★★ Definition of Done PER ENGINE — "tạo user + phân quyền phải CHẠY THẬT" (bắt buộc, không mơ hồ)

Một engine **chỉ được coi là xong** khi integration test trên **container thật** (không phải demo, không phải chỉ đọc catalog) pass EXIT=0 chứng minh **đủ 6 bước** dưới đây. Đây là gate cứng — thiếu bất kỳ bước nào = phase chưa xong, không merge.

| Bước | Nội dung phải chứng minh | Vì sao bắt buộc |
|---|---|---|
| **1. CREATE** | Tạo user/role kèm password bằng builder → statement chạy thành công trên container | Chứng minh CREATE thật sự chạy (không dính bẫy driver §1.4b) |
| **2. LOGIN** | **Mở connection MỚI bằng chính user + password vừa tạo** → xác thực OK | Chứng minh password đặt đúng + account login được (không chỉ tồn tại trong catalog) |
| **3. DENIED trước grant** | Bằng connection user mới đó: SELECT trên bảng seed → **bị từ chối** (permission denied nguyên văn engine) | Chứng minh user thật sự CHƯA có quyền (baseline) |
| **4. GRANT → ALLOWED** | Admin apply preset/grant (Read-only) → user mới SELECT lại → **OK** | Chứng minh GRANT thật sự có hiệu lực (không "im lặng sai") |
| **5. WRITE vẫn DENIED** | User Read-only làm INSERT/UPDATE/CREATE → **bị từ chối** | Chứng minh phân quyền có ranh giới đúng (read-only là read-only thật) |
| **6. REVOKE → DENIED lại** | Admin revoke → user SELECT → **bị từ chối lại**; DROP user → catalog sạch | Chứng minh REVOKE + DROP thật sự gỡ quyền/xoá |

Ràng buộc bổ sung theo từng engine (đã có ở §2–§10, nhắc lại để không sót):
- **PG**: bước 4 phải chạy GRANT trên **đúng database** (sub-connection); thêm case future-tables (bật checkbox → tạo bảng mới bằng owner → user vẫn đọc được).
- **MySQL/MariaDB**: bước 1 + 4 phải đi **TEXT protocol** (§1.4b) — test tạo user + GRANT phải pass, đây chính là bằng chứng không dính lỗi 1295. MariaDB thêm: `is_role` phân loại đúng + `SET DEFAULT ROLE … FOR` có hiệu lực sau reconnect.
- **MSSQL**: 2 tầng — CREATE LOGIN (server) rồi CREATE USER FOR LOGIN (database) rồi GRANT; thêm case **DENY thắng GRANT** (deny 1 bảng dù schema đã grant → bảng đó vẫn denied).
- **ClickHouse**: container bật `access_management`; grant qua role → user.
- **Cassandra**: container bật PasswordAuthenticator; MODIFY vs SELECT tách đúng.
- **MongoDB**: bước 2 connect với `authSource` đúng; role `read` → find OK/insert denied → thêm role `readWrite` → insert OK.
- **Oracle**: bước 1 kèm `GRANT CREATE SESSION` (không có thì không login được — bước 2 sẽ fail, đúng như Oracle thật); introspection tôn trọng §1.4c.

**Preset phân quyền (§1.8) cũng phải qua chuẩn vàng này**: test riêng cho từng preset (Read-only / Read-write / Full / Revoke all) — apply preset → connect user → assert đúng tập quyền allowed/denied của preset đó (không chỉ test "1 câu GRANT lẻ").

Nếu một bước không chạy được trên 1 engine vì lý do kỹ thuật thật (không phải bug của ta), **ghi rõ vào spec + báo user**, KHÔNG âm thầm bỏ qua hoặc nới assertion (kỷ luật CLAUDE.md: "kẹt >3 lần → ghi tình trạng + hỏi").

### 1.8 ★ CORE — Ma trận phân quyền PER-USER theo database/schema (KHÔNG mơ hồ)

Yêu cầu user (2026-07-15): chọn 1 user → thấy và sửa được **user đó vào được database/schema nào, có quyền gì** (create/update/delete/execute/alter/…/read-only). Đây là tab **`Privileges`** trong detail của mỗi principal (tên tab per engine ở bảng 1.8.6).

#### 1.8.1 Mô hình chung: GRID user-centric

```
User: app_user                      Database: [appdb ▾]   (chỉ engine có multi-db per grant — PG/MSSQL)
┌───────────────────┬────────┬────────┬────────┬────────┬─────────┬────────┬───────┐
│ Scope (db/schema) │ SELECT │ INSERT │ UPDATE │ DELETE │ EXECUTE │ CREATE │ ALTER │ …
├───────────────────┼────────┼────────┼────────┼────────┼─────────┼────────┼───────┤
│ public            │   ✓    │   ✓    │   ■    │   ☐    │    ◐    │   ☐    │   ☐   │
│ sales             │   ✓    │   ☐    │   ☐    │   ☐    │    ☐    │   ☐    │   ✕   │
└───────────────────┴────────┴────────┴────────┴────────┴─────────┴────────┴───────┘
[Preset: Read-only] [Read-write] [Read-write + Execute] [Full] [Revoke all on scope]
Pending changes (SQL preview) … [Apply] [Discard]
```

**Trạng thái cell (định nghĩa cứng):**
| Ký hiệu | Nghĩa | Nguồn dữ liệu | Click? |
|---|---|---|---|
| `☐` | Không có quyền | không có row grant | click → GRANT |
| `✓` | Quyền trực tiếp, phủ TOÀN scope | grant ở scope-level (db.*/SCHEMA::/ALL TABLES đủ 100%) | click → REVOKE |
| `■` | **Partial** — chỉ 1 phần object trong scope có grant. Áp cho **MỌI engine có grant dưới-scope** (không riêng PG): PG (`table_grants`), MySQL/MariaDB (`TABLE_PRIVILEGES`/`COLUMN_PRIVILEGES` — grant table/column-level trong db), MSSQL (`db_permissions` class=1 object-grant), ClickHouse (`grants` có cột `table` non-empty), Cassandra (LIST PERMISSIONS row `ON TABLE`), Oracle (`tab_privs` per-object). MongoDB KHÔNG có (role-based, custom role hiển thị riêng) | đếm per scope: `n/m` object, tooltip "SELECT on 7/12 tables" | click → GRANT phủ nốt toàn scope (statement scope-level); Alt-click → REVOKE toàn bộ (scope-level + từng object-grant lẻ) |
| `◐` | **Inherited** — có quyền qua role/group membership, KHÔNG phải grant trực tiếp | resolve membership (§1.8.5) | read-only, tooltip "via role <r>" — sửa phải vào role đó |
| `✕` | **DENY** (chỉ MSSQL) | `state_desc='DENY'` | click-cycle qua menu cell (Grant/Deny/Revoke) |

**Quy tắc sinh SQL = DIFF**: grid load state hiện tại từ introspection → user toggle → chỉ emit statement cho cell ĐỔI (không re-grant cái đã có). Mọi statement dồn vào "Pending changes" preview, Apply chạy tuần tự, dừng ở statement lỗi, refresh lại grid từ introspection sau Apply (không tin optimistic state).

**Preset = đặt trạng thái đích cho 1 row (scope)**, builder tự diff ra statement. Định nghĩa đích per engine ở 1.8.2–1.8.4 — preset chỉ là shortcut, KHÔNG phải lệnh riêng.

#### 1.8.2 Preset & cột per engine — nhóm schema-as-database (MySQL/MariaDB/ClickHouse) + Cassandra/Mongo: 1 statement phủ trọn scope

| Engine | Row của grid | Cột (whitelist đúng thứ tự hiển thị) | Read-only | Read-write | Read-write + Execute | Full | Revoke all |
|---|---|---|---|---|---|---|---|
| **MySQL / MariaDB** | mỗi database = **UNION(`list_schemas`, DISTINCT `TABLE_SCHEMA` từ `SCHEMA_PRIVILEGES`+`TABLE_PRIVILEGES` của user)** — grant trên db chưa/không tồn tại hoặc pattern (`` `db\_%` ``) vẫn phải hiện row (badge "pattern/missing"), nếu chỉ lấy list_schemas sẽ có grant vô hình. + row ghim đầu `*.* (Global)` | `SELECT · INSERT · UPDATE · DELETE · EXECUTE · CREATE · ALTER · DROP · INDEX · REFERENCES · TRIGGER · CREATE VIEW · SHOW VIEW · CREATE ROUTINE · ALTER ROUTINE · EVENT · LOCK TABLES · CREATE TEMPORARY TABLES` | ``GRANT SELECT ON `D`.* TO 'u'@'h'`` | ``GRANT SELECT, INSERT, UPDATE, DELETE ON `D`.* TO 'u'@'h'`` | + `, EXECUTE` | ``GRANT ALL PRIVILEGES ON `D`.* TO 'u'@'h'`` | ``REVOKE ALL PRIVILEGES ON `D`.* FROM 'u'@'h'`` |
| **ClickHouse** | mỗi database | `SELECT · INSERT · ALTER UPDATE · ALTER DELETE · ALTER (DDL) · CREATE TABLE · CREATE VIEW · DROP TABLE · TRUNCATE · OPTIMIZE · SHOW` — **UPDATE/DELETE của CH là mutation ⇒ quyền tên là `ALTER UPDATE`/`ALTER DELETE`, UI vẫn đặt cột "UPDATE"/"DELETE" kèm tooltip tên quyền thật** | `` GRANT SELECT ON `D`.* TO u `` | `` GRANT SELECT, INSERT, ALTER UPDATE, ALTER DELETE ON `D`.* TO u `` | (CH không có EXECUTE object-priv — cột bỏ) | `` GRANT ALL ON `D`.* TO u `` | `` REVOKE ALL ON `D`.* FROM u `` |
| **Cassandra** | mỗi keyspace | `SELECT · MODIFY · CREATE · ALTER · DROP · AUTHORIZE · DESCRIBE` — tooltip cố định: **MODIFY = INSERT + UPDATE + DELETE + TRUNCATE** (Cassandra không tách 3 quyền ghi) | `GRANT SELECT ON KEYSPACE ks TO r` | + `GRANT MODIFY ON KEYSPACE ks TO r` | (không có EXECUTE trên keyspace v1) | `GRANT ALL PERMISSIONS ON KEYSPACE ks TO r` | `REVOKE ALL PERMISSIONS ON KEYSPACE ks FROM r` |
| **MongoDB** | mỗi database | **cells = built-in role, không phải priv rời**: `read · readWrite · dbAdmin · dbOwner · userAdmin` (custom fine-grained → role builder §8) | `grantRolesToUser {roles:[{role:'read',db:D}]}` | `readWrite@D` | (execute không tồn tại — bỏ) | `dbOwner@D` | `revokeRolesFromUser` toàn bộ role@D |

#### 1.8.3 PostgreSQL — 2 tầng database→schema (grid row = schema của database đang chọn)

PG grant sống **trong từng database** (catalog per-db) → grid có **Database selector**, statements chạy trên sub-connection `attach_database` (`{conn}::{db}` — hạ tầng sẵn có). Cột grid: `USAGE (schema) · CREATE (schema) · SELECT · INSERT · UPDATE · DELETE · TRUNCATE · REFERENCES · TRIGGER (tables) · SELECT/USAGE (sequences) · EXECUTE (functions)`.

Preset per (database D, schema S, user U) — **statement chính xác, đúng thứ tự**:

- **Read-only**:
  ```sql
  GRANT CONNECT ON DATABASE "D" TO "U";
  GRANT USAGE ON SCHEMA "S" TO "U";
  GRANT SELECT ON ALL TABLES IN SCHEMA "S" TO "U";
  GRANT SELECT ON ALL SEQUENCES IN SCHEMA "S" TO "U";
  ```
- **Read-write**: Read-only +
  ```sql
  GRANT INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "S" TO "U";
  GRANT USAGE ON ALL SEQUENCES IN SCHEMA "S" TO "U";
  ```
- **Read-write + Execute**: + `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA "S" TO "U";`
- **Full (schema)**:
  ```sql
  GRANT USAGE, CREATE ON SCHEMA "S" TO "U";
  GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA "S" TO "U";
  GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA "S" TO "U";
  GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA "S" TO "U";
  ```
- **Revoke all on schema** — PHẢI gỡ cả default privileges đã cấp trước đó (nếu không, bảng tạo sau user lại tự có quyền — "revoke giả"):
  ```sql
  REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA "S" FROM "U";
  REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA "S" FROM "U";
  REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA "S" FROM "U";
  REVOKE USAGE, CREATE ON SCHEMA "S" FROM "U";
  -- với TỪNG owner tìm thấy trong default_acl có grantee = "U" và schema = "S":
  ALTER DEFAULT PRIVILEGES FOR ROLE "<owner>" IN SCHEMA "S" REVOKE ALL ON TABLES FROM "U";
  ALTER DEFAULT PRIVILEGES FOR ROLE "<owner>" IN SCHEMA "S" REVOKE ALL ON SEQUENCES FROM "U";
  ```
- **Lưu ý cột EXECUTE (PG)**: PostgreSQL mặc định grant `EXECUTE` cho **PUBLIC** trên mọi function mới → cột EXECUTE thường hiện `◐ via PUBLIC` cho mọi user. UI hiển thị đúng như vậy (không phải bug); muốn chặn thật phải `REVOKE EXECUTE … FROM PUBLIC` — thao tác này nằm ở row `PUBLIC` (role ảo), không nằm ở row user.
- **BẪY "future tables" (phải nói thẳng trong UI)**: `ON ALL TABLES` chỉ phủ object **hiện có**. Checkbox `Also apply to future tables in this schema` (mặc định ON cho preset) → emit thêm:
  ```sql
  ALTER DEFAULT PRIVILEGES FOR ROLE "<owner>" IN SCHEMA "S" GRANT SELECT[, INSERT, UPDATE, DELETE] ON TABLES TO "U";
  ALTER DEFAULT PRIVILEGES FOR ROLE "<owner>" IN SCHEMA "S" GRANT USAGE[, SELECT] ON SEQUENCES TO "U";
  ```
  trong đó `<owner>` = **schema owner** (dropdown, default từ `pg_namespace.nspowner::regrole`) — ngữ nghĩa PG: default-privileges áp cho object do ĐÚNG role đó tạo; không chọn owner đúng là preset "im lặng không phủ bảng mới". Hint cố định 1 dòng giải thích điều này. (Đây là lý do default_acl view §2.1 phải có — grid đọc lại được trạng thái default-priv.)

#### 1.8.4 MSSQL & Oracle — đặc thù riêng

**MSSQL** (grid row = schema của database đang chọn; prerequisite: user phải tồn tại trong DB — nếu login chưa map, banner + nút mở `MssqlCreateUserDialog`):
- Cột: `SELECT · INSERT · UPDATE · DELETE · EXECUTE · ALTER · REFERENCES · VIEW DEFINITION · CONTROL`.
- Cell click thường = GRANT/REVOKE; **menu chuột phải trên cell** = `Grant` / `Grant + WITH GRANT OPTION` / `Deny` / `Revoke` (đủ 3 trạng thái MSSQL; DENY hiển thị `✕` màu error).
- Preset per (schema S, user U): Read-only `GRANT SELECT ON SCHEMA::[S] TO [U]` · Read-write `GRANT SELECT, INSERT, UPDATE, DELETE ON SCHEMA::[S] TO [U]` · +Execute `GRANT EXECUTE ON SCHEMA::[S] TO [U]` · Full `GRANT CONTROL ON SCHEMA::[S] TO [U]` · Revoke all `REVOKE SELECT, INSERT, UPDATE, DELETE, EXECUTE, ALTER, REFERENCES, VIEW DEFINITION, CONTROL ON SCHEMA::[S] FROM [U]`.
- Row ghim đầu grid: `(whole database)` = 2 checkbox nhanh **db_datareader** / **db_datawriter** (`ALTER ROLE [db_datareader] ADD/DROP MEMBER [U]`) — hiển thị `◐` trên mọi row schema khi bật (inherited-via-role, tooltip "via db_datareader").

**Oracle** (grid row = schema/owner; Oracle KHÔNG có database-level, KHÔNG có `GRANT ... ON SCHEMA`):
- **Trung thực kỹ thuật**: quyền object Oracle chỉ grant **per-object**. Preset per (owner S, user U) = builder lấy danh sách object từ introspection rồi sinh **batch N statement**:
  - Read-only: `GRANT SELECT ON "S"."<t>" TO "U";` cho TỪNG table + view của S (preview hiện đủ N câu + đếm "Grants SELECT on 27 tables/views").
  - Read-write: thêm `GRANT INSERT, UPDATE, DELETE ON "S"."<t>" TO "U";` từng table (không áp view).
  - +Execute: `GRANT EXECUTE ON "S"."<p>" TO "U";` từng procedure/function/package.
  - Revoke all: `REVOKE <privs> ON "S"."<obj>" FROM "U";` cho từng object đang có grant (từ `tab_privs`).
- Cảnh báo cố định trong UI: *"Objects created later are NOT covered — re-run the preset after new objects are added."* Phương án system-priv (`SELECT ANY TABLE`…) chỉ nằm ở tab System Privileges với warning "grants access to ALL schemas" — KHÔNG trộn vào grid.
- Cell `■` partial là trạng thái thường trực ở Oracle (per-object) — tooltip luôn hiện `n/m`.

#### 1.8.5 Đọc ngược state grid (introspection → cell) — nguồn dữ liệu cứng

| Engine | Direct grant | Inherited (`◐`) |
|---|---|---|
| PG | `schema_grants` + `table_grants` (aggregate per schema: đủ 100% object → `✓`, ngược lại `■`) + `db_grants` + `default_acl` | expand `members` đệ quy (rolinherit) → grants của role cha; PUBLIC hiển thị như 1 role ảo ở row riêng |
| MySQL/MariaDB | `SCHEMA_PRIVILEGES` (+ `USER_PRIVILEGES` cho row Global) | `role_edges`/`roles_mapping` → grants của role (MySQL: chỉ khi role active/default — tooltip ghi rõ "requires role activation") |
| MSSQL | `db_permissions` (class=3 SCHEMA + class=0 DATABASE), `state_desc` GRANT/GRANT_WITH_GRANT_OPTION/DENY | `db_role_members` → permissions của role + fixed-role semantics (db_datareader = SELECT mọi schema) |
| ClickHouse | `grants` (user_name = U) | `role_grants` → `grants` (role_name) |
| Cassandra | `LIST ALL PERMISSIONS OF <r>` đã bao gồm inherited — tách direct bằng `LIST ALL PERMISSIONS OF <r> NORECURSIVE` **[CẦN XÁC MINH cú pháp NORECURSIVE cho LIST PERMISSIONS — nếu không có thì mọi cell hiển thị effective + chú thích]** | (như trái) |
| MongoDB | `usersInfo.roles` (role@db gán trực tiếp) | `usersInfo showPrivileges → inheritedRoles` |
| Oracle | `tab_privs`/`col_privs`/`sys_privs` (grantee = U) | `role_privs` đệ quy → `tab_privs`/`sys_privs` (grantee = role) |

#### 1.8.6 Tên tab per engine (khớp thuật ngữ từng hệ) + test bắt buộc

| Engine | Tab hiển thị grid §1.8 |
|---|---|
| PG | `Privileges` (thay 3 sub-view Database/Schema/Tables cũ ở §2.3 — grid là mặc định, bảng chi tiết object-level giữ dạng "Advanced" collapse) |
| MySQL/MariaDB | `Schema Privileges` (§3.3 — grid này CHÍNH LÀ tab đó, thay flow Add-Entry bằng grid full-database list) |
| MSSQL | `Securables` (scope Database) |
| ClickHouse | `Grants` |
| Cassandra | `Permissions` |
| MongoDB | `Roles per Database` |
| Oracle | `Object Privileges` (grid theo owner) |

**Test bắt buộc cho §1.8** (bổ sung vào §15):
- Unit: preset builder per engine — snapshot đúng NGUYÊN VĂN statement như 1.8.2–1.8.4 (kể cả thứ tự); diff engine (state A → target B chỉ emit đổi); aggregate `✓/■` từ fixture introspection.
- Integration per engine: **apply preset Read-only → connect bằng user đó → SELECT OK + INSERT/UPDATE/DELETE bị từ chối; apply Read-write → INSERT OK + CREATE TABLE bị từ chối; Revoke all → SELECT bị từ chối lại** (chuẩn vàng allowed/denied theo TỪNG preset). PG thêm case future-tables: bật checkbox → tạo bảng MỚI bằng owner → user vẫn SELECT được bảng mới.
- e2e demo: grid render đúng state từ fixture (✓/■/◐/✕), preset điền Pending changes đúng SQL, Apply refresh grid.

### 1.9 Version gates + giới hạn đã biết (ghi tường minh, hiển thị trong UI khi chạm phải)

**Version gate (probe 1 lần khi mở User Manager, cache theo connection):**
| Engine | Probe | Hệ quả UI |
|---|---|---|
| MySQL | `SELECT VERSION()` — `< 8.0` | Ẩn tab Roles + `SET DEFAULT ROLE` (5.7 không có role); các phần còn lại (user@host, grant/revoke, lock 5.7.6+) giữ nguyên |
| MariaDB | `< 10.4` | `mysql.user` không phải view global_priv → cột `is_role` vẫn có từ 10.0.5 (roles ra đời 10.0.5) — chỉ mất `account_locked`/`password_expired` (<10.4) → cột h

## 2. PostgreSQL — Roles (user = role có LOGIN)

Mô hình: **một loại principal duy nhất = role**. "User" = role có `LOGIN`. Privileges dạng ACL trên object; membership role-trong-role; default privileges.

### 2.1 Introspection (views cho `users_query("postgres", …)`)

| view | SQL (nguyên văn) |
|---|---|
| `roles` | `SELECT rolname AS name, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin, rolreplication, rolbypassrls, rolconnlimit, COALESCE(rolvaliduntil::text,'') AS valid_until FROM pg_roles WHERE rolname NOT LIKE 'pg\_%' ORDER BY rolname` — (tuỳ chọn "Show system roles" bỏ WHERE) |
| `members` | `SELECT m.roleid::regrole::text AS role, m.member::regrole::text AS member, m.admin_option, m.grantor::regrole::text AS grantor FROM pg_auth_members m ORDER BY 1, 2` |
| `db_grants` | `SELECT d.datname AS database, CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS grantee, a.privilege_type, a.is_grantable FROM pg_database d, LATERAL aclexplode(d.datacl) a WHERE d.datacl IS NOT NULL ORDER BY 1, 2` |
| `schema_grants` | `SELECT n.nspname AS schema, CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS grantee, a.privilege_type, a.is_grantable FROM pg_namespace n, LATERAL aclexplode(n.nspacl) a WHERE n.nspacl IS NOT NULL AND n.nspname NOT LIKE 'pg\_%' ORDER BY 1, 2` |
| `table_grants` | `SELECT n.nspname AS schema, c.relname AS object, c.relkind::text AS kind, CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS grantee, a.privilege_type, a.is_grantable FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, LATERAL aclexplode(c.relacl) a WHERE c.relacl IS NOT NULL AND n.nspname NOT IN ('pg_catalog','information_schema') ORDER BY 1, 2, 4` — cover table/view/matview/sequence (relkind r/v/m/S) |
| `default_acl` | `SELECT pg_get_userbyid(d.defaclrole) AS owner, COALESCE(n.nspname,'') AS schema, d.defaclobjtype::text AS objtype, CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS grantee, a.privilege_type, a.is_grantable FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace, LATERAL aclexplode(d.defaclacl) a ORDER BY 1, 2` |

Gate quyền quản trị: `SELECT rolsuper OR rolcreaterole AS can_manage FROM pg_roles WHERE rolname = current_user` → false → banner "Current role lacks CREATEROLE/SUPERUSER".

### 2.2 Mutations (builder `src/lib/users/postgres.ts`)

| Hàm | Statement sinh ra (nguyên văn, `<>` = escaped) |
|---|---|
| `createRole(opts)` | `CREATE ROLE <name> [LOGIN\|NOLOGIN] [SUPERUSER] [CREATEDB] [CREATEROLE] [REPLICATION] [BYPASSRLS] [NOINHERIT] [CONNECTION LIMIT <n>] [PASSWORD '<pwd>'] [VALID UNTIL '<ts>'] [IN ROLE <r1>, <r2>]` — mỗi option là checkbox/field; option không chọn thì **không emit** (dùng default server) |
| `alterRoleOptions(name, opts)` | `ALTER ROLE <name> [LOGIN\|NOLOGIN] [SUPERUSER\|NOSUPERUSER] … [CONNECTION LIMIT <n>]` — chỉ emit option user ĐỔI (so với giá trị load được) |
| `alterPassword(name, pwd)` | `ALTER ROLE <name> PASSWORD '<pwd>'` — server tự hash theo `password_encryption` (scram-sha-256 mặc định PG14+) |
| `alterValidUntil(name, ts\|null)` | `ALTER ROLE <name> VALID UNTIL '<ts>'` / `VALID UNTIL 'infinity'` |
| `renameRole(a, b)` | `ALTER ROLE <a> RENAME TO <b>` (server chặn khi có password MD5 — surface lỗi nguyên văn) |
| `grantMembership(role, member, admin)` | `GRANT <role> TO <member>[ WITH ADMIN OPTION]` |
| `revokeMembership(role, member)` | `REVOKE <role> FROM <member>` |
| `grantOnTable(schema, obj, privs[], grantee, grantOpt)` | `GRANT SELECT, INSERT ON TABLE <schema>.<obj> TO <grantee>[ WITH GRANT OPTION]` — privs whitelist: `SELECT INSERT UPDATE DELETE TRUNCATE REFERENCES TRIGGER` hoặc `ALL PRIVILEGES` |
| `grantOnAllTablesInSchema(schema, privs[], grantee)` | `GRANT … ON ALL TABLES IN SCHEMA <schema> TO <grantee>` |
| `grantOnSequence` | `GRANT USAGE, SELECT, UPDATE ON SEQUENCE <schema>.<seq> TO …` (whitelist 3) |
| `grantOnSchema` | `GRANT USAGE, CREATE ON SCHEMA <schema> TO …` (whitelist 2) |
| `grantOnDatabase` | `GRANT CONNECT, CREATE, TEMPORARY ON DATABASE <db> TO …` (whitelist 3) |
| `grantExecute(schema, routineSig, grantee)` | `GRANT EXECUTE ON FUNCTION <schema>.<name>(<argtypes>) TO …` — signature lấy từ introspection routines sẵn có (`pg_get_function_arguments`, T28) |
| `revoke*` (đối xứng từng grant) | `REVOKE [GRANT OPTION FOR] <privs> ON … FROM <grantee> [CASCADE]` — checkbox "Only grant option" + "Cascade" |
| `dropRole(name)` | `DROP ROLE <name>` |
| `dropRoleOwned(name, newOwner)` | 3 statement tuần tự: `REASSIGN OWNED BY <name> TO <newOwner>; DROP OWNED BY <name>; DROP ROLE <name>` — wizard "Drop role & handle owned objects" khi DROP thường fail vì dependency (chạy trên TỪNG database chứa object — v1 chỉ chạy trên DB hiện tại + ghi chú rõ trong dialog) |

### 2.3 UI riêng PG — theo pgAdmin: một mục hợp nhất **"Login/Group Roles"**

Nguyên tắc (user đã chốt): Postgres KHÔNG tách User/Role — một mục duy nhất **`Login/Group Roles`**. "User" = role có LOGIN; "Group" = role không LOGIN chứa role khác. UI không bao giờ dùng chữ "User" đứng riêng cho PG.

- **Cây Explorer**: node `Login/Group Roles` cấp connection (§1.2b).
- **List trái (trong tab)**: tất cả roles; icon Login-role vs Group-role (theo `rolcanlogin`); badge `SUPER`; toggle "Show pg_* system roles" (default off).
- **Detail tab General — checkbox attributes đúng wording pgAdmin** (map 1-1 vào cờ):

  | Checkbox trên UI | Cờ PG | Ghi chú |
  |---|---|---|
  | `Can login?` | `LOGIN`/`NOLOGIN` | Bật = Login role ("user"); tắt = Group role |
  | `Superuser?` | `SUPERUSER` | |
  | `Create roles?` | `CREATEROLE` | |
  | `Create databases?` | `CREATEDB` | |
  | `Inherit rights from the parent roles?` | `INHERIT`/`NOINHERIT` | default bật |
  | `Can initiate streaming replication and backups?` | `REPLICATION` | Advanced (collapse) |
  | `Bypass RLS?` | `BYPASSRLS` | Advanced |
  + field `Connection limit` (số, -1 = unlimited), `Account expires` (VALID UNTIL, date-time picker + "No expiry"), `Password` (đổi ở đây).
- **Tab Membership**: 2 bảng "Member of" / "Members" (chỉ hiện với Group role hoặc role có member), cột Admin option — map GRANT/REVOKE membership §2.2.
- **Tab Privileges** = **GRID §1.8.3** (Database selector + row per schema + preset Read-only/Read-write/…); bảng chi tiết object-level (từ `*_grants`, grant/revoke per object) nằm dưới grid dạng "Advanced" collapse.
- **Tab Default privileges**: read-only v1 (ALTER DEFAULT PRIVILEGES edit ở v2).
- **New Role = POPUP dialog** (`PgCreateRoleDialog`, rule §1.2) = form General ở trên + preview `CREATE ROLE …` + Execute; checkbox `Can login?` quyết định label nút: bật → "Create login role", tắt → "Create group role". Membership/Privileges chỉnh sau khi tạo, trong tab detail.
- Grant wizard: chọn object kind → schema dropdown (introspection sẵn có) → object (multi-select) → priv checkboxes (whitelist đúng kind) → grantee → preview.

### 2.4 Integration test (container postgres, pattern seed→verify)

`pg_user_manager_end_to_end`: (1) CREATE ROLE `u_spec` LOGIN PASSWORD → **mở connection MỚI bằng chính user đó** (LiveConnection::connect với profile trỏ user/pwd mới) → `SELECT 1` OK; (2) SELECT trên bảng seed → **bị lỗi permission denied**; (3) GRANT SELECT → SELECT OK; (4) REVOKE → denied lại; (5) GRANT membership vào role thứ 2 → `pg_auth_members` thấy; (6) `users_query` views trả đúng dòng vừa tạo; (7) DROP OWNED/DROP ROLE → `pg_roles` không còn. Tên/password chứa `'` và space để test escaping.

---

## 3. MySQL 8 — Users `'name'@'host'` + Roles

Mô hình: account = cặp **user@host**; role (8.0+) cũng là account bị khoá. **MySQL KHÔNG có cờ is_role** — không thể phân biệt tuyệt đối role vs user bị lock; UI hiển thị mọi account một danh sách, cột `locked`, và tab Roles dựng từ `mysql.role_edges` (account xuất hiện ở FROM_USER = đang được dùng như role). Ghi chú này hiện trong UI (tooltip) — trung thực, không đoán.

### 3.1 Introspection

| view | SQL |
|---|---|
| `users` | `SELECT user, host, plugin, account_locked, password_expired, CAST(password_last_changed AS CHAR) AS password_last_changed FROM mysql.user ORDER BY user, host` — cần `SELECT ON mysql.*`; thiếu quyền → fallback `SELECT CURRENT_USER() AS user` + banner |
| `grants_for` (arg = `'u'@'h'` đã escape) | `SHOW GRANTS FOR <arg>` — hiển thị **nguyên văn** từng dòng GRANT (nguồn sự thật; không parse) |
| `global_privs` | `SELECT GRANTEE AS grantee, PRIVILEGE_TYPE AS privilege, IS_GRANTABLE AS grantable FROM information_schema.USER_PRIVILEGES ORDER BY GRANTEE, PRIVILEGE_TYPE` |
| `schema_privs` | `SELECT GRANTEE, TABLE_SCHEMA, PRIVILEGE_TYPE, IS_GRANTABLE FROM information_schema.SCHEMA_PRIVILEGES ORDER BY GRANTEE, TABLE_SCHEMA` |
| `table_privs` | `SELECT GRANTEE, TABLE_SCHEMA, TABLE_NAME, PRIVILEGE_TYPE, IS_GRANTABLE FROM information_schema.TABLE_PRIVILEGES ORDER BY GRANTEE, TABLE_SCHEMA, TABLE_NAME` |
| `column_privs` | `SELECT GRANTEE, TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, PRIVILEGE_TYPE FROM information_schema.COLUMN_PRIVILEGES ORDER BY 1,2,3,4` |
| `role_edges` | `SELECT FROM_USER AS role_user, FROM_HOST AS role_host, TO_USER AS member_user, TO_HOST AS member_host, WITH_ADMIN_OPTION FROM mysql.role_edges ORDER BY 1,3` |
| `default_roles` | `SELECT USER AS member_user, HOST AS member_host, DEFAULT_ROLE_USER, DEFAULT_ROLE_HOST FROM mysql.default_roles ORDER BY 1` |

**Bẫy đã biết (AUDIT-5)**: mọi string decode từ `mysql.*`/`information_schema` phải qua helper `text()`/`text_opt()` (charset binary → VARBINARY panic) — reads đi qua `exec_statement` là TEXT protocol + `decode_rows` đã xử lý, nhưng integration phải assert giá trị thật.

### 3.2 Mutations (`src/lib/users/mysql.ts`)

Account literal: `acct(user, host)` → `'<user>'@'<host>'` (escape §1.5; host default `%`).

| Hàm | Statement |
|---|---|
| `createUser` | `CREATE USER 'u'@'h' IDENTIFIED [WITH <plugin>] BY '<pwd>' [REQUIRE SSL] [PASSWORD EXPIRE INTERVAL <n> DAY \| PASSWORD EXPIRE NEVER] [ACCOUNT LOCK]` — plugin dropdown MySQL: `caching_sha2_password` (default 8.0), `mysql_native_password`, `sha256_password`; không chọn plugin → bỏ `WITH` |
| `alterPassword` | `ALTER USER 'u'@'h' IDENTIFIED BY '<pwd>'` |
| `lock/unlock` | `ALTER USER 'u'@'h' ACCOUNT LOCK` / `ACCOUNT UNLOCK` |
| `expirePassword` | `ALTER USER 'u'@'h' PASSWORD EXPIRE` |
| `renameUser` | `RENAME USER 'a'@'h1' TO 'b'@'h2'` |
| `dropUser` | `DROP USER 'u'@'h'` |
| `grant(privs[], level, grantee, grantOpt)` | `GRANT <privs> ON {*.* \| <db>.* \| <db>.<tbl>} TO 'u'@'h' [WITH GRANT OPTION]` — level = Global/Schema/Table; priv whitelist per level (Global gồm cả `CREATE USER, RELOAD, PROCESS, SHOW DATABASES, REPLICATION CLIENT, SUPER…`; Table gồm `SELECT INSERT UPDATE DELETE CREATE DROP INDEX ALTER REFERENCES TRIGGER SHOW VIEW…`) |
| `grantColumns(privs, db, tbl, cols[], grantee)` | `GRANT SELECT (col1, col2), UPDATE (col1) ON <db>.<tbl> TO 'u'@'h'` — chỉ `SELECT/INSERT/UPDATE/REFERENCES` cho column-level (whitelist) |
| `revoke` | `REVOKE <privs> ON <level> FROM 'u'@'h'` |
| `revokeAll` | `REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'u'@'h'` (form reset toàn bộ — destructive, confirm) |
| `createRole` | `CREATE ROLE 'r'` (tuỳ chọn `'r'@'h'`) |
| `grantRole(role, member, admin)` | `GRANT 'r' TO 'u'@'h' [WITH ADMIN OPTION]` |
| `revokeRole` | `REVOKE 'r' FROM 'u'@'h'` |
| `setDefaultRole` | `SET DEFAULT ROLE ALL TO 'u'@'h'` / `SET DEFAULT ROLE 'r1' TO 'u'@'h'` / `SET DEFAULT ROLE NONE TO 'u'@'h'` |
| `dropRole` | `DROP ROLE 'r'` |

**KHÔNG** emit `FLUSH PRIVILEGES` — account-management statements tự flush (chỉ cần khi sửa bảng grant trực tiếp, ta không bao giờ làm).

### 3.3 UI riêng MySQL — tiêu đề **"Users and Privileges"** (theo Workbench)

- **Cây Explorer**: node `Users and Privileges` cấp connection (§1.2b).
- **List trái**: account `user@host` (2 dòng: user đậm, host muted), badge `locked`/`expired`.
- **Add Account = POPUP dialog** (`MySqlCreateUserDialog`, rule §1.2), chỉ chứa phần Login: field **`User Name`** + field **`Host`** (**bắt buộc, không được rỗng** — input có datalist gợi ý: `%` — any host · `localhost` · nhập IP/subnet như `10.0.0.%`; default `%`; hint 1 dòng giải thích account = cặp user@host, cùng user khác host là account khác) + `Authentication plugin` dropdown + `Password`/`Confirm password` + `Account locked` + `Password expire` policy + preview `CREATE USER …` + Execute. Grants/roles chỉnh sau khi tạo, trong tab detail (các tab dưới đây).
- **Tab Login (detail, account đã tồn tại)**: các field trên ở dạng edit (đổi plugin/password/lock/expire/rename).
- **Tab Administrative (Global Privileges)**: checklist toàn bộ global privs (whitelist §3.2, nhóm theo category: Data `SELECT/INSERT/…`, Structure `CREATE/ALTER/INDEX/…`, Administration `CREATE USER/RELOAD/PROCESS/SHOW DATABASES/REPLICATION CLIENT/SUPER/…`) + checkbox `WITH GRANT OPTION`. Sinh `GRANT … ON *.*`. (Preset bundle kiểu "Administrative Roles" của Workbench = v2, ghi chú trong UI — v1 chỉ checklist thô để không mơ hồ về mapping.)
- **Tab Schema Privileges** = **GRID §1.8.2** (row per database — full list từ `list_schemas`, không cần Add-Entry; cột priv + preset; row ghim `*.* Global`). Drill-down Table/Column giữ dạng "Advanced": chọn table (`list_tables`) → priv checkboxes table-level; chọn columns (multi-select `list_columns`) → column-priv (chỉ SELECT/INSERT/UPDATE/REFERENCES).
- **Tab Roles** (MySQL 8 role objects): granted roles + default roles + admin option; nút `Create Role…`.
- **Tab SHOW GRANTS**: output `SHOW GRANTS FOR 'u'@'h'` nguyên văn (nguồn sự thật, read-only).

### 3.4 Integration

`mysql_user_manager_end_to_end`: tạo `'u spec'@'%'` (space trong tên) password có `'` → connect connection mới bằng account đó → SELECT denied → GRANT SELECT ON db.tbl → OK → column-grant → verify `COLUMN_PRIVILEGES` → role: CREATE ROLE + GRANT role + SET DEFAULT ROLE ALL → login lại thấy quyền qua role (`SELECT CURRENT_ROLE()`) → REVOKE/DROP sạch. Assert `SHOW GRANTS` chứa đúng chuỗi grant sinh ra.

---

## 4. MariaDB — Users + Roles (khác MySQL, UI riêng)

Kế thừa builder MySQL cho phần trùng, nhưng component + builder nhánh riêng vì:

| Khác biệt | MariaDB |
|---|---|
| Cờ role thật | `mysql.user` (view trên `global_priv` từ 10.4) **có cột `is_role` ('Y'/'N')** → view `users`: `SELECT user, host, plugin, account_locked, password_expired, is_role FROM mysql.user ORDER BY user, host` — UI tách Users/Roles **chính xác**, không heuristic |
| Role membership catalog | `mysql.roles_mapping`: `SELECT Host AS member_host, User AS member_user, Role AS role, Admin_option FROM mysql.roles_mapping ORDER BY Role, User` (KHÔNG có role_edges) |
| Default role syntax | `SET DEFAULT ROLE <r> FOR 'u'@'h'` (từ khoá **FOR**, không phải TO; không có dạng `ALL`) — check hiện tại: `SELECT DEFAULT_ROLE FROM information_schema.APPLICABLE_ROLES` **[CẦN XÁC MINH cột — fallback đọc `mysql.user.default_role`]** |
| Auth plugins | dropdown: `mysql_native_password` (default), `ed25519`, `unix_socket` (không password); KHÔNG có `caching_sha2_password` |
| Tạo role | `CREATE ROLE 'r' [WITH ADMIN CURRENT_USER]` |
| Không có | `PASSWORD EXPIRE INTERVAL` trước 10.4.3 — chỉ emit khi user điền, lỗi server surface nguyên văn |

Grant/revoke/level/column-priv/`REVOKE ALL PRIVILEGES, GRANT OPTION` — giống MySQL (§3.2). Integration `mariadb_user_manager_end_to_end` giống §3.4 + assert `is_role` phân loại đúng + `SET DEFAULT ROLE … FOR` có hiệu lực sau reconnect.

**UI riêng MariaDB**: cùng shell **"Users and Privileges"** như §3.3 (Login tab với Host bắt buộc + Administrative/Global Privileges checklist + Schema Privileges Add-Entry matrix + SHOW GRANTS), nhưng: (a) list trái + cây Explorer tách 2 folder **Users** / **Roles** chính xác theo `is_role` (không heuristic như MySQL); (b) Roles tab dùng `roles_mapping` + `SET DEFAULT ROLE … FOR`; (c) plugin dropdown theo bảng trên (chọn `unix_socket` → ẩn field Password).

---

## 5. MSSQL — 2 tầng: Server Logins ↔ Database Users, GRANT/DENY/REVOKE

Mô hình khác hẳn: **Login** (server-level, để đăng nhập) map vào **User** (database-level, để phân quyền trong DB) + server roles (fixed) + database roles (fixed + custom) + 3 trạng thái quyền **GRANT / DENY / REVOKE** (DENY thắng GRANT — UI phải thể hiện).

### 5.1 Introspection

| view | SQL |
|---|---|
| `logins` | `SELECT p.name, p.type_desc, p.is_disabled, CAST(p.create_date AS varchar(19)) AS create_date, p.default_database_name, COALESCE(l.is_policy_checked, 0) AS is_policy_checked FROM sys.server_principals p LEFT JOIN sys.sql_logins l ON l.principal_id = p.principal_id WHERE p.type IN ('S','U','G','E','X') AND p.name NOT LIKE '##%' ORDER BY p.name` (S=SQL, U/G=Windows, E/X=AAD) |
| `server_roles` | `SELECT name FROM sys.server_principals WHERE type = 'R' ORDER BY name` |
| `server_role_members` | `SELECT r.name AS role, m.name AS member FROM sys.server_role_members rm JOIN sys.server_principals r ON r.principal_id = rm.role_principal_id JOIN sys.server_principals m ON m.principal_id = rm.member_principal_id ORDER BY r.name, m.name` |
| `db_users` | `SELECT dp.name, dp.type_desc, COALESCE(dp.default_schema_name,'') AS default_schema, COALESCE(sp.name,'') AS login_name, CASE WHEN dp.type = 'S' AND sp.sid IS NULL AND dp.authentication_type <> 0 THEN 1 ELSE 0 END AS orphaned FROM sys.database_principals dp LEFT JOIN sys.server_principals sp ON sp.sid = dp.sid WHERE dp.type IN ('S','U','G','E','X') AND dp.name NOT IN ('sys','INFORMATION_SCHEMA','guest') ORDER BY dp.name` — cột `orphaned` = user mà login đã bị xoá (case thực tế phổ biến sau restore DB); UI badge **orphaned** + action `Drop user` hoặc remap (`ALTER USER [u] WITH LOGIN = [l]`) |
| `db_roles` | `SELECT name, is_fixed_role FROM sys.database_principals WHERE type = 'R' ORDER BY is_fixed_role DESC, name` |
| `db_role_members` | `SELECT r.name AS role, m.name AS member FROM sys.database_role_members rm JOIN sys.database_principals r ON r.principal_id = rm.role_principal_id JOIN sys.database_principals m ON m.principal_id = rm.member_principal_id ORDER BY r.name, m.name` |
| `db_permissions` | `SELECT pr.name AS principal, pe.state_desc, pe.permission_name, CASE pe.class WHEN 0 THEN 'DATABASE' WHEN 1 THEN COALESCE(OBJECT_SCHEMA_NAME(pe.major_id) + '.' + OBJECT_NAME(pe.major_id), '?') WHEN 3 THEN 'SCHEMA::' + SCHEMA_NAME(pe.major_id) ELSE pe.class_desc END AS securable, COALESCE(c.name, '') AS column_name FROM sys.database_permissions pe JOIN sys.database_principals pr ON pr.principal_id = pe.grantee_principal_id LEFT JOIN sys.columns c ON pe.class = 1 AND c.object_id = pe.major_id AND c.column_id = pe.minor_id ORDER BY pr.name, securable` |
| `server_permissions` | `SELECT pr.name AS principal, pe.state_desc, pe.permission_name, pe.class_desc FROM sys.server_permissions pe JOIN sys.server_principals pr ON pr.principal_id = pe.grantee_principal_id ORDER BY pr.name` |

Lưu ý: các view `db_*` chạy trên **database hiện tại của connection** — UI có DB selector (reuse `attach_database` sub-connection như SqlWorkspace/Compare) để quản trị user của từng database.

### 5.2 Mutations (`src/lib/users/mssql.ts`)

| Hàm | Statement |
|---|---|
| `createLogin` | `CREATE LOGIN [x] WITH PASSWORD = N'<pwd>'[, CHECK_POLICY = OFF][, CHECK_EXPIRATION = OFF][, DEFAULT_DATABASE = [db]]` — SQL authentication |
| `createWindowsLogin` | `CREATE LOGIN [DOMAIN\name] FROM WINDOWS [WITH DEFAULT_DATABASE = [db]]` — radio "Windows authentication" trong dialog (không có field password); tên nhập dạng `DOMAIN\name`, vẫn escape `[…]`. AAD (`FROM EXTERNAL PROVIDER`) **chỉ Azure SQL** — v1 KHÔNG có nút tạo, chỉ hiển thị login E/X đã tồn tại (badge), ghi chú trong UI |
| `alterLoginPassword` | `ALTER LOGIN [x] WITH PASSWORD = N'<pwd>'` |
| `enable/disableLogin` | `ALTER LOGIN [x] ENABLE` / `DISABLE` |
| `dropLogin` | `DROP LOGIN [x]` |
| `createUser` | `CREATE USER [u] FOR LOGIN [l] [WITH DEFAULT_SCHEMA = [s]]` — hoặc `CREATE USER [u] WITHOUT LOGIN` (contained, checkbox) |
| `dropUser` | `DROP USER [u]` |
| `createDbRole` | `CREATE ROLE [r] [AUTHORIZATION [owner]]` |
| `dropDbRole` | `DROP ROLE [r]` |
| `addDbRoleMember` / `dropDbRoleMember` | `ALTER ROLE [r] ADD MEMBER [u]` / `DROP MEMBER [u]` |
| `addServerRoleMember` / `drop…` | `ALTER SERVER ROLE [sysadmin] ADD MEMBER [login]` / `DROP MEMBER` — fixed roles whitelist: `sysadmin serveradmin securityadmin processadmin setupadmin bulkadmin diskadmin dbcreator` |
| `grant/deny(perm[], securable, principal, opts)` | `{GRANT\|DENY} <perms> ON {[s].[t] [(col,…)] \| SCHEMA::[s] \| DATABASE::[db]} TO [principal] [WITH GRANT OPTION]` — perm whitelist per securable class: object = `SELECT INSERT UPDATE DELETE EXECUTE REFERENCES ALTER VIEW DEFINITION CONTROL`; schema = thêm `CREATE SEQUENCE`; database = `CREATE TABLE CREATE VIEW CREATE PROCEDURE BACKUP DATABASE VIEW DEFINITION CONNECT…`; server-level (`VIEW SERVER STATE ALTER ANY LOGIN…`) = `GRANT <p> TO [login]` chạy trên master |
| `revoke` | `REVOKE [GRANT OPTION FOR] <perms> ON <securable> {TO\|FROM} [principal] [CASCADE]` — REVOKE xoá cả GRANT lẫn DENY (giải thích trong UI) |

**Driver fix bắt buộc** (§1.4): route toàn bộ qua `simple_query`.

### 5.3 UI riêng MSSQL — theo SSMS: **Security** 2 tầng Server/Database

- **Cây Explorer (§1.2b, đúng SSMS)**: cấp connection có folder **`Security`** → **`Logins`** + **`Server Roles`**; **trong mỗi database node** có folder **`Security`** → **`Users`** + **`Roles`** (Database Roles). Thuật ngữ đúng SSMS, không dịch, không gộp.
- **Tab User Manager 2 tầng**: thanh scope trên cùng **`Server`** · **`Database: [DB selector ▾]`** (reuse `attach_database` sub-connection).
- **Scope Server — Logins**: list + type badge (`SQL Server authentication` / `Windows` / `Azure AD`), disabled dot. Detail: **General** (password — chỉ SQL auth, `Enforce password policy` = CHECK_POLICY, `Default database` dropdown) · **Server Roles** (checkbox theo fixed list `sysadmin serveradmin securityadmin processadmin setupadmin bulkadmin diskadmin dbcreator`) · **Securables** (server permissions từ `server_permissions`, state GRANT/DENY) · **User Mapping** (bảng: mỗi database × user đã map + default schema — đúng dialog Login Properties của SSMS; tick database chưa map → sinh `CREATE USER … FOR LOGIN`; **mỗi statement chạy trên đúng database đích qua sub-connection `attach_database` `{conn}::{db}`** — CREATE USER là lệnh per-database, không chạy được từ DB khác).
- **Scope Database — Users**: list (cột `login_name` map về, `default_schema`); New User = chọn Login (dropdown từ `logins`) + tên user + default schema. **Roles**: fixed roles (`db_owner db_datareader db_datawriter db_ddladmin db_securityadmin db_accessadmin db_backupoperator db_denydatareader db_denydatawriter`) đánh dấu khoá không xoá được + custom roles CRUD; detail role = members (Add/Drop member).
- **Permissions matrix** (scope Database): bảng securable × principal, mỗi ô hiển thị state 3 giá trị `GRANT` / `GRANT + WITH GRANT OPTION` / `DENY` bằng màu (DENY = màu error) + chú thích cố định "DENY overrides GRANT".
- **New Login / New User / New Role = POPUP dialog** (rule §1.2): `MssqlCreateLoginDialog` (name + auth type + password/policy + default database), `MssqlCreateUserDialog` (chọn Login từ dropdown + tên user + default schema — mở từ node Users của database nào thì bind database đó), `MssqlCreateRoleDialog` (tên + owner). Securables/role membership chỉnh sau khi tạo, trong tab detail.
- **Wizard "New login + user + role membership"** = POPUP wizard 3 bước (kịch bản phổ biến nhất): Login (server) → map User vào 1..n database → tick database roles; preview 2–4 statement theo đúng thứ tự CREATE LOGIN → CREATE USER → ALTER ROLE ADD MEMBER; Execute chạy tuần tự trong dialog.

### 5.4 Integration

`mssql_user_manager_end_to_end`: CREATE LOGIN (CHECK_POLICY=OFF, password phức) → connect connection mới bằng login đó vào DB test → SELECT denied (chưa có user) → CREATE USER FOR LOGIN → vẫn denied → GRANT SELECT ON schema::dbo → OK → **DENY SELECT trên 1 bảng → bảng đó denied dù schema GRANT** (chứng minh DENY-wins render đúng) → REVOKE/DROP USER/LOGIN sạch. Chạy qua raw-batch routing.

---

## 6. ClickHouse — SQL-driven RBAC (users/roles/grants), gate `access_management`

### 6.1 Gates (bắt buộc kiểm tra trước, UI banner)

1. **Quyền**: user hiện tại cần `ACCESS MANAGEMENT` privileges. Probe: `SHOW GRANTS` → nếu thiếu `ACCESS MANAGEMENT` trong output → banner hướng dẫn: docker image bật bằng env `CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1` hoặc `access_management: 1` trong `users.xml`.
2. **Storage**: chỉ user/role có `storage = 'local_directory'` sửa được bằng SQL; user định nghĩa trong `users.xml` → badge **read-only (users.xml)**. **[CẦN XÁC MINH giá trị chuỗi `storage` chính xác trên CH 24.x — đọc `system.users.storage` trong integration test đầu tiên rồi khoá hằng]**

### 6.2 Introspection

| view | SQL |
|---|---|
| `users` | `SELECT name, storage, toString(auth_type) AS auth_type, toString(host_ip) AS host_ip, toString(host_names) AS host_names, default_roles_all, toString(default_roles_list) AS default_roles, toString(default_database) AS default_database FROM system.users ORDER BY name` (`toString` để version-safe — `auth_type` thành Array trong CH mới) |
| `roles` | `SELECT name, storage FROM system.roles ORDER BY name` |
| `grants` | `SELECT COALESCE(user_name, '') AS user, COALESCE(role_name, '') AS role, toString(access_type) AS access_type, COALESCE(database, '') AS database, COALESCE(table, '') AS table, COALESCE(column, '') AS column, is_partial_revoke, grant_option FROM system.grants ORDER BY user, role, access_type` |
| `role_grants` | `SELECT COALESCE(user_name,'') AS user, COALESCE(role_name,'') AS role, granted_role_name, with_admin_option FROM system.role_grants ORDER BY 1, 3` |
| `grants_for` (arg) | `SHOW GRANTS FOR <name>` — hiển thị nguyên văn |
| `settings_profiles` / `row_policies` / `quotas` | `SELECT name, storage FROM system.settings_profiles ORDER BY name` / `SELECT name, short_name, database, table FROM system.row_policies ORDER BY name` / `SELECT name, storage FROM system.quotas ORDER BY name` — **v1 read-only** (manage = phase sau) |

### 6.3 Mutations (`src/lib/users/clickhouse.ts`)

| Hàm | Statement |
|---|---|
| `createUser` | `CREATE USER <u> IDENTIFIED WITH sha256_password BY '<pwd>' [HOST {ANY \| IP '<ip>' \| LIKE '<pattern>'}] [DEFAULT ROLE <r1>, <r2> \| DEFAULT ROLE NONE] [DEFAULT DATABASE <db>] [SETTINGS PROFILE '<p>']` — auth dropdown: `sha256_password` (default), `no_password` (cảnh báo), `plaintext_password` (cảnh báo mạnh) |
| `alterUserPassword` | `ALTER USER <u> IDENTIFIED WITH sha256_password BY '<pwd>'` |
| `alterUserHost` | `ALTER USER <u> HOST …` |
| `renameUser` | `ALTER USER <u> RENAME TO <v>` |
| `dropUser` | `DROP USER <u>` |
| `createRole` / `dropRole` | `CREATE ROLE <r>` / `DROP ROLE <r>` |
| `grant(privs[], scope, grantee, opt)` | `GRANT SELECT(col1, col2), INSERT ON <db>.<tbl> TO <grantee> [WITH GRANT OPTION]` — scope: `*.*` / `<db>.*` / `<db>.<tbl>` (+column list cho SELECT/INSERT/ALTER UPDATE). Priv whitelist chuẩn CH: `SELECT INSERT ALTER CREATE DROP TRUNCATE OPTIMIZE SHOW KILL QUERY ACCESS MANAGEMENT SYSTEM dictGet…` — nhóm theo cây priv của CH (UI hiện dạng tree checkbox) |
| `grantRole(role, grantee, admin)` | `GRANT <r> TO <u> [WITH ADMIN OPTION]` |
| `revoke` | `REVOKE <privs> ON <scope> FROM <grantee>` / `REVOKE <r> FROM <u>` |
| `setDefaultRole` | `SET DEFAULT ROLE <r1>[, <r2>] TO <u>` / `SET DEFAULT ROLE NONE TO <u>` / `ALTER USER <u> DEFAULT ROLE ALL` |

Execute qua `exec_statement` (ChDriver HTTP) — cảnh báo trong UI khi connection không SSL: password đi plaintext trong HTTP body.

### 6.4 Integration (container `clickhouse/clickhouse-server` + env `CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1`)

`clickhouse_user_manager_end_to_end`: CREATE USER + ROLE → GRANT SELECT ON db.tbl TO role → GRANT role TO user → connect connection mới bằng user → SELECT OK, INSERT **denied** → `system.grants`/`system.role_grants` phản ánh đúng → SET DEFAULT ROLE → REVOKE → denied → DROP sạch. Assert luôn giá trị `storage` thật (khoá hằng ở 6.1.2).

---

## 7. Cassandra — Roles + Permissions (CQL), gate PasswordAuthenticator

### 7.1 Gate

Cluster default (`AllowAllAuthenticator`/`AllowAllAuthorizer`) → mọi lệnh role/permission **vô nghĩa hoặc lỗi**. Probe: chạy `LIST ROLES` qua `cql_exec`; lỗi (`InvalidRequest`/`Unauthorized`) → panel hướng dẫn bật trong `cassandra.yaml`: `authenticator: PasswordAuthenticator`, `authorizer: CassandraAuthorizer` (+ superuser mặc định `cassandra/cassandra`). Không fake UI khi chưa bật.

### 7.2 Introspection (đều qua `cql_exec`, kết quả là result set chuẩn)

| view | CQL |
|---|---|
| roles | `LIST ROLES` (cột: `role`, `super`, `login`, `options`, `datacenters` tuỳ version) |
| roles of member | `LIST ROLES OF <role> NORECURSIVE` |
| all permissions | `LIST ALL PERMISSIONS` |
| permissions of role | `LIST ALL PERMISSIONS OF <role>` |
| permissions on resource | `LIST ALL PERMISSIONS ON KEYSPACE <ks>` / `ON TABLE <ks>.<t>` |

**KHÔNG** đọc thẳng `system_auth.roles` (chứa `salted_hash` — cấm hiển thị; LIST ROLES là API đúng).

### 7.3 Mutations (`src/lib/users/cassandra.ts`)

| Hàm | CQL |
|---|---|
| `createRole` | `CREATE ROLE <r> WITH PASSWORD = '<pwd>' AND LOGIN = true AND SUPERUSER = false` — LOGIN/SUPERUSER checkbox; role không login (pure group) → bỏ PASSWORD + LOGIN=false |
| `alterRole` | `ALTER ROLE <r> WITH PASSWORD = '<pwd>'` / `WITH LOGIN = false` / `WITH SUPERUSER = true` (emit đúng option đổi) |
| `dropRole` | `DROP ROLE [IF EXISTS] <r>` |
| `grantRole` | `GRANT <r1> TO <r2>` |
| `revokeRole` | `REVOKE <r1> FROM <r2>` |
| `grantPermission(perm, resource, role)` | `GRANT {ALL PERMISSIONS\|SELECT\|MODIFY\|ALTER\|DROP\|AUTHORIZE\|DESCRIBE\|EXECUTE\|CREATE} ON {ALL KEYSPACES\|KEYSPACE <ks>\|TABLE <ks>.<t>\|ALL ROLES\|ROLE <r>} TO <role>` — cả 2 chiều whitelist; matrix hợp lệ perm×resource enforce trong builder (vd `EXECUTE` chỉ trên FUNCTION resources — v1 bỏ function resources, ghi chú) |
| `revokePermission` | `REVOKE <perm> ON <resource> FROM <role>` |

### 7.4 UI riêng Cassandra

Một loại principal (role); list + badge `LOGIN`/`SUPER`; tabs General (password/login/super) · Member of · Permissions (bảng từ LIST ALL PERMISSIONS OF, nút Grant per keyspace/table từ tree introspection sẵn có).

### 7.5 Integration (container `cassandra:5.0`, bật auth qua override entrypoint)

Command container: `bash -c "sed -i 's/AllowAllAuthenticator/PasswordAuthenticator/; s/AllowAllAuthorizer/CassandraAuthorizer/' /etc/cassandra/cassandra.yaml && exec docker-entrypoint.sh cassandra -f"` **[CẦN XÁC MINH đường dẫn yaml trong image 5.0 — kiểm tra 1 lần khi viết test]**; wait strategy = retry login `cassandra/cassandra` (superuser được tạo async ~10s). Test `cassandra_user_manager_end_to_end`: login superuser → CREATE ROLE app_user LOGIN → connect connection mới bằng role đó → SELECT trên bảng seed **Unauthorized** → GRANT SELECT ON KEYSPACE → OK → MODIFY denied → GRANT MODIFY → INSERT OK → LIST ALL PERMISSIONS OF khớp → REVOKE + DROP ROLE sạch.

---

## 8. MongoDB — per-database users + built-in/custom roles (command-based)

Không SQL — toàn bộ qua **driver methods mới** trong `drivers/mongo.rs` (run_command), expose thành command Tauri riêng + `ipc.mongo*` + demo mock. Không string-build → không escaping.

### 8.1 Driver methods + commands mới

| Command | run_command (trên DB `<db>` trừ khi ghi khác) | Trả về |
|---|---|---|
| `mongo_users(conn_id)` | `{ usersInfo: { forAllDBs: true }, showCredentials: false }` chạy trên **admin**; nếu lỗi (thiếu quyền) fallback `{ usersInfo: 1 }` trên từng db của connection | mảng `{ user, db, roles: [{role, db}], mechanisms }` |
| `mongo_user_detail(conn_id, db, user)` | `{ usersInfo: { user: <u>, db: <db> }, showPrivileges: true }` | user + `inheritedRoles` + `inheritedPrivileges` |
| `mongo_create_user(conn_id, db, user, pwd, roles)` | `{ createUser: <u>, pwd: <p>, roles: [{ role, db }] }` | ok |
| `mongo_change_password(conn_id, db, user, pwd)` | `{ updateUser: <u>, pwd: <p> }` | ok |
| `mongo_drop_user(conn_id, db, user)` | `{ dropUser: <u> }` | ok |
| `mongo_grant_roles(conn_id, db, user, roles)` | `{ grantRolesToUser: <u>, roles: [...] }` | ok |
| `mongo_revoke_roles(conn_id, db, user, roles)` | `{ revokeRolesFromUser: <u>, roles: [...] }` | ok |
| `mongo_roles(conn_id, db)` | `{ rolesInfo: 1, showBuiltinRoles: true, showPrivileges: true }` | built-in + custom roles |
| `mongo_create_role(conn_id, db, role, privileges, inheritedRoles)` | `{ createRole: <r>, privileges: [{ resource: { db, collection }, actions: [...] }], roles: [...] }` | ok |
| `mongo_update_role` / `mongo_drop_role` | `{ updateRole: … }` / `{ dropRole: <r> }` | ok |

Gate: connection không bật auth (`--auth` off) → `usersInfo` vẫn chạy nhưng cảnh báo banner "Server running without authentication — users exist but are not enforced". Thiếu quyền (`userAdmin`/`userAdminAnyDatabase`) → lỗi nguyên văn từ server.

### 8.2 UI riêng Mongo

- DB selector (user thuộc authentication database) + list users `user@db`.
- Detail: **Roles** (chips `role@db`, thêm/xoá qua grant/revoke; dropdown built-in roles: `read readWrite dbAdmin dbOwner userAdmin clusterAdmin clusterManager clusterMonitor hostManager backup restore readAnyDatabase readWriteAnyDatabase userAdminAnyDatabase dbAdminAnyDatabase root` + custom roles của db) · **Privileges (effective)** (bảng `inheritedPrivileges`: resource → actions, read-only) · **Password** (changeUserPassword).
- Tab Roles (custom role builder): resource = db+collection picker (từ tree sẵn có), actions multi-select whitelist (`find insert update remove createCollection dropCollection createIndex dropIndex listCollections listIndexes…` — dùng đúng action list của server, nhóm theo category).

### 8.3 Integration (container `mongo:7` + `MONGO_INITDB_ROOT_USERNAME/PASSWORD` + `--auth`)

`mongo_user_manager_end_to_end`: root connect → createUser `app` với `read@testdb` → connect connection mới bằng `app` (authSource=testdb) → find OK, insert **denied** (`not authorized`) → grantRolesToUser `readWrite` → insert OK → custom role chỉ `find` trên 1 collection → verify effective privileges → revoke/drop sạch → usersInfo không còn.

---

## 9. Redis — **NGOÀI PHẠM VI (user chốt không làm)**

Không làm ACL manager cho Redis. Entry point User Manager **ẩn** với connection redis. Không code, không UI stub. (Nếu sau này cần, mô hình đúng là Redis ACL ≥6 qua driver methods typed — sẽ spec lại khi user yêu cầu.)

---

## 10. Oracle — Users + Roles + System/Object privileges

### 10.1 Introspection (alias quoted-lowercase như precedent `admin.rs:124-139`)

| view | SQL |
|---|---|
| `users` | `SELECT username AS "name", account_status AS "status", default_tablespace AS "tablespace", temporary_tablespace AS "temp_tablespace", profile AS "profile", authentication_type AS "auth_type", TO_CHAR(created,'YYYY-MM-DD') AS "created", TO_CHAR(expiry_date,'YYYY-MM-DD') AS "expires" FROM dba_users ORDER BY username` |
| `roles` | `SELECT role AS "name", authentication_type AS "auth_type" FROM dba_roles ORDER BY role` |
| `role_privs` (arg=grantee) | `SELECT grantee AS "grantee", granted_role AS "role", admin_option AS "admin_option", default_role AS "default_role" FROM dba_role_privs ORDER BY grantee, granted_role` |
| `sys_privs` | `SELECT grantee AS "grantee", privilege AS "privilege", admin_option AS "admin_option" FROM dba_sys_privs ORDER BY grantee, privilege` |
| `tab_privs` | `SELECT grantee AS "grantee", owner AS "owner", table_name AS "object", privilege AS "privilege", grantable AS "grantable" FROM dba_tab_privs WHERE owner NOT IN ('SYS','SYSTEM') ORDER BY grantee, owner, table_name` (toggle hiện SYS) |
| `col_privs` | `SELECT grantee AS "grantee", owner AS "owner", table_name AS "object", column_name AS "column", privilege AS "privilege" FROM dba_col_privs ORDER BY 1,2,3` |
| `quotas` | `SELECT username AS "name", tablespace_name AS "tablespace", CASE WHEN max_bytes = -1 THEN 'UNLIMITED' ELSE TO_CHAR(max_bytes) END AS "quota" FROM dba_ts_quotas ORDER BY username` |
| `profiles` | `SELECT DISTINCT profile AS "name" FROM dba_profiles ORDER BY profile` |

Gate: `dba_*` cần quyền DBA — bắt `ORA-00942` → banner "Requires DBA privileges (SELECT on DBA_ views)". Không fallback `user_*` (chỉ thấy chính mình — vô dụng cho manager).

### 10.2 Mutations (`src/lib/users/oracle.ts`)

| Hàm | Statement |
|---|---|
| `createUser` | `CREATE USER <u> IDENTIFIED BY "<pwd>" [DEFAULT TABLESPACE <ts>] [TEMPORARY TABLESPACE <ts>] [QUOTA {UNLIMITED\|<n>M} ON <ts>] [PROFILE <p>] [ACCOUNT UNLOCK]` — tablespace/profile dropdown từ introspection; **kèm gợi ý mặc định grant `CREATE SESSION`** (checkbox "Grant CREATE SESSION" bật sẵn → emit thêm `GRANT CREATE SESSION TO <u>`) |
| `alterPassword` | `ALTER USER <u> IDENTIFIED BY "<pwd>"` |
| `lock/unlock` | `ALTER USER <u> ACCOUNT LOCK` / `ACCOUNT UNLOCK` |
| `expirePassword` | `ALTER USER <u> PASSWORD EXPIRE` |
| `setQuota` | `ALTER USER <u> QUOTA {UNLIMITED\|<n>M} ON <ts>` |
| `dropUser` | `DROP USER <u> [CASCADE]` — CASCADE checkbox, cảnh báo đỏ (xoá toàn bộ schema objects) |
| `createRole` / `dropRole` | `CREATE ROLE <r> [IDENTIFIED BY "<pwd>"]` / `DROP ROLE <r>` |
| `grantSysPrivs(privs[], grantee, admin)` | `GRANT <p1>, <p2> TO <grantee> [WITH ADMIN OPTION]` — whitelist system privs nhóm theo category (`CREATE SESSION`, `CREATE TABLE`, `CREATE VIEW`, `CREATE PROCEDURE`, `CREATE SEQUENCE`, `CREATE TRIGGER`, `UNLIMITED TABLESPACE`, `SELECT ANY TABLE`…, danh sách đầy = hằng trong builder) |
| `grantRole(role, grantee, admin)` | `GRANT <r> TO <grantee> [WITH ADMIN OPTION]` + `ALTER USER <u> DEFAULT ROLE ALL` (checkbox) |
| `grantObjPrivs(privs[], owner, obj, grantee, grantOpt, cols?)` | `GRANT SELECT, UPDATE (col1, col2) ON <owner>.<obj> TO <grantee> [WITH GRANT OPTION]` — object priv whitelist: `SELECT INSERT UPDATE DELETE ALTER INDEX REFERENCES EXECUTE READ WRITE`; **object priv dùng GRANT OPTION, system/role dùng ADMIN OPTION** (builder enforce, không cho lẫn) |
| `revoke*` | `REVOKE <p> FROM <grantee>` / `REVOKE <p> ON <owner>.<obj> FROM <grantee>` |

Lưu ý CDB: nếu connect vào CDB$ROOT, common user phải prefix `C##` — builder **không tự thêm**; bắt lỗi `ORA-65096` → hint "In CDB root, common users must be named C##…; connect to a PDB to create local users."

### 10.2b UI riêng Oracle — theo SQL Developer: **"Other Users"** + dialog Create/Edit User dạng tab

- **Cây Explorer (§1.2b)**: node **`Other Users`** cấp connection (đúng tên SQL Developer; con = từng user, badge account_status `OPEN`/`LOCKED`/`EXPIRED`) + node **`Roles`** ngang hàng (từ `dba_roles`).
- **List trái (trong tab)**: users (badge status) | toggle sang Roles.
- **Create User = POPUP dialog** (`OracleCreateUserDialog`, rule §1.2) — đúng bố cục tab của SQL Developer (bảng dưới); **Edit user đã tồn tại = tab User Manager detail** dùng cùng bố cục tab. Mỗi tab map thẳng vào builder §10.2:

  | Tab | Nội dung | Map builder |
  |---|---|---|
  | **User** | `User Name` · `New Password`/`Confirm` · `Profile` (dropdown từ view `profiles`) · `Authentication` (v1 chỉ Password) · `Default Tablespace` + `Temporary Tablespace` (dropdown từ introspection) · checkbox `Account is Locked` · checkbox `Password Expired (user must change next login)` | `createUser`/`alterPassword`/`lock/unlock`/`expirePassword` |
  | **Granted Roles** | Grid **mọi role** (từ `roles`) × 3 checkbox mỗi dòng: `Granted` · `Admin Option` · `Default` | `grantRole`/`revoke` + `ALTER USER … DEFAULT ROLE` |
  | **System Privileges** | Grid system privs (whitelist §10.2) × 2 checkbox: `Granted` · `Admin Option`; filter box | `grantSysPrivs`/`revoke` |
  | **Object Privileges** | Bảng grants hiện có (từ `tab_privs`/`col_privs`, filter grantee = user) + nút `Grant…` (owner → object → privs whitelist → cột optional → `Grant Option`) / `Revoke` per dòng | `grantObjPrivs`/`revoke` |
  | **Quotas** | Grid tablespace × quota: radio `None` / `Unlimited` / value MB | `setQuota` |
  | **SQL** | Preview **toàn bộ** statement sẽ chạy (tổng hợp diff các tab, đúng thứ tự CREATE/ALTER → GRANT), read-only, highlightSql — đúng tab "SQL" của SQL Developer | tất cả |

- Apply = chạy tuần tự các statement trong tab SQL, dừng tại statement lỗi + surface `ORA-…` nguyên văn + đánh dấu statement nào đã chạy xong (không rollback tự động — DDL Oracle autocommit; ghi chú rõ trong dialog).
- `Drop User`: confirm in-app, checkbox `CASCADE` kèm cảnh báo đỏ "drops all objects in the user's schema".

### 10.3 Integration

Container `gvenzl/oracle-free` (theo hạ tầng test Oracle hiện có — nếu chưa có target integration Oracle thì tạo `users_integration.rs` riêng, **[CẦN XÁC MINH hạ tầng test Oracle hiện trạng trước khi code]**): SYSTEM → CREATE USER + GRANT CREATE SESSION → connect connection mới → SELECT trên bảng seed denied (`ORA-00942`) → GRANT SELECT → OK → REVOKE → denied → DROP USER CASCADE sạch.

---

## 11. Kafka — **NGOÀI PHẠM VI (user chốt không làm)**

Không làm ACL manager cho Kafka. Entry point User Manager **ẩn** với connection kafka. Kafka ACL giữ nguyên trạng thái Deferred từ T23 (cần broker authorizer + verify rdkafka Admin ACL API — chỉ spec lại khi user yêu cầu).

---

## 12. NATS — **NGOÀI PHẠM VI (user chốt không làm)**

Không làm gì cho NATS (kể cả info panel). Entry point User Manager **ẩn** với connection nats. NATS NKey-JWT giữ nguyên trạng thái Deferred từ T-D.

---

## 13. SQLite — Không có hệ thống user (panel giải thích)

SQLite là file-based, không có user/GRANT (access control = quyền file OS). `NoUserSystem.svelte`: một panel tĩnh "SQLite has no user/privilege system. Access control is the file system's permissions on the database file." + đường dẫn file từ profile. Entry point (context menu/toolbar) **ẩn** cho sqlite thay vì mở panel — **[QUYẾT ĐỊNH: ẩn hẳn hay hiện panel? — đề xuất: ẩn hẳn entry, đỡ noise]**.

---

## 14. Demo mocks (bắt buộc — rule ipc/demo)

`demo.ts` thêm case cho: `users_view` (per system trả fixture roles/users/grants hợp lý cho 8 engine trong phạm vi), `mongo_users`/`mongo_roles`/… (stateful create/drop để e2e, pattern `demoNatsStreams`). Mutation SQL engines đi qua `exec_statement` demo sẵn có (no-op ok) — e2e assert **SQL preview đúng** thay vì kết quả server (kết quả server do integration test cover).

## 15. Testing tổng hợp (gate mỗi phase)

1. **Unit (Vitest)** — builder per engine: mỗi hàm ≥1 test statement nguyên văn; escaping tests bắt buộc: tên chứa `'`, `"`, `` ` ``, `]`, space, unicode; password chứa `'` + `\`; Oracle password chứa `"` → throw validate.
2. **Unit (Rust)** — `users_query` per (system,view) như `admin_query_per_dialect` (`admin.rs:262`); `quote_ident/quote_str` backend; MSSQL `is_raw_batch` mở rộng.
3. **e2e (Playwright, demo)** — per engine 1 spec: mở User Manager → list render → **New user = POPUP dialog** (assert: dialog hiện, KHÔNG có tab mới sinh ra, backdrop-không-đóng) → preview chứa statement đúng → Execute (demo) → đóng dialog + list refresh → confirm dialog cho Drop. **+ Cây Explorer (§1.2b)**: node Security đúng tên/vị trí per engine (`Login/Group Roles` cấp connection PG; `Security→Logins` cấp server + `Security→Users/Roles` trong database node MSSQL; `Users and Privileges` MySQL/MariaDB; `Other Users` Oracle; `Users` trong db node Mongo), double-click principal mở tab focus đúng, context menu đủ item. **Lưu ý bài học AUDIT-11: e2e demo KHÔNG chứng minh hành vi server — chỉ chứng minh UI/preview.**
4. **Integration (testcontainers, methodology chuẩn CLAUDE.md)** — per engine `*_user_manager_end_to_end` như mô tả từng section. **Chuẩn vàng bắt buộc: connect connection MỚI bằng chính user vừa tạo và chứng minh allowed/denied trước & sau grant/revoke** (không chỉ đọc catalog). Cassandra/MSSQL chậm — timeout rộng, chạy `--test-threads=1`.
5. Gates thường trực: `npm run check` 0/0, `npm run tokens:check` 0 vi phạm mới, vitest/playwright/rust unit xanh, integration EXIT=0 per engine của phase.
6. **★ GATE CỨNG (§1.9): mỗi engine phải pass integration 6 bước CREATE→LOGIN→DENIED→GRANT→WRITE-DENIED→REVOKE trên container thật + test preset §1.8 theo chuẩn vàng.** Không đủ 6 bước = phase KHÔNG xong, KHÔNG merge. e2e demo (bước 3) chỉ chứng minh UI/preview — KHÔNG thay thế được integration này.

## 16. Thứ tự phase đề xuất (mỗi phase 1 commit, dừng chờ duyệt theo quy trình)

| Phase | Nội dung | Lý do thứ tự |
|---|---|---|
| **U0** | Khung: tab `user-manager` + `UserManagerView` dispatch + `users_admin.rs` (`users_query` skeleton + escapers) + entry points + **khung node Security trong ObjectExplorer (§1.2b, render per-engine theo phase)** + demo skeleton | Nền cho mọi engine |
| **U1** | PostgreSQL (§2) | Mô hình role thuần, catalog sạch nhất — chuẩn hoá UX |
| **U2** | MySQL (§3) + **U2b** MariaDB (§4) | Dùng chung nhiều builder; MariaDB ăn theo ngay sau |
| **U3** | MSSQL (§5) — gồm driver fix `is_raw_batch` | Phức tạp nhất (2 tầng + DENY) |
| **U4** | ClickHouse (§6) | |
| **U5** | MongoDB (§8) | Driver methods, không SQL |
| **U6** | Oracle (§10) | Phụ thuộc hạ tầng test Oracle [CẦN XÁC MINH] |
| **U7** | Cassandra (§7) + tổng rà soát entry points (ẩn cho sqlite/redis/kafka/nats) | Cần container auth riêng; chốt sổ |

## 17b. Rà soát so với thực tế — case đã cân nhắc, chốt v1 vs v2 (đọc kỹ trước khi code)

Đây là danh sách các case "thực tế có nhưng spec chủ động cắt khỏi v1" — ghi rõ để không hiểu nhầm là thiếu sót. Nếu user cần case nào vào v1, báo trước khi làm phase tương ứng.

| # | Case thực tế | Trạng thái | Lý do / xử lý |
|---|---|---|---|
| 1 | **PG connection limit reset khi ALTER** | v1 | `alterRoleOptions` chỉ emit option đổi — an toàn |
| 2 | **PG `IN ROLE` vs `ROLE` vs `ADMIN` lúc CREATE** | v1 chỉ `IN ROLE` | đủ cho gán membership; 2 cái kia hiếm |
| 3 | **PG default privileges EDIT trong grid** | v1 chỉ trong preset (checkbox future-tables) + read tab | tab "Default privileges" edit tự do = v2 |
| 4 | **PG RLS policies (`CREATE POLICY`)** | KHÔNG (out of scope) | là bảo mật row-level, khác trục user/privilege — feature riêng |
| 5 | **MySQL resource limits** (`MAX_QUERIES_PER_HOUR`, `MAX_USER_CONNECTIONS`) | v2 | field phụ trong CREATE/ALTER USER; ghi chú UI |
| 6 | **MySQL `REQUIRE SSL/X509/CIPHER`, `WITH MAX_*`** | v1 chỉ `REQUIRE SSL` (checkbox) | phần TLS chi tiết = v2 |
| 7 | **MySQL proxy users (`GRANT PROXY`)** | KHÔNG | hiếm, out of scope |
| 8 | **MySQL 8 partial revokes / `activate_all_roles_on_login`** | v1 hiển thị (tooltip role activation), không quản lý | đúng bản chất, không đoán |
| 9 | **MSSQL contained database users (`WITHOUT LOGIN` / `WITH PASSWORD`)** | v1 có `WITHOUT LOGIN`; contained-with-password = v2 | checkbox đã có ở `createUser` |
| 10 | **MSSQL Always Encrypted / column master keys / cert-based logins** | KHÔNG | ngoài trục user/privilege |
| 11 | **MSSQL application roles (`CREATE APPLICATION ROLE`)** | KHÔNG (out of scope) | hiếm |
| 12 | **MSSQL grant trên securable cấp cao khác** (ASSEMBLY, TYPE, XML SCHEMA COLLECTION, SERVICE…) | KHÔNG | grid chỉ cover DATABASE/SCHEMA/OBJECT(table,view,proc) — đủ 99% nhu cầu |
| 13 | **ClickHouse row policies / quotas / settings profiles — MANAGE** | v1 read-only (§6.2) | câu hỏi §17.3 |
| 14 | **ClickHouse `ON CLUSTER`** (RBAC đồng bộ nhiều node) | v1 KHÔNG tự thêm | checkbox `ON CLUSTER <name>` = v2; single-node chạy đúng |
| 15 | **ClickHouse grant theo cột / `GRANT CURRENT GRANTS`** | v1 có column-grant ở object-level; `CURRENT GRANTS` = v2 | |
| 16 | **Cassandra permission trên FUNCTION/MBEAN/ROLE resource** | v1 chỉ KEYSPACE/TABLE/ALL KEYSPACES/ROLE | FUNCTION resource = v2 (ghi chú §7.3) |
| 17 | **Cassandra `LIST … NORECURSIVE` cho PERMISSIONS** | **[CẦN XÁC MINH §1.8.5]** | nếu không hỗ trợ → hiển thị effective + chú thích |
| 18 | **MongoDB custom role với `privileges` fine-grained + cluster-wide roles** | v1 có builder role (§8.2) + built-in cluster roles gán được | privilege actions dùng danh sách server |
| 19 | **MongoDB users trên `$external`** (LDAP/x509/Kerberos) | v1 hiển thị (db=`$external`), tạo = v2 | createUser SCRAM là chính |
| 20 | **Oracle proxy users (`ALTER USER … GRANT CONNECT THROUGH`)** | KHÔNG | hiếm |
| 21 | **Oracle profiles CRUD, password verify function, tablespace CRUD** | KHÔNG (chỉ dropdown chọn profile/tablespace có sẵn) | quản lý profile/tablespace là feature riêng |
| 22 | **Oracle CDB common users (`C##`) tạo từ root** | v1 KHÔNG tự thêm prefix — bắt lỗi ORA-65096 + hint (§10.2) | local user trong PDB là luồng chính |
| 23 | **Oracle 12c `ADMINISTER KEY MANAGEMENT`, unified auditing grants** | KHÔNG | ngoài trục |
| 24 | **Tất cả engine: rename principal đang có active session** | surface lỗi server nguyên văn | không pre-check |
| 25 | **Concurrency: 2 admin sửa cùng user** | không lock; Apply xong luôn re-read introspection (§1.8.1) nên state hội tụ | last-write-wins, đúng như mọi tool |

## 17. Quyết định đã chốt (user đồng ý toàn bộ đề xuất — 2026-07-15)

Tất cả các câu dưới đã được user **chốt theo đề xuất**. Đây là ràng buộc khi code, không mở lại trừ khi user yêu cầu.

1. **Entry point** (§1.1): ✅ **Đổi thẳng** — nút "Users & privileges" mở User Manager mới; AdminView vẫn giữ tab Users read-only.
2. **Redis/Kafka/NATS**: ✅ không làm. **SQLite**: ✅ **ẩn hẳn** entry point (không hiện panel N/A).
3. **ClickHouse row policies / quotas / settings profiles**: ✅ **v1 read-only** (§6.2), manage để v2.
4. **PG `ALTER DEFAULT PRIVILEGES`**: ✅ **v1 chỉ edit qua checkbox "future tables"** trong preset (§1.8.3) + tab read-only; edit tự do = v2.
5. **Thứ tự phase §16**: ✅ giữ nguyên U0 → PG → MySQL/MariaDB → MSSQL → ClickHouse → MongoDB → Oracle → Cassandra.
6. **Danh sách cắt-khỏi-v1 §17b**: ✅ **giữ nguyên bảng** — không đưa case nào thêm vào v1.
7. **MSSQL Windows/AAD login**: ✅ v1 tạo được **SQL + Windows login** (`FROM WINDOWS`); **AAD chỉ hiển thị** (badge), không tạo (chỉ Azure SQL mới tạo được).

> Còn lại 3 điểm **[CẦN XÁC MINH]** (không phải câu hỏi cho user — tự xác minh khi code, đã có phương án dự phòng): (a) chuỗi `system.users.storage` ClickHouse §6.1.2; (b) `LIST … PERMISSIONS … NORECURSIVE` Cassandra §1.8.5/§17b#17; (c) đường dẫn `cassandra.yaml` image 5.0 §7.5 + hạ tầng test Oracle §10.3. Mỗi cái xác minh bằng 1 lệnh trên container ở đầu phase tương ứng.
