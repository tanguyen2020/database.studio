pub mod commands;
pub mod connections;
pub mod drivers;
pub mod error;
pub mod lint;
pub mod state;
pub mod storage;

use tauri::Manager;

use crate::connections::registry::Registry;
use crate::state::AppState;
use crate::storage::Storage;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("cannot resolve app data dir");
            let storage = Storage::open(data_dir)?;
            app.manage(AppState {
                storage,
                registry: Registry::default(),
                pubsub: Default::default(),
                kafka_stops: Default::default(),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // connections
            commands::connections::list_connections,
            commands::connections::save_connection,
            commands::connections::delete_connection,
            commands::connections::duplicate_connection,
            commands::connections::connect,
            commands::connections::disconnect,
            commands::connections::reconnect,
            commands::connections::quick_connect,
            commands::connections::test_connection,
            commands::connections::ping_connection,
            // query
            commands::query::exec_statement,
            commands::query::cancel_query,
            // redis
            commands::redis::redis_scan,
            commands::redis::redis_get,
            commands::redis::redis_del,
            commands::redis::redis_set_ttl,
            commands::redis::redis_edit,
            commands::redis::redis_command,
            commands::redis::redis_memory_usage,
            commands::redis::redis_flushdb,
            commands::redis::redis_subscribe,
            commands::redis::redis_unsubscribe,
            commands::redis::redis_publish,
            // nats
            commands::nats::nats_info,
            commands::nats::nats_subscribe,
            commands::nats::nats_unsubscribe,
            commands::nats::nats_publish,
            commands::nats::nats_request,
            commands::nats::nats_js_streams,
            commands::nats::nats_js_consumers,
            commands::nats::nats_js_peek,
            commands::nats::nats_js_create_stream,
            commands::nats::nats_js_delete_stream,
            commands::nats::nats_js_purge_stream,
            commands::nats::nats_js_create_consumer,
            commands::nats::nats_js_delete_consumer,
            commands::nats::nats_js_delete_message,
            commands::nats::nats_kv_buckets,
            commands::nats::nats_kv_create,
            commands::nats::nats_kv_delete_bucket,
            commands::nats::nats_kv_keys,
            commands::nats::nats_kv_get,
            commands::nats::nats_kv_put,
            commands::nats::nats_kv_delete,
            commands::nats::nats_obj_buckets,
            commands::nats::nats_obj_create,
            commands::nats::nats_obj_delete_bucket,
            commands::nats::nats_obj_list,
            commands::nats::nats_obj_put_file,
            commands::nats::nats_obj_get_file,
            commands::nats::nats_obj_delete,
            // kafka
            commands::kafka::kafka_cluster,
            commands::kafka::kafka_topics,
            commands::kafka::kafka_create_topic,
            commands::kafka::kafka_delete_topic,
            commands::kafka::kafka_consume,
            commands::kafka::kafka_stop_consume,
            commands::kafka::kafka_produce,
            commands::kafka::kafka_consumer_groups,
            commands::kafka::kafka_group_lag,
            commands::kafka::kafka_reset_offset,
            commands::kafka::kafka_sr_subjects,
            commands::kafka::kafka_sr_versions,
            commands::kafka::kafka_sr_schema,
            // cassandra (Phase 4b)
            commands::cassandra::cql_exec,
            commands::cassandra::cassandra_keyspaces,
            commands::cassandra::cassandra_tree,
            commands::cassandra::cassandra_ring,
            commands::cassandra::cassandra_table_ddl,
            // clickhouse advanced (Phase 5)
            commands::clickhouse::ch_table_meta,
            // query plan visualizer (Phase 5)
            commands::plan::explain_plan,
            // schema
            commands::schema::list_schemas,
            commands::schema::list_tables,
            commands::schema::list_columns,
            commands::schema::list_indexes,
            commands::schema::list_constraints,
            commands::schema::list_routines,
            commands::schema::list_triggers,
            commands::schema::list_sequences,
            commands::schema::list_foreign_keys,
            // files
            commands::files::write_text_file,
            // lint tầng 1
            commands::lint::lint_sql,
            // SQLite PRAGMA panel
            commands::sqlite::sqlite_file_info,
            commands::sqlite::sqlite_set_pragma,
            commands::sqlite::sqlite_integrity_check,
            // history + snippets
            commands::library::list_history,
            commands::library::list_snippets,
            commands::library::save_snippet,
            commands::library::delete_snippet,
            // editable grid
            commands::grid::preview_grid_changes,
            commands::grid::apply_grid_changes,
            commands::grid::exec_filtered,
            // tabs + app state
            commands::tabs::save_tabs,
            commands::tabs::load_tabs,
            commands::tabs::get_app_state,
            commands::tabs::set_app_state,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Database Studio");
}
