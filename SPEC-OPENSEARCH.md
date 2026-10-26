# SPEC-OPENSEARCH — Hỗ trợ OpenSearch (biến thể của engine Elasticsearch)

> Trạng thái: **đang implement** (2026-10-25). Mọi khẳng định dưới đây đã được **đo trên container
> `opensearchproject/opensearch:3` (OpenSearch 3.9.0)**, một bản bật security plugin (HTTPS, admin)
> và một bản tắt security — không suy diễn. Khuôn: `SPEC-VALKEY.md` / `SPEC-SCYLLADB.md` (biến thể
> của engine có sẵn). Yêu cầu người dùng: giao diện thương mại, **không thiếu tính năng**.

---

## 0. Kết luận & phạm vi

**OpenSearch KHÔNG là `SystemType` mới** — là flavor `opensearch` của engine `elasticsearch`: cùng
REST API lõi (index, document, search, aggregation, mapping, settings, alias, data stream, snapshot,
template, ingest pipeline, painless, analyze, profile, cat, nodes, tasks…), cùng driver reqwest, cùng
workspace (Discover, Index page, Console, Dev Tools, Cluster). Khác ở các **plugin** OpenSearch thay
cho tính năng X-Pack của Elastic. "Không thiếu tính năng" = mỗi màn hình Elastic có bản OpenSearch
tương đương chạy được, dùng đúng API của OpenSearch; tính năng Elastic không có tương đương thì
**không hiện** (không để nút hỏng).

Ngoài phạm vi: Anomaly Detection, k-NN/Neural search UI, ML Commons, Observability/Trace analytics,
Query Workbench notebooks, Index rollup search (đọc rollup index dùng Discover như index thường),
Notifications channel CRUD riêng (monitor action vẫn soạn được trong JSON).

## 1. Khác biệt đã đo (OpenSearch 3.9 vs Elasticsearch 8.x)

| # | Tính năng app | Elasticsearch | OpenSearch 3.9 (đo) | Xử lý |
|---|---|---|---|---|
| O1 | Nhận diện | `GET /` | `version.distribution: "opensearch"`, tagline OpenSearch | flavor + logo + tên |
| O2 | Kết nối user quyền tối thiểu (403 ở `GET /`) | `_security/_authenticate` | **400 no handler**; dùng `_plugins/_security/authinfo` | fallback 2 bước |
| O3 | SQL (Query Editor + tab SQL) | `POST _sql?format=json` | **405**; `POST _plugins/_sql?format=jdbc` → `{schema:[{name,type}], datarows:[[…]], total, size, cursor:"n:…"}`; trang sau `{cursor}`; đóng `_plugins/_sql/close` | đường riêng |
| O4 | SQL translate | `_sql/translate` | 400; `_plugins/_sql/_explain` | "Explain" |
| O5 | ES\|QL | `_query` | **405** — không có; thay bằng **PPL** `_plugins/_ppl` (cùng shape jdbc) + `_plugins/_ppl/_explain` | tab PPL |
| O6 | Lỗi SQL/PPL | `error.type/reason` | `{error:{reason:"Invalid SQL query", details:"…", type}}` — chi tiết nằm ở `details` | đọc `details` |
| O7 | Index lifecycle | `_ilm/policy`, `/{i}/_ilm/explain` | 400; **ISM** `_plugins/_ism/policies[/{id}]`, `_plugins/_ism/explain/{i}`, `add/{i}` `{policy_id}`, `remove/{i}`, `retry/{i}` | ISM |
| O8 | Snapshot lifecycle | `_slm/policy` | 400; **SM** `_plugins/_sm/policies/{name}` (POST tạo, PUT sửa), `_explain`, `_start`, `_stop` | SM |
| O9 | Transforms | `_transform` | `_plugins/_transform[/{id}]` (list `{total_transforms, transforms:[{_id,_seq_no,_primary_term,transform}]}`), `_start`, `_stop`, `_explain`, `_preview` | đường riêng |
| O10 | Rollups (OS có thêm) | — | `_plugins/_rollup/jobs[/{id}]` list `{total_rollups, rollups}`, `_start/_stop/_explain` | thêm |
| O11 | Watcher | `_watcher/*` | 400; **Alerting** `_plugins/_alerting/monitors` (POST tạo, id tự sinh), `/_search`, `/{id}`, `/{id}/_execute`, `alerts` | Alerting |
| O12 | Enrich | `_enrich/policy` | 400 — không có | ẩn |
| O13 | `_license`, `_xpack` | có | 400 | không gọi |
| O14 | Cập nhật ISM / transform / rollup / SM | PUT ghi đè | **409 version_conflict** (SM: validation) nếu thiếu `?if_seq_no=&if_primary_term=` | đọc lại seq ngay trước khi lưu |
| O15 | List khi plugin chưa có index cấu hình | `{}` | `_ingest/pipeline` → **404 `{}`**; transform/rollup → 404 `index_not_found .opendistro-ism-config` | 404 = danh sách rỗng |
| O16 | Security | `_security/user|role|role_mapping|api_key` | `_plugins/_security/api/internalusers|roles|rolesmapping|actiongroups|tenants|account|securityconfig`, `authinfo`; PATCH JSON-patch; **API tokens tắt mặc định** (`apitokens` 403); bản không security → 400 | màn Security riêng |
| O17 | Discover / KQL | KQL | cùng cú pháp — tên là **DQL** (Dashboards Query Language) | đổi nhãn |
| O18 | Giống hệt (đo) | — | cluster health/stats, cat indices/shards, nodes stats, tasks, cluster settings, allocation explain, index template + simulate, component template, ingest simulate + grok, data stream + rollover, snapshot repo, painless `_execute`, analyze, profile, validate, auto_date_histogram, bulk, mget, reindex, clone/shrink/split | dùng chung |

## 2. Thiết kế

- **Flavor**: trường profile `cassandra_flavor` (trường "server flavor" chung, tiền lệ Valkey):
  Elasticsearch = `"" | "elasticsearch" | "opensearch"`. Backend `es_server_info` (lưu flavor),
  `EsDriver` biết `distribution` từ `GET /` hoặc `authinfo`.
- **Backend**: `exec_sql` theo flavor (O3), connect fallback (O2), `describe_error` đọc `details`
  (O6). Mọi tính năng khác đi qua `es_request` (REST generic) — frontend chọn path theo flavor.
- **Frontend**: `src/lib/elastic/flavor.ts` (product, ngôn ngữ truy vấn, nhãn); `os-resources.ts` —
  danh mục Stack Management của OpenSearch dùng chung `EsManageView` (mở rộng `ResourceKind`:
  `emptyOn404`, `concurrency` (seq_no), `rowId`/`createPath` cho monitor); `EsQueryView` PPL/SQL;
  `EsIndexView` tab Lifecycle = ISM (apply/remove/retry); màn Security riêng `OsSecurityManager`
  (internal users, roles + DLS/FLS/masking + tenant permissions, role mappings, action groups,
  tenants, account); Console gợi ý endpoint `_plugins/*`; logo + thẻ picker + nhóm sidebar.
- **Logo**: mark chính thức OpenSearch hai tông (`#005EB8` + `#003B5C`) từ svg-logos
  `opensearch-icon` (CC0), chép nguyên văn; phần tối theo theme ở dark mode.

## 3. Kiểm thử

- Integration container thật `tests/opensearch_integration.rs`: OpenSearch 3.9 không security (mọi
  path frontend dùng, qua fixture chung với vitest) + có security (user quyền tối thiểu kết nối được;
  user/role/mapping/action group/tenant CRUD và kiểm quyền bằng hành vi thật).
- Vitest: flavor, os-resources (fixture), lỗi OpenSearch, kết quả jdbc.
- e2e `opensearch.spec.ts` trên demo `?opensearch=1`.
