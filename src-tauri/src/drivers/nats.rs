//! NATS driver (Phase 3) — async-nats. Không phải SQL: pub/sub + request/reply +
//! JetStream (T9/T10). Ở đây: connect/test/ping. Client multiplexed (clone rẻ).

use std::time::Instant;

use crate::drivers::types::TestResult;
use crate::error::QueryError;

pub struct NatsDriver {
    pub client: async_nats::Client,
}

pub struct NatsConnParams {
    pub host: String,
    pub port: u16,
    /// Auth username/password (rỗng = no-auth).
    pub user: String,
    pub password: String,
    pub ssl: bool,
}

fn err(msg: impl Into<String>, raw: impl std::fmt::Display) -> QueryError {
    QueryError::new("nats", msg.into(), raw.to_string())
}

impl NatsDriver {
    async fn open(p: &NatsConnParams) -> Result<async_nats::Client, QueryError> {
        let mut opts = async_nats::ConnectOptions::new();
        if !p.user.is_empty() {
            opts = opts.user_and_password(p.user.clone(), p.password.clone());
        }
        if p.ssl {
            opts = opts.require_tls(true);
        }
        let url = format!("nats://{}:{}", p.host, p.port);
        opts.connect(&url)
            .await
            .map_err(|e| err(format!("Failed to connect to NATS {url}"), e))
    }

    pub async fn connect(p: &NatsConnParams) -> Result<Self, QueryError> {
        Ok(Self { client: Self::open(p).await? })
    }

    pub async fn test(p: &NatsConnParams) -> TestResult {
        let started = Instant::now();
        match Self::open(p).await {
            Ok(client) => {
                let version = {
                    let info = client.server_info();
                    if info.version.is_empty() { None } else { Some(format!("NATS {}", info.version)) }
                };
                TestResult {
                    ok: true,
                    latency_ms: Some(started.elapsed().as_millis() as u64),
                    server_version: version,
                    error: None,
                }
            }
            Err(e) => TestResult { ok: false, latency_ms: None, server_version: None, error: Some(e.message) },
        }
    }

    pub async fn ping(&mut self) -> bool {
        matches!(self.client.connection_state(), async_nats::connection::State::Connected)
    }

    /// Subscribe subject/wildcard (`>`, `*`) → Subscriber stream (task nền đọc).
    pub async fn subscribe(&self, subject: String) -> Result<async_nats::Subscriber, QueryError> {
        self.client
            .subscribe(subject)
            .await
            .map_err(|e| err("Subscribe error", e))
    }

    /// Publish payload lên subject (kèm reply-to tùy chọn), flush để chắc chắn gửi.
    pub async fn publish(
        &self,
        subject: String,
        payload: String,
        reply: Option<String>,
    ) -> Result<(), QueryError> {
        let bytes = bytes::Bytes::from(payload.into_bytes());
        match reply {
            Some(r) => self
                .client
                .publish_with_reply(subject, r, bytes)
                .await
                .map_err(|e| err("Publish error", e))?,
            None => self.client.publish(subject, bytes).await.map_err(|e| err("Publish error", e))?,
        }
        self.client.flush().await.map_err(|e| err("Flush error", e))?;
        Ok(())
    }

    /// Request/Reply với timeout → payload trả về (UTF-8) hoặc lỗi timeout.
    pub async fn request(
        &self,
        subject: String,
        payload: String,
        timeout_ms: u64,
    ) -> Result<String, QueryError> {
        let fut = self.client.request(subject, bytes::Bytes::from(payload.into_bytes()));
        let msg = tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), fut)
            .await
            .map_err(|_| err("Request timeout", "no reply within timeout"))?
            .map_err(|e| err("Request error", e))?;
        Ok(String::from_utf8_lossy(&msg.payload).into_owned())
    }

    pub fn server_info(&self) -> async_nats::ServerInfo {
        self.client.server_info()
    }

    // ---- KV Store (T9) ------------------------------------------------------

    /// List KV buckets (stream tên "KV_<bucket>").
    pub async fn kv_buckets(&self) -> Result<Vec<String>, QueryError> {
        use futures::StreamExt;
        let js = async_nats::jetstream::new(self.client.clone());
        let mut names = js.stream_names();
        let mut out = Vec::new();
        while let Some(n) = names.next().await {
            if let Ok(n) = n {
                if let Some(b) = n.strip_prefix("KV_") {
                    out.push(b.to_string());
                }
            }
        }
        Ok(out)
    }

    pub async fn kv_create(&self, bucket: String) -> Result<(), QueryError> {
        let js = async_nats::jetstream::new(self.client.clone());
        js.create_key_value(async_nats::jetstream::kv::Config { bucket, ..Default::default() })
            .await
            .map_err(|e| err("Failed to create KV bucket", e))?;
        Ok(())
    }

    pub async fn kv_delete_bucket(&self, bucket: &str) -> Result<(), QueryError> {
        let js = async_nats::jetstream::new(self.client.clone());
        js.delete_key_value(bucket).await.map_err(|e| err("Failed to delete KV bucket", e))?;
        Ok(())
    }

    pub async fn kv_keys(&self, bucket: &str) -> Result<Vec<String>, QueryError> {
        use futures::StreamExt;
        let js = async_nats::jetstream::new(self.client.clone());
        let store = js.get_key_value(bucket).await.map_err(|e| err("Failed to get KV bucket", e))?;
        let mut keys = store.keys().await.map_err(|e| err("KV keys error", e))?;
        let mut out = Vec::new();
        while let Some(k) = keys.next().await {
            if let Ok(k) = k {
                out.push(k);
            }
        }
        Ok(out)
    }

    pub async fn kv_get(&self, bucket: &str, key: &str) -> Result<Option<String>, QueryError> {
        let js = async_nats::jetstream::new(self.client.clone());
        let store = js.get_key_value(bucket).await.map_err(|e| err("Failed to get KV bucket", e))?;
        let v = store.get(key).await.map_err(|e| err("KV get error", e))?;
        Ok(v.map(|b| String::from_utf8_lossy(&b).into_owned()))
    }

    pub async fn kv_put(&self, bucket: &str, key: &str, value: String) -> Result<(), QueryError> {
        let js = async_nats::jetstream::new(self.client.clone());
        let store = js.get_key_value(bucket).await.map_err(|e| err("Failed to get KV bucket", e))?;
        store.put(key, value.into_bytes().into()).await.map_err(|e| err("KV put error", e))?;
        Ok(())
    }

    pub async fn kv_delete(&self, bucket: &str, key: &str) -> Result<(), QueryError> {
        let js = async_nats::jetstream::new(self.client.clone());
        let store = js.get_key_value(bucket).await.map_err(|e| err("Failed to get KV bucket", e))?;
        store.delete(key).await.map_err(|e| err("KV delete error", e))?;
        Ok(())
    }

    // ---- stream-workspace:nats (W4) — account usage + KV versions / history / watch ----

    /// JetStream usage and limits of this connection's account. When JetStream is
    /// not enabled for the account (or not running on the server) this is NOT an
    /// error: `enabled = false` + the server's reason, so the Overview can say so.
    pub async fn account_info(&self) -> Result<NatsAccount, QueryError> {
        use async_nats::jetstream::context::AccountErrorKind;
        let js = async_nats::jetstream::new(self.client.clone());
        match js.query_account().await {
            Ok(a) => Ok(NatsAccount {
                enabled: true,
                reason: None,
                memory: a.memory,
                storage: a.storage,
                streams: a.streams as u64,
                consumers: a.consumers as u64,
                max_memory: a.limits.max_memory,
                max_storage: a.limits.max_storage,
                max_streams: a.limits.max_streams,
                max_consumers: a.limits.max_consumers,
                domain: a.domain.filter(|d| !d.is_empty()),
                api_total: a.requests.total,
                api_errors: a.requests.errors,
            }),
            Err(e) => {
                let raw = e.to_string();
                if matches!(e.kind(), AccountErrorKind::JetStreamUnavailable) || persistence_off(&raw) {
                    Ok(NatsAccount::disabled(raw))
                } else {
                    Err(err("Failed to read the account's JetStream usage", raw))
                }
            }
        }
    }

    async fn kv_store(&self, bucket: &str) -> Result<async_nats::jetstream::kv::Store, QueryError> {
        let js = async_nats::jetstream::new(self.client.clone());
        js.get_key_value(bucket)
            .await
            .map_err(|e| err(format!("Key-value bucket '{bucket}' could not be opened"), e))
    }

    /// Settings + size of one KV bucket (fresh from the server).
    pub async fn kv_status(&self, bucket: &str) -> Result<KvStatus, QueryError> {
        let store = self.kv_store(bucket).await?;
        let st = store.status().await.map_err(|e| err("KV status error", e))?;
        Ok(kv_status_from_info(&st.bucket, &st.info))
    }

    /// Every KV bucket with its settings and size, from ONE stream listing (a KV
    /// bucket is the stream `KV_<bucket>`), instead of one status call per bucket.
    pub async fn kv_bucket_list(&self) -> Result<Vec<KvStatus>, QueryError> {
        use futures::TryStreamExt;
        let js = async_nats::jetstream::new(self.client.clone());
        let mut infos = js.streams();
        let mut out = Vec::new();
        while let Some(info) = infos.try_next().await.map_err(|e| err("List key-value buckets error", e))? {
            if let Some(b) = info.config.name.strip_prefix("KV_") {
                out.push(kv_status_from_info(b, &info));
            }
        }
        out.sort_by(|a, b| a.bucket.cmp(&b.bucket));
        Ok(out)
    }

    /// Latest entry of every key in a bucket (value + version + time), deleted keys
    /// included as markers so the UI can show "Deleted". One ordered consumer
    /// delivering the last message per key — not one request per key. At most
    /// `limit` keys; `truncated` says when there were more.
    pub async fn kv_entries(&self, bucket: &str, limit: usize) -> Result<KvEntries, QueryError> {
        use futures::StreamExt;
        let limit = limit.clamp(1, 10_000);
        let store = self.kv_store(bucket).await?;
        let mut watch = store.watch_with_history(">").await.map_err(|e| err("KV read error", e))?;
        let mut entries = Vec::new();
        let mut truncated = false;
        loop {
            let next = tokio::time::timeout(std::time::Duration::from_secs(5), watch.next()).await;
            let Ok(Some(item)) = next else { break };
            let e = item.map_err(|e| err("KV read error", e))?;
            let done = e.delta == 0 || e.seen_current;
            entries.push(kv_entry_from(e));
            if done {
                break;
            }
            if entries.len() >= limit {
                truncated = true;
                break;
            }
        }
        entries.sort_by(|a, b| a.key.cmp(&b.key));
        Ok(KvEntries { entries, truncated })
    }

    /// Current entry of one key — the value with its version and time. A deleted
    /// key comes back with `operation = "delete"` (its marker), `None` = never set.
    pub async fn kv_entry(&self, bucket: &str, key: &str) -> Result<Option<KvEntry>, QueryError> {
        let store = self.kv_store(bucket).await?;
        let e = store.entry(key).await.map_err(|e| err("KV read error", e))?;
        Ok(e.map(kv_entry_from))
    }

    /// Every version the bucket still keeps for a key, oldest first, including the
    /// delete / purge markers. A key that was never written has no history (the
    /// history stream would wait forever for it, so it is checked first).
    pub async fn kv_history(&self, bucket: &str, key: &str) -> Result<Vec<KvEntry>, QueryError> {
        use futures::StreamExt;
        let store = self.kv_store(bucket).await?;
        if store.entry(key).await.map_err(|e| err("KV read error", e))?.is_none() {
            return Ok(Vec::new());
        }
        let mut hist = store.history(key).await.map_err(|e| err("KV history error", e))?;
        let mut out = Vec::new();
        loop {
            let next = tokio::time::timeout(std::time::Duration::from_secs(5), hist.next()).await;
            let Ok(Some(item)) = next else { break };
            let e = item.map_err(|e| err("KV history error", e))?;
            let done = e.delta == 0;
            out.push(kv_entry_from(e));
            if done || out.len() >= 1_000 {
                break;
            }
        }
        Ok(out)
    }

    /// Put a value and return the new version number.
    pub async fn kv_put_version(&self, bucket: &str, key: &str, value: String) -> Result<u64, QueryError> {
        let store = self.kv_store(bucket).await?;
        store.put(key, value.into_bytes().into()).await.map_err(|e| err("KV put error", e))
    }

    /// Remove a key AND all its earlier versions (a purge marker is left).
    pub async fn kv_purge(&self, bucket: &str, key: &str) -> Result<(), QueryError> {
        let store = self.kv_store(bucket).await?;
        store.purge(key).await.map_err(|e| err("KV purge error", e))
    }

    /// Create a bucket with explicit settings (versions kept, expiry, storage…).
    pub async fn kv_create_bucket(&self, req: KvCreate) -> Result<KvStatus, QueryError> {
        let js = async_nats::jetstream::new(self.client.clone());
        let store = js
            .create_key_value(kv_config_from(&req))
            .await
            .map_err(|e| err(format!("Failed to create key-value bucket '{}'", req.bucket), e))?;
        let st = store.status().await.map_err(|e| err("KV status error", e))?;
        Ok(kv_status_from_info(&st.bucket, &st.info))
    }

    /// Live changes of a bucket (`pattern`, default every key), from now on.
    pub async fn kv_watch(&self, bucket: &str, pattern: &str) -> Result<async_nats::jetstream::kv::Watch, QueryError> {
        let store = self.kv_store(bucket).await?;
        let p = if pattern.trim().is_empty() { ">" } else { pattern.trim() };
        store.watch(p).await.map_err(|e| err("KV watch error", e))
    }

    // ---- Object Store (T9) --------------------------------------------------

    /// List Object Store buckets (stream tên "OBJ_<bucket>").
    pub async fn obj_buckets(&self) -> Result<Vec<String>, QueryError> {
        use futures::StreamExt;
        let js = async_nats::jetstream::new(self.client.clone());
        let mut names = js.stream_names();
        let mut out = Vec::new();
        while let Some(n) = names.next().await {
            if let Ok(n) = n {
                if let Some(b) = n.strip_prefix("OBJ_") {
                    out.push(b.to_string());
                }
            }
        }
        Ok(out)
    }

    pub async fn obj_create(&self, bucket: String) -> Result<(), QueryError> {
        let js = async_nats::jetstream::new(self.client.clone());
        js.create_object_store(async_nats::jetstream::object_store::Config { bucket, ..Default::default() })
            .await
            .map_err(|e| err("Failed to create Object bucket", e))?;
        Ok(())
    }

    pub async fn obj_delete_bucket(&self, bucket: &str) -> Result<(), QueryError> {
        let js = async_nats::jetstream::new(self.client.clone());
        js.delete_object_store(bucket).await.map_err(|e| err("Failed to delete Object bucket", e))?;
        Ok(())
    }

    /// List objects trong bucket (name/size/chunks).
    pub async fn obj_list(&self, bucket: &str) -> Result<Vec<ObjInfo>, QueryError> {
        use futures::StreamExt;
        let js = async_nats::jetstream::new(self.client.clone());
        let store = js.get_object_store(bucket).await.map_err(|e| err("Failed to get Object bucket", e))?;
        let mut list = store.list().await.map_err(|e| err("Object list error", e))?;
        let mut out = Vec::new();
        while let Some(o) = list.next().await {
            if let Ok(o) = o {
                out.push(ObjInfo { name: o.name, size: o.size as u64, chunks: o.chunks as u64 });
            }
        }
        Ok(out)
    }

    /// Upload object từ path file thật (đọc bytes).
    pub async fn obj_put_file(&self, bucket: &str, name: String, path: &str) -> Result<(), QueryError> {
        let js = async_nats::jetstream::new(self.client.clone());
        let store = js.get_object_store(bucket).await.map_err(|e| err("Failed to get Object bucket", e))?;
        let bytes = tokio::fs::read(path).await.map_err(|e| err(format!("Failed to read file {path}"), e))?;
        let mut slice: &[u8] = &bytes;
        store.put(name.as_str(), &mut slice).await.map_err(|e| err("Object put error", e))?;
        Ok(())
    }

    /// Download object ra path file thật.
    pub async fn obj_get_file(&self, bucket: &str, name: &str, path: &str) -> Result<(), QueryError> {
        use tokio::io::AsyncReadExt;
        let js = async_nats::jetstream::new(self.client.clone());
        let store = js.get_object_store(bucket).await.map_err(|e| err("Failed to get Object bucket", e))?;
        let mut obj = store.get(name).await.map_err(|e| err("Object get error", e))?;
        let mut buf = Vec::new();
        obj.read_to_end(&mut buf).await.map_err(|e| err("Failed to read object", e))?;
        tokio::fs::write(path, buf).await.map_err(|e| err(format!("Failed to write file {path}"), e))?;
        Ok(())
    }

    pub async fn obj_delete(&self, bucket: &str, name: &str) -> Result<(), QueryError> {
        let js = async_nats::jetstream::new(self.client.clone());
        let store = js.get_object_store(bucket).await.map_err(|e| err("Failed to get Object bucket", e))?;
        store.delete(name).await.map_err(|e| err("Object delete error", e))?;
        Ok(())
    }

    pub fn client(&self) -> async_nats::Client {
        self.client.clone()
    }

    // ---- JetStream (T10) ----------------------------------------------------

    /// List streams + config/state cơ bản.
    pub async fn js_streams(&self) -> Result<Vec<JsStream>, QueryError> {
        use futures::TryStreamExt;
        let js = async_nats::jetstream::new(self.client.clone());
        let mut out = Vec::new();
        let mut infos = js.streams();
        while let Some(info) = infos.try_next().await.map_err(|e| err("List streams error", e))? {
            let limits = stream_limits(&info); // stream-workspace:nats
            out.push(JsStream {
                limits,
                name: info.config.name,
                subjects: info.config.subjects,
                retention: format!("{:?}", info.config.retention),
                storage: format!("{:?}", info.config.storage),
                messages: info.state.messages,
                bytes: info.state.bytes,
                consumers: info.state.consumer_count as u64,
            });
        }
        Ok(out)
    }

    /// List consumers của 1 stream.
    pub async fn js_consumers(&self, stream: &str) -> Result<Vec<JsConsumer>, QueryError> {
        use futures::TryStreamExt;
        let js = async_nats::jetstream::new(self.client.clone());
        let s = js.get_stream(stream).await.map_err(|e| err("Failed to get stream", e))?;
        let mut out = Vec::new();
        let mut cons = s.consumers();
        while let Some(ci) = cons.try_next().await.map_err(|e| err("List consumers error", e))? {
            out.push(JsConsumer {
                name: ci.name,
                deliver_policy: format!("{:?}", ci.config.deliver_policy),
                ack_policy: format!("{:?}", ci.config.ack_policy),
                filter_subjects: consumer_filters(&ci.config.filter_subject, &[]), // filter_subjects needs async-nats "server_2_10"
                filter_subject: ci.config.filter_subject,
                num_pending: ci.num_pending,
                num_ack_pending: ci.num_ack_pending as u64,
                ack_floor_stream_seq: ci.ack_floor.stream_sequence,
                delivered_stream_seq: ci.delivered.stream_sequence,
            });
        }
        Ok(out)
    }

    /// Tạo stream (subjects, retention/storage mặc định Limits/File).
    pub async fn js_create_stream(&self, name: String, subjects: Vec<String>) -> Result<(), QueryError> {
        let js = async_nats::jetstream::new(self.client.clone());
        js.create_stream(async_nats::jetstream::stream::Config { name, subjects, ..Default::default() })
            .await
            .map_err(|e| err("Failed to create stream", e))?;
        Ok(())
    }

    /// Delete a stream ON THE SERVER, then SELF-VERIFY it is really gone.
    /// `delete_stream` returns a `DeleteStatus`; `success:false` → error. On success we
    /// re-list with the SAME client and confirm the stream no longer exists — if it is
    /// still there the delete did not actually take effect on this connection's
    /// JetStream (wrong domain/account, or the stream was recreated by server
    /// config/a controller), so we surface a precise error instead of a false "deleted".
    pub async fn js_delete_stream(&self, name: &str) -> Result<(), QueryError> {
        use futures::TryStreamExt;
        let js = async_nats::jetstream::new(self.client.clone());
        let status = js
            .delete_stream(name)
            .await
            .map_err(|e| err(format!("Failed to delete stream '{name}'"), e))?;
        if !status.success {
            return Err(err(
                format!("NATS did not delete stream '{name}'"),
                "delete_stream returned success=false",
            ));
        }
        // Self-verify on the server: the stream must be absent from a fresh listing.
        let mut infos = js.streams();
        while let Some(info) = infos
            .try_next()
            .await
            .map_err(|e| err("Verify delete: failed to list streams", e))?
        {
            if info.config.name == name {
                return Err(err(
                    format!(
                        "Stream '{name}' still exists after delete — the server did not remove it. \
                         Likely a JetStream domain/account mismatch, or the stream is recreated by \
                         server config or an external controller."
                    ),
                    "post-delete verification: stream still present",
                ));
            }
        }
        Ok(())
    }

    /// Purge toàn bộ message của stream.
    pub async fn js_purge_stream(&self, name: &str) -> Result<(), QueryError> {
        let js = async_nats::jetstream::new(self.client.clone());
        let stream = js.get_stream(name).await.map_err(|e| err("Failed to get stream", e))?;
        stream.purge().await.map_err(|e| err("Failed to purge stream", e))?;
        Ok(())
    }

    /// Tạo pull consumer (durable) + filter subject tùy chọn.
    pub async fn js_create_consumer(
        &self,
        stream: &str,
        durable: String,
        filter: String,
    ) -> Result<(), QueryError> {
        let js = async_nats::jetstream::new(self.client.clone());
        let s = js.get_stream(stream).await.map_err(|e| err("Failed to get stream", e))?;
        s.create_consumer(async_nats::jetstream::consumer::pull::Config {
            durable_name: Some(durable),
            filter_subject: filter,
            ..Default::default()
        })
        .await
        .map_err(|e| err("Failed to create consumer", e))?;
        Ok(())
    }

    /// Xóa consumer của stream.
    pub async fn js_delete_consumer(&self, stream: &str, name: &str) -> Result<(), QueryError> {
        let js = async_nats::jetstream::new(self.client.clone());
        let s = js.get_stream(stream).await.map_err(|e| err("Failed to get stream", e))?;
        s.delete_consumer(name).await.map_err(|e| err("Failed to delete consumer", e))?;
        Ok(())
    }

    /// Xóa 1 message theo sequence.
    pub async fn js_delete_message(&self, stream: &str, seq: u64) -> Result<(), QueryError> {
        let js = async_nats::jetstream::new(self.client.clone());
        let s = js.get_stream(stream).await.map_err(|e| err("Failed to get stream", e))?;
        s.delete_message(seq).await.map_err(|e| err("Failed to delete message", e))?;
        Ok(())
    }

    /// Peek message theo sequence number.
    pub async fn js_peek(&self, stream: &str, seq: u64) -> Result<JsMessage, QueryError> {
        let js = async_nats::jetstream::new(self.client.clone());
        let s = js.get_stream(stream).await.map_err(|e| err("Failed to get stream", e))?;
        let raw = s.get_raw_message(seq).await.map_err(|e| err(format!("Failed to peek seq {seq}"), e))?;
        Ok(JsMessage {
            seq: raw.sequence,
            subject: raw.subject.to_string(),
            payload: String::from_utf8_lossy(&raw.payload).into_owned(),
            key: header_key(Some(&raw.headers)),
            // Server-stored publish time as ISO-8601, preserving the server's own
            // UTC offset (parseable by JS Date).
            time: iso_with_offset(raw.time),
        })
    }

    /// Browse up to `limit` existing messages of a subject (server-side filtered,
    /// no-wait fetch). Uses an ephemeral pull consumer so nothing is left behind.
    pub async fn js_subject_messages(
        &self,
        stream: &str,
        subject: &str,
        limit: usize,
        start_seq: Option<u64>,
    ) -> Result<Vec<JsMessage>, QueryError> {
        self.fetch_window(stream, subject, start_seq.unwrap_or(0), u64::MAX, limit).await
    }

    /// Read the messages of `subject` whose stream sequence falls in `[start, end]`,
    /// at most `cap` of them, oldest first. JetStream only reads FORWARD, so this is
    /// the single primitive every paging step is built on: the server filters by
    /// subject and we stop as soon as a message past `end` shows up.
    async fn fetch_window(
        &self,
        stream: &str,
        subject: &str,
        start: u64,
        end: u64,
        cap: usize,
    ) -> Result<Vec<JsMessage>, QueryError> {
        use async_nats::jetstream::consumer::{pull::Config as PullConfig, AckPolicy, DeliverPolicy};
        use futures::StreamExt;
        let js = async_nats::jetstream::new(self.client.clone());
        let s = js.get_stream(stream).await.map_err(|e| err("Failed to get stream", e))?;
        // Server-side pagination: start at a given stream sequence (Next fetches the
        // next page from the server, never loading the whole subject at once).
        let deliver_policy = match start {
            seq if seq > 1 => DeliverPolicy::ByStartSequence { start_sequence: seq },
            _ => DeliverPolicy::All,
        };
        let consumer = s
            .create_consumer(PullConfig {
                filter_subject: subject.to_string(),
                deliver_policy,
                ack_policy: AckPolicy::None,
                ..Default::default()
            })
            .await
            .map_err(|e| err("Failed to create browse consumer", e))?;
        let mut batch = consumer
            .fetch()
            .max_messages(cap.max(1))
            .messages()
            .await
            .map_err(|e| err("Failed to fetch messages", e))?;
        let mut out = Vec::new();
        while let Some(item) = batch.next().await {
            let m = item.map_err(|e| err("Message read error", e))?;
            let info = m.info().ok();
            let seq = info.as_ref().map(|i| i.stream_sequence).unwrap_or(0);
            // past the window: everything from here on belongs to a newer page
            if seq > end {
                break;
            }
            let key = header_key(m.headers.as_ref());
            out.push(JsMessage {
                seq,
                subject: m.subject.to_string(),
                payload: String::from_utf8_lossy(&m.payload).into_owned(),
                key,
                // Server-stored publish time as ISO-8601, preserving the server's own
                // UTC offset (parseable by JS Date).
                time: info.map(|i| iso_with_offset(i.published)).unwrap_or_default(),
            });
        }
        Ok(out)
    }

    /// ONE page of a subject's messages, newest-first, ending at `end_seq`
    /// (default: the newest message of the subject). Returns at most `page_size`
    /// messages — the NEWEST ones at or before the cursor — plus how many server
    /// round-trips the search needed.
    ///
    /// Why a search is needed: a subject is usually a sparse slice of a busy stream
    /// and JetStream cannot read backwards, so "where do the last N messages of this
    /// subject start" is not something the server can answer. We probe a sequence
    /// window: double it while it holds too few messages, halve it when it is so
    /// dense that one fetch cannot cover it. A window that IS covered (fewer rows
    /// than the cap) is authoritative — its last `page_size` rows are exactly the
    /// page. Cost is a couple of fetches, independent of stream size.
    ///
    /// RULE: counting must never block reading. The per-subject total needs
    /// `STREAM.INFO` with a subjects filter, which the server pages over EVERY
    /// matching subject — on a stream with many distinct subjects that is slow and
    /// can time out. So the page is read first, from the stream's own last sequence,
    /// and the total is a best-effort extra (0 = unknown) fetched with a deadline.
    pub async fn js_subject_page(
        &self,
        stream: &str,
        subject: &str,
        page_size: usize,
        end_seq: Option<u64>,
    ) -> Result<JsPage, QueryError> {
        let page_size = page_size.clamp(1, 5_000);
        let js = async_nats::jetstream::new(self.client.clone());
        let mut st = js.get_stream(stream).await.map_err(|e| err("Failed to get stream", e))?;
        // cheap and always available: the stream's own sequence range
        // Copy what we need out of the cached info: `info()` borrows the stream
        // mutably, and the stream is still needed for the last-by-subject lookup.
        let (stream_first, stream_last, stream_messages, stream_subjects) = {
            let info = st.info().await.map_err(|e| err("Failed to get stream info", e))?;
            (
                info.state.first_sequence,
                info.state.last_sequence,
                info.state.messages,
                info.state.subjects_count,
            )
        };
        trace(|| {
            format!("page {stream}/{subject}: stream_first={stream_first} stream_last={stream_last} messages={stream_messages} subjects={stream_subjects}")
        });

        // Cursor: caller's end, else the subject's own newest message (one cheap
        // request) and if even that is unavailable the stream's last sequence.
        let end = match end_seq {
            Some(e) => e.min(stream_last),
            None => match st.get_last_raw_message_by_subject(subject).await {
                Ok(m) => m.sequence,
                Err(e) => {
                    trace(|| format!("page {stream}/{subject}: last-by-subject unavailable ({e}) — starting from stream_last={stream_last}"));
                    stream_last
                }
            },
        };
        // Counting is only attempted for the newest page (the one that labels the
        // pager); later pages reuse the total the UI already holds.
        let want_count = end_seq.is_none() && should_count(subject, stream_subjects);
        if !want_count && end_seq.is_none() {
            trace(|| format!("count {stream}/{subject}: skipped — wildcard over {stream_subjects} subjects"));
        }
        if end == 0 || end < stream_first {
            trace(|| format!("page {stream}/{subject}: nothing at or before end={end} (stream starts at {stream_first})"));
            let total = if want_count { self.subject_total_best_effort(stream, subject).await } else { 0 };
            return Ok(JsPage { msgs: Vec::new(), probes: 0, total, last_seq: stream_last });
        }

        let cap = page_size.saturating_mul(2).saturating_add(1);
        // The first window is sized from the subject's DENSITY in the stream. An exact
        // subject is counted with one cheap request (a single subject-index entry) —
        // far cheaper than the extra probes a wrong guess costs on a sparse subject
        // (assuming the whole stream's density took 7 probes per page for a subject
        // holding 1% of it). A wildcard may span a huge subject space, so it keeps the
        // stream estimate and lets the doubling find the width.
        let counted = if !is_wildcard(subject) || want_count { self.subject_total_best_effort(stream, subject).await } else { 0 };
        let est_total = if counted > 0 { counted } else { stream_messages.max(1) };
        let mut w = initial_window(page_size, est_total, stream_last.max(1));
        let mut probes = 0u32;
        let mut widest: Vec<JsMessage> = Vec::new();
        let mut msgs: Option<Vec<JsMessage>> = None;
        for _ in 0..MAX_PAGE_PROBES {
            let start = end.saturating_sub(w.saturating_sub(1)).max(stream_first.max(1));
            let mut rows = self.fetch_window(stream, subject, start, end, cap).await?;
            probes += 1;
            // window_step reads "position 1" as "the window reaches the start of the stream":
            // pass the window start RELATIVE to the stream's first sequence. (Passing
            // start.min(stream_first) made it 1 for every stream that begins at seq 1, so
            // the first probe always counted as complete — a sparse subject came back with
            // a couple of rows per page instead of a full page.)
            let step = window_step(rows.len(), page_size, cap, start.saturating_sub(stream_first.max(1)) + 1);
            trace(|| format!("page {stream}/{subject}: probe {probes} window=[{start},{end}] w={w} rows={} → {step:?}", rows.len()));
            match step {
                WindowStep::Done => {
                    let keep = rows.len().saturating_sub(page_size);
                    msgs = Some(rows.split_off(keep));
                    break;
                }
                WindowStep::Wider => {
                    widest = rows;
                    w = w.saturating_mul(2);
                }
                WindowStep::Narrower => {
                    w = (w / 2).max(page_size as u64);
                }
            }
        }
        let msgs = msgs.unwrap_or_else(|| {
            // Probe budget exhausted (pathological distribution): return the widest
            // window actually read rather than claiming the subject is empty.
            let keep = widest.len().saturating_sub(page_size);
            widest.split_off(keep)
        });
        let total = if want_count { counted } else { 0 };
        trace(|| format!("page {stream}/{subject}: returning {} rows (probes={probes}, total={total})", msgs.len()));
        Ok(JsPage { msgs, probes, total, last_seq: stream_last })
    }

    /// Per-subject message count, best effort: 0 means "unknown", never an error.
    /// `STREAM.INFO` with a subjects filter makes the server page over every matching
    /// subject, so on a stream with many distinct subjects this is slow — it gets a
    /// deadline and its failure must never keep messages off the screen.
    async fn subject_total_best_effort(&self, stream: &str, subject: &str) -> u64 {
        let fut = self.subject_total(stream, subject);
        match tokio::time::timeout(SUBJECT_COUNT_DEADLINE, fut).await {
            Ok(Ok(n)) => n,
            Ok(Err(e)) => {
                trace(|| format!("count {stream}/{subject}: failed ({}) — total unknown", e.message));
                0
            }
            Err(_) => {
                trace(|| format!("count {stream}/{subject}: timed out after {:?} — total unknown", SUBJECT_COUNT_DEADLINE));
                0
            }
        }
    }

    /// Sum of the server's per-subject counts for `subject` (may be a wildcard).
    async fn subject_total(&self, stream: &str, subject: &str) -> Result<u64, QueryError> {
        use futures::TryStreamExt;
        let js = async_nats::jetstream::new(self.client.clone());
        let s = js.get_stream(stream).await.map_err(|e| err("Failed to get stream", e))?;
        // STREAM.INFO returns the subject index in pages and the SAME subject can
        // appear in more than one page (observed against nats 2.10) — summing every
        // entry counted those subjects twice, so the totals were wrong. Keep one
        // count per subject name.
        let mut seen: std::collections::HashMap<String, u64> = std::collections::HashMap::new();
        let mut subjects = s
            .info_with_subjects(subject)
            .await
            .map_err(|e| err("Failed to get subject counts", e))?;
        while let Some((subj, count)) = subjects
            .try_next()
            .await
            .map_err(|e| err("Failed to read subject counts", e))?
        {
            seen.insert(subj, count as u64);
        }
        Ok(seen.values().sum())
    }

    /// Subjects of `stream` under `filter` whose name STARTS WITH `prefix`
    /// (case-insensitive), newest-irrelevant: this reads the server's per-subject
    /// index (STREAM.INFO with a subjects filter), not the messages — so "find the
    /// subject I half-remember" costs one API call instead of walking the log.
    ///
    /// NATS filters match whole tokens and are case-sensitive, which is why a
    /// partial token like `_inbox.opjxo` can never be a filter: the prefix has to
    /// be applied to the subject NAMES, which is what this does. Capped at `limit`
    /// names (the caller shows the count it could not list).
    pub async fn js_stream_subjects(
        &self,
        stream: &str,
        filter: &str,
        prefix: &str,
        limit: usize,
    ) -> Result<StreamSubjects, QueryError> {
        use futures::TryStreamExt;
        let js = async_nats::jetstream::new(self.client.clone());
        let s = js.get_stream(stream).await.map_err(|e| err("Failed to get stream", e))?;
        let want = prefix.to_lowercase();
        // The index is paged and repeats subjects across pages (nats 2.10), so both
        // the counts and the matches are kept per NAME — otherwise a subject is
        // listed twice and "how many matched" is inflated.
        let mut all: std::collections::HashMap<String, u64> = std::collections::HashMap::new();
        let mut hits: std::collections::HashMap<String, u64> = std::collections::HashMap::new();
        let mut subjects = s
            .info_with_subjects(if filter.is_empty() { ">" } else { filter })
            .await
            .map_err(|e| err("Failed to list subjects", e))?;
        while let Some((subject, count)) = subjects
            .try_next()
            .await
            .map_err(|e| err("Failed to read subjects", e))?
        {
            if want.is_empty() || subject.to_lowercase().starts_with(&want) {
                hits.insert(subject.clone(), count as u64);
            }
            all.insert(subject, count as u64);
        }
        let matched = hits.len() as u64;
        let scanned = all.len() as u64;
        let mut out: Vec<SubjectCount> = hits
            .into_iter()
            .map(|(subject, messages)| SubjectCount { subject, messages })
            .collect();
        out.sort_by(|a, b| b.messages.cmp(&a.messages).then_with(|| a.subject.cmp(&b.subject)));
        out.truncate(limit);
        Ok(StreamSubjects { subjects: out, matched, scanned })
    }

    /// Total retained messages + last stream sequence for a subject. Both parts are
    /// best effort: a failed/slow count reports 0 ("unknown") and a missing
    /// last-by-subject falls back to the stream's last sequence, because neither is
    /// allowed to stop the message browser from showing messages.
    pub async fn js_subject_stats(&self, stream: &str, subject: &str) -> Result<SubjectStats, QueryError> {
        let js = async_nats::jetstream::new(self.client.clone());
        let mut s = js.get_stream(stream).await.map_err(|e| err("Failed to get stream", e))?;
        let stream_last = match s.info().await {
            Ok(i) => i.state.last_sequence,
            Err(e) => {
                trace(|| format!("stats {stream}/{subject}: stream info failed ({e})"));
                0
            }
        };
        let subjects_count = s.info().await.map(|i| i.state.subjects_count).unwrap_or(0);
        let total = if should_count(subject, subjects_count) {
            self.subject_total_best_effort(stream, subject).await
        } else {
            trace(|| format!("stats {stream}/{subject}: count skipped — wildcard over {subjects_count} subjects"));
            0
        };
        let last_seq = match s.get_last_raw_message_by_subject(subject).await {
            Ok(m) => m.sequence,
            Err(e) => {
                trace(|| format!("stats {stream}/{subject}: last-by-subject unavailable ({e}) — using stream_last={stream_last}"));
                stream_last
            }
        };
        trace(|| format!("stats {stream}/{subject}: total={total} last_seq={last_seq}"));
        Ok(SubjectStats { total, last_seq })
    }

    /// Clear messages of a single subject (JetStream purge with a subject filter).
    /// Leaves the stream and its other subjects intact.
    pub async fn js_purge_subject(&self, stream: &str, subject: &str) -> Result<(), QueryError> {
        let js = async_nats::jetstream::new(self.client.clone());
        let s = js.get_stream(stream).await.map_err(|e| err("Failed to get stream", e))?;
        s.purge().filter(subject).await.map_err(|e| err("Failed to purge subject", e))?;
        Ok(())
    }

    /// Delete a subject entirely: purge its messages, then drop it from the stream's
    /// config (update stream). The stream itself is always kept. Refuses to remove a
    /// subject the stream doesn't have, or the last remaining subject (a stream must
    /// keep ≥1 subject — the stream is never deleted here).
    pub async fn js_remove_subject(&self, stream: &str, subject: &str) -> Result<(), QueryError> {
        let js = async_nats::jetstream::new(self.client.clone());
        let mut s = js.get_stream(stream).await.map_err(|e| err("Failed to get stream", e))?;
        let mut cfg = s.info().await.map_err(|e| err("Failed to get stream info", e))?.config.clone();
        let before = cfg.subjects.len();
        cfg.subjects.retain(|x| x != subject);
        if cfg.subjects.len() == before {
            return Err(err("Subject not found in stream", subject));
        }
        if cfg.subjects.is_empty() {
            return Err(err(
                "Cannot delete the only subject of a stream",
                "a stream must keep at least one subject — delete the stream itself instead",
            ));
        }
        // Clear the subject's retained messages first, then remove it from config.
        s.purge().filter(subject).await.map_err(|e| err("Failed to purge subject", e))?;
        js.update_stream(&cfg).await.map_err(|e| err("Failed to update stream", e))?;
        Ok(())
    }

    /// JetStream: add a subject to a stream and publish an initial message to it.
    /// If the stream doesn't yet capture the subject it is added to the stream config
    /// (a wildcard entry may already cover it → the config update is best-effort), then
    /// the payload is published through JetStream so the subject has a stored message.
    /// NATS timestamps the message on the server; the client cannot set the publish time.
    pub async fn js_add_subject(&self, stream: &str, subject: &str, payload: &str) -> Result<(), QueryError> {
        if subject.trim().is_empty() {
            return Err(err("Subject is required", "empty subject"));
        }
        let js = async_nats::jetstream::new(self.client.clone());
        let mut s = js.get_stream(stream).await.map_err(|e| err("Failed to get stream", e))?;
        let mut cfg = s.info().await.map_err(|e| err("Failed to get stream info", e))?.config.clone();
        if !cfg.subjects.iter().any(|x| x == subject) {
            cfg.subjects.push(subject.to_string());
            // Best-effort: a pre-existing wildcard may already cover the subject, in which
            // case adding it verbatim is rejected as overlapping — ignore and still publish.
            let _ = js.update_stream(&cfg).await;
        }
        let ack = js
            .publish(subject.to_string(), payload.to_string().into())
            .await
            .map_err(|e| err("Failed to publish", e))?;
        ack.await.map_err(|e| err("Publish not acknowledged (subject not captured by the stream?)", e))?;
        Ok(())
    }
}

#[derive(Debug, serde::Serialize)]
pub struct JsStream {
    pub name: String,
    pub subjects: Vec<String>,
    pub retention: String,
    pub storage: String,
    pub messages: u64,
    pub bytes: u64,
    pub consumers: u64,
    // stream-workspace:nats — limits + state for the Streams detail (rule U4: the
    // UI reads them in words). Additive: older callers ignore them.
    /// stream config limits as the server reports them (see `StreamLimits`)
    #[serde(flatten)]
    pub limits: StreamLimits,
}

/// stream-workspace:nats — a stream's retention limits and sequence range, read
/// from its info. `-1` / `0` mean "no limit" exactly as the server reports them;
/// the frontend turns them into words ("Keep messages forever").
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct StreamLimits {
    /// 0 = keep forever
    pub max_age_ms: u64,
    /// -1 = no limit
    pub max_msgs: i64,
    /// -1 = no limit
    pub max_bytes: i64,
    /// -1 = no limit; KV buckets use this as "versions kept"
    pub max_msgs_per_subject: i64,
    /// -1 = no limit
    pub max_msg_size: i64,
    pub replicas: u64,
    /// "old" (drop oldest) | "new" (refuse new)
    pub discard: String,
    pub duplicate_window_ms: u64,
    pub description: Option<String>,
    pub first_seq: u64,
    pub last_seq: u64,
    /// ISO-8601, empty when the stream has never held a message
    pub last_time: String,
    pub created: String,
    pub subjects_count: u64,
    pub sealed: bool,
    pub deny_delete: bool,
    pub deny_purge: bool,
}

/// stream-workspace:nats — limits + state of a stream, from its server info.
pub fn stream_limits(info: &async_nats::jetstream::stream::Info) -> StreamLimits {
    let c = &info.config;
    StreamLimits {
        max_age_ms: c.max_age.as_millis() as u64,
        max_msgs: c.max_messages,
        max_bytes: c.max_bytes,
        max_msgs_per_subject: c.max_messages_per_subject,
        max_msg_size: c.max_message_size as i64,
        replicas: c.num_replicas as u64,
        discard: match c.discard {
            async_nats::jetstream::stream::DiscardPolicy::New => "new".into(),
            _ => "old".into(),
        },
        duplicate_window_ms: c.duplicate_window.as_millis() as u64,
        description: c.description.clone().filter(|d| !d.is_empty()),
        first_seq: info.state.first_sequence,
        last_seq: info.state.last_sequence,
        last_time: if info.state.last_sequence == 0 { String::new() } else { iso_with_offset(info.state.last_timestamp) },
        created: iso_with_offset(info.created),
        subjects_count: info.state.subjects_count,
        sealed: c.sealed,
        deny_delete: c.deny_delete,
        deny_purge: c.deny_purge,
    }
}

/// All subject filters of a consumer, deduped: the legacy single `filter_subject` and
/// the newer `filter_subjects` list. Empty means it reads the whole stream.
pub fn consumer_filters(single: &str, many: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for f in std::iter::once(single.to_string()).chain(many.iter().cloned()) {
        if !f.is_empty() && !out.contains(&f) {
            out.push(f);
        }
    }
    out
}

#[derive(Debug, serde::Serialize)]
pub struct JsConsumer {
    pub name: String,
    pub deliver_policy: String,
    pub ack_policy: String,
    pub filter_subject: String,
    pub num_pending: u64,
    pub num_ack_pending: u64,
    /// every subject filter (`filter_subject` plus the newer `filter_subjects`); empty = the whole stream
    pub filter_subjects: Vec<String>,
    /// stream sequence of the last message acknowledged contiguously: every message
    /// at or below it has been processed by this consumer
    pub ack_floor_stream_seq: u64,
    /// stream sequence of the last message delivered (handed out, maybe not acked yet)
    pub delivered_stream_seq: u64,
}

#[derive(Debug, serde::Serialize)]
pub struct SubjectCount {
    pub subject: String,
    pub messages: u64,
}

/// Result of a subject-name search: the matches we list, how many matched in
/// total (the list is capped), and how many subject names the stream holds.
#[derive(Debug, serde::Serialize)]
pub struct StreamSubjects {
    pub subjects: Vec<SubjectCount>,
    pub matched: u64,
    pub scanned: u64,
}

#[derive(Debug, serde::Serialize)]
pub struct SubjectStats {
    pub total: u64,
    pub last_seq: u64,
}

#[derive(Debug, serde::Serialize)]
pub struct JsMessage {
    pub seq: u64,
    pub subject: String,
    pub payload: String,
    pub time: String,
    /// Message key = the `Nats-Msg-Id` header if the publisher set one (empty otherwise).
    pub key: String,
}

/// One page of a subject's messages (newest-first cursor paging), plus the
/// subject's server-side totals so the UI can label pages without a second call.
#[derive(Debug, serde::Serialize)]
pub struct JsPage {
    /// Ascending by sequence, at most `page_size` items: the newest messages
    /// at or before the requested end cursor.
    pub msgs: Vec<JsMessage>,
    /// Server round-trips the window search needed (diagnostics / tests).
    pub probes: u32,
    pub total: u64,
    pub last_seq: u64,
}

/// Deadline for the best-effort per-subject count (see `subject_total_best_effort`).
pub(crate) const SUBJECT_COUNT_DEADLINE: std::time::Duration = std::time::Duration::from_secs(3);

/// Above this many distinct subjects in the stream, a WILDCARD subject's count is
/// not even attempted: `STREAM.INFO` with a subjects filter pages over every
/// matching subject, so it would cost far more than the page itself is worth. The UI
/// renders an unknown total instead (messages matter, a page count does not).
pub(crate) const SUBJECT_COUNT_SKIP_ABOVE: u64 = 10_000;

/// Does this subject contain NATS wildcards (`*` token, `>` tail)?
pub(crate) fn is_wildcard(subject: &str) -> bool {
    subject.split('.').any(|t| t == "*" || t == ">")
}

/// Should we try to count this subject at all? Exact subjects are cheap (one entry);
/// a wildcard over a stream with a huge subject space is not worth the wait.
pub(crate) fn should_count(subject: &str, stream_subjects: u64) -> bool {
    !is_wildcard(subject) || stream_subjects <= SUBJECT_COUNT_SKIP_ABOVE
}

/// Diagnostics for the JetStream browse path, off unless `DBSTUDIO_NATS_TRACE=1`
/// (same shape as the Kafka proxy trace). Prints to stderr, so `tauri dev` shows it.
pub(crate) fn trace(msg: impl FnOnce() -> String) {
    if std::env::var("DBSTUDIO_NATS_TRACE").is_ok_and(|v| v == "1") {
        eprintln!("nats-browse: {}", msg());
    }
}

/// Upper bound on window-search fetches for one page. Each step doubles or halves
/// the window, so this covers a stream sequence range of 2^24 pages worth.
pub(crate) const MAX_PAGE_PROBES: usize = 24;

/// What to do after probing a sequence window (pure — unit tested).
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum WindowStep {
    /// The window is fully covered and holds enough rows (or we hit sequence 1):
    /// its last `page_size` rows are the page.
    Done,
    /// The window holds too few messages of this subject — widen it.
    Wider,
    /// The window is so dense that one capped fetch could not cover it — narrow it.
    Narrower,
}

/// Decide the next search step from what a probe returned. `found` is the number of
/// rows read, `cap` the fetch limit: `found == cap` means the fetch was truncated,
/// so the rows do NOT necessarily reach the end of the window and cannot be trusted
/// as "the newest ones".
pub(crate) fn window_step(found: usize, page_size: usize, cap: usize, start: u64) -> WindowStep {
    if found >= cap {
        WindowStep::Narrower
    } else if found >= page_size || start <= 1 {
        WindowStep::Done
    } else {
        WindowStep::Wider
    }
}

/// First window to probe: `page_size` messages worth of stream sequences, scaled by
/// how sparse the subject is inside the stream (total messages vs last sequence),
/// with 50% headroom. Never smaller than `page_size` (a window of N sequences can
/// hold at most N messages).
pub(crate) fn initial_window(page_size: usize, total: u64, last_seq: u64) -> u64 {
    let page = page_size.max(1) as u128;
    if total == 0 {
        return last_seq.max(page_size as u64);
    }
    // sequences per message = last_seq / total  →  window = page * that * 1.5
    let est = page * (last_seq as u128).max(1) * 3 / ((total as u128) * 2);
    est.clamp(page, u64::MAX as u128) as u64
}

// ---- stream-workspace:nats (W4) — types + pure mapping -------------------------

/// JetStream usage of the account behind this connection.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct NatsAccount {
    /// false = persistence (JetStream) is not available to this account
    pub enabled: bool,
    /// the server's reason when `enabled` is false
    pub reason: Option<String>,
    pub memory: u64,
    pub storage: u64,
    pub streams: u64,
    pub consumers: u64,
    /// `None` = no limit
    pub max_memory: Option<i64>,
    pub max_storage: Option<i64>,
    pub max_streams: Option<i64>,
    pub max_consumers: Option<i64>,
    pub domain: Option<String>,
    pub api_total: u64,
    pub api_errors: u64,
}

impl NatsAccount {
    pub fn disabled(reason: String) -> Self {
        NatsAccount { enabled: false, reason: Some(reason), ..Default::default() }
    }
}

/// True when an account-info failure means "JetStream is off" rather than a real
/// error: the server answers 10039 "jetstream not enabled for account", or nobody
/// answers the JetStream API at all (no responders / 503).
pub(crate) fn persistence_off(raw: &str) -> bool {
    let r = raw.to_ascii_lowercase();
    r.contains("not enabled") || r.contains("10039") || r.contains("no responders") || r.contains("unavailable") || r.contains("503")
}

/// Settings + size of a key-value bucket.
#[derive(Debug, Clone, serde::Serialize)]
pub struct KvStatus {
    pub bucket: String,
    pub description: Option<String>,
    /// distinct keys present (deleted keys still count until their marker expires)
    pub keys: u64,
    /// stored values including earlier versions and delete markers
    pub values: u64,
    /// versions kept per key
    pub history: i64,
    /// 0 = keys never expire
    pub max_age_ms: u64,
    pub bytes: u64,
    /// `None` = no size limit
    pub max_bytes: Option<i64>,
    /// `None` = no per-value limit
    pub max_value_size: Option<i64>,
    /// "file" | "memory"
    pub storage: String,
    pub replicas: u64,
    pub created: String,
    /// last write time (ISO), empty when the bucket is empty
    pub last_time: String,
}

/// One version of a key.
#[derive(Debug, Clone, serde::Serialize)]
pub struct KvEntry {
    pub key: String,
    pub value: String,
    /// the version number (stream sequence)
    pub revision: u64,
    /// ISO-8601 time of the write
    pub created: String,
    /// "put" | "delete" | "purge"
    pub operation: String,
    /// value size in bytes
    pub size: u64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct KvEntries {
    pub entries: Vec<KvEntry>,
    pub truncated: bool,
}

/// Settings for a new bucket. Seconds / bytes; 0 or negative = no limit.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct KvCreate {
    pub bucket: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "one")]
    pub history: i64,
    #[serde(default)]
    pub max_age_secs: u64,
    /// "file" (default) | "memory"
    #[serde(default)]
    pub storage: String,
    #[serde(default)]
    pub max_bytes: i64,
    #[serde(default = "one_usize")]
    pub replicas: usize,
}
fn one() -> i64 {
    1
}
fn one_usize() -> usize {
    1
}

/// `-1` / `0` from the server mean "no limit" → `None`.
pub(crate) fn limit_opt(v: i64) -> Option<i64> {
    if v > 0 { Some(v) } else { None }
}

pub(crate) fn op_name(op: async_nats::jetstream::kv::Operation) -> &'static str {
    use async_nats::jetstream::kv::Operation;
    match op {
        Operation::Put => "put",
        Operation::Delete => "delete",
        Operation::Purge => "purge",
    }
}

pub(crate) fn kv_entry_from(e: async_nats::jetstream::kv::Entry) -> KvEntry {
    KvEntry {
        size: e.value.len() as u64,
        value: String::from_utf8_lossy(&e.value).into_owned(),
        key: e.key,
        revision: e.revision,
        created: iso_with_offset(e.created),
        operation: op_name(e.operation).to_string(),
    }
}

/// A bucket's settings and size from the info of its backing stream `KV_<bucket>`.
pub fn kv_status_from_info(bucket: &str, info: &async_nats::jetstream::stream::Info) -> KvStatus {
    let c = &info.config;
    KvStatus {
        bucket: bucket.to_string(),
        description: c.description.clone().filter(|d| !d.is_empty()),
        keys: info.state.subjects_count,
        values: info.state.messages,
        history: c.max_messages_per_subject,
        max_age_ms: c.max_age.as_millis() as u64,
        bytes: info.state.bytes,
        max_bytes: limit_opt(c.max_bytes),
        max_value_size: limit_opt(c.max_message_size as i64),
        storage: match c.storage {
            async_nats::jetstream::stream::StorageType::Memory => "memory".into(),
            _ => "file".into(),
        },
        replicas: c.num_replicas.max(1) as u64,
        created: iso_with_offset(info.created),
        last_time: if info.state.last_sequence == 0 { String::new() } else { iso_with_offset(info.state.last_timestamp) },
    }
}

/// The client config for a new bucket: versions kept clamped to the server's
/// 1–64, memory storage only when asked, limits only when positive.
pub fn kv_config_from(req: &KvCreate) -> async_nats::jetstream::kv::Config {
    use async_nats::jetstream::stream::StorageType;
    async_nats::jetstream::kv::Config {
        bucket: req.bucket.trim().to_string(),
        description: req.description.trim().to_string(),
        history: req.history.clamp(1, 64),
        max_age: std::time::Duration::from_secs(req.max_age_secs),
        max_bytes: if req.max_bytes > 0 { req.max_bytes } else { -1 },
        storage: if req.storage.eq_ignore_ascii_case("memory") { StorageType::Memory } else { StorageType::File },
        num_replicas: req.replicas.clamp(1, 5),
        ..Default::default()
    }
}

/// Format a server timestamp as ISO-8601 keeping the server's own UTC offset
/// (e.g. `2026-06-30T10:23:14Z` or `2026-06-30T17:23:14+07:00`). The datetime's
/// components are already expressed in its offset, so the frontend can render the
/// server's wall clock verbatim while the string stays parseable by JS `Date`.
fn iso_with_offset(t: time::OffsetDateTime) -> String {
    let secs = t.offset().whole_seconds();
    let tz = if secs == 0 {
        "Z".to_string()
    } else {
        let (h, m, _) = t.offset().as_hms();
        format!("{}{:02}:{:02}", if secs < 0 { '-' } else { '+' }, (h as i32).abs(), (m as i32).abs())
    };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}{}",
        t.year(),
        u8::from(t.month()),
        t.day(),
        t.hour(),
        t.minute(),
        t.second(),
        tz
    )
}

/// Extract the `Nats-Msg-Id` header (used as a message key/dedup id) if present.
/// Must use the standard `NATS_MESSAGE_ID` header name — a plain `&str` lookup
/// builds a *custom* header name that won't match the server's standard variant.
fn header_key(headers: Option<&async_nats::HeaderMap>) -> String {
    headers
        .and_then(|h| h.get(async_nats::header::NATS_MESSAGE_ID))
        .map(|v| v.as_str().to_string())
        .unwrap_or_default()
}

#[derive(Debug, serde::Serialize)]
pub struct ObjInfo {
    pub name: String,
    pub size: u64,
    pub chunks: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn consumer_filters_merge_legacy_and_list_without_duplicates() {
        assert!(consumer_filters("", &[]).is_empty()); // whole stream
        assert_eq!(consumer_filters("orders.eu", &[]), vec!["orders.eu"]);
        assert_eq!(
            consumer_filters("orders.eu", &["orders.eu".into(), "orders.us".into(), "".into()]),
            vec!["orders.eu", "orders.us"]
        );
        assert_eq!(consumer_filters("", &["a.>".into()]), vec!["a.>"]);
    }

    #[test]
    fn window_step_trusts_only_a_covered_window() {
        let (page, cap) = (100usize, 201usize);
        // truncated fetch: the rows may not reach the window end → narrow
        assert_eq!(window_step(cap, page, cap, 5_000), WindowStep::Narrower);
        // covered and full enough → done (the last page_size rows are the page)
        assert_eq!(window_step(page, page, cap, 5_000), WindowStep::Done);
        assert_eq!(window_step(page + 40, page, cap, 5_000), WindowStep::Done);
        // covered but short → widen
        assert_eq!(window_step(page - 1, page, cap, 5_000), WindowStep::Wider);
        assert_eq!(window_step(0, page, cap, 5_000), WindowStep::Wider);
        // reached the start of the stream: a short page is the real answer
        assert_eq!(window_step(7, page, cap, 1), WindowStep::Done);
        assert_eq!(window_step(0, page, cap, 1), WindowStep::Done);
    }

    #[test]
    fn narrowing_always_terminates() {
        // A window of page_size sequences can hold at most page_size messages, which
        // is below the cap — so Narrower can never be returned at the floor.
        let (page, cap) = (100usize, 201usize);
        assert_eq!(window_step(page, page, cap, 900_001), WindowStep::Done);
    }

    #[test]
    fn wildcard_detection_and_count_policy() {
        assert!(is_wildcard("evt.>"));
        assert!(is_wildcard("evt.*.created"));
        assert!(is_wildcard(">"));
        assert!(!is_wildcard("evt.created"));
        // a literal star inside a token is NOT a wildcard token
        assert!(!is_wildcard("evt.a*b"));
        // exact subjects are always cheap enough to count
        assert!(should_count("evt.created", 5_000_000));
        // wildcards are counted on small subject spaces, skipped on huge ones
        assert!(should_count("evt.>", SUBJECT_COUNT_SKIP_ABOVE));
        assert!(!should_count("evt.>", SUBJECT_COUNT_SKIP_ABOVE + 1));
    }

    #[test]
    fn initial_window_scales_with_sparsity() {
        // dense subject (every sequence): ~page_size * 1.5
        assert_eq!(initial_window(100, 1_000_000, 1_000_000), 150);
        // 10% of the stream: ~10x more sequences to cover one page
        assert_eq!(initial_window(100, 100_000, 1_000_000), 1_500);
        // 0.1% of the stream: ~1000x
        assert_eq!(initial_window(100, 1_000, 1_000_000), 150_000);
        // never smaller than the page itself
        assert_eq!(initial_window(100, 1_000_000, 100), 100);
        // empty subject → no division by zero
        assert_eq!(initial_window(100, 0, 4_242), 4_242);
    }

    #[test]
    fn probe_budget_covers_a_million_sequence_stream() {
        // doubling from the page floor must reach a 1M-sequence stream well inside
        // the budget (this is what bounds the search cost)
        let mut w = initial_window(100, 1_000, 1_000_000);
        let mut steps = 0;
        while w < 1_000_000 {
            w = w.saturating_mul(2);
            steps += 1;
        }
        assert!(steps < MAX_PAGE_PROBES, "{steps} doublings must stay under the probe budget");
    }

    // ---- stream-workspace:nats (W4) ----

    fn kv_info_json(storage: &str, max_bytes: i64, max_age_ns: u64, last_seq: u64) -> async_nats::jetstream::stream::Info {
        serde_json::from_value(serde_json::json!({
            "config": {
                "name": "KV_flags",
                "subjects": ["$KV.flags.>"],
                "retention": "limits",
                "max_consumers": -1,
                "max_msgs": -1,
                "max_bytes": max_bytes,
                "max_age": max_age_ns,
                "max_msgs_per_subject": 10,
                "max_msg_size": -1,
                "discard": "new",
                "storage": storage,
                "num_replicas": 3,
                "duplicate_window": 120_000_000_000u64,
                "description": "feature flags"
            },
            "created": "2026-10-21T08:00:00Z",
            "state": {
                "messages": 42,
                "bytes": 2048,
                "first_seq": 1,
                "first_ts": "2026-10-21T08:00:00Z",
                "last_seq": last_seq,
                "last_ts": "2026-10-21T09:30:00Z",
                "consumer_count": 0,
                "num_subjects": 7
            }
        }))
        .expect("stream info json")
    }

    #[test]
    fn kv_status_reads_bucket_settings_from_its_stream() {
        let s = kv_status_from_info("flags", &kv_info_json("memory", 1_048_576, 1_800_000_000_000, 42));
        assert_eq!(s.bucket, "flags");
        assert_eq!(s.keys, 7, "distinct keys = subjects of the stream");
        assert_eq!(s.values, 42, "values include earlier versions");
        assert_eq!(s.history, 10, "versions kept = max messages per subject");
        assert_eq!(s.max_age_ms, 1_800_000, "30 min");
        assert_eq!(s.max_bytes, Some(1_048_576));
        assert_eq!(s.max_value_size, None, "-1 = no per-value limit");
        assert_eq!(s.storage, "memory");
        assert_eq!(s.replicas, 3);
        assert_eq!(s.description.as_deref(), Some("feature flags"));
        assert_eq!(s.last_time, "2026-10-21T09:30:00Z");

        let unlimited = kv_status_from_info("flags", &kv_info_json("file", -1, 0, 0));
        assert_eq!(unlimited.max_bytes, None);
        assert_eq!(unlimited.max_age_ms, 0, "0 = never expire");
        assert_eq!(unlimited.storage, "file");
        assert_eq!(unlimited.last_time, "", "empty bucket has no last write");
    }

    #[test]
    fn stream_limits_keep_server_values_for_the_ui() {
        let l = stream_limits(&kv_info_json("file", 5_000, 3_600_000_000_000, 42));
        assert_eq!(l.max_age_ms, 3_600_000);
        assert_eq!(l.max_msgs, -1);
        assert_eq!(l.max_bytes, 5_000);
        assert_eq!(l.max_msgs_per_subject, 10);
        assert_eq!(l.replicas, 3);
        assert_eq!(l.discard, "new");
        assert_eq!(l.duplicate_window_ms, 120_000);
        assert_eq!((l.first_seq, l.last_seq), (1, 42));
        assert_eq!(l.subjects_count, 7);
        assert_eq!(l.created, "2026-10-21T08:00:00Z");
    }

    #[test]
    fn kv_create_config_clamps_and_maps_limits() {
        let req: KvCreate = serde_json::from_value(serde_json::json!({ "bucket": " flags ", "history": 500, "storage": "Memory", "max_age_secs": 60, "replicas": 9 })).unwrap();
        let c = kv_config_from(&req);
        assert_eq!(c.bucket, "flags");
        assert_eq!(c.history, 64, "server maximum");
        assert_eq!(c.max_age, std::time::Duration::from_secs(60));
        assert_eq!(c.max_bytes, -1, "no size limit unless asked");
        assert_eq!(c.num_replicas, 5);
        assert!(matches!(c.storage, async_nats::jetstream::stream::StorageType::Memory));

        let d: KvCreate = serde_json::from_value(serde_json::json!({ "bucket": "b", "history": 0 })).unwrap();
        let c = kv_config_from(&d);
        assert_eq!(c.history, 1);
        assert_eq!(c.num_replicas, 1);
        assert!(matches!(c.storage, async_nats::jetstream::stream::StorageType::File));
    }

    #[test]
    fn markers_and_limits_read_as_words() {
        use async_nats::jetstream::kv::Operation;
        assert_eq!(op_name(Operation::Put), "put");
        assert_eq!(op_name(Operation::Delete), "delete");
        assert_eq!(op_name(Operation::Purge), "purge");
        assert_eq!(limit_opt(-1), None);
        assert_eq!(limit_opt(0), None);
        assert_eq!(limit_opt(10), Some(10));
    }

    #[test]
    fn jetstream_off_is_recognised_not_reported_as_a_failure() {
        assert!(persistence_off("jetstream error: jetstream not enabled for account (code 503, error code 10039)"));
        assert!(persistence_off("jetstream unavailable"));
        assert!(persistence_off("no responders"));
        assert!(!persistence_off("timed out"));
        assert!(!persistence_off("authorization violation"));
        let d = NatsAccount::disabled("jetstream not enabled".into());
        assert!(!d.enabled);
        assert_eq!(d.reason.as_deref(), Some("jetstream not enabled"));
    }
}
