//! Tauri command lint tầng 1 — parse-only, frontend gọi theo debounce ~400ms.

use crate::lint::{lint, LintDiagnostic};

#[tauri::command]
pub fn lint_sql(system: String, sql: String) -> Vec<LintDiagnostic> {
    lint(&system, &sql)
}
