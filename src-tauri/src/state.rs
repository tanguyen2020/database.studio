use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tokio::task::AbortHandle;

use crate::connections::registry::Registry;
use crate::storage::Storage;

/// Các task pub/sub Redis đang chạy (1 subscription / connection). Subscribe mới
/// hủy cái cũ; unsubscribe / disconnect hủy task.
#[derive(Default)]
pub struct PubSubTasks(Mutex<HashMap<String, AbortHandle>>);

impl PubSubTasks {
    /// Đăng ký task mới cho connId, hủy task cũ nếu có.
    pub fn replace(&self, id: String, handle: AbortHandle) {
        if let Some(old) = self.0.lock().unwrap().insert(id, handle) {
            old.abort();
        }
    }

    /// Hủy + gỡ task của connId (nếu có).
    pub fn abort(&self, id: &str) {
        if let Some(h) = self.0.lock().unwrap().remove(id) {
            h.abort();
        }
    }
}

/// Cờ dừng cho consumer Kafka (chạy trong OS thread riêng, không phải tokio task —
/// rdkafka consumer phải được drop trong thread poll của nó, tránh deadlock async).
#[derive(Default)]
pub struct KafkaStops(Mutex<HashMap<String, Arc<AtomicBool>>>);

impl KafkaStops {
    /// Đăng ký cờ mới cho connId, bật cờ cũ (dừng consumer cũ) nếu có.
    pub fn set(&self, id: String, flag: Arc<AtomicBool>) {
        if let Some(old) = self.0.lock().unwrap().insert(id, flag) {
            old.store(true, Ordering::Relaxed);
        }
    }

    /// Bật cờ dừng + gỡ khỏi map.
    pub fn stop(&self, id: &str) {
        if let Some(f) = self.0.lock().unwrap().remove(id) {
            f.store(true, Ordering::Relaxed);
        }
    }
}

pub struct AppState {
    pub storage: Storage,
    pub registry: Registry,
    pub pubsub: PubSubTasks,
    pub kafka_stops: KafkaStops,
}
