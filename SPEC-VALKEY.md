# SPEC-VALKEY — Hỗ trợ Valkey (biến thể của engine Redis)

> Trạng thái: **đã implement** (2026-10-25). Mọi khẳng định về hành vi Valkey dưới đây đã được
> **đo trên container `valkey/valkey:8.1-alpine` (Valkey 8.1.10)**, so với `redis:7.2-alpine`,
> không suy diễn. Khuôn làm theo `SPEC-SCYLLADB.md` (biến thể của một engine có sẵn).

---

## 0. Kết luận & phạm vi

**Valkey KHÔNG là `SystemType` mới.** Valkey là fork của Redis 7.2.4 (Linux Foundation), cùng
giao thức RESP, cùng bộ lệnh, cùng encoding. App coi nó là **biến thể (flavor) `valkey` của
engine `redis`**: cùng driver (`drivers/redis.rs`, crate `redis`), cùng workspace Redis Browser,
cùng Backup & Restore. Chỉ khác **thương hiệu** (tên, logo, nhóm sidebar) và **2 chỗ đọc INFO**.

**Phạm vi**: nhận diện Valkey, hiện đúng tên và phiên bản thật, logo chính thức, thẻ riêng ở màn
chọn hệ, nhóm riêng trên sidebar, mọi câu chữ trong workspace gọi đúng "Valkey"; chứng minh mọi
tính năng Redis chạy trên Valkey thật bằng integration test.

**Ngoài phạm vi**: module riêng của Valkey (valkey-json, valkey-search, valkey-bloom), Valkey
Cluster (giống Redis Cluster — app chưa hỗ trợ cluster cho cả hai).

**Ràng buộc**: additive-only. Connection Redis không có flavor (hoặc flavor `redis`) giữ nguyên
mọi hành vi, tên, logo như trước.

## 1. Khác biệt đã đo (Valkey 8.1.10 vs Redis 7.2)

| # | Điểm | Redis 7.2 | Valkey 8.1 | Hệ quả nếu không xử lý |
|---|---|---|---|---|
| P1 | `INFO server` → phiên bản | `redis_version:7.2.x` | `redis_version:7.2.4` (**đóng băng** cho client cũ) + `valkey_version:8.1.10` + `server_name:valkey` | App hiện "Redis 7.2.4" cho server Valkey 8 |
| P2 | Chế độ server | `redis_mode:standalone` | **`server_mode:standalone`**, không có `redis_mode` | Hàng "Mode" trong Server info biến mất |
| P3 | Lệnh, encoding, `MEMORY USAGE`, `OBJECT ENCODING`, `SLOWLOG`, `CONFIG GET`, `DUMP/RESTORE`, Lua `EVAL` | — | Giống hệt (encoding embstr/listpack/intset/stream như nhau; size khác nhau vì allocator, không ảnh hưởng) | Không cần sửa — integration chứng minh |

INFO Valkey còn thêm vài trường (`io_threaded_*`, `paused_*`, `availability_zone`…) — app không
dùng, bảng Raw vẫn hiện đủ.

## 2. Thiết kế

- **Profile**: tái dùng trường `cassandra_flavor` làm trường "server flavor" chung (cùng tiền lệ
  `mssql_auth` / `sqlite_path` dùng chung): Redis = `"" | "redis" | "valkey"`. Không đổi schema
  lưu trữ, không đổi struct literal ở test.
- **Nhận diện**: pure `drivers/redis.rs::server_identity(info)` → `RedisServerInfo {flavor,
  version, label}`; Valkey nếu có `valkey_version` hoặc `server_name:valkey`, phiên bản lấy từ
  `valkey_version`. Dùng ở `RedisDriver::test` (Test connection hiện "Valkey 8.1.10") và lệnh
  mới `redis_server_info` (sau khi connect; lưu flavor vào profile, bỏ qua quick-connect).
- **Brand** (`src/lib/brand.ts`, dời từ `scylla/brand.ts`): `FLAVOR_BRANDS` (`scylladb` →
  cassandra, `valkey` → redis), `isValkey`, `brandKey`, `brandLabel`, `brandMeta`,
  `withFlavorBrands` (chèn brand ngay sau engine — dùng cho picker và nhóm sidebar).
- **Logo**: mark chính thức của Valkey. simple-icons **không có** Valkey → lấy nguyên văn path
  `valkey-icon` của **svg-logos** (gilbarbara/logos, CC0) qua `@iconify-json/logos` 1.2.17, màu
  thương hiệu `#6983FF`, viewBox riêng `0 0 256 295`. Không vẽ tay. Test ghim path bằng fixture
  `src/lib/components/__fixtures__/valkey-icon.d.txt`.
- **Token màu**: thêm `valkey` vào map SYS của prototype (`#6983FF`, badge `VK`) +
  `EXPECTED_SYSTEMS` → `npm run tokens`.
- **Workspace**: `stream/redis-info.ts::serverProduct(info)` đặt tên sản phẩm theo INFO (fallback
  brand của profile trước khi INFO về); `headerStats`/`redisHealth`/`serverInfoGroups` dùng nó;
  Mode đọc `redis_mode ?? server_mode`. Mọi câu chữ trong Browser / Workbench / Add key / Set
  expiry dùng tên sản phẩm; Workbench nói `valkey-cli` cho Valkey. `StreamShell` thêm prop `brand`
  (chỉ đổi logo, `data-stream-shell` vẫn là `redis`).
- **Form kết nối**: ô "Database engine" (2 thẻ có logo) dùng chung cho Cassandra/ScyllaDB và
  Redis/Valkey; Test connection tự chọn đúng thẻ. Kèm sửa lỗi có sẵn: connection Redis mới để
  trống ô DB Index → nay mặc định `0`.

## 3. Kiểm thử

- Rust unit `server_identity_tells_valkey_from_redis` (INFO thật của Valkey, server_name một
  mình, trường chỉ trùng tiền tố không bị đọc).
- Vitest: `brand.test.ts` (Valkey), `redis-browser.test.ts` (product/version/Mode),
  `color-identity.test.ts` (logo đúng path chính thức, không phải SystemKey).
- Integration container thật (cùng đường code với Redis, chạy trên `valkey/valkey:8.1-alpine`):
  `redis_workspace_integration::valkey_workspace_slowlog_info_and_key_meta` (Test connection +
  nhận diện + SLOWLOG + INFO + size/encoding + sửa từng phần tử bằng EVAL + SCAN pipeline + DEL),
  `backup_integration::valkey_backup_restore_one_logical_database_with_ttls`.
- e2e `valkey.spec.ts` (demo `?valkey=1` / `?valkey=undetected`): thẻ picker, form, nhóm sidebar,
  workspace/Server info/Workbench nói "Valkey 8.1.10", Redis thường vẫn nói Redis, profile chưa
  nhận diện tự chuyển sang nhóm Valkey sau khi connect.
