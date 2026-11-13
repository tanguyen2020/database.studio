// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `database-studio --mcp-stdio`: MCP bridge for clients that only speak stdio
    // (forwards to the running app's local MCP server; never opens a window).
    if database_studio_lib::mcp::stdio::requested() {
        std::process::exit(database_studio_lib::mcp::stdio::run());
    }
    database_studio_lib::run()
}
