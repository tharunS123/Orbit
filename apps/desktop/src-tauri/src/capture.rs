//! The Quick Capture window: exactly one, created once (hidden) and then shown/hidden, so it opens
//! instantly and keeps an unfinished draft between openings.

use std::sync::Mutex;
use tauri::{AppHandle, Emitter, LogicalSize, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const LABEL: &str = "quick-capture";
pub const WIDTH: f64 = 560.0;
pub const MIN_HEIGHT: f64 = 120.0;
pub const MAX_HEIGHT: f64 = 480.0;
const INITIAL_HEIGHT: f64 = 196.0;

pub const EVENT_SHOWN: &str = "orbit://quick-capture-shown";

/// Serialises creation: two shortcut presses racing can't build two windows.
static CREATE: Mutex<()> = Mutex::new(());

/// The Quick Capture window, creating it (hidden) the first time.
pub fn ensure_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<WebviewWindow<R>> {
    let _guard = CREATE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(window) = app.get_webview_window(LABEL) {
        return Ok(window);
    }
    let builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("capture".into()))
        .title("Quick Capture")
        .inner_size(WIDTH, INITIAL_HEIGHT)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        .shadow(true)
        .visible(false)
        .focused(true)
        .center();
    builder.build()
}

/// Show and focus Quick Capture (creating it if needed). Never opens the main window.
pub fn show<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let window = ensure_window(app)?;
    #[cfg(debug_assertions)]
    if std::env::var_os("ORBIT_DEBUG_CAPTURE").is_some() {
        eprintln!("[quick-capture] show (visible={:?})", window.is_visible());
    }
    if !window.is_visible().unwrap_or(false) {
        place_on_active_monitor(app, &window);
        window.show()?;
    }
    window.set_focus()?;
    // The page focuses its input, refreshes lists/labels and drops a stale draft.
    window.emit_to(LABEL, EVENT_SHOWN, ())?;
    Ok(())
}

pub fn hide<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(LABEL) {
        window.hide()?;
    }
    Ok(())
}

/// Resize to the page's content height (clamped), keeping the width.
pub fn resize<R: Runtime>(app: &AppHandle<R>, height: f64) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(LABEL) {
        window.set_size(LogicalSize::new(WIDTH, clamp_height(height)))?;
    }
    Ok(())
}

pub fn clamp_height(height: f64) -> f64 {
    if height.is_finite() {
        height.clamp(MIN_HEIGHT, MAX_HEIGHT)
    } else {
        INITIAL_HEIGHT
    }
}

/// Open on the monitor the pointer is on, a third of the way down (like Spotlight).
fn place_on_active_monitor<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>) {
    let Ok(cursor) = app.cursor_position() else { return };
    let Ok(Some(monitor)) = app.monitor_from_point(cursor.x, cursor.y) else { return };
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let (mx, my) = (area.position.x as f64 / scale, area.position.y as f64 / scale);
    let (mw, mh) = (area.size.width as f64 / scale, area.size.height as f64 / scale);
    let x = mx + (mw - WIDTH) / 2.0;
    let y = my + mh * 0.22;
    let _ = window.set_position(tauri::LogicalPosition::new(x, y));
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::test::{mock_builder, mock_context, noop_assets};

    fn app() -> tauri::App<tauri::test::MockRuntime> {
        mock_builder().build(mock_context(noop_assets())).expect("mock app")
    }

    #[test]
    fn there_is_only_ever_one_quick_capture_window() {
        let app = app();
        let handle = app.handle();
        let first = ensure_window(handle).unwrap();
        let second = ensure_window(handle).unwrap();
        assert_eq!(first.label(), second.label());
        show(handle).unwrap();
        show(handle).unwrap();
        let captures = handle.webview_windows().keys().filter(|l| l.as_str() == LABEL).count();
        assert_eq!(captures, 1);
    }

    #[test]
    fn concurrent_opens_create_one_window() {
        let app = app();
        let handle = app.handle().clone();
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let h = handle.clone();
                std::thread::spawn(move || ensure_window(&h).map(|w| w.label().to_string()))
            })
            .collect();
        for t in threads {
            assert_eq!(t.join().unwrap().unwrap(), LABEL);
        }
        assert_eq!(handle.webview_windows().len(), 1);
    }

    #[test]
    fn show_focuses_the_existing_window_and_hide_keeps_it() {
        let app = app();
        let handle = app.handle();
        show(handle).unwrap();
        let window = handle.get_webview_window(LABEL).unwrap();
        hide(handle).unwrap();
        // Hidden, not destroyed: reopening reuses it (draft preserved, instant open).
        assert!(handle.get_webview_window(LABEL).is_some());
        show(handle).unwrap();
        assert_eq!(handle.get_webview_window(LABEL).unwrap().label(), window.label());
    }

    #[test]
    fn heights_are_clamped() {
        assert_eq!(clamp_height(40.0), MIN_HEIGHT);
        assert_eq!(clamp_height(260.0), 260.0);
        assert_eq!(clamp_height(4000.0), MAX_HEIGHT);
        assert_eq!(clamp_height(f64::NAN), INITIAL_HEIGHT);
    }
}
