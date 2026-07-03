use crate::connections::registry::Registry;
use crate::storage::Storage;

pub struct AppState {
    pub storage: Storage,
    pub registry: Registry,
}
