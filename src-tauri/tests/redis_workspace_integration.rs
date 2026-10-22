//! Redis Browser workspace (SPEC-REDIS-BROWSER.md §3/§5) against a real
//! `redis:7-alpine` container: Slow commands (SLOWLOG GET + threshold), Server info
//! (INFO grouped by section) and the per-key size/encoding pipeline the Browser uses
//! for the keys on screen. Every expectation is read back from the server itself.

use std::time::{Duration, Instant};

use database_studio_lib::commands::redis::info_sections;
use database_studio_lib::drivers::redis::{RedisConnParams, RedisDriver};
use testcontainers::core::IntoContainerPort;
use testcontainers::runners::AsyncRunner;
use testcontainers::GenericImage;
use testcontainers::ImageExt;

async fn connect(port: u16) -> RedisDriver {
    let params = RedisConnParams { host: "localhost".into(), port, password: "test123".into(), db: 0, ssl: false, ssl_ca: String::new() };
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        match RedisDriver::connect(&params).await {
            Ok(d) => return d,
            Err(e) => {
                assert!(Instant::now() < deadline, "redis never came up: {}", e.message);
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
    }
}

fn cmd(args: &[&str]) -> Vec<String> {
    args.iter().map(|s| s.to_string()).collect()
}

#[tokio::test]
async fn redis_workspace_slowlog_info_and_key_meta() {
    let c = GenericImage::new("redis", "7-alpine")
        .with_exposed_port(6379.tcp())
        .with_cmd(vec!["redis-server", "--requirepass", "test123"])
        .start()
        .await
        .expect("start redis container (Docker must be running)");
    let port = c.get_host_port_ipv4(6379).await.unwrap();
    let mut drv = connect(port).await;

    // ---- Slow commands: log everything, run a few commands, read them back ----
    drv.command(&cmd(&["CONFIG", "SET", "slowlog-log-slower-than", "0"])).await.unwrap();
    drv.command(&cmd(&["CONFIG", "SET", "slowlog-max-len", "64"])).await.unwrap();
    drv.command(&cmd(&["SLOWLOG", "RESET"])).await.unwrap();
    drv.command(&cmd(&["CLIENT", "SETNAME", "ws-it"])).await.unwrap();
    drv.command(&cmd(&["SET", "slow:probe", "1"])).await.unwrap();
    drv.command(&cmd(&["GET", "slow:probe"])).await.unwrap();
    let slow = drv.slowlog(50).await.unwrap();
    assert_eq!(slow.threshold_us, Some(0), "threshold read from CONFIG GET");
    assert_eq!(slow.max_len, Some(64));
    assert!(!slow.entries.is_empty(), "every command is logged at threshold 0");
    let set = slow
        .entries
        .iter()
        .find(|e| e.args.first().map(String::as_str) == Some("SET") && e.args.get(1).map(String::as_str) == Some("slow:probe"))
        .unwrap_or_else(|| panic!("SET slow:probe in the slow log: {:?}", slow.entries));
    assert!(set.timestamp > 1_600_000_000, "unix seconds: {}", set.timestamp);
    assert!(set.duration_us >= 0);
    assert!(set.client.contains(':'), "client address ip:port: {:?}", set.client);
    assert_eq!(set.client_name, "ws-it", "CLIENT SETNAME shows up next to the command");
    // newest first, as SLOWLOG GET returns them
    let ids: Vec<i64> = slow.entries.iter().map(|e| e.id).collect();
    assert!(ids.windows(2).all(|w| w[0] > w[1]), "newest first: {ids:?}");
    // the count is honoured
    assert!(drv.slowlog(1).await.unwrap().entries.len() == 1);

    // ---- Server info: grouped by section, values from the live server ----
    let text = drv.info().await.unwrap();
    let sections = info_sections(&text);
    let names: Vec<&str> = sections.iter().map(|s| s.name.as_str()).collect();
    for want in ["Server", "Clients", "Memory", "Persistence", "Stats", "Replication", "Keyspace"] {
        assert!(names.contains(&want), "INFO section {want} in {names:?}");
    }
    let get = |sec: &str, key: &str| {
        sections
            .iter()
            .find(|s| s.name == sec)
            .and_then(|s| s.entries.iter().find(|(k, _)| k == key))
            .map(|(_, v)| v.clone())
    };
    assert!(get("Server", "redis_version").is_some_and(|v| v.starts_with('7')), "redis_version");
    assert_eq!(get("Server", "redis_mode").as_deref(), Some("standalone"));
    assert!(get("Memory", "used_memory").and_then(|v| v.parse::<u64>().ok()).is_some_and(|n| n > 0));
    assert_eq!(get("Replication", "role").as_deref(), Some("master"));

    // ---- key meta: size + encoding for each data type, missing key = unknown ----
    drv.command(&cmd(&["SET", "m:str", "hello"])).await.unwrap();
    drv.command(&cmd(&["SET", "m:int", "12345"])).await.unwrap();
    drv.command(&cmd(&["HSET", "m:hash", "a", "1", "b", "2"])).await.unwrap();
    drv.command(&cmd(&["RPUSH", "m:list", "x", "y", "z"])).await.unwrap();
    drv.command(&cmd(&["SADD", "m:set", "p", "q"])).await.unwrap();
    drv.command(&cmd(&["SADD", "m:intset", "1", "2", "3"])).await.unwrap();
    drv.command(&cmd(&["ZADD", "m:zset", "1", "a", "2", "b"])).await.unwrap();
    drv.command(&cmd(&["XADD", "m:stream", "*", "f", "v"])).await.unwrap();
    let keys: Vec<String> = ["m:str", "m:int", "m:hash", "m:list", "m:set", "m:intset", "m:zset", "m:stream", "m:gone"].iter().map(|s| s.to_string()).collect();
    let meta = drv.key_meta(&keys).await.unwrap();
    assert_eq!(meta.len(), keys.len(), "one row per key, in order");
    for (m, k) in meta.iter().zip(&keys) {
        assert_eq!(&m.key, k);
    }
    // compare against what the server answers one key at a time
    for m in meta.iter().filter(|m| m.key != "m:gone") {
        let enc = drv.command(&cmd(&["OBJECT", "ENCODING", &m.key])).await.unwrap();
        let mem = drv.command(&cmd(&["MEMORY", "USAGE", &m.key])).await.unwrap();
        let encoding = m.encoding.clone().unwrap_or_else(|| panic!("encoding for {}", m.key));
        assert!(enc.contains(&encoding), "{}: pipeline {encoding:?} vs OBJECT ENCODING {enc:?}", m.key);
        let bytes = m.bytes.unwrap_or_else(|| panic!("size for {}", m.key));
        assert!(bytes > 0 && mem.contains(&bytes.to_string()), "{}: pipeline {bytes} vs MEMORY USAGE {mem:?}", m.key);
    }
    let by = |k: &str| meta.iter().find(|m| m.key == k).unwrap().encoding.clone().unwrap();
    assert_eq!(by("m:str"), "embstr");
    assert_eq!(by("m:int"), "int");
    assert_eq!(by("m:intset"), "intset");
    assert_eq!(by("m:stream"), "stream");
    let gone = meta.iter().find(|m| m.key == "m:gone").unwrap();
    assert_eq!((gone.bytes, gone.encoding.as_deref()), (None, None), "a missing key stays unknown, never 0");
    assert!(drv.key_meta(&[]).await.unwrap().is_empty());

    // ---- single-item edits (one atomic EVAL each), read back with plain commands ----
    use database_studio_lib::drivers::redis::RedisEditOp;
    // List with a duplicate: deleting position 0 removes exactly one "a"
    drv.command(&cmd(&["RPUSH", "e:list", "a", "b", "a"])).await.unwrap();
    drv.apply_edit("e:list", RedisEditOp::LDelAt { index: 0, expected: "a".into() }).await.unwrap();
    assert_eq!(drv.command(&cmd(&["LRANGE", "e:list", "0", "-1"])).await.unwrap(), "1) \"b\"\n2) \"a\"", "only the item at 0 is gone");
    drv.apply_edit("e:list", RedisEditOp::LSetAt { index: 1, expected: "a".into(), value: "c".into() }).await.unwrap();
    assert_eq!(drv.command(&cmd(&["LRANGE", "e:list", "0", "-1"])).await.unwrap(), "1) \"b\"\n2) \"c\"");
    // stale read (the item is no longer what the user saw) → refused, nothing changes
    let stale = drv.apply_edit("e:list", RedisEditOp::LSetAt { index: 0, expected: "zzz".into(), value: "x".into() }).await.unwrap_err();
    assert!(stale.message.contains("changed on the server"), "{}", stale.message);
    assert!(drv.apply_edit("e:list", RedisEditOp::LDelAt { index: 9, expected: "b".into() }).await.is_err(), "out of range → refused");
    assert_eq!(drv.command(&cmd(&["LRANGE", "e:list", "0", "-1"])).await.unwrap(), "1) \"b\"\n2) \"c\"");

    // Hash: change a value; rename a field (old one gone); rename onto an existing field refused
    drv.command(&cmd(&["HSET", "e:hash", "email", "an@acme.io", "role", "admin"])).await.unwrap();
    drv.apply_edit("e:hash", RedisEditOp::HReplace { from: "email".into(), to: "email".into(), value: "an@new.io".into() }).await.unwrap();
    assert_eq!(drv.command(&cmd(&["HGET", "e:hash", "email"])).await.unwrap(), "\"an@new.io\"");
    drv.apply_edit("e:hash", RedisEditOp::HReplace { from: "email".into(), to: "mail".into(), value: "an@new.io".into() }).await.unwrap();
    assert_eq!(drv.command(&cmd(&["HEXISTS", "e:hash", "email"])).await.unwrap(), "(integer) 0");
    assert_eq!(drv.command(&cmd(&["HGET", "e:hash", "mail"])).await.unwrap(), "\"an@new.io\"");
    let taken = drv.apply_edit("e:hash", RedisEditOp::HReplace { from: "mail".into(), to: "role".into(), value: "x".into() }).await.unwrap_err();
    assert!(taken.message.contains("already used"), "{}", taken.message);
    assert_eq!(drv.command(&cmd(&["HGET", "e:hash", "role"])).await.unwrap(), "\"admin\"", "the existing field is untouched");
    assert!(drv.apply_edit("e:hash", RedisEditOp::HReplace { from: "gone".into(), to: "new".into(), value: "x".into() }).await.is_err(), "renaming a field that vanished is refused");

    // Set: replace a member; onto an existing member refused
    drv.command(&cmd(&["SADD", "e:set", "redis", "svelte"])).await.unwrap();
    drv.apply_edit("e:set", RedisEditOp::SReplace { from: "svelte".into(), to: "sveltekit".into() }).await.unwrap();
    assert_eq!(drv.command(&cmd(&["SISMEMBER", "e:set", "svelte"])).await.unwrap(), "(integer) 0");
    assert_eq!(drv.command(&cmd(&["SISMEMBER", "e:set", "sveltekit"])).await.unwrap(), "(integer) 1");
    assert!(drv.apply_edit("e:set", RedisEditOp::SReplace { from: "sveltekit".into(), to: "redis".into() }).await.is_err());
    assert_eq!(drv.command(&cmd(&["SCARD", "e:set"])).await.unwrap(), "(integer) 2");

    // Sorted set: new score, then rename keeping the score
    drv.command(&cmd(&["ZADD", "e:zset", "1", "an", "2", "binh"])).await.unwrap();
    drv.apply_edit("e:zset", RedisEditOp::ZReplace { from: "an".into(), to: "an".into(), score: 9.5 }).await.unwrap();
    assert_eq!(drv.command(&cmd(&["ZSCORE", "e:zset", "an"])).await.unwrap(), "\"9.5\"");
    drv.apply_edit("e:zset", RedisEditOp::ZReplace { from: "an".into(), to: "anh".into(), score: 9.5 }).await.unwrap();
    assert_eq!(drv.command(&cmd(&["ZSCORE", "e:zset", "an"])).await.unwrap(), "(nil)");
    assert_eq!(drv.command(&cmd(&["ZSCORE", "e:zset", "anh"])).await.unwrap(), "\"9.5\"");
    assert!(drv.apply_edit("e:zset", RedisEditOp::ZReplace { from: "anh".into(), to: "binh".into(), score: 1.0 }).await.is_err());
    assert_eq!(drv.command(&cmd(&["ZSCORE", "e:zset", "binh"])).await.unwrap(), "\"2\"");

    eprintln!("CHK redis_workspace_slowlog_info_and_key_meta OK ({} slow entries, {} sections)", slow.entries.len(), sections.len());
}
