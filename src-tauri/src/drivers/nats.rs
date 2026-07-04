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
            .map_err(|e| err(format!("Không kết nối được NATS {url}"), e))
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
            .map_err(|e| err("Subscribe lỗi", e))
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
                .map_err(|e| err("Publish lỗi", e))?,
            None => self.client.publish(subject, bytes).await.map_err(|e| err("Publish lỗi", e))?,
        }
        self.client.flush().await.map_err(|e| err("Flush lỗi", e))?;
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
            .map_err(|e| err("Request lỗi", e))?;
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
            .map_err(|e| err("Tạo KV bucket lỗi", e))?;
        Ok(())
    }

    pub async fn kv_delete_bucket(&self, bucket: &str) -> Result<(), QueryError> {
        let js = async_nats::jetstream::new(self.client.clone());
        js.delete_key_value(bucket).await.map_err(|e| err("Xóa KV bucket lỗi", e))?;
        Ok(())
    }

    pub async fn kv_keys(&self, bucket: &str) -> Result<Vec<String>, QueryError> {
        use futures::StreamExt;
        let js = async_nats::jetstream::new(self.client.clone());
        let store = js.get_key_value(bucket).await.map_err(|e| err("Get KV bucket lỗi", e))?;
        let mut keys = store.keys().await.map_err(|e| err("KV keys lỗi", e))?;
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
        let store = js.get_key_value(bucket).await.map_err(|e| err("Get KV bucket lỗi", e))?;
        let v = store.get(key).await.map_err(|e| err("KV get lỗi", e))?;
        Ok(v.map(|b| String::from_utf8_lossy(&b).into_owned()))
    }

    pub async fn kv_put(&self, bucket: &str, key: &str, value: String) -> Result<(), QueryError> {
        let js = async_nats::jetstream::new(self.client.clone());
        let store = js.get_key_value(bucket).await.map_err(|e| err("Get KV bucket lỗi", e))?;
        store.put(key, value.into_bytes().into()).await.map_err(|e| err("KV put lỗi", e))?;
        Ok(())
    }

    pub async fn kv_delete(&self, bucket: &str, key: &str) -> Result<(), QueryError> {
        let js = async_nats::jetstream::new(self.client.clone());
        let store = js.get_key_value(bucket).await.map_err(|e| err("Get KV bucket lỗi", e))?;
        store.delete(key).await.map_err(|e| err("KV delete lỗi", e))?;
        Ok(())
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
            .map_err(|e| err("Tạo Object bucket lỗi", e))?;
        Ok(())
    }

    pub async fn obj_delete_bucket(&self, bucket: &str) -> Result<(), QueryError> {
        let js = async_nats::jetstream::new(self.client.clone());
        js.delete_object_store(bucket).await.map_err(|e| err("Xóa Object bucket lỗi", e))?;
        Ok(())
    }

    /// List objects trong bucket (name/size/chunks).
    pub async fn obj_list(&self, bucket: &str) -> Result<Vec<ObjInfo>, QueryError> {
        use futures::StreamExt;
        let js = async_nats::jetstream::new(self.client.clone());
        let store = js.get_object_store(bucket).await.map_err(|e| err("Get Object bucket lỗi", e))?;
        let mut list = store.list().await.map_err(|e| err("Object list lỗi", e))?;
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
        let store = js.get_object_store(bucket).await.map_err(|e| err("Get Object bucket lỗi", e))?;
        let bytes = tokio::fs::read(path).await.map_err(|e| err(format!("Đọc file {path} lỗi"), e))?;
        let mut slice: &[u8] = &bytes;
        store.put(name.as_str(), &mut slice).await.map_err(|e| err("Object put lỗi", e))?;
        Ok(())
    }

    /// Download object ra path file thật.
    pub async fn obj_get_file(&self, bucket: &str, name: &str, path: &str) -> Result<(), QueryError> {
        use tokio::io::AsyncReadExt;
        let js = async_nats::jetstream::new(self.client.clone());
        let store = js.get_object_store(bucket).await.map_err(|e| err("Get Object bucket lỗi", e))?;
        let mut obj = store.get(name).await.map_err(|e| err("Object get lỗi", e))?;
        let mut buf = Vec::new();
        obj.read_to_end(&mut buf).await.map_err(|e| err("Đọc object lỗi", e))?;
        tokio::fs::write(path, buf).await.map_err(|e| err(format!("Ghi file {path} lỗi"), e))?;
        Ok(())
    }

    pub async fn obj_delete(&self, bucket: &str, name: &str) -> Result<(), QueryError> {
        let js = async_nats::jetstream::new(self.client.clone());
        let store = js.get_object_store(bucket).await.map_err(|e| err("Get Object bucket lỗi", e))?;
        store.delete(name).await.map_err(|e| err("Object delete lỗi", e))?;
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
        while let Some(info) = infos.try_next().await.map_err(|e| err("List streams lỗi", e))? {
            out.push(JsStream {
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
        let s = js.get_stream(stream).await.map_err(|e| err("Get stream lỗi", e))?;
        let mut out = Vec::new();
        let mut cons = s.consumers();
        while let Some(ci) = cons.try_next().await.map_err(|e| err("List consumers lỗi", e))? {
            out.push(JsConsumer {
                name: ci.name,
                deliver_policy: format!("{:?}", ci.config.deliver_policy),
                ack_policy: format!("{:?}", ci.config.ack_policy),
                filter_subject: ci.config.filter_subject,
                num_pending: ci.num_pending,
                num_ack_pending: ci.num_ack_pending as u64,
            });
        }
        Ok(out)
    }

    /// Tạo stream (subjects, retention/storage mặc định Limits/File).
    pub async fn js_create_stream(&self, name: String, subjects: Vec<String>) -> Result<(), QueryError> {
        let js = async_nats::jetstream::new(self.client.clone());
        js.create_stream(async_nats::jetstream::stream::Config { name, subjects, ..Default::default() })
            .await
            .map_err(|e| err("Tạo stream lỗi", e))?;
        Ok(())
    }

    /// Xóa stream.
    pub async fn js_delete_stream(&self, name: &str) -> Result<(), QueryError> {
        let js = async_nats::jetstream::new(self.client.clone());
        js.delete_stream(name).await.map_err(|e| err("Xóa stream lỗi", e))?;
        Ok(())
    }

    /// Purge toàn bộ message của stream.
    pub async fn js_purge_stream(&self, name: &str) -> Result<(), QueryError> {
        let js = async_nats::jetstream::new(self.client.clone());
        let stream = js.get_stream(name).await.map_err(|e| err("Get stream lỗi", e))?;
        stream.purge().await.map_err(|e| err("Purge stream lỗi", e))?;
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
        let s = js.get_stream(stream).await.map_err(|e| err("Get stream lỗi", e))?;
        s.create_consumer(async_nats::jetstream::consumer::pull::Config {
            durable_name: Some(durable),
            filter_subject: filter,
            ..Default::default()
        })
        .await
        .map_err(|e| err("Tạo consumer lỗi", e))?;
        Ok(())
    }

    /// Xóa consumer của stream.
    pub async fn js_delete_consumer(&self, stream: &str, name: &str) -> Result<(), QueryError> {
        let js = async_nats::jetstream::new(self.client.clone());
        let s = js.get_stream(stream).await.map_err(|e| err("Get stream lỗi", e))?;
        s.delete_consumer(name).await.map_err(|e| err("Xóa consumer lỗi", e))?;
        Ok(())
    }

    /// Xóa 1 message theo sequence.
    pub async fn js_delete_message(&self, stream: &str, seq: u64) -> Result<(), QueryError> {
        let js = async_nats::jetstream::new(self.client.clone());
        let s = js.get_stream(stream).await.map_err(|e| err("Get stream lỗi", e))?;
        s.delete_message(seq).await.map_err(|e| err("Xóa message lỗi", e))?;
        Ok(())
    }

    /// Peek message theo sequence number.
    pub async fn js_peek(&self, stream: &str, seq: u64) -> Result<JsMessage, QueryError> {
        let js = async_nats::jetstream::new(self.client.clone());
        let s = js.get_stream(stream).await.map_err(|e| err("Get stream lỗi", e))?;
        let raw = s.get_raw_message(seq).await.map_err(|e| err(format!("Peek seq {seq} lỗi"), e))?;
        Ok(JsMessage {
            seq: raw.sequence,
            subject: raw.subject.to_string(),
            payload: String::from_utf8_lossy(&raw.payload).into_owned(),
            time: raw.time.to_string(),
        })
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
}

#[derive(Debug, serde::Serialize)]
pub struct JsConsumer {
    pub name: String,
    pub deliver_policy: String,
    pub ack_policy: String,
    pub filter_subject: String,
    pub num_pending: u64,
    pub num_ack_pending: u64,
}

#[derive(Debug, serde::Serialize)]
pub struct JsMessage {
    pub seq: u64,
    pub subject: String,
    pub payload: String,
    pub time: String,
}

#[derive(Debug, serde::Serialize)]
pub struct ObjInfo {
    pub name: String,
    pub size: u64,
    pub chunks: u64,
}
