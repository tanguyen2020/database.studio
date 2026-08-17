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
        // In-app updates: the frontend checks GitHub Releases on start-up, and the
        // user installs from a prompt (see src/lib/update.ts). `process` provides the
        // relaunch that finishes the install.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Point ODPI-C at the bundled Oracle Instant Client (shipped as a Tauri
            // resource under `instantclient/`) so Oracle works without a system-wide
            // install. Must run before any Oracle connection. If no bundled client is
            // present (e.g. a platform we didn't ship IC for), we leave ODPI-C on its
            // default search so a system-installed client still works.
            if let Ok(res_dir) = app.path().resource_dir() {
                let ic = res_dir.join("instantclient");
                if let Some(lib_dir) = crate::drivers::oracle::instant_client_lib(&ic) {
                    crate::drivers::oracle::init_client_dir(&lib_dir);
                }
            }

            let data_dir = app
                .path()
                .app_data_dir()
                .expect("cannot resolve app data dir");
            // File-based fallback for the encryption master key (durable even
            // when the OS keychain is unavailable, e.g. an unsigned macOS build).
            crate::storage::crypto::set_key_dir(data_dir.clone());
            let storage = Storage::open(data_dir)?;
            app.manage(AppState {
                storage,
                registry: Registry::default(),
                pubsub: Default::default(),
                kafka_stops: Default::default(),
                test_cancels: Default::default(),
                export_cancels: Default::default(),
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
            commands::connections::open_database,
            commands::connections::attach_database,
            commands::connections::open_tab_connection,
            commands::connections::close_tab_connection,
            commands::export::export_query_to_file,
            commands::export::cancel_export,
            commands::connections::test_connection,
            commands::connections::cancel_test,
            commands::connections::ping_connection,
            // query
            commands::query::exec_statement,
            commands::query::exec_statement_stream,
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
            commands::redis::redis_select_db,
            commands::redis::redis_database_count,
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
            commands::nats::nats_js_subject_messages,
            commands::nats::nats_js_subject_stats,
            commands::nats::nats_js_purge_subject,
            commands::nats::nats_js_remove_subject,
            commands::nats::nats_js_add_subject,
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
            commands::kafka::kafka_purge_topic,
            commands::kafka::kafka_delete_records,
            commands::kafka::kafka_consume,
            commands::kafka::kafka_fetch_page,
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
            commands::cassandra::cassandra_object_ddl,
            commands::cassandra::cassandra_columns,
            // mongodb
            commands::mongo::mongo_exec,
            commands::mongo::mongo_users,
            commands::mongo::mongo_roles,
            commands::mongo::mongo_create_user,
            commands::mongo::mongo_change_password,
            commands::mongo::mongo_drop_user,
            commands::mongo::mongo_grant_roles,
            commands::mongo::mongo_revoke_roles,
            // clickhouse advanced (Phase 5)
            commands::clickhouse::ch_table_meta,
            commands::clickhouse::ch_dictionaries,
            // query plan visualizer (Phase 5)
            commands::plan::explain_plan,
            commands::plan::explain_capability,
            // schema
            commands::schema::list_schemas,
            commands::schema::list_databases,
            commands::schema::list_tables,
            commands::schema::list_columns,
            commands::schema::list_indexes,
            commands::schema::list_constraints,
            commands::schema::list_partitions,
            commands::schema::list_routines,
            commands::schema::list_functions,
            commands::schema::list_triggers,
            commands::schema::list_sequences,
            commands::schema::list_foreign_keys,
            commands::schema::scan_indexes,
            commands::schema::object_definition,
            commands::schema::index_definition,
            commands::backup::backup_tool_status,
            commands::backup::backup_database,
            commands::backup::restore_database,
            commands::admin::admin_view,
            commands::admin::kill_session,
            commands::users_admin::users_view,
            // files
            commands::files::write_text_file,
            commands::files::write_file_base64,
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
            commands::grid::ch_generate_mutations,
            // tabs + app state
            commands::tabs::save_tabs,
            commands::tabs::load_tabs,
            commands::tabs::get_app_state,
            commands::tabs::set_app_state,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Database Studio");
}
