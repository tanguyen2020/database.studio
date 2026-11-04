//! The macOS application menu.
//!
//! Without one, Tauri installs its default menu, whose "Close Window" owns ⌘W.
//! This app has tabs and closes the current tab on Ctrl/⌘+W (like every tabbed
//! Mac app), so the stock menu would close the whole window instead. This menu
//! is the stock one with "Close Window" moved to ⇧⌘W; everything Mac users rely
//! on stays: About, Hide (⌘H), Quit (⌘Q), the Edit items that make ⌘C / ⌘V /
//! ⌘A / ⌘Z work in a WKWebView, Full Screen and Minimize.
//!
//! Windows and Linux never get a menu bar (see `with_platform_menu`).

use tauri::menu::{AboutMetadata, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, Runtime};

pub const CLOSE_WINDOW_ID: &str = "ds-close-window";
/// ⇧⌘W — ⌘W is the app's "close tab".
pub const CLOSE_WINDOW_ACCELERATOR: &str = "Shift+CmdOrCtrl+W";

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let pkg = app.package_info();
    let config = app.config();
    let about = AboutMetadata {
        name: Some(pkg.name.clone()),
        version: Some(pkg.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config.bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };
    let close_window = MenuItem::with_id(app, CLOSE_WINDOW_ID, "Close Window", true, Some(CLOSE_WINDOW_ACCELERATOR))?;

    let app_menu = Submenu::with_items(
        app,
        pkg.name.clone(),
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(about))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let file_menu = Submenu::with_items(app, "File", true, &[&close_window])?;
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let view_menu = Submenu::with_items(app, "View", true, &[&PredefinedMenuItem::fullscreen(app, None)?])?;
    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[&PredefinedMenuItem::minimize(app, None)?, &PredefinedMenuItem::maximize(app, None)?],
    )?;

    Menu::with_items(app, &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu])
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn on_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    if event.id().as_ref() != CLOSE_WINDOW_ID {
        return;
    }
    let windows = app.webview_windows();
    let target = windows
        .values()
        .find(|w| w.is_focused().unwrap_or(false))
        .or_else(|| windows.get("main"));
    if let Some(w) = target {
        let _ = w.close();
    }
}

/// macOS gets the menu above; Windows and Linux keep no menu bar at all.
pub fn with_platform_menu<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    #[cfg(target_os = "macos")]
    {
        builder.menu(|app| build(app)).on_menu_event(on_event)
    }
    #[cfg(not(target_os = "macos"))]
    {
        builder
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn close_window_does_not_take_the_close_tab_shortcut() {
        // ⌘W / Ctrl+W must reach the page (close tab); the window moves to ⇧⌘W.
        let a = CLOSE_WINDOW_ACCELERATOR.to_ascii_lowercase();
        assert!(a.contains("shift") && a.ends_with("+w"), "{a}");
    }
}
