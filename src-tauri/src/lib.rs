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
            app.manage(AppState { storage, registry: Registry::default() });
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
            commands::connections::test_connection,
            commands::connections::ping_connection,
            // query
            commands::query::exec_statement,
            commands::query::cancel_query,
            // schema
            commands::schema::list_schemas,
            commands::schema::list_tables,
            commands::schema::list_columns,
            commands::schema::list_indexes,
            commands::schema::list_constraints,
            commands::schema::list_routines,
            commands::schema::list_triggers,
            commands::schema::list_sequences,
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
            // tabs + app state
            commands::tabs::save_tabs,
            commands::tabs::load_tabs,
            commands::tabs::get_app_state,
            commands::tabs::set_app_state,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Database Studio");
}
