use std::collections::HashMap;
use std::sync::Mutex;

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

pub struct AppState {
    pub storage: Storage,
    pub registry: Registry,
    pub pubsub: PubSubTasks,
}
