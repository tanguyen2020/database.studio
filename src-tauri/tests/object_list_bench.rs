//! Bench (ignored): how long the Generate Scripts object list takes on a big
//! schema, current introspection vs. a names-only query.
//!
//!   cargo test --test object_list_bench -- --ignored --nocapture --test-threads=1

use std::time::{Duration, Instant};

use database_studio_lib::drivers::mysql::{MySqlConnParams, MySqlDriver};
use database_studio_lib::drivers::postgres::{PgConnParams, PgDriver};
use testcontainers::core::IntoContainerPort;
use testcontainers::runners::AsyncRunner;
use testcontainers::{GenericImage, ImageExt};

const PASS: &str = "test123";

use database_studio_lib::drivers::types::ObjectName;

fn sorted(mut v: Vec<ObjectName>) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = v.drain(..).map(|o| (o.kind, o.name)).collect();
    out.sort();
    out
}
fn kind_of(view: bool) -> String {
    if view { "view".into() } else { "table".into() }
}
async fn old_mysql(d: &mut MySqlDriver, s: &str) -> Vec<(String, String)> {
    let mut v: Vec<(String, String)> = d.tables(s).await.unwrap().into_iter().map(|t| (kind_of(t.kind == "view"), t.name)).collect();
    v.extend(d.routines(s).await.unwrap().into_iter().map(|r| (r.kind, r.name)));
    v.extend(d.triggers(s).await.unwrap().into_iter().map(|t| ("trigger".to_string(), t.name)));
    v.sort();
    v
}
async fn old_pg(d: &mut PgDriver, s: &str) -> Vec<(String, String)> {
    let mut v: Vec<(String, String)> = d.tables(s).await.unwrap().into_iter().map(|t| (kind_of(t.kind == "view"), t.name)).collect();
    v.extend(d.routines(s).await.unwrap().into_iter().map(|r| (r.kind, r.name)));
    v.extend(d.triggers(s).await.unwrap().into_iter().map(|t| ("trigger".to_string(), t.name)));
    v.extend(d.sequences(s).await.unwrap().into_iter().map(|q| ("sequence".to_string(), q.name)));
    v.sort();
    v
}

async fn retry<T, F, Fut>(mut connect: F) -> T
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, database_studio_lib::error::QueryError>>,
{
    let deadline = Instant::now() + Duration::from_secs(240);
    loop {
        match connect().await {
            Ok(v) => return v,
            Err(e) => {
                assert!(Instant::now() < deadline, "container not ready: {}", e.message);
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    }
}

macro_rules! timed {
    ($label:expr, $e:expr) => {{
        let t = Instant::now();
        let r = $e;
        println!("BENCH {:<44} {:>7} ms", $label, t.elapsed().as_millis());
        r
    }};
}

#[tokio::test]
#[ignore]
async fn bench_mysql_object_list() {
    let c = GenericImage::new("mysql", "8")
        .with_exposed_port(3306.tcp())
        .with_env_var("MYSQL_ROOT_PASSWORD", PASS)
        .with_env_var("MYSQL_DATABASE", "app")
        .start()
        .await
        .unwrap();
    let port = c.get_host_port_ipv4(3306).await.unwrap();
    let params = MySqlConnParams {
        host: "localhost".into(),
        port,
        database: "app".into(),
        user: "root".into(),
        password: PASS.into(),
        ssl: false,
        ssl_ca: String::new(),
        ssl_cert: String::new(),
        ssl_key: String::new(),
    };
    let mut d = retry(|| MySqlDriver::connect(&params, "mysql")).await;

    let target_tables = 1500;
    let noise_schemas = 10;
    let noise_tables = 200;
    let routines = 200;
    // seed with a procedure (one round trip per batch instead of one per table)
    d.exec(
        "CREATE PROCEDURE mk(IN db VARCHAR(64), IN n INT, IN pfx VARCHAR(10)) BEGIN
           DECLARE i INT DEFAULT 0;
           WHILE i < n DO
             SET @s = CONCAT('CREATE TABLE `', db, '`.`', pfx, i, '` (id INT PRIMARY KEY, a VARCHAR(20), b INT)');
             PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
             SET i = i + 1;
           END WHILE;
         END",
    )
    .await
    .unwrap();
    timed!("seed target tables", d.exec(&format!("CALL mk('app', {target_tables}, 't')")).await.unwrap());
    for s in 0..noise_schemas {
        d.exec(&format!("CREATE DATABASE noise{s}")).await.unwrap();
        d.exec(&format!("CALL mk('noise{s}', {noise_tables}, 'n')")).await.unwrap();
    }
    for i in 0..routines {
        d.exec(&format!("CREATE PROCEDURE p{i}(IN a INT, IN b VARCHAR(10), OUT c INT) BEGIN SET c = a; END"))
            .await
            .unwrap();
    }
    for i in 0..50 {
        d.exec(&format!("CREATE TRIGGER tr{i} BEFORE INSERT ON t{i} FOR EACH ROW SET NEW.b = 1"))
            .await
            .unwrap();
    }
    d.exec("CREATE VIEW app.v1 AS SELECT * FROM app.t1").await.unwrap();
    d.exec("CREATE FUNCTION app.f1(x INT) RETURNS INT DETERMINISTIC RETURN x").await.unwrap();
    println!("seeded: {target_tables} tables + {} noise, {routines} routines, 50 triggers", noise_schemas * noise_tables);

    // what the dialog does today (stats are cold on the first call)
    let n = timed!("tables() — 1st (cold stats)", d.tables("app").await.unwrap()).len();
    timed!("tables() — 2nd", d.tables("app").await.unwrap());
    let r = timed!("routines() (+ params per routine)", d.routines("app").await.unwrap()).len();
    timed!("triggers()", d.triggers("app").await.unwrap());
    println!("tables={n} routines={r}");
    let names = timed!("object_names() — the new single query", d.object_names("app").await.unwrap());
    let old = old_mysql(&mut d, "app").await;
    assert_eq!(sorted(names), old, "object_names must list exactly the same objects");

    // names only
    let q = |sql: &str| sql.to_string();
    timed!(
        "names: TABLES, CONVERT filter",
        d.exec(&q("SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES \
                    WHERE CONVERT(TABLE_SCHEMA USING utf8mb4) = CONVERT('app' USING utf8mb4)"))
            .await
            .unwrap()
    );
    timed!(
        "names: TABLES, plain filter",
        d.exec(&q("SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'app'"))
            .await
            .unwrap()
    );
    timed!("names: SHOW FULL TABLES", d.exec("SHOW FULL TABLES FROM `app`").await.unwrap());
    timed!(
        "names: ROUTINES, CONVERT filter",
        d.exec(&q("SELECT ROUTINE_NAME, ROUTINE_TYPE FROM information_schema.ROUTINES \
                    WHERE CONVERT(ROUTINE_SCHEMA USING utf8mb4) = CONVERT('app' USING utf8mb4)"))
            .await
            .unwrap()
    );
    timed!(
        "names: ROUTINES, plain filter",
        d.exec(&q("SELECT ROUTINE_NAME, ROUTINE_TYPE FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = 'app'"))
            .await
            .unwrap()
    );
    timed!(
        "names: TRIGGERS, plain filter",
        d.exec(&q("SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = 'app'"))
            .await
            .unwrap()
    );

    // ---- routines: the old one-PARAMETERS-query-per-routine, replayed ----------
    d.exec("CREATE PROCEDURE app.dup(IN a INT) BEGIN END").await.unwrap();
    d.exec("CREATE FUNCTION app.dup(x INT, y VARCHAR(5)) RETURNS INT DETERMINISTIC RETURN x").await.unwrap();
    let new = timed!("routines() — params in ONE query", d.routines("app").await.unwrap());
    let t = Instant::now();
    for r in &new {
        d.exec(&format!(
            "SELECT PARAMETER_NAME, DTD_IDENTIFIER, PARAMETER_MODE FROM information_schema.PARAMETERS \
             WHERE CONVERT(SPECIFIC_SCHEMA USING utf8mb4) = CONVERT('app' USING utf8mb4) \
               AND CONVERT(SPECIFIC_NAME USING utf8mb4) = CONVERT('{}' USING utf8mb4) AND ORDINAL_POSITION > 0 \
             ORDER BY ORDINAL_POSITION",
            r.name
        ))
        .await
        .unwrap();
    }
    println!("BENCH {:<44} {:>7} ms", format!("old: + {} PARAMETERS queries", new.len()), t.elapsed().as_millis());
    let p0 = new.iter().find(|r| r.name == "p0").unwrap();
    assert_eq!(p0.params.iter().map(|p| (p.name.as_str(), p.mode.as_str())).collect::<Vec<_>>(), [("a", "IN"), ("b", "IN"), ("c", "OUT")]);
    assert_eq!(p0.params[1].data_type, "varchar(10)");
    // a procedure and a function may share a name — each keeps its own parameters
    let dp = new.iter().find(|r| r.name == "dup" && r.kind == "procedure").unwrap();
    let df = new.iter().find(|r| r.name == "dup" && r.kind == "function").unwrap();
    assert_eq!(dp.params.len(), 1, "procedure dup: {:?}", dp.params);
    assert_eq!(df.params.len(), 2, "function dup: {:?}", df.params);
    assert_eq!(df.return_type.as_deref(), Some("int"));

    // ---- tables(): which part costs, with statistics forced cold ---------------
    d.exec("SET SESSION information_schema_stats_expiry = 0").await.unwrap();
    timed!("COLD tables() — rows + size + partitions", d.tables("app").await.unwrap());
    timed!(
        "COLD rows only",
        d.exec(&q("SELECT TABLE_NAME, TABLE_ROWS FROM information_schema.TABLES \
                    WHERE CONVERT(TABLE_SCHEMA USING utf8mb4) = CONVERT('app' USING utf8mb4)"))
            .await
            .unwrap()
    );
    timed!(
        "COLD rows + size (no partitions)",
        d.exec(&q("SELECT TABLE_NAME, TABLE_ROWS, DATA_LENGTH + INDEX_LENGTH FROM information_schema.TABLES \
                    WHERE CONVERT(TABLE_SCHEMA USING utf8mb4) = CONVERT('app' USING utf8mb4)"))
            .await
            .unwrap()
    );
    timed!(
        "COLD names + partitions",
        d.exec(&q("SELECT t.TABLE_NAME, EXISTS(SELECT 1 FROM information_schema.PARTITIONS p \
                    WHERE CONVERT(p.TABLE_SCHEMA USING utf8mb4) = CONVERT(t.TABLE_SCHEMA USING utf8mb4) \
                      AND CONVERT(p.TABLE_NAME USING utf8mb4) = CONVERT(t.TABLE_NAME USING utf8mb4) \
                      AND p.PARTITION_NAME IS NOT NULL) FROM information_schema.TABLES t \
                    WHERE CONVERT(t.TABLE_SCHEMA USING utf8mb4) = CONVERT('app' USING utf8mb4)"))
            .await
            .unwrap()
    );
}

#[tokio::test]
#[ignore]
async fn bench_pg_object_list() {
    let c = GenericImage::new("postgres", "16-alpine")
        .with_exposed_port(5432.tcp())
        .with_env_var("POSTGRES_PASSWORD", PASS)
        .with_env_var("POSTGRES_DB", "testdb")
        .start()
        .await
        .unwrap();
    let port = c.get_host_port_ipv4(5432).await.unwrap();
    let params = PgConnParams {
        host: "localhost".into(),
        port,
        database: "testdb".into(),
        user: "postgres".into(),
        password: PASS.into(),
        ssl: false,
        ssl_ca: String::new(),
        ssl_cert: String::new(),
        ssl_key: String::new(),
    };
    let mut d = retry(|| PgDriver::connect(&params)).await;
    timed!(
        "seed 3000 tables + 300 functions",
        d.exec(
            "DO $$ BEGIN
               FOR i IN 0..2999 LOOP
                 EXECUTE format('CREATE TABLE public.t%s (id int PRIMARY KEY, a text, b int)', i);
               END LOOP;
               FOR i IN 0..299 LOOP
                 EXECUTE format('CREATE FUNCTION public.f%s(a int) RETURNS int LANGUAGE sql AS ''SELECT $1''', i);
               END LOOP;
             END $$"
        )
        .await
        .unwrap()
    );
    d.exec("CREATE VIEW public.v1 AS SELECT * FROM public.t1").await.unwrap();
    d.exec("CREATE MATERIALIZED VIEW public.mv1 AS SELECT * FROM public.t2").await.unwrap();
    d.exec("CREATE SEQUENCE public.s1").await.unwrap();
    d.exec("CREATE PROCEDURE public.p1() LANGUAGE sql AS 'SELECT 1'").await.unwrap();
    d.exec("CREATE FUNCTION public.trgf() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'").await.unwrap();
    d.exec("CREATE TRIGGER tg1 BEFORE INSERT ON public.t3 FOR EACH ROW EXECUTE FUNCTION public.trgf()").await.unwrap();
    d.exec("CREATE TABLE public.parted (id int) PARTITION BY RANGE (id)").await.unwrap();
    d.exec("CREATE TABLE public.parted_1 PARTITION OF public.parted FOR VALUES FROM (0) TO (10)").await.unwrap();
    // relcache is per session: each variant on a FRESH connection pays the real
    // first-expand cost the Explorer pays on a new session
    {
        let mut fresh = retry(|| PgDriver::connect(&params)).await;
        timed!(
            "FRESH session: rows only (no size)",
            fresh
                .exec("SELECT c.relname, c.reltuples FROM pg_catalog.pg_class c \
                       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
                       WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m')")
                .await
                .unwrap()
        );
    }
    {
        let mut fresh = retry(|| PgDriver::connect(&params)).await;
        timed!("FRESH session: tables() rows + size", fresh.tables("public").await.unwrap());
    }
    let n = timed!("tables() (rows + size per table)", d.tables("public").await.unwrap()).len();
    timed!("tables() 2nd", d.tables("public").await.unwrap());
    timed!("routines()", d.routines("public").await.unwrap());
    timed!("triggers()", d.triggers("public").await.unwrap());
    timed!("sequences()", d.sequences("public").await.unwrap());
    println!("tables={n}");
    let names = timed!("object_names() — the new single query", d.object_names("public").await.unwrap());
    let old = old_pg(&mut d, "public").await;
    assert_eq!(sorted(names), old, "object_names must list exactly the same objects");
    timed!(
        "names: pg_class only",
        d.exec(
            "SELECT c.relname, c.relkind FROM pg_catalog.pg_class c
               JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S')"
        )
        .await
        .unwrap()
    );
}
