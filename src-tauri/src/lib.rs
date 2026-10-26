// The async command bodies nest deeply (with_driver takes an async closure that
// matches on every LiveConnection variant, and some commands chain several of
// those), so computing their layout goes past rustc's default query depth of 128.
// It showed up as "queries overflow the depth limit ... computing layout of
// {async fn body of commands::admin::admin_view()}" on the aarch64-apple-darwin
// leg of the release build while x86_64 happened to stay under the limit.
#![recursion_limit = "512"]

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
                // Resources keep their `resources/` prefix inside the bundle, so look
                // in both places (the flat one first, as before).
                let found = [res_dir.join("instantclient"), res_dir.join("resources").join("instantclient")]
                    .iter()
                    .find_map(|ic| crate::drivers::oracle::instant_client_lib(ic));
                if let Some(lib_dir) = found {
                    crate::drivers::oracle::init_client_dir(&lib_dir);
                }
                // Backup & Restore: the pg_dump / mysqldump / mongodump / expdp copies
                // shipped inside the installer (see tools/fetch-dump-tools).
                crate::drivers::bundled_tools::set_resource_dir(&res_dir);
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

            // Keep every open connection warm. Without this, an idle connection is
            // reaped by the server (wait_timeout / idle_session_timeout), by a NAT
            // or load-balancer idle rule, or with the SSH session behind a tunnel —
            // and the user only finds out minutes later, when the next query fails
            // with a raw socket error on a connection the UI still shows as open.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(crate::connections::registry::keepalive_interval()).await;
                    handle.state::<AppState>().registry.keepalive_sweep().await;
                }
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
            // stream-workspace:redis — Browser / Slow commands / Server info
            commands::redis::redis_info,
            commands::redis::redis_server_info,
            commands::redis::redis_slowlog,
            commands::redis::redis_key_meta,
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
            commands::nats::nats_js_subject_page,
            commands::nats::nats_js_subject_stats,
            commands::nats::nats_js_stream_subjects,
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
            // stream-workspace:nats (W4)
            commands::nats::nats_account_info,
            commands::nats::nats_kv_status,
            commands::nats::nats_kv_bucket_list,
            commands::nats::nats_kv_entries,
            commands::nats::nats_kv_entry,
            commands::nats::nats_kv_history,
            commands::nats::nats_kv_put_version,
            commands::nats::nats_kv_purge,
            commands::nats::nats_kv_create_bucket,
            commands::nats::nats_kv_watch,
            commands::nats::nats_kv_unwatch,
            commands::nats::nats_obj_buckets,
            commands::nats::nats_obj_create,
            commands::nats::nats_obj_delete_bucket,
            commands::nats::nats_obj_list,
            commands::nats::nats_obj_put_file,
            commands::nats::nats_obj_get_file,
            commands::nats::nats_obj_delete,
            // elasticsearch (REST API)
            commands::elasticsearch::es_request,
            commands::elasticsearch::es_server_info,
            commands::elasticsearch::es_overview,
            commands::elasticsearch::es_indices,
            commands::elasticsearch::es_mapping_fields,
            // rabbitmq (Management HTTP API)
            commands::rabbitmq::rabbit_overview,
            commands::rabbitmq::rabbit_vhosts,
            commands::rabbitmq::rabbit_queues,
            commands::rabbitmq::rabbit_queue,
            commands::rabbitmq::rabbit_exchanges,
            commands::rabbitmq::rabbit_queue_bindings,
            commands::rabbitmq::rabbit_exchange_bindings,
            commands::rabbitmq::rabbit_get_messages,
            commands::rabbitmq::rabbit_publish,
            commands::rabbitmq::rabbit_purge_queue,
            commands::rabbitmq::rabbit_delete_queue,
            commands::rabbitmq::rabbit_delete_exchange,
            commands::rabbitmq::rabbit_declare_queue,
            commands::rabbitmq::rabbit_declare_exchange,
            commands::rabbitmq::rabbit_bind_queue,
            commands::rabbitmq::rabbit_unbind_queue,
            commands::rabbitmq::rabbit_live_start,
            commands::rabbitmq::rabbit_live_stop,
            commands::rabbitmq::rabbit_whoami,
            commands::rabbitmq::rabbit_vhost_list,
            commands::rabbitmq::rabbit_create_vhost,
            commands::rabbitmq::rabbit_delete_vhost,
            commands::rabbitmq::rabbit_users,
            commands::rabbitmq::rabbit_create_user,
            commands::rabbitmq::rabbit_set_user_password,
            commands::rabbitmq::rabbit_set_user_tags,
            commands::rabbitmq::rabbit_delete_user,
            commands::rabbitmq::rabbit_permissions,
            commands::rabbitmq::rabbit_set_permission,
            commands::rabbitmq::rabbit_delete_permission,
            commands::rabbitmq::rabbit_topic_permissions,
            commands::rabbitmq::rabbit_set_topic_permission,
            commands::rabbitmq::rabbit_delete_topic_permissions,
            commands::rabbitmq::rabbit_policies,
            commands::rabbitmq::rabbit_set_policy,
            commands::rabbitmq::rabbit_delete_policy,
            // stream-workspace:rabbitmq — cluster workspace (nodes, connections, consumers)
            commands::rabbitmq::rabbit_nodes,
            commands::rabbitmq::rabbit_connections,
            commands::rabbitmq::rabbit_close_connection,
            commands::rabbitmq::rabbit_consumers,
            // kafka
            commands::kafka::kafka_cluster,
            commands::kafka::kafka_topics,
            commands::kafka::kafka_create_topic,
            commands::kafka::kafka_delete_topic,
            commands::kafka::kafka_set_partitions,
            commands::kafka::kafka_purge_topic,
            commands::kafka::kafka_delete_records,
            commands::kafka::kafka_consume,
            commands::kafka::kafka_fetch_page,
            commands::kafka::kafka_stop_consume,
            commands::kafka::kafka_produce,
            commands::kafka::kafka_consumer_groups,
            commands::kafka::kafka_group_lag,
            commands::kafka::kafka_group_topic_lag,
            commands::kafka::kafka_reset_offset,
            commands::kafka::kafka_topic_configs,
            commands::kafka::kafka_alter_topic_configs,
            commands::kafka::kafka_delete_group,
            commands::redpanda::redpanda_admin_request,
            commands::redpanda::redpanda_server_info,
            commands::redpanda::kafka_acls,
            commands::redpanda::kafka_create_acls,
            commands::redpanda::kafka_delete_acls,
            commands::kafka::kafka_offsets_for_time,
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
            commands::cassandra::cassandra_server_info,
            // mongodb
            commands::mongo::mongo_exec,
            commands::mongo::mongo_server_info,
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
            commands::schema::list_object_names,
            commands::schema::list_foreign_keys,
            commands::schema::scan_indexes,
            commands::schema::object_definition,
            commands::schema::index_definition,
            commands::backup::backup_tool_status,
            commands::backup::backup_database,
            commands::backup::restore_database,
            commands::backup::backup_plan,
            commands::backup::cancel_backup,
            commands::files::reveal_path,
            commands::admin::admin_view,
            commands::admin::kill_session,
            commands::admin::drop_database,
            commands::admin::database_sessions,
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
