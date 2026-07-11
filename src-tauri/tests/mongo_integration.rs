//! Integration test MongoDB (M1) — introspection chạy trên MongoDB THẬT qua
//! testcontainers (`mongo:7`). Seed bằng client mongodb rồi truy vấn lại bằng
//! MongoDriver để verify (không hard-code kết quả).
//!
//! Chạy: `cargo test --test mongo_integration` (cần Docker daemon).

use std::time::{Duration, Instant};

use database_studio_lib::drivers::mongo::{MongoConnParams, MongoDriver};
use database_studio_lib::drivers::types::StatementOutcome;
use mongodb::bson::{doc, Document};
use mongodb::Client;
use testcontainers::core::IntoContainerPort;
use testcontainers::runners::AsyncRunner;
use testcontainers::{ContainerAsync, GenericImage};

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
}
