//! Kafka driver (Phase 4) — rdkafka bọc librdkafka. Không phải SQL: metadata +
//! consume/produce + consumer groups + admin. librdkafka build KHÔNG có SSL nên
//! chỉ PLAINTEXT + SASL/PLAIN (SASL_SSL/SCRAM là hạn chế đã ghi nhận).
//!
//! Các lệnh metadata/admin của rdkafka là blocking → bọc spawn_blocking.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use rdkafka::admin::{AdminClient, AdminOptions, NewTopic, TopicReplication};
use rdkafka::client::DefaultClientContext;
use rdkafka::config::ClientConfig;
use rdkafka::consumer::{BaseConsumer, Consumer, ConsumerContext};
use rdkafka::message::{Headers, Message};
use rdkafka::producer::{FutureProducer, FutureRecord};
use rdkafka::{Offset, TopicPartitionList};

use crate::drivers::types::TestResult;
use crate::error::QueryError;

const META_TIMEOUT: Duration = Duration::from_secs(10);
/// Trần cho MỘT lần hỏi watermark của một partition. Rộng rãi hơn 2s của bản cũ vì
/// giờ các lượt hỏi chạy song song (một partition chậm không còn cộng dồn vào tổng),
/// và 2s là quá ngắn cho broker ở xa / đi qua SSH tunnel — hết giờ là mất số đếm.
const WATERMARK_TIMEOUT: Duration = Duration::from_secs(15);
/// Số luồng hỏi watermark song song.
const WATERMARK_THREADS: usize = 16;
/// Mặc định "Recent": số message mới nhất lấy về khi mở một topic.
pub const RECENT_DEFAULT: i64 = 500;

/// Watermark (low, high) cho nhiều partition + **lỗi đầu tiên gặp phải** (nếu có).
///
/// Dùng `fetch_watermarks` (rd_kafka_query_watermark_offsets) — API DUY NHẤT có ngữ
/// nghĩa không mập mờ — nhưng chạy **song song nhiều luồng** thay vì nối đuôi, nên vẫn
/// nhanh hơn hẳn đường cũ. Cách gộp bằng `offsets_for_times` với sentinel timestamp
/// (−2 earliest / −1 latest) tuy nhanh hơn nữa nhưng **KHÔNG đáng tin giữa các broker**:
/// broker nào không đặc-biệt-hoá sentinel sẽ hiểu chúng là mốc thời gian thật, trả về
/// "message đầu tiên có ts ≥ mốc" cho CẢ HAI đầu ⇒ `low == high` ⇒ mọi topic đếm ra
/// **0 message** dù còn đầy dữ liệu, mà cả hai giá trị đều là offset hợp lệ nên không
/// một guard nào bắt được. Đã đổi lấy độ đúng.
///
/// Lỗi KHÔNG bị nuốt: partition nào không đọc được watermark sẽ vắng mặt trong map và
/// lý do được trả về để giao diện hiện "? msg + vì sao", thay vì im lặng ra 0.
fn watermarks<C: ConsumerContext + 'static>(
    consumer: &Arc<BaseConsumer<C>>,
    parts: &[(String, i32)],
) -> (HashMap<(String, i32), (i64, i64)>, Option<String>) {
    let mut out = HashMap::new();
    if parts.is_empty() {
        return (out, None);
    }
    let lanes = WATERMARK_THREADS.min(parts.len());
    let mut chunks: Vec<Vec<&(String, i32)>> = (0..lanes).map(|_| Vec::new()).collect();
    for (i, item) in parts.iter().enumerate() {
        chunks[i % lanes].push(item);
    }
    let mut first_err: Option<String> = None;
    std::thread::scope(|scope| {
        let mut handles = Vec::new();
        for chunk in chunks {
            let c = Arc::clone(consumer);
            handles.push(scope.spawn(move || {
                let mut acc = Vec::with_capacity(chunk.len());
                let mut err = None;
                for (t, p) in chunk {
                    match c.fetch_watermarks(t, *p, WATERMARK_TIMEOUT) {
                        Ok(w) => acc.push(((t.clone(), *p), w)),
                        Err(e) if err.is_none() => err = Some(format!("{t}[{p}]: {e}")),
                        Err(_) => {}
                    }
                }
                (acc, err)
            }));
        }
        for h in handles {
            if let Ok((acc, err)) = h.join() {
                out.extend(acc);
                if first_err.is_none() {
                    first_err = err;
                }
            }
        }
    });
    (out, first_err)
}

/// Giải thích vì sao không đọc được watermark, dựa trên metadata của chính cluster.
///
/// `NotLeaderForPartition` gần như luôn có nghĩa: yêu cầu ListOffsets đi tới broker
/// KHÔNG phải leader của partition đó — tức máy này chỉ với tới được một phần cluster.
/// Có đúng hai kiểu, và metadata phân biệt được:
///
/// 1. **Mọi broker cùng một địa chỉ** nhưng khác `node_id` — dấu hiệu của cluster nhiều
///    broker đi qua MỘT SSH tunnel: proxy ghi đè mọi broker thành `127.0.0.1:<cổng tunnel>`
///    nên request nào cũng rơi vào đúng một broker (giới hạn đã ghi trong `tunnel.rs`).
/// 2. **Các broker có địa chỉ khác nhau** — leader nằm ở địa chỉ máy này không kết nối tới
///    được (advertised.listeners nội bộ / firewall).
pub fn diagnose_offsets_failure(
    brokers: &[(i32, String, i32)],
    leader: Option<i32>,
    raw: &str,
) -> String {
    let collapsed = brokers.len() > 1
        && brokers.windows(2).all(|w| w[0].1 == w[1].1 && w[0].2 == w[1].2);
    if collapsed {
        let (_, host, port) = &brokers[0];
        return format!(
            "{raw} · This cluster reports {} brokers but metadata advertises the same address \
             {host}:{port} for all of them, so only one broker is actually reachable — partitions \
             led by the others cannot be read. (A multi-broker cluster behind a single SSH tunnel \
             hits exactly this; the tunnel needs one local port per broker.)",
            brokers.len()
        );
    }
    match leader.and_then(|l| brokers.iter().find(|b| b.0 == l).map(|b| (l, &b.1, b.2))) {
        Some((id, host, port)) => format!(
            "{raw} · The partition leader is broker {id} at {host}:{port} — that address must be \
             reachable from this machine."
        ),
        None => match leader {
            Some(id) => format!("{raw} · The partition leader (broker {id}) is not in the cluster metadata."),
            None => raw.to_string(),
        },
    }
}

pub struct KafkaDriver {
    /// Consumer dùng cho metadata + (sau) consume. Arc để clone vào spawn_blocking.
    consumer: Arc<BaseConsumer>,
    /// Config gốc để tạo producer / admin client khi cần.
    config: ClientConfig,
}

pub struct KafkaConnParams {
    /// bootstrap servers, phân tách bởi dấu phẩy: host:port,host:port
    pub bootstrap: String,
    /// "" (none) | "PLAIN" | "SCRAM-SHA-256" | "SCRAM-SHA-512"
    pub sasl_mechanism: String,
    pub user: String,
    pub password: String,
    pub ssl: bool,
}

fn err(msg: impl Into<String>, raw: impl std::fmt::Display) -> QueryError {
    QueryError::new("kafka", msg.into(), raw.to_string())
}

impl KafkaDriver {
    pub fn build_config(p: &KafkaConnParams) -> ClientConfig {
        let mut c = ClientConfig::new();
        c.set("bootstrap.servers", &p.bootstrap);
        // security.protocol theo auth/ssl (SSL thật cần librdkafka có OpenSSL — hạn chế)
        if !p.sasl_mechanism.is_empty() {
            c.set("security.protocol", if p.ssl { "SASL_SSL" } else { "SASL_PLAINTEXT" });
            c.set("sasl.mechanism", &p.sasl_mechanism);
            c.set("sasl.username", &p.user);
            c.set("sasl.password", &p.password);
        } else if p.ssl {
            c.set("security.protocol", "SSL");
        }
        c
    }

    pub async fn connect(p: &KafkaConnParams) -> Result<Self, QueryError> {
        let config = Self::build_config(p);
        let consumer: BaseConsumer = config
            .create()
            .map_err(|e| err("Failed to create Kafka consumer", e))?;
        let consumer = Arc::new(consumer);
        // xác nhận broker bằng fetch_metadata (blocking → spawn_blocking)
        let c = consumer.clone();
        tokio::task::spawn_blocking(move || c.fetch_metadata(None, META_TIMEOUT))
            .await
            .map_err(|e| err("spawn_blocking error", e))?
            .map_err(|e| err("Failed to fetch metadata (broker unreachable?)", e))?;
        Ok(Self { consumer, config })
    }

    pub async fn test(p: &KafkaConnParams) -> TestResult {
        let started = Instant::now();
        match Self::connect(p).await {
            Ok(mut drv) => {
                let brokers = drv.broker_count().await.unwrap_or(0);
                TestResult {
                    ok: true,
                    latency_ms: Some(started.elapsed().as_millis() as u64),
                    server_version: Some(format!("Kafka · {brokers} broker(s)")),
                    error: None,
                }
            }
            Err(e) => TestResult { ok: false, latency_ms: None, server_version: None, error: Some(e.message) },
        }
    }

    pub async fn ping(&mut self) -> bool {
        let c = self.consumer.clone();
        tokio::task::spawn_blocking(move || c.fetch_metadata(None, Duration::from_secs(5)))
            .await
            .map(|r| r.is_ok())
            .unwrap_or(false)
    }

    async fn broker_count(&mut self) -> Result<usize, QueryError> {
        let c = self.consumer.clone();
        let md = tokio::task::spawn_blocking(move || c.fetch_metadata(None, META_TIMEOUT))
            .await
            .map_err(|e| err("spawn_blocking error", e))?
            .map_err(|e| err("fetch_metadata error", e))?;
        Ok(md.brokers().len())
    }

    /// Consumer + config để các thao tác Phase 4 sau dùng lại.
    pub fn consumer(&self) -> Arc<BaseConsumer> {
        self.consumer.clone()
    }
    pub fn config(&self) -> ClientConfig {
        self.config.clone()
    }

    // ---- cluster overview (T2) ----------------------------------------------

    /// Broker list + tổng topic/partition (controller = orig broker của metadata).
    pub async fn cluster_info(&self) -> Result<KafkaCluster, QueryError> {
        let c = self.consumer.clone();
        let md = tokio::task::spawn_blocking(move || c.fetch_metadata(None, META_TIMEOUT))
            .await
            .map_err(|e| err("spawn_blocking error", e))?
            .map_err(|e| err("fetch_metadata error", e))?;
        let brokers: Vec<KafkaBroker> = md
            .brokers()
            .iter()
            .map(|b| KafkaBroker { id: b.id(), host: b.host().to_string(), port: b.port() as i32 })
            .collect();
        let topics: Vec<_> = md.topics().iter().filter(|t| t.error().is_none()).collect();
        let partition_count: usize = topics.iter().map(|t| t.partitions().len()).sum();
        Ok(KafkaCluster {
            brokers,
            controller_id: md.orig_broker_id(),
            topic_count: topics.len(),
            partition_count,
        })
    }

    // ---- topic browser (T3) -------------------------------------------------

    /// List topics + partitions (leader/replicas/isr) + watermark offsets + lag.
    pub async fn topics(&self) -> Result<Vec<KafkaTopic>, QueryError> {
        let c = self.consumer.clone();
        let out = tokio::task::spawn_blocking(move || -> Result<Vec<KafkaTopic>, String> {
            let md = c.fetch_metadata(None, META_TIMEOUT).map_err(|e| e.to_string())?;
            // Watermark offsets (earliest/latest) → lag. Hỏi song song (xem `watermarks`).
            let targets: Vec<(String, i32)> = md
                .topics()
                .iter()
                .filter(|t| t.error().is_none())
                .flat_map(|t| t.partitions().iter().map(move |p| (t.name().to_string(), p.id())))
                .collect();
            let (marks, offsets_error) = watermarks(&c, &targets);
            // đủ dữ liệu để giải thích thất bại thay vì ném nguyên lỗi librdkafka ra
            let broker_list: Vec<(i32, String, i32)> = md
                .brokers()
                .iter()
                .map(|b| (b.id(), b.host().to_string(), b.port()))
                .collect();
            let mut topics = Vec::new();
            for t in md.topics() {
                if t.error().is_some() {
                    continue;
                }
                let mut parts = Vec::new();
                // partition nào KHÔNG đọc được watermark thì đánh dấu "không biết"
                // (offsets_known = false) chứ không được lặng lẽ đếm thành 0 message
                let mut offsets_known = true;
                let mut failed_leader = None;
                for p in t.partitions() {
                    let (low, high) = match marks.get(&(t.name().to_string(), p.id())).copied() {
                        Some(w) => w,
                        None => {
                            offsets_known = false;
                            failed_leader.get_or_insert(p.leader());
                            (0, 0)
                        }
                    };
                    parts.push(KafkaPartition {
                        id: p.id(),
                        leader: p.leader(),
                        replicas: p.replicas().to_vec(),
                        isr: p.isr().to_vec(),
                        low,
                        high,
                        lag: (high - low).max(0),
                    });
                }
                let internal = t.name().starts_with("__");
                topics.push(KafkaTopic {
                    name: t.name().to_string(),
                    partitions: parts,
                    offsets_known,
                    offsets_error: if offsets_known {
                        None
                    } else {
                        Some(diagnose_offsets_failure(
                            &broker_list,
                            failed_leader,
                            offsets_error.as_deref().unwrap_or("the broker did not report offsets"),
                        ))
                    },
                    internal,
                });
            }
            Ok(topics)
        })
        .await
        .map_err(|e| err("spawn_blocking error", e))?
        .map_err(|e| err("List topics error", e))?;
        Ok(out)
    }
}

impl KafkaDriver {
    /// Tạo BaseConsumer để DUYỆT message: assign trực tiếp partitions (KHÔNG
    /// subscribe consumer-group). Dùng BaseConsumer + poll trong OS thread riêng
    /// (StreamConsumer async close deadlock nếu ngừng poll — rdkafka gotcha).
    /// from: "earliest" | "latest" | "offset". partition None = tất cả partitions.
    pub fn browse_consumer<C: ConsumerContext + 'static>(
        &self,
        topic: &str,
        from: &str,
        offset: i64,
        partition: Option<i32>,
        context: C,
    ) -> Result<BaseConsumer<C>, QueryError> {
        let mut cfg = self.config.clone();
        cfg.set("group.id", format!("dbstudio-browse-{}", uuid::Uuid::new_v4()));
        cfg.set("enable.auto.commit", "false");
        // Emit a PartitionEOF when a partition is drained so the UI can tell
        // "reached end (topic empty / all read)" apart from "can't fetch".
        cfg.set("enable.partition.eof", "true");
        let consumer: BaseConsumer<C> =
            cfg.create_with_context(context).map_err(|e| err("Failed to create BaseConsumer", e))?;

        let partitions: Vec<i32> = match partition {
            Some(p) => vec![p],
            None => {
                let md = self
                    .consumer
                    .fetch_metadata(Some(topic), META_TIMEOUT)
                    .map_err(|e| err("fetch_metadata (partitions) error", e))?;
                md.topics()
                    .iter()
                    .find(|t| t.name() == topic)
                    .map(|t| t.partitions().iter().map(|p| p.id()).collect())
                    .unwrap_or_default()
            }
        };
        let mut tpl = TopicPartitionList::new();
        if from == "recent" {
            // "N message mới nhất": bắt đầu ở high − N/số-partition thay vì đọc lại từ
            // đầu log. Mở một topic vài triệu message vì thế không phải kéo cả log về
            // (UI chỉ giữ được vài trăm dòng gần nhất). Watermark lấy gộp 1 lượt.
            // MỖI partition lùi lại `want` message (không chia đều): dữ liệu Kafka
            // thường dồn theo key vào vài partition, chia đều thì partition đông dữ
            // liệu chỉ hiện được một phần nhỏ — tệ hơn nữa là cửa sổ đuôi có thể
            // KHÔNG chứa message hiển thị được nào (log compaction, control record
            // của transaction chiếm offset) và giao diện tưởng topic rỗng.
            let per = if offset > 0 { offset } else { RECENT_DEFAULT };
            let targets: Vec<(String, i32)> =
                partitions.iter().map(|p| (topic.to_string(), *p)).collect();
            let (marks, _) = watermarks(&self.consumer, &targets);
            for p in partitions {
                let start = match marks.get(&(topic.to_string(), p)) {
                    Some((low, high)) => Offset::Offset((high - per).max(*low)),
                    // Không đọc nổi watermark kể cả sau khi hỏi riêng: đọc từ ĐẦU log.
                    // Tuyệt đối không dùng Offset::End ở đây — nó đọc về 0 message và
                    // topic có dữ liệu sẽ bị báo là rỗng.
                    None => Offset::Beginning,
                };
                tpl.add_partition_offset(topic, p, start).map_err(|e| err("TPL error", e))?;
            }
        } else {
            let off = match from {
                "offset" => Offset::Offset(offset),
                "latest" => Offset::End,
                _ => Offset::Beginning,
            };
            for p in partitions {
                tpl.add_partition_offset(topic, p, off).map_err(|e| err("TPL error", e))?;
            }
        }
        consumer.assign(&tpl).map_err(|e| err("assign error", e))?;
        Ok(consumer)
    }

    /// Tổng message CÒN GIỮ LẠI trên các partition đang duyệt (Σ high − low).
    ///
    /// Dùng để nói đúng "topic không có message" thay vì suy ra từ "duyệt xong mà
    /// không nhận được gì" — hai chuyện đó khác nhau: cửa sổ đuôi log có thể không
    /// chứa message hiển thị được (compaction, control record) trong khi topic vẫn
    /// còn đầy dữ liệu ở offset thấp hơn.
    pub fn retained_messages(&self, topic: &str, partitions: &[i32]) -> (i64, Option<String>) {
        let targets: Vec<(String, i32)> =
            partitions.iter().map(|p| (topic.to_string(), *p)).collect();
        let (marks, err) = watermarks(&self.consumer, &targets);
        // thiếu bất kỳ partition nào ⇒ tổng KHÔNG đáng tin ⇒ trả -1 (không biết)
        if marks.len() < targets.len() {
            return (-1, err);
        }
        (marks.values().map(|(l, h)| (h - l).max(0)).sum(), None)
    }

    /// Đọc MỘT TRANG message: cửa sổ `[start, end)` của mỗi partition, với
    /// `end = until` (hoặc high watermark khi `until < 0` = trang mới nhất) và
    /// `start = max(low, end − limit)`.
    ///
    /// Khác `browse_consumer` (stream không giới hạn): đọc đúng một cửa sổ có biên rồi
    /// dừng, nên mở một topic khổng lồ không kéo cả log về. Consumer tạo riêng cho lần
    /// đọc này và được drop ngay trong thread blocking (rdkafka phải drop trong đúng
    /// thread poll của nó).
    pub async fn fetch_page(
        &self,
        topic: &str,
        partition: Option<i32>,
        until: i64,
        limit: i64,
    ) -> Result<KafkaPage, QueryError> {
        let meta = self.consumer.clone();
        let cfg = self.config.clone();
        let topic = topic.to_string();
        let limit = limit.clamp(1, 5_000);
        let page = tokio::task::spawn_blocking(move || -> Result<KafkaPage, String> {
            // Metadata luôn được đọc (không chỉ khi partition = None) để còn giải thích
            // được thất bại: cần danh sách broker + leader của partition hỏng.
            let md = meta.fetch_metadata(Some(&topic), META_TIMEOUT).map_err(|e| e.to_string())?;
            let md_topic = md.topics().iter().find(|t| t.name() == topic);
            let parts: Vec<i32> = match partition {
                Some(p) => vec![p],
                None => md_topic
                    .map(|t| t.partitions().iter().map(|p| p.id()).collect())
                    .unwrap_or_default(),
            };
            let broker_list: Vec<(i32, String, i32)> =
                md.brokers().iter().map(|b| (b.id(), b.host().to_string(), b.port())).collect();
            let leader_of = |id: i32| -> Option<i32> {
                md_topic
                    .and_then(|t| t.partitions().iter().find(|p| p.id() == id))
                    .map(|p| p.leader())
            };
            let targets: Vec<(String, i32)> =
                parts.iter().map(|p| (topic.clone(), *p)).collect();
            let (marks, offsets_error) = watermarks(&meta, &targets);

            let mut tpl = TopicPartitionList::new();
            let mut window: HashMap<i32, (i64, i64)> = HashMap::new();
            let mut retained = 0i64;
            let mut window_start = i64::MAX;
            let mut has_older = false;
            let mut at_newest = true;
            let mut known = false;
            for p in &parts {
                let Some((low, high)) = marks.get(&(topic.clone(), *p)).copied() else {
                    continue; // không biết watermark → bỏ qua partition này, không đoán
                };
                known = true;
                retained += (high - low).max(0);
                let end = if until < 0 { high } else { until.min(high) };
                let start = (end - limit).max(low);
                if start > low {
                    has_older = true;
                }
                if end < high {
                    at_newest = false;
                }
                window_start = window_start.min(start);
                if end > start {
                    window.insert(*p, (start, end));
                    tpl.add_partition_offset(&topic, *p, Offset::Offset(start))
                        .map_err(|e| e.to_string())?;
                }
            }
            // thiếu watermark của bất kỳ partition nào ⇒ tổng KHÔNG đáng tin
            let all_known = known && marks.len() == parts.len();
            let mut page = KafkaPage {
                msgs: Vec::new(),
                retained: if all_known { retained } else { -1 },
                window_start: if window_start == i64::MAX { 0 } else { window_start },
                has_older,
                at_newest,
                offsets_error: if all_known {
                    None
                } else {
                    let failed = parts.iter().find(|p| !marks.contains_key(&(topic.clone(), **p)));
                    Some(diagnose_offsets_failure(
                        &broker_list,
                        failed.and_then(|p| leader_of(*p)),
                        offsets_error.as_deref().unwrap_or("the broker did not report offsets"),
                    ))
                },
            };
            if tpl.count() == 0 {
                return Ok(page); // cửa sổ rỗng (topic rỗng, hoặc đã ở đầu log)
            }

            let mut cfg = cfg;
            cfg.set("group.id", format!("dbstudio-page-{}", uuid::Uuid::new_v4()));
            cfg.set("enable.auto.commit", "false");
            cfg.set("enable.partition.eof", "true");
            let consumer: BaseConsumer = cfg.create().map_err(|e| e.to_string())?;
            consumer.assign(&tpl).map_err(|e| e.to_string())?;

            let deadline = Instant::now() + Duration::from_secs(30);
            let mut done: std::collections::HashSet<i32> = std::collections::HashSet::new();
            while Instant::now() < deadline && done.len() < window.len() {
                match consumer.poll(Duration::from_millis(300)) {
                    Some(Ok(m)) => {
                        let p = m.partition();
                        let off = m.offset();
                        if let Some((_s, end)) = window.get(&p) {
                            if off < *end {
                                page.msgs.push(borrowed_to_message(&m));
                            }
                            if off + 1 >= *end {
                                done.insert(p);
                            }
                        }
                    }
                    Some(Err(rdkafka::error::KafkaError::PartitionEOF(p))) => {
                        done.insert(p);
                    }
                    _ => {}
                }
            }
            drop(consumer); // drop trong đúng thread poll

            // mới nhất lên đầu, đúng thứ tự lưới đang hiển thị
            page.msgs.sort_by(|a, b| {
                b.timestamp.cmp(&a.timestamp).then(b.offset.cmp(&a.offset))
            });
            page.msgs.truncate(limit as usize);
            Ok(page)
        })
        .await
        .map_err(|e| err("spawn_blocking error", e))?
        .map_err(|e| err("Failed to read messages", e))?;
        Ok(page)
    }

    /// Produce 1 message → (partition, offset) đã land.
    pub async fn produce(
        &self,
        topic: &str,
        key: &str,
        value: &str,
        partition: Option<i32>,
    ) -> Result<(i32, i64), QueryError> {
        let producer: FutureProducer =
            self.config.create().map_err(|e| err("Failed to create producer", e))?;
        let mut record = FutureRecord::to(topic).payload(value);
        if !key.is_empty() {
            record = record.key(key);
        }
        if let Some(p) = partition {
            record = record.partition(p);
        }
        producer
            .send(record, Duration::from_secs(15))
            .await
            .map(|d| (d.partition, d.offset))
            .map_err(|(e, _)| err("Produce error", e))
    }

    // ---- consumer groups (T6) -----------------------------------------------

    /// List consumer groups + members (id/client/host).
    pub async fn consumer_groups(&self) -> Result<Vec<KafkaGroup>, QueryError> {
        let c = self.consumer.clone();
        let out = tokio::task::spawn_blocking(move || -> Result<Vec<KafkaGroup>, String> {
            let gl = c.fetch_group_list(None, META_TIMEOUT).map_err(|e| e.to_string())?;
            let mut groups = Vec::new();
            for g in gl.groups() {
                let members = g
                    .members()
                    .iter()
                    .map(|m| KafkaMember {
                        member_id: m.id().to_string(),
                        client_id: m.client_id().to_string(),
                        host: m.client_host().to_string(),
                    })
                    .collect();
                groups.push(KafkaGroup {
                    name: g.name().to_string(),
                    state: g.state().to_string(),
                    protocol: g.protocol().to_string(),
                    members,
                });
            }
            Ok(groups)
        })
        .await
        .map_err(|e| err("spawn_blocking error", e))?
        .map_err(|e| err("fetch_group_list error", e))?;
        Ok(out)
    }

    /// Lag per topic-partition của 1 group: committed offset vs high watermark.
    /// Chỉ trả các partition group đã commit (committed >= 0).
    pub async fn group_lag(&self, group: String) -> Result<Vec<KafkaLag>, QueryError> {
        let cfg = self.config.clone();
        let meta = self.consumer.clone();
        let out = tokio::task::spawn_blocking(move || -> Result<Vec<KafkaLag>, String> {
            // TPL tất cả partition của topic non-internal
            let md = meta.fetch_metadata(None, META_TIMEOUT).map_err(|e| e.to_string())?;
            let mut tpl = TopicPartitionList::new();
            for t in md.topics() {
                if t.name().starts_with("__") {
                    continue;
                }
                for p in t.partitions() {
                    tpl.add_partition(t.name(), p.id());
                }
            }
            // consumer với group.id = group để lấy committed offsets
            let mut gcfg = cfg;
            gcfg.set("group.id", &group);
            let gc: BaseConsumer = gcfg.create().map_err(|e| e.to_string())?;
            let committed = gc.committed_offsets(tpl, META_TIMEOUT).map_err(|e| e.to_string())?;
            // high watermark của các partition group đã commit — lấy GỘP (2 request)
            // thay vì hỏi tuần tự từng partition như trước.
            let need: Vec<(String, i32)> = committed
                .elements()
                .iter()
                .filter(|e| matches!(e.offset(), rdkafka::Offset::Offset(_)))
                .map(|e| (e.topic().to_string(), e.partition()))
                .collect();
            let gc = Arc::new(gc);
            let (marks, _) = watermarks(&gc, &need);
            let mut out = Vec::new();
            for elem in committed.elements() {
                let off = match elem.offset() {
                    rdkafka::Offset::Offset(o) => o,
                    _ => continue, // group chưa commit partition này
                };
                let (_low, high) = match marks.get(&(elem.topic().to_string(), elem.partition())) {
                    Some(w) => *w,
                    // gộp không ra số → hỏi riêng partition đó (giữ hành vi cũ)
                    None => gc
                        .fetch_watermarks(elem.topic(), elem.partition(), Duration::from_secs(5))
                        .unwrap_or((0, off)),
                };
                out.push(KafkaLag {
                    topic: elem.topic().to_string(),
                    partition: elem.partition(),
                    committed: off,
                    high,
                    lag: (high - off).max(0),
                });
            }
            Ok(out)
        })
        .await
        .map_err(|e| err("spawn_blocking error", e))?
        .map_err(|e| err("group_lag error", e))?;
        Ok(out)
    }

    /// Reset offset của group cho 1 topic-partition → target (earliest/latest/offset).
    /// Chỉ chạy được khi group KHÔNG có member active (Kafka từ chối commit lúc active).
    pub async fn reset_group_offset(
        &self,
        group: String,
        topic: String,
        partition: i32,
        target: String,
        offset: i64,
    ) -> Result<(), QueryError> {
        let cfg = self.config.clone();
        let meta = self.consumer.clone();
        tokio::task::spawn_blocking(move || -> Result<(), String> {
            // xác định offset đích
            let target_off = match target.as_str() {
                "offset" => offset,
                "latest" => {
                    let (_l, h) = meta
                        .fetch_watermarks(&topic, partition, Duration::from_secs(5))
                        .map_err(|e| e.to_string())?;
                    h
                }
                _ => {
                    let (l, _h) = meta
                        .fetch_watermarks(&topic, partition, Duration::from_secs(5))
                        .map_err(|e| e.to_string())?;
                    l
                }
            };
            let mut gcfg = cfg;
            gcfg.set("group.id", &group);
            let gc: BaseConsumer = gcfg.create().map_err(|e| e.to_string())?;
            let mut tpl = TopicPartitionList::new();
            tpl.add_partition_offset(&topic, partition, rdkafka::Offset::Offset(target_off))
                .map_err(|e| e.to_string())?;
            gc.commit(&tpl, rdkafka::consumer::CommitMode::Sync).map_err(|e| e.to_string())?;
            Ok(())
        })
        .await
        .map_err(|e| err("spawn_blocking error", e))?
        .map_err(|e| err("reset offset error (group active?)", e))?;
        Ok(())
    }

    /// Tạo topic (admin) — partitions + replication factor.
    pub async fn create_topic(&self, name: &str, partitions: i32, replication: i32) -> Result<(), QueryError> {
        let admin: AdminClient<DefaultClientContext> =
            self.config.create().map_err(|e| err("Failed to create admin client", e))?;
        let nt = NewTopic::new(name, partitions, TopicReplication::Fixed(replication));
        let opts = AdminOptions::new().operation_timeout(Some(Duration::from_secs(30)));
        let res = admin
            .create_topics([&nt], &opts)
            .await
            .map_err(|e| err("create_topics error", e))?;
        for r in res {
            r.map_err(|(t, e)| err(format!("Failed to create topic '{t}'"), e))?;
        }
        Ok(())
    }

    /// Clear a topic's messages WITHOUT dropping the topic: delete every record
    /// up to each partition's high watermark (KIP-107 DeleteRecords). Keeps the
    /// topic, its partitions, config and ACLs intact — just empties it.
    pub async fn purge_topic(&self, name: &str) -> Result<(), QueryError> {
        let consumer = self.consumer.clone();
        let topic = name.to_string();
        // fetch partitions + high watermark (blocking rdkafka calls)
        let tpl = tokio::task::spawn_blocking(move || -> Result<TopicPartitionList, String> {
            let md = consumer.fetch_metadata(Some(&topic), META_TIMEOUT).map_err(|e| e.to_string())?;
            let t = md
                .topics()
                .iter()
                .find(|t| t.name() == topic)
                .ok_or_else(|| format!("topic '{topic}' not found"))?;
            if t.partitions().is_empty() {
                return Err(format!("topic '{topic}' has no partitions"));
            }
            let mut tpl = TopicPartitionList::new();
            for p in t.partitions() {
                let (_low, high) = consumer
                    .fetch_watermarks(&topic, p.id(), Duration::from_secs(5))
                    .map_err(|e| e.to_string())?;
                // DeleteRecords deletes everything BEFORE this offset → high == all.
                tpl.add_partition_offset(&topic, p.id(), Offset::Offset(high))
                    .map_err(|e| e.to_string())?;
            }
            Ok(tpl)
        })
        .await
        .map_err(|e| err("spawn_blocking error", e))?
        .map_err(|e| err("Failed to read topic watermarks", e))?;

        let admin: AdminClient<DefaultClientContext> =
            self.config.create().map_err(|e| err("Failed to create admin client", e))?;
        let opts = AdminOptions::new().operation_timeout(Some(Duration::from_secs(30)));
        admin.delete_records(&tpl, &opts).await.map_err(|e| err("delete_records error", e))?;
        Ok(())
    }

    /// Delete records in ONE partition up to (and including) `offset` — the only
    /// per-message deletion Kafka supports. KIP-107 DeleteRecords truncates the log
    /// prefix, so this removes the record at `offset` AND every older record in that
    /// partition; Kafka cannot delete a single record from the middle of the log.
    pub async fn delete_records_upto(&self, name: &str, partition: i32, offset: i64) -> Result<(), QueryError> {
        let mut tpl = TopicPartitionList::new();
        // DeleteRecords deletes everything BEFORE this offset → offset+1 includes the target.
        tpl.add_partition_offset(name, partition, Offset::Offset(offset + 1))
            .map_err(|e| err("invalid partition offset", e))?;
        let admin: AdminClient<DefaultClientContext> =
            self.config.create().map_err(|e| err("Failed to create admin client", e))?;
        let opts = AdminOptions::new().operation_timeout(Some(Duration::from_secs(30)));
        admin.delete_records(&tpl, &opts).await.map_err(|e| err("delete_records error", e))?;
        Ok(())
    }

    /// Xóa topic (admin).
    pub async fn delete_topic(&self, name: &str) -> Result<(), QueryError> {
        let admin: AdminClient<DefaultClientContext> =
            self.config.create().map_err(|e| err("Failed to create admin client", e))?;
        let opts = AdminOptions::new().operation_timeout(Some(Duration::from_secs(30)));
        let res = admin
            .delete_topics(&[name], &opts)
            .await
            .map_err(|e| err("delete_topics error", e))?;
        for r in res {
            r.map_err(|(t, e)| err(format!("Failed to delete topic '{t}'"), e))?;
        }
        Ok(())
    }
}

/// Message consume được (value/key decode UTF-8 lossy; frontend tự pretty JSON).
#[derive(Debug, serde::Serialize, Clone)]
pub struct KafkaMessage {
    pub partition: i32,
    pub offset: i64,
    pub timestamp: i64,
    pub key: String,
    pub value: String,
    pub headers: Vec<(String, String)>,
}

/// Convert 1 BorrowedMessage (từ StreamConsumer.recv) → KafkaMessage.
pub fn borrowed_to_message(m: &rdkafka::message::BorrowedMessage) -> KafkaMessage {
    let key = m.key().map(|b| String::from_utf8_lossy(b).into_owned()).unwrap_or_default();
    let value = m.payload().map(|b| String::from_utf8_lossy(b).into_owned()).unwrap_or_default();
    let mut headers = Vec::new();
    if let Some(hs) = m.headers() {
        for i in 0..hs.count() {
            let h = hs.get(i);
            let v = h.value.map(|b| String::from_utf8_lossy(b).into_owned()).unwrap_or_default();
            headers.push((h.key.to_string(), v));
        }
    }
    KafkaMessage {
        partition: m.partition(),
        offset: m.offset(),
        timestamp: m.timestamp().to_millis().unwrap_or(0),
        key,
        value,
        headers,
    }
}

/// Một TRANG message + đủ thông tin để giao diện phân trang và nói đúng sự thật.
#[derive(Debug, serde::Serialize)]
pub struct KafkaPage {
    pub msgs: Vec<KafkaMessage>,
    /// Σ(high − low) của các partition đang xem; **−1 = không đọc được watermark**
    /// (KHÔNG được hiểu là topic rỗng).
    pub retained: i64,
    /// Offset đầu cửa sổ — dùng làm `until` để lấy trang cũ hơn.
    pub window_start: i64,
    /// Còn message cũ hơn cửa sổ này.
    pub has_older: bool,
    /// Cửa sổ đã chạm cuối log (không có trang mới hơn).
    pub at_newest: bool,
    /// Lý do không đọc được watermark (nếu có) — hiện ra thay vì im lặng ra 0.
    pub offsets_error: Option<String>,
}

#[derive(Debug, serde::Serialize)]
pub struct KafkaMember {
    pub member_id: String,
    pub client_id: String,
    pub host: String,
}

#[derive(Debug, serde::Serialize)]
pub struct KafkaGroup {
    pub name: String,
    pub state: String,
    pub protocol: String,
    pub members: Vec<KafkaMember>,
}

#[derive(Debug, serde::Serialize)]
pub struct KafkaLag {
    pub topic: String,
    pub partition: i32,
    pub committed: i64,
    pub high: i64,
    pub lag: i64,
}

#[derive(Debug, serde::Serialize)]
pub struct KafkaBroker {
    pub id: i32,
    pub host: String,
    pub port: i32,
}

#[derive(Debug, serde::Serialize)]
pub struct KafkaCluster {
    pub brokers: Vec<KafkaBroker>,
    pub controller_id: i32,
    pub topic_count: usize,
    pub partition_count: usize,
}

#[derive(Debug, serde::Serialize)]
pub struct KafkaPartition {
    pub id: i32,
    pub leader: i32,
    pub replicas: Vec<i32>,
    pub isr: Vec<i32>,
    pub low: i64,
    pub high: i64,
    pub lag: i64,
}

#[derive(Debug, serde::Serialize)]
pub struct KafkaTopic {
    pub name: String,
    pub partitions: Vec<KafkaPartition>,
    /// `false` = KHÔNG đọc được watermark của ít nhất một partition ⇒ số message là
    /// **không biết**, giao diện phải hiện "? msg" chứ không được hiện "0 msg".
    pub offsets_known: bool,
    /// Lý do broker/librdkafka không trả watermark (hiện trong tooltip).
    pub offsets_error: Option<String>,
    pub internal: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    const RAW: &str = "onesis-class-student-enrollment[0]: Meta data fetch error: NotLeaderForPartition";

    #[test]
    fn diagnoses_a_multi_broker_cluster_collapsed_onto_one_address() {
        // dau hieu cua cluster nhieu broker di qua MOT SSH tunnel: khac node_id nhung
        // metadata bao cung mot dia chi -> chi mot broker thuc su ket noi duoc
        let brokers = vec![
            (1, "127.0.0.1".to_string(), 54321),
            (2, "127.0.0.1".to_string(), 54321),
            (3, "127.0.0.1".to_string(), 54321),
        ];
        let out = diagnose_offsets_failure(&brokers, Some(3), RAW);
        assert!(out.starts_with(RAW), "phai giu nguyen loi goc");
        assert!(out.contains("3 brokers"), "phai noi ro co bao nhieu broker: {out}");
        assert!(out.contains("127.0.0.1:54321"));
        assert!(out.contains("single SSH tunnel"), "phai chi ra nguyen nhan that: {out}");
    }

    #[test]
    fn names_the_unreachable_leader_when_brokers_have_distinct_addresses() {
        let brokers = vec![
            (1, "kafka-1.internal".to_string(), 9092),
            (2, "kafka-2.internal".to_string(), 9092),
        ];
        let out = diagnose_offsets_failure(&brokers, Some(2), RAW);
        assert!(out.contains("broker 2 at kafka-2.internal:9092"), "{out}");
        assert!(!out.contains("SSH tunnel"), "day khong phai kieu tunnel collapse: {out}");
    }

    #[test]
    fn single_broker_cluster_is_not_reported_as_collapsed() {
        let brokers = vec![(1, "127.0.0.1".to_string(), 54321)];
        let out = diagnose_offsets_failure(&brokers, Some(1), RAW);
        assert!(!out.contains("brokers but metadata"), "1 broker thi khong phai collapse: {out}");
        assert!(out.contains("broker 1 at 127.0.0.1:54321"));
    }

    #[test]
    fn falls_back_to_the_raw_error_when_metadata_says_nothing() {
        assert_eq!(diagnose_offsets_failure(&[], None, RAW), RAW);
    }

    #[test]
    fn reports_a_leader_missing_from_metadata() {
        let brokers = vec![(1, "h".to_string(), 9092)];
        let out = diagnose_offsets_failure(&brokers, Some(7), RAW);
        assert!(out.contains("broker 7) is not in the cluster metadata"), "{out}");
    }
}
