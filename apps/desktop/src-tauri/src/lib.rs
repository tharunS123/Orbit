//! Orbit desktop shell (Tauri 2). The UI is the web app; this crate adds what only a native app
//! can do: a global Quick Capture shortcut with its own floating window, a tray, and keeping the
//! app alive (for the shortcut) when the main window is closed.

pub mod capture;
pub mod config;
pub mod shortcut;

use shortcut::{Patch, PluginRegistrar, ShortcutManager, Status};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, RunEvent, Runtime, WindowEvent, Wry};
use tauri_plugin_global_shortcut::ShortcutState;

pub const MAIN: &str = "main";
const EVENT_CONFIG: &str = "orbit://quick-capture-config";
const EVENT_NAVIGATE: &str = "orbit://navigate";
const EVENT_OUTBOX: &str = "orbit://outbox-changed";

type Shortcuts = ShortcutManager<PluginRegistrar<Wry>>;

/// Show and focus the main window; optionally route it to an in-app path.
pub fn show_main<R: Runtime>(app: &AppHandle<R>, path: Option<String>) {
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        if let Some(path) = path.filter(|p| is_safe_path(p)) {
            let _ = window.emit_to(MAIN, EVENT_NAVIGATE, path);
        }
    }
}

/// Only same-app relative paths may be navigated to (never URLs from elsewhere).
pub fn is_safe_path(path: &str) -> bool {
    path.starts_with('/') && !path.starts_with("//") && !path.contains('\\') && !path.contains(['\r', '\n'])
}

fn broadcast_config<R: Runtime>(app: &AppHandle<R>, status: &Status) {
    let _ = app.emit(EVENT_CONFIG, status);
}

// ───────────── commands (invoked from apps/web/src/lib/desktop.ts) ─────────────

#[tauri::command]
fn quick_capture_config(shortcuts: tauri::State<'_, Shortcuts>) -> Status {
    shortcuts.status()
}

#[tauri::command]
fn quick_capture_update(app: AppHandle, shortcuts: tauri::State<'_, Shortcuts>, patch: Patch) -> Result<Status, String> {
    let status = shortcuts.update(patch)?;
    broadcast_config(&app, &status);
    Ok(status)
}

#[tauri::command]
fn quick_capture_reset(app: AppHandle, shortcuts: tauri::State<'_, Shortcuts>) -> Status {
    let status = shortcuts.reset();
    broadcast_config(&app, &status);
    status
}

#[tauri::command]
fn quick_capture_pause(shortcuts: tauri::State<'_, Shortcuts>, paused: bool) -> Status {
    shortcuts.pause(paused)
}

#[tauri::command]
fn quick_capture_show(app: AppHandle) -> Result<(), String> {
    capture::show(&app).map_err(|e| e.to_string())
}

#[tauri::command]
fn quick_capture_hide(app: AppHandle) -> Result<(), String> {
    capture::hide(&app).map_err(|e| e.to_string())
}

#[tauri::command]
fn quick_capture_resize(app: AppHandle, height: f64) -> Result<(), String> {
    capture::resize(&app, height).map_err(|e| e.to_string())
}

/// Quick Capture queued work in the shared outbox: the main window adopts and syncs it.
#[tauri::command]
fn outbox_changed(app: AppHandle) {
    let _ = app.emit_to(MAIN, EVENT_OUTBOX, ());
}

#[tauri::command]
fn show_main_window(app: AppHandle, path: Option<String>) {
    show_main(&app, path);
}

#[tauri::command]
fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let allowed = url.starts_with("https://") || url.starts_with("http://") || url.starts_with("mailto:");
    if !allowed {
        return Err("Only web and email links can be opened.".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

// ───────────── app ─────────────

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Orbit", true, None::<&str>)?;
    let quick = MenuItem::with_id(app, "capture", "Quick Capture", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Orbit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quick, &PredefinedMenuItem::separator(app)?, &quit])?;
    let mut tray = TrayIconBuilder::with_id("orbit").tooltip("Orbit").menu(&menu).show_menu_on_left_click(true).on_menu_event(|app, event| match event.id.as_ref() {
        "open" => show_main(app, None),
        "capture" => {
            let _ = capture::show(app);
        }
        "quit" => app.exit(0),
        _ => {}
    });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        // Must be first: a second launch focuses this instance instead of starting another one
        // (which would also try to claim the same global shortcut).
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| show_main(app, None)))
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    // Only one global shortcut is ever registered: Quick Capture. Pressing it while
                    // the window is open focuses it (Esc closes).
                    if event.state() == ShortcutState::Pressed {
                        if let Err(e) = capture::show(app) {
                            eprintln!("[quick-capture] could not open: {e}");
                        }
                    }
                })
                .build(),
        )
        .setup(|app| {
            let path = app.path().app_config_dir().ok().map(|d| d.join("quick-capture.json"));
            let saved = path.as_deref().map(config::load).unwrap_or_default();
            let shortcuts: Shortcuts = ShortcutManager::new(PluginRegistrar(app.handle().clone()), path, saved);
            let status = shortcuts.start();
            match &status.error {
                Some(err) => eprintln!("[quick-capture] {} not registered: {err}", status.shortcut),
                None if status.registered => eprintln!("[quick-capture] registered {}", status.shortcut),
                None => eprintln!("[quick-capture] disabled"),
            }
            let enabled = status.enabled;
            app.manage(shortcuts);
            build_tray(app)?;
            // Pre-create the (hidden) capture window so the first shortcut press is instant.
            if enabled {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(1500));
                    let h = handle.clone();
                    let _ = handle.run_on_main_thread(move || {
                        let _ = capture::ensure_window(&h);
                    });
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            #[cfg(debug_assertions)]
            if let WindowEvent::Focused(focused) = event {
                if window.label() == capture::LABEL && std::env::var_os("ORBIT_DEBUG_CAPTURE").is_some() {
                    eprintln!("[quick-capture] focused={focused}");
                }
            }
            match event {
                // Closing windows hides them: Orbit keeps running so the global shortcut works.
                WindowEvent::CloseRequested { api, .. } if window.label() == MAIN || window.label() == capture::LABEL => {
                    api.prevent_close();
                    let _ = window.hide();
                }
                WindowEvent::Focused(false) if window.label() == capture::LABEL => {
                    let hide = window.app_handle().state::<Shortcuts>().config().hide_on_blur;
                    if hide {
                        let _ = window.hide();
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            quick_capture_config,
            quick_capture_update,
            quick_capture_reset,
            quick_capture_pause,
            quick_capture_show,
            quick_capture_hide,
            quick_capture_resize,
            outbox_changed,
            show_main_window,
            open_external
        ])
        .build(tauri::generate_context!())
        .expect("error while building Orbit")
        .run(|app, event| match event {
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => show_main(app, None),
            RunEvent::Exit => app.state::<Shortcuts>().shutdown(),
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn navigation_accepts_only_in_app_paths() {
        assert!(is_safe_path("/inbox"));
        assert!(is_safe_path("/list?id=abc"));
        assert!(!is_safe_path("//evil.example"));
        assert!(!is_safe_path("https://evil.example"));
        assert!(!is_safe_path("/\\evil"));
        assert!(!is_safe_path("/inbox\r\nx"));
    }
}
