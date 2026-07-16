//! Integration test MongoDB (M1) — introspection chạy trên MongoDB THẬT qua
//! testcontainers (`mongo:7`). Seed bằng client mongodb rồi truy vấn lại bằng
//! MongoDriver để verify (không hard-code kết quả).
//!
//! Chạy: `cargo test --test mongo_integration` (cần Docker daemon).

use std::time::{Duration, Instant};

use database_studio_lib::drivers::grid::{Col, GridChange};
use std::sync::atomic::AtomicBool;

use database_studio_lib::drivers::mongo::{MongoConnParams, MongoDriver};
use database_studio_lib::drivers::plan::parse_mongodb;
use database_studio_lib::drivers::postgres::ExportFormat;
use database_studio_lib::drivers::types::StatementOutcome;
use mongodb::bson::{doc, Document};
use serde_json::json;
use mongodb::Client;
use testcontainers::core::IntoContainerPort;
use testcontainers::runners::AsyncRunner;
use testcontainers::{ContainerAsync, GenericImage, ImageExt};

async fn start_mongo() -> (ContainerAsync<GenericImage>, u16) {
    let c = GenericImage::new("mongo", "7")
        .with_exposed_port(27017.tcp())
        .start()
        .await
        .expect("start mongo container (Docker daemon phải đang chạy)");
    let port = c.get_host_port_ipv4(27017).await.unwrap();
    (c, port)
}

fn params(port: u16) -> MongoConnParams {
    MongoConnParams {
        host: "localhost".into(),
        port,
        database: "appdb".into(),
        user: String::new(),
        password: String::new(),
        ssl: false,
        ssl_ca: String::new(),
    }
}

#[tokio::test]
async fn mongo_introspection_databases_collections_indexes_fields() {
    let (_c, port) = start_mongo().await;

    // Chờ container sẵn sàng (retry connect tới deadline).
    let deadline = Instant::now() + Duration::from_secs(180);
    let drv = loop {
        match MongoDriver::connect(&params(port)).await {
            Ok(d) => break d,
            Err(e) => {
                assert!(Instant::now() < deadline, "mongo chưa sẵn sàng: {}", e.message);
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    };

    // --- Seed bằng client mongodb thật ---------------------------------------
    let client = Client::with_uri_str(format!("mongodb://localhost:{port}/"))
        .await
        .expect("seed client");
    let db = client.database("appdb");
    let coll = db.collection::<Document>("users");
    coll.insert_many(vec![
        doc! { "_id": 1, "name": "Ann", "age": 30, "email": "a@x.com" },
        doc! { "_id": 2, "name": "Bob", "age": 25 },
    ])
    .await
    .expect("insert seed docs");
    db.run_command(doc! {
        "createIndexes": "users",
        "indexes": [ { "key": { "email": 1 }, "name": "email_idx", "unique": true } ],
    })
    .await
    .expect("create index");

    // --- databases() ---------------------------------------------------------
    let dbs = drv.databases().await.expect("databases");
    assert!(dbs.iter().any(|d| d.name == "appdb"), "appdb phải có trong danh sách");
    assert!(
        dbs.iter().any(|d| d.name == "appdb" && d.current),
        "appdb là database mặc định → current=true"
    );

    // --- collections() -------------------------------------------------------
    let cols = drv.collections("appdb").await.expect("collections");
    assert!(
        cols.iter().any(|t| t.name == "users" && t.kind == "table"),
        "collection users phải liệt kê là kind=table"
    );

    // --- indexes() -----------------------------------------------------------
    let idx = drv.indexes("appdb", "users").await.expect("indexes");
    assert!(
        idx.iter().any(|i| i.primary && i.name == "_id_"),
        "index _id_ là primary"
    );
    let email = idx.iter().find(|i| i.name == "email_idx").expect("email_idx");
    assert!(email.unique, "email_idx phải unique");
    assert_eq!(email.columns, vec!["email".to_string()]);

    // --- collection_fields() — union key, _id đứng đầu -----------------------
    let fields = drv.collection_fields("appdb", "users").await.expect("fields");
    assert_eq!(fields.first().map(|f| f.name.as_str()), Some("_id"), "_id field đứng đầu");
    assert!(fields.iter().find(|f| f.name == "_id").unwrap().is_pk, "_id is_pk");
    let names: Vec<&str> = fields.iter().map(|f| f.name.as_str()).collect();
    for expected in ["name", "age", "email"] {
        assert!(names.contains(&expected), "field {expected} phải được suy ra qua sampling");
    }
    // Kiểu suy ra từ giá trị mẫu.
    let age = fields.iter().find(|f| f.name == "age").unwrap();
    assert_eq!(age.data_type, "int", "age là Int32 → 'int'");

    // --- exec_mongo (query editor, M2) --------------------------------------
    let rows = |o: StatementOutcome| match o {
        StatementOutcome::Rows { result } => result,
        other => panic!("expected Rows, got {other:?}"),
    };
    let affected = |o: StatementOutcome| match o {
        StatementOutcome::Affected { affected } => affected,
        other => panic!("expected Affected, got {other:?}"),
    };

    // find all (seeded 2 docs)
    let all = rows(drv.exec_mongo("db.users.find({})", None, None).await.unwrap().outcome);
    assert_eq!(all.total, 2, "find({{}}) trả 2 doc");
    assert!(all.cols.iter().any(|(n, _)| n == "_id"));

    // find với filter $gt (chỉ Ann, age 30)
    let filtered = rows(
        drv.exec_mongo("db.users.find({\"age\":{\"$gt\":26}})", None, None)
            .await
            .unwrap()
            .outcome,
    );
    assert_eq!(filtered.total, 1, "age>26 → chỉ Ann");
    assert_eq!(filtered.rows[0]["name"], "Ann");

    // countDocuments → single-row result
    let cnt = rows(drv.exec_mongo("db.users.countDocuments({})", None, None).await.unwrap().outcome);
    assert_eq!(cnt.rows[0]["count"].as_i64(), Some(2));

    // insertOne → updateOne → find → deleteOne
    let ins = affected(
        drv.exec_mongo(
            "db.users.insertOne({\"_id\":3,\"name\":\"Cathy\",\"age\":40,\"email\":\"c@x.com\"})",
            None,
            None,
        )
        .await
        .unwrap()
        .outcome,
    );
    assert_eq!(ins, 1);
    let upd = affected(
        drv.exec_mongo("db.users.updateOne({\"_id\":3},{\"$set\":{\"age\":41}})", None, None)
            .await
            .unwrap()
            .outcome,
    );
    assert_eq!(upd, 1, "updateOne nModified=1");
    let c3 = rows(drv.exec_mongo("db.users.find({\"_id\":3})", None, None).await.unwrap().outcome);
    assert_eq!(c3.rows[0]["age"].as_i64(), Some(41), "update áp dụng thật");
    let del = affected(
        drv.exec_mongo("db.users.deleteOne({\"_id\":3})", None, None).await.unwrap().outcome,
    );
    assert_eq!(del, 1);

    // aggregate $group tổng age (Ann 30 + Bob 25 = 55)
    let agg = rows(
        drv.exec_mongo(
            "db.users.aggregate([{\"$group\":{\"_id\":null,\"total\":{\"$sum\":\"$age\"}}}])",
            None,
            None,
        )
        .await
        .unwrap()
        .outcome,
    );
    assert_eq!(agg.rows[0]["total"].as_i64(), Some(55));

    // Extended JSON: server-assigned ObjectId → {"$oid": "..."}
    affected(
        drv.exec_mongo("db.users.insertOne({\"name\":\"Zed\",\"email\":\"z@x.com\"})", None, None)
            .await
            .unwrap()
            .outcome,
    );
    let zed = rows(drv.exec_mongo("db.users.find({\"name\":\"Zed\"})", None, None).await.unwrap().outcome);
    assert!(
        zed.rows[0]["_id"]["$oid"].is_string(),
        "ObjectId phải serialize dạng Extended JSON {{\"$oid\":…}}: {:?}",
        zed.rows[0]["_id"]
    );
    let zed_id = zed.rows[0]["_id"].clone();

    // --- M1 fix: exec_mongo phải khớp ObjectId _id qua Extended JSON ------------
    let hex = zed_id["$oid"].as_str().expect("zed _id $oid").to_string();
    let up = affected(
        drv.exec_mongo(
            &format!("db.users.updateOne({{\"_id\":{{\"$oid\":\"{hex}\"}}}}, {{\"$set\":{{\"note\":\"via-editor\"}}}})"),
            None,
            None,
        )
        .await
        .unwrap()
        .outcome,
    );
    assert_eq!(up, 1, "updateOne theo ObjectId _id qua editor phải match (Extended JSON)");
    let f = rows(
        drv.exec_mongo(&format!("db.users.find({{\"_id\":{{\"$oid\":\"{hex}\"}}}})"), None, None)
            .await
            .unwrap()
            .outcome,
    );
    assert_eq!(f.total, 1, "find theo ObjectId _id qua editor phải trả đúng 1 doc");
    assert_eq!(f.rows[0]["note"], "via-editor");

    // --- C1 fix: delete/update thiếu filter → LỖI (không wipe toàn bộ collection) --
    assert!(
        drv.exec_mongo("db.users.deleteMany()", None, None).await.is_err(),
        "deleteMany() không filter phải trả lỗi, KHÔNG xoá toàn bộ"
    );
    assert!(
        drv.exec_mongo("db.users.updateMany(5, {\"$set\":{\"x\":1}})", None, None).await.is_err(),
        "updateMany với filter không phải object phải trả lỗi"
    );

    // --- apply_grid (inline edit by _id, M3) --------------------------------
    let col = |name: &str, value: serde_json::Value| Col { name: name.into(), value, col_type: None };
    let sch = || Some("appdb".to_string());

    // insert by _id
    let ins = drv
        .apply_grid(&[GridChange::Insert {
            schema: sch(),
            table: "users".into(),
            values: vec![col("_id", json!(100)), col("name", json!("Grid")), col("email", json!("g@x.com"))],
        }])
        .await
        .unwrap();
    assert_eq!(ins, 1, "apply_grid insert 1 doc");

    // update by integer _id
    let upd = drv
        .apply_grid(&[GridChange::Update {
            schema: sch(),
            table: "users".into(),
            pk: vec![col("_id", json!(100))],
            set: vec![col("name", json!("GridUp"))],
        }])
        .await
        .unwrap();
    assert_eq!(upd, 1, "apply_grid update by int _id, nModified=1");
    let g = rows(drv.exec_mongo("db.users.find({\"_id\":100})", None, None).await.unwrap().outcome);
    assert_eq!(g.rows[0]["name"], "GridUp", "update áp dụng thật");

    // update by ObjectId _id (serialized {"$oid":…}) — json_to_bson phải convert lại
    let obj_upd = drv
        .apply_grid(&[GridChange::Update {
            schema: sch(),
            table: "users".into(),
            pk: vec![col("_id", zed_id.clone())],
            set: vec![col("email", json!("zed2@x.com"))],
        }])
        .await
        .unwrap();
    assert_eq!(obj_upd, 1, "update by ObjectId _id phải khớp (Extended JSON round-trip)");

    // delete by _id
    let del = drv
        .apply_grid(&[GridChange::Delete {
            schema: sch(),
            table: "users".into(),
            pk: vec![col("_id", json!(100))],
        }])
        .await
        .unwrap();
    assert_eq!(del, 1, "apply_grid delete 1 doc");

    // --- explain (M4a) ------------------------------------------------------
    // No index on `age` → COLLSCAN. queryPlanner (estimated) does not run the query.
    let est = drv.explain_mongo("db.users.find({\"age\":{\"$gt\":18}})", false).await.unwrap();
    assert!(est.get("queryPlanner").is_some(), "explain có queryPlanner");
    let plan = parse_mongodb(&est, false);
    assert_eq!(plan.system, "mongodb");
    assert_eq!(plan.mode, "estimated");
    let proot = plan.root.expect("plan root");
    // FETCH→COLLSCAN or plain COLLSCAN → a SeqScan somewhere + hotspot warning.
    let has_collscan = proot.operation == "SeqScan"
        || proot.children.iter().any(|c| c.operation == "SeqScan");
    assert!(has_collscan, "find không index → COLLSCAN (SeqScan): {:?}", proot.operation);
    assert!(!plan.summary.warnings.is_empty(), "COLLSCAN sinh cảnh báo");
    // Missing-index (M5): COLLSCAN + filter age → gợi ý createIndex trên users.age.
    let mi = plan.missing_index.expect("missing-index suggestion cho COLLSCAN có filter");
    assert_eq!(mi.table, "users");
    assert!(mi.ddl.contains("createIndex") && mi.ddl.contains("age"), "ddl: {}", mi.ddl);

    // executionStats (actual) runs the query and reports timing.
    let act = drv.explain_mongo("db.users.find({\"age\":{\"$gt\":18}})", true).await.unwrap();
    assert!(act.get("executionStats").is_some(), "explain actual có executionStats");
    let plan_a = parse_mongodb(&act, true);
    assert_eq!(plan_a.mode, "actual");
    assert!(plan_a.root.is_some());

    // --- scan_indexes (review): $indexStats → mọi index của mọi collection --------
    let scan = drv.scan_indexes("appdb").await.unwrap();
    assert!(
        scan.iter().any(|r| r.table == "users" && r.name == "_id_" && r.primary),
        "scan_indexes phải liệt kê _id_ (primary) của users"
    );
    assert!(
        scan.iter().any(|r| r.name == "email_idx" && r.unique),
        "scan_indexes phải thấy email_idx unique"
    );

    // --- createCollection + renameCollection (review) qua editor db-level ---------
    drv.exec_mongo("db.createCollection(\"scratch\")", None, None).await.unwrap();
    assert!(
        drv.collections("appdb").await.unwrap().iter().any(|t| t.name == "scratch"),
        "createCollection tạo collection mới"
    );
    drv.exec_mongo("db.scratch.renameCollection(\"scratch2\")", None, None).await.unwrap();
    let cols2 = drv.collections("appdb").await.unwrap();
    assert!(cols2.iter().any(|t| t.name == "scratch2"), "renameCollection đổi tên");
    assert!(!cols2.iter().any(|t| t.name == "scratch"), "tên cũ biến mất sau rename");

    // --- collection_ddl (Show Definition) ----------------------------------------
    let ddl = drv.collection_ddl("appdb", "users").await.unwrap();
    assert!(ddl.contains("createCollection") && ddl.contains("users"), "ddl: {ddl}");

    // --- admin views (M5) ---------------------------------------------------
    // serverStatus → metric/value rows incl. version.
    let server = drv.admin_view("server").await.unwrap();
    assert!(
        server.rows.iter().any(|r| r["metric"] == "version" && !r["value"].is_null()),
        "server status có metric version"
    );
    // currentOp + usersInfo → Ok (rows may be empty on a quiet standalone).
    let sessions = drv.admin_view("sessions").await.unwrap();
    assert!(sessions.cols.iter().any(|(n, _)| n == "pid"), "sessions có cột pid");
    drv.admin_view("users").await.expect("usersInfo Ok");

    // --- streaming export (M5) ----------------------------------------------
    // find() the whole collection → JSON array (bounded via cursor getMore).
    let cancel = AtomicBool::new(false);
    let mut buf: Vec<u8> = Vec::new();
    let n = drv
        .stream_export(Some("appdb"), "db.users.find({})", ExportFormat::Json, &mut buf, |_| {}, &cancel)
        .await
        .unwrap();
    assert!(n >= 2, "export ít nhất Ann + Bob");
    let text = String::from_utf8(buf).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&text).expect("output là JSON array hợp lệ");
    assert_eq!(parsed.as_array().map(|a| a.len() as u64), Some(n), "số phần tử = số docs");
    assert!(text.contains("$oid"), "ObjectId _id serialize Extended JSON trong export");

    // CSV export: header = union key của batch đầu (Bob thiếu `age` nhưng cột `age`
    // vẫn có trong header vì Ann có) + có Ann.
    let mut csv: Vec<u8> = Vec::new();
    drv.stream_export(Some("appdb"), "db.users.find({})", ExportFormat::Csv, &mut csv, |_| {}, &cancel)
        .await
        .unwrap();
    let csv = String::from_utf8(csv).unwrap();
    let header = csv.lines().next().unwrap_or("");
    assert!(header.contains("_id") && header.contains("name"), "CSV header: {header}");
    assert!(csv.contains("Ann"), "CSV có dữ liệu");

    // SQL export: mongosh insertOne lines.
    let mut sql: Vec<u8> = Vec::new();
    drv.stream_export(Some("appdb"), "db.users.find({})", ExportFormat::Sql, &mut sql, |_| {}, &cancel)
        .await
        .unwrap();
    let sql = String::from_utf8(sql).unwrap();
    assert!(sql.contains("db.users.insertOne("), "SQL export = insertOne lines: {sql}");

    // killOp: an idempotent no-op for an unknown opid must succeed (not error).
    drv.kill_op(999_999).await.expect("killOp không được lỗi với opid không tồn tại");
}

// TLS: a self-signed cert (openssl) is copied into a mongod started with
// --tlsMode requireTLS; the client connects with ssl=true + ssl_ca pointing at the
// cert (its own CA). Proves the TLS connection path succeeds. Skips if openssl is
// unavailable.
#[tokio::test]
async fn mongo_connects_over_tls() {
    let dir = std::env::temp_dir().join(format!("ds-mongo-tls-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let ca_key = dir.join("ca.key");
    let ca_crt = dir.join("ca.crt"); // client trust anchor (CA:TRUE)
    let s_key = dir.join("server.key");
    let s_csr = dir.join("server.csr");
    let s_crt = dir.join("server.crt"); // server cert signed by CA, SAN=localhost
    let ext = dir.join("san.ext");
    std::fs::write(&ext, "subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\n").unwrap();
    let p = |x: &std::path::Path| x.to_str().unwrap().to_string();
    let openssl = |args: Vec<String>| -> bool {
        std::process::Command::new("openssl")
            .args(&args)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    };
    // 1) self-signed CA, 2) server key+CSR, 3) server cert signed by CA with SAN.
    let ok = openssl(vec![
        "req".into(), "-x509".into(), "-newkey".into(), "rsa:2048".into(), "-nodes".into(),
        "-keyout".into(), p(&ca_key), "-out".into(), p(&ca_crt), "-days".into(), "2".into(),
        "-subj".into(), "/CN=Test CA".into(), "-addext".into(), "basicConstraints=critical,CA:TRUE".into(),
    ]) && openssl(vec![
        "req".into(), "-newkey".into(), "rsa:2048".into(), "-nodes".into(),
        "-keyout".into(), p(&s_key), "-out".into(), p(&s_csr), "-subj".into(), "/CN=localhost".into(),
    ]) && openssl(vec![
        "x509".into(), "-req".into(), "-in".into(), p(&s_csr), "-CA".into(), p(&ca_crt),
        "-CAkey".into(), p(&ca_key), "-CAcreateserial".into(), "-out".into(), p(&s_crt),
        "-days".into(), "2".into(), "-extfile".into(), p(&ext),
    ]);
    if !ok {
        eprintln!("SKIP mongo_connects_over_tls: openssl unavailable/failed");
        let _ = std::fs::remove_dir_all(&dir);
        return;
    }
    let cert = ca_crt.clone(); // client ssl_ca = the CA
    // mongod tlsCertificateKeyFile = server cert + key concatenated.
    let mut pem = std::fs::read(&s_crt).unwrap();
    pem.extend(std::fs::read(&s_key).unwrap());

    // mongod 7 requires a chain of trust (--tlsCAFile) when TLS is on (SERVER-72839).
    let ca_bytes = std::fs::read(&ca_crt).unwrap();
    let c = GenericImage::new("mongo", "7")
        .with_exposed_port(27017.tcp())
        .with_copy_to("/etc/mongo.pem", pem)
        .with_copy_to("/etc/ca.crt", ca_bytes)
        .with_cmd([
            "--tlsMode", "requireTLS",
            "--tlsCertificateKeyFile", "/etc/mongo.pem",
            "--tlsCAFile", "/etc/ca.crt",
            "--tlsAllowConnectionsWithoutCertificates",
        ])
        .start()
        .await
        .expect("start tls mongo container");
    let port = c.get_host_port_ipv4(27017).await.unwrap();

    let p = MongoConnParams {
        host: "localhost".into(),
        port,
        database: String::new(),
        user: String::new(),
        password: String::new(),
        ssl: true,
        ssl_ca: cert.to_str().unwrap().to_string(),
    };
    let deadline = Instant::now() + Duration::from_secs(60);
    let drv = loop {
        match MongoDriver::connect(&p).await {
            Ok(d) => break d,
            Err(e) => {
                if Instant::now() >= deadline {
                    let logs = String::from_utf8_lossy(&c.stdout_to_vec().await.unwrap_or_default()).to_string();
                    panic!("TLS connect failed: {}\n--- mongod logs (tail) ---\n{}", e.message, &logs[logs.len().saturating_sub(2000)..]);
                }
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    };
    // A command over the TLS connection succeeds → connection verified.
    assert!(drv.databases().await.is_ok(), "chạy lệnh qua kết nối TLS thành công");
    let _ = std::fs::remove_dir_all(&dir);
}

// Auth-enabled server: a root user lives in `admin`, so build_uri's default
// authSource=admin must let it log in even while the profile points at `appdb`.
#[tokio::test]
async fn mongo_auth_defaults_authsource_to_admin() {
    let c = GenericImage::new("mongo", "7")
        .with_exposed_port(27017.tcp())
        .with_env_var("MONGO_INITDB_ROOT_USERNAME", "root")
        .with_env_var("MONGO_INITDB_ROOT_PASSWORD", "secret")
        .start()
        .await
        .expect("start auth mongo container");
    let port = c.get_host_port_ipv4(27017).await.unwrap();

    let p = MongoConnParams {
        host: "localhost".into(),
        port,
        database: "appdb".into(), // NOT admin — but the root user is defined in admin
        user: "root".into(),
        password: "secret".into(),
        ssl: false,
        ssl_ca: String::new(),
    };
    let deadline = Instant::now() + Duration::from_secs(180);
    let drv = loop {
        match MongoDriver::connect(&p).await {
            Ok(d) => break d,
            Err(e) => {
                assert!(Instant::now() < deadline, "auth mongo chưa sẵn sàng: {}", e.message);
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    };
    // Authenticated: an admin command works (proves authSource=admin default).
    let dbs = drv.databases().await.expect("liệt kê databases sau khi auth admin");
    assert!(dbs.iter().any(|d| d.name == "admin"), "thấy admin db sau khi auth");
}

// New Database (Feature 5), Design Document field ops (Feature 1) and page-based
// pagination (Feature 2) — runs the EXACT mongosh statements the frontend builders
// emit (createCollection / updateMany $set·$rename·$unset / countDocuments +
// find.skip.limit) against a real MongoDB and verifies via query-back.
#[tokio::test]
async fn mongo_new_database_design_document_and_pagination() {
    let (_c, port) = start_mongo().await;
    let deadline = Instant::now() + Duration::from_secs(180);
    let drv = loop {
        match MongoDriver::connect(&params(port)).await {
            Ok(d) => break d,
            Err(e) => {
                assert!(Instant::now() < deadline, "mongo chưa sẵn sàng: {}", e.message);
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    };
    let rows = |o: StatementOutcome| match o {
        StatementOutcome::Rows { result } => result,
        other => panic!("expected Rows, got {other:?}"),
    };

    // --- Feature 5: New Database — createCollection in a brand-new database ------
    drv.exec_mongo_in(Some("shopdb"), "db.createCollection(\"products\")", None, None)
        .await
        .expect("createCollection in a new database");
    let dbs = drv.databases().await.expect("databases");
    assert!(dbs.iter().any(|d| d.name == "shopdb"), "New Database → shopdb xuất hiện");
    assert!(
        drv.collections("shopdb").await.unwrap().iter().any(|t| t.name == "products"),
        "collection đầu tiên (products) tồn tại → database đã materialize"
    );

    // --- Seed 5 docs (fresh database) for Design + pagination -------------------
    let client = Client::with_uri_str(format!("mongodb://localhost:{port}/")).await.unwrap();
    let people = client.database("designdb").collection::<Document>("people");
    let seed: Vec<Document> = (1..=5)
        .map(|i| doc! { "_id": i, "name": format!("P{i}"), "age": 20 + i })
        .collect();
    people.insert_many(seed).await.unwrap();

    // --- Feature 1: Design Document — add / rename / drop field (exact builder output) --
    drv.exec_mongo_in(
        Some("designdb"),
        "db.people.updateMany({ \"active\": { \"$exists\": false } }, { \"$set\": { \"active\": true } })",
        None,
        None,
    )
    .await
    .expect("add field via $set");
    drv.exec_mongo_in(
        Some("designdb"),
        "db.people.updateMany({}, { \"$rename\": { \"name\": \"fullName\" } })",
        None,
        None,
    )
    .await
    .expect("rename field via $rename");
    drv.exec_mongo_in(Some("designdb"), "db.people.updateMany({}, { \"$unset\": { \"age\": \"\" } })", None, None)
        .await
        .expect("drop field via $unset");

    let one = rows(
        drv.exec_mongo_in(Some("designdb"), "db.people.find({\"_id\":1})", None, None)
            .await
            .unwrap()
            .outcome,
    );
    assert_eq!(one.rows[0]["active"].as_bool(), Some(true), "add-field (active) áp dụng");
    assert!(one.rows[0].get("fullName").is_some(), "rename name→fullName áp dụng");
    assert!(one.rows[0].get("name").is_none(), "field name cũ biến mất sau rename");
    assert!(one.rows[0].get("age").is_none(), "drop field age áp dụng");

    // --- Feature 2: pagination — countDocuments (total) + find.skip.limit -------
    let cnt = rows(
        drv.exec_mongo_in(Some("designdb"), "db.people.countDocuments({})", None, None)
            .await
            .unwrap()
            .outcome,
    );
    assert_eq!(cnt.rows[0]["count"].as_i64(), Some(5), "total = 5 docs");
    let page2 = rows(
        drv.exec_mongo_in(Some("designdb"), "db.people.find({}).skip(2).limit(2)", None, None)
            .await
            .unwrap()
            .outcome,
    );
    assert_eq!(page2.total, 2, "trang 2 (skip 2, limit 2) trả đúng 2 docs");
}

// Query Editor + Open Documents paths — the exact mongosh shapes the editor/viewer
// send (find with filter / projection / limit). Proves querying works end-to-end
// (Issue: "Query Editor chưa query được" was SQL-vs-mongosh syntax, not a backend bug).
#[tokio::test]
async fn mongo_query_editor_find_filter_projection_limit() {
    let (_c, port) = start_mongo().await;
    let deadline = Instant::now() + Duration::from_secs(180);
    let drv = loop {
        match MongoDriver::connect(&params(port)).await {
            Ok(d) => break d,
            Err(e) => {
                assert!(Instant::now() < deadline, "mongo chưa sẵn sàng: {}", e.message);
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    };
    let rows = |o: StatementOutcome| match o {
        StatementOutcome::Rows { result } => result,
        other => panic!("expected Rows, got {other:?}"),
    };

    let client = Client::with_uri_str(format!("mongodb://localhost:{port}/")).await.unwrap();
    let users = client.database("appdb").collection::<Document>("users");
    let seed: Vec<Document> = (1..=4)
        .map(|i| doc! { "_id": i, "name": format!("U{i}"), "age": 18 + i * 5 })
        .collect();
    users.insert_many(seed).await.unwrap();

    // filter — db.users.find({"age":{"$gt":25}})
    let f = rows(
        drv.exec_mongo("db.users.find({\"age\":{\"$gt\":25}})", None, None).await.unwrap().outcome,
    );
    assert!(f.total >= 1, "filter trả ít nhất 1 doc");
    assert!(f.rows.iter().all(|r| r["age"].as_i64().unwrap_or(0) > 25), "mọi doc age>25");

    // projection — db.users.find({}, {"name":1}) → chỉ name (+ _id), không age
    let p = rows(drv.exec_mongo("db.users.find({}, {\"name\":1})", None, None).await.unwrap().outcome);
    assert!(
        p.rows.iter().all(|r| r.get("name").is_some() && r.get("age").is_none()),
        "projection chỉ trả name (+_id), loại age"
    );

    // limit — db.users.find({}).limit(2)
    let l = rows(drv.exec_mongo("db.users.find({}).limit(2)", None, None).await.unwrap().outcome);
    assert_eq!(l.total, 2, "limit(2) → đúng 2 docs");
}

// The methods (find/updateMany/aggregate/distinct/deleteMany) and operators
// ($gt/$in/$or/$set/$inc/$match/$group/$sum) the Query Editor autocompletes must
// actually execute — this runs a representative sample against a real MongoDB.
#[tokio::test]
async fn mongo_suggested_methods_and_operators_execute() {
    let (_c, port) = start_mongo().await;
    let deadline = Instant::now() + Duration::from_secs(180);
    let drv = loop {
        match MongoDriver::connect(&params(port)).await {
            Ok(d) => break d,
            Err(e) => {
                assert!(Instant::now() < deadline, "mongo chưa sẵn sàng: {}", e.message);
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    };
    let rows = |o: StatementOutcome| match o {
        StatementOutcome::Rows { result } => result,
        other => panic!("expected Rows, got {other:?}"),
    };
    let affected = |o: StatementOutcome| match o {
        StatementOutcome::Affected { affected } => affected,
        other => panic!("expected Affected, got {other:?}"),
    };

    let client = Client::with_uri_str(format!("mongodb://localhost:{port}/")).await.unwrap();
    let users = client.database("appdb").collection::<Document>("u");
    users
        .insert_many(vec![
            doc! { "_id": 1, "name": "Ann", "age": 30 },
            doc! { "_id": 2, "name": "Bob", "age": 20 },
            doc! { "_id": 3, "name": "Cat", "age": 40 },
        ])
        .await
        .unwrap();

    // $gt
    let gt = rows(drv.exec_mongo("db.u.find({\"age\":{\"$gt\":25}})", None, None).await.unwrap().outcome);
    assert_eq!(gt.total, 2, "$gt 25 → Ann + Cat");
    // $in
    let in_ = rows(drv.exec_mongo("db.u.find({\"name\":{\"$in\":[\"Ann\",\"Bob\"]}})", None, None).await.unwrap().outcome);
    assert_eq!(in_.total, 2, "$in → Ann + Bob");
    // $or
    let or = rows(drv.exec_mongo("db.u.find({\"$or\":[{\"age\":40},{\"name\":\"Bob\"}]})", None, None).await.unwrap().outcome);
    assert_eq!(or.total, 2, "$or → Cat(age 40) + Bob");

    // updateMany $set + $inc
    let up = affected(
        drv.exec_mongo("db.u.updateMany({}, {\"$set\":{\"active\":true},\"$inc\":{\"age\":1}})", None, None)
            .await
            .unwrap()
            .outcome,
    );
    assert_eq!(up, 3, "updateMany áp cho cả 3 doc");
    let ann = rows(drv.exec_mongo("db.u.find({\"_id\":1})", None, None).await.unwrap().outcome);
    assert_eq!(ann.rows[0]["active"].as_bool(), Some(true), "$set active");
    assert_eq!(ann.rows[0]["age"].as_i64(), Some(31), "$inc age 30→31");

    // aggregate $match / $group / $sum
    let agg = rows(
        drv.exec_mongo(
            "db.u.aggregate([{\"$match\":{\"active\":true}},{\"$group\":{\"_id\":null,\"total\":{\"$sum\":\"$age\"}}}])",
            None,
            None,
        )
        .await
        .unwrap()
        .outcome,
    );
    // ages after $inc: 31 + 21 + 41 = 93
    assert_eq!(agg.rows[0]["total"].as_i64(), Some(93), "$group/$sum tổng age");

    // distinct
    let dist = rows(drv.exec_mongo("db.u.distinct(\"name\")", None, None).await.unwrap().outcome);
    assert_eq!(dist.total, 3, "distinct name → 3 giá trị");

    // deleteMany with filter (không wipe toàn bộ)
    let del = affected(drv.exec_mongo("db.u.deleteMany({\"name\":\"Ann\"})", None, None).await.unwrap().outcome);
    assert_eq!(del, 1, "deleteMany filter → xoá 1 (Ann)");
    let left = rows(drv.exec_mongo("db.u.countDocuments({})", None, None).await.unwrap().outcome);
    assert_eq!(left.rows[0]["count"].as_i64(), Some(2), "còn 2 doc");
}

/// U5 — MongoDB User Manager, Definition-of-Done (spec §1.9). Command-based via
/// the driver's um_* methods (createUser / grantRolesToUser / revokeRolesFromUser
/// / updateUser / dropUser / usersInfo). Auth-enabled container.
#[tokio::test]
async fn mongo_user_manager_end_to_end() {
    let c = GenericImage::new("mongo", "7")
        .with_exposed_port(27017.tcp())
        .with_env_var("MONGO_INITDB_ROOT_USERNAME", "root")
        .with_env_var("MONGO_INITDB_ROOT_PASSWORD", "test123")
        .start()
        .await
        .expect("start mongo container with auth");
    let port = c.get_host_port_ipv4(27017).await.unwrap();

    let root_params = MongoConnParams {
        host: "localhost".into(),
        port,
        database: "admin".into(),
        user: "root".into(),
        password: "test123".into(),
        ssl: false,
        ssl_ca: String::new(),
    };
    // wait for readiness
    let deadline = Instant::now() + Duration::from_secs(180);
    let admin = loop {
        match MongoDriver::connect(&root_params).await {
            Ok(d) => break d,
            Err(e) => {
                assert!(Instant::now() < deadline, "mongo(auth) not ready: {}", e.message);
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    };

    // seed appdb.secret with a raw root client
    let seed = Client::with_uri_str(format!("mongodb://root:test123@localhost:{port}/?authSource=admin"))
        .await
        .expect("seed client");
    seed.database("appdb")
        .collection::<Document>("secret")
        .insert_many(vec![doc! { "_id": 1, "v": "x" }, doc! { "_id": 2, "v": "y" }])
        .await
        .expect("seed secret");

    // 1. CREATE user in admin with NO roles yet — um_create_user
    admin.um_create_user("admin", "app", "pw", &[]).await.expect("create user");

    // 2. LOGIN as app (authSource defaults to admin)
    let app_params = MongoConnParams {
        host: "localhost".into(),
        port,
        database: "appdb".into(),
        user: "app".into(),
        password: "pw".into(),
        ssl: false,
        ssl_ca: String::new(),
    };
    let app = MongoDriver::connect(&app_params).await.expect("login as app");

    // 3. DENIED before grant
    assert!(app.exec_mongo_in(Some("appdb"), "db.secret.find({})", None, None).await.is_err(), "denied before grant");

    // 4. GRANT read@appdb — um_grant_roles
    admin.um_grant_roles("admin", "app", &[json!({ "role": "read", "db": "appdb" })]).await.expect("grant read");
    let app = MongoDriver::connect(&app_params).await.expect("reconnect app");
    let out = app.exec_mongo_in(Some("appdb"), "db.secret.countDocuments({})", None, None).await.expect("count after grant");
    let StatementOutcome::Rows { result } = out.outcome else { panic!("expected rows") };
    assert_eq!(result.rows[0]["count"].as_i64(), Some(2), "read granted");

    // 5. WRITE denied (read only)
    assert!(
        app.exec_mongo_in(Some("appdb"), "db.secret.insertOne({\"_id\":3,\"v\":\"z\"})", None, None).await.is_err(),
        "read-only cannot insert",
    );

    // 6. REVOKE → denied; DROP → gone
    admin.um_revoke_roles("admin", "app", &[json!({ "role": "read", "db": "appdb" })]).await.expect("revoke");
    let app = MongoDriver::connect(&app_params).await.expect("reconnect app");
    assert!(app.exec_mongo_in(Some("appdb"), "db.secret.find({})", None, None).await.is_err(), "denied again after revoke");
    admin.um_drop_user("admin", "app").await.expect("drop user");
    let users = admin.um_list_users().await.expect("list users");
    assert!(!users.rows.iter().any(|r| r["user"] == json!("app")), "app gone");
}
