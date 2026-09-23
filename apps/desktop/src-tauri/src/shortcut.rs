//! Global Quick Capture shortcut: validation, registration lifecycle and persistence.
//!
//! The OS registration sits behind [`Registrar`] so the lifecycle rules (no double registration,
//! keep the old shortcut when a new one is refused, pause while recording, restore on launch) are
//! unit-tested without touching the real keyboard hooks.

use crate::config::{self, QuickCaptureConfig};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::Mutex;
use tauri_plugin_global_shortcut::{Modifiers, Shortcut};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RegisterError {
    /// Another application (or the system) owns the combination.
    Taken,
    /// Orbit itself already registered it (should not happen; guarded by the manager).
    AlreadyOurs,
    Other(String),
}

impl RegisterError {
    pub fn message(&self) -> String {
        match self {
            RegisterError::Taken => "This shortcut is already being used by another application. Choose a different one.".into(),
            RegisterError::AlreadyOurs => "Orbit already uses this shortcut.".into(),
            RegisterError::Other(e) => format!("Couldn’t register the shortcut: {e}"),
        }
    }
}

/// OS-level registration of one accelerator.
pub trait Registrar: Send + Sync {
    fn register(&self, accelerator: &str) -> Result<(), RegisterError>;
    fn unregister(&self, accelerator: &str);
}

/// Parse and sanity-check an accelerator ("Shift+Alt+Space"). Returns a user-facing message on
/// failure. The web UI validates first (reserved/common combos); this is the authoritative check.
pub fn validate(accelerator: &str) -> Result<Shortcut, String> {
    let shortcut = Shortcut::from_str(accelerator).map_err(|_| format!("“{accelerator}” isn’t a valid shortcut."))?;
    let strong = Modifiers::CONTROL | Modifiers::ALT | Modifiers::SUPER;
    let key = format!("{:?}", shortcut.key);
    let is_function_key = key.len() > 1 && key.starts_with('F') && key[1..].chars().all(|c| c.is_ascii_digit());
    if !shortcut.mods.intersects(strong) && !is_function_key {
        return Err("Include Ctrl, Alt/Option or Cmd so the shortcut doesn’t trigger while you type.".into());
    }
    Ok(shortcut)
}

/// "Alt+Shift+Space" and "shift+alt+space" are the same OS registration.
pub fn same_combination(a: &str, b: &str) -> bool {
    match (Shortcut::from_str(a), Shortcut::from_str(b)) {
        (Ok(x), Ok(y)) => x.id() == y.id(),
        _ => a == b,
    }
}

/// What the settings screen shows (camelCase JSON for the web UI).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub enabled: bool,
    pub shortcut: String,
    pub default_shortcut: String,
    pub hide_on_blur: bool,
    pub registered: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Patch {
    pub enabled: Option<bool>,
    pub shortcut: Option<String>,
    pub hide_on_blur: Option<bool>,
}

struct State {
    config: QuickCaptureConfig,
    /// Accelerator currently registered with the OS (at most one).
    registered: Option<String>,
    paused: bool,
    error: Option<String>,
}

pub struct ShortcutManager<R: Registrar> {
    registrar: R,
    path: Option<PathBuf>,
    state: Mutex<State>,
}

impl<R: Registrar> ShortcutManager<R> {
    pub fn new(registrar: R, path: Option<PathBuf>, config: QuickCaptureConfig) -> Self {
        Self { registrar, path, state: Mutex::new(State { config, registered: None, paused: false, error: None }) }
    }

    /// Register the saved shortcut at launch. A failure is kept as a visible status (the app
    /// still starts; Settings explains what happened).
    pub fn start(&self) -> Status {
        let mut s = self.state.lock().unwrap();
        if s.config.enabled {
            let accel = s.config.shortcut.clone();
            s.error = self.ensure_registered(&mut s, &accel).err();
        }
        Self::status_of(&s)
    }

    pub fn status(&self) -> Status {
        Self::status_of(&self.state.lock().unwrap())
    }

    pub fn config(&self) -> QuickCaptureConfig {
        self.state.lock().unwrap().config.clone()
    }

    /// Apply a settings change. A refused new shortcut leaves the previous one working and
    /// returns the reason; nothing is saved in that case.
    pub fn update(&self, patch: Patch) -> Result<Status, String> {
        let mut s = self.state.lock().unwrap();
        let mut next = s.config.clone();
        if let Some(hide) = patch.hide_on_blur {
            next.hide_on_blur = hide;
        }
        if let Some(shortcut) = patch.shortcut.as_deref() {
            validate(shortcut)?;
            next.shortcut = shortcut.to_string();
        }
        if let Some(enabled) = patch.enabled {
            next.enabled = enabled;
        }

        let shortcut_changed = next.shortcut != s.config.shortcut;
        if next.enabled && s.paused && shortcut_changed {
            // Recording in Settings (shortcut released): still verify the OS accepts the new one.
            self.registrar.register(&next.shortcut).map_err(|e| e.message())?;
            self.registrar.unregister(&next.shortcut);
        }
        if next.enabled && !s.paused {
            let accel = next.shortcut.clone();
            match self.ensure_registered(&mut s, &accel) {
                Ok(()) => s.error = None,
                // Changing to a combination the OS refuses: keep the old one, report why.
                Err(e) if shortcut_changed => {
                    let restore = s.config.shortcut.clone();
                    if s.config.enabled {
                        let _ = self.ensure_registered(&mut s, &restore);
                    }
                    return Err(e);
                }
                // Enabling (or re-applying) a combination that is taken: save, but show why.
                Err(e) => s.error = Some(e),
            }
        } else if !next.enabled {
            self.release(&mut s);
            s.error = None;
        }
        s.config = next;
        self.persist(&s.config);
        Ok(Self::status_of(&s))
    }

    pub fn reset(&self) -> Status {
        let patch = Patch { enabled: Some(true), shortcut: Some(config::default_shortcut().into()), hide_on_blur: None };
        match self.update(patch) {
            Ok(status) => status,
            // The default itself is taken: still reset the preference and report it.
            Err(e) => {
                let mut s = self.state.lock().unwrap();
                self.release(&mut s);
                s.config.shortcut = config::default_shortcut().into();
                s.config.enabled = true;
                s.error = Some(e);
                self.persist(&s.config);
                Self::status_of(&s)
            }
        }
    }

    /// Temporarily release the shortcut (while Settings records a new one) and restore it.
    pub fn pause(&self, paused: bool) -> Status {
        let mut s = self.state.lock().unwrap();
        if paused == s.paused {
            return Self::status_of(&s);
        }
        s.paused = paused;
        if paused {
            self.release(&mut s);
        } else if s.config.enabled {
            let accel = s.config.shortcut.clone();
            s.error = self.ensure_registered(&mut s, &accel).err();
        }
        Self::status_of(&s)
    }

    /// Unregister on shutdown.
    pub fn shutdown(&self) {
        let mut s = self.state.lock().unwrap();
        self.release(&mut s);
    }

    /// Register `accel`, replacing whatever is registered. Idempotent: registering the current
    /// accelerator again is a no-op, so the OS never sees a double registration.
    fn ensure_registered(&self, s: &mut State, accel: &str) -> Result<(), String> {
        if s.registered.as_deref().is_some_and(|cur| same_combination(cur, accel)) {
            s.registered = Some(accel.to_string());
            return Ok(());
        }
        validate(accel)?;
        // Register the new one before releasing the old so a refusal can't leave us with nothing.
        self.registrar.register(accel).map_err(|e| e.message())?;
        if let Some(old) = s.registered.replace(accel.to_string()) {
            self.registrar.unregister(&old);
        }
        Ok(())
    }

    fn release(&self, s: &mut State) {
        if let Some(old) = s.registered.take() {
            self.registrar.unregister(&old);
        }
    }

    fn persist(&self, config: &QuickCaptureConfig) {
        if let Some(path) = &self.path {
            if let Err(e) = config::save(path, config) {
                eprintln!("[quick-capture] could not save preferences: {e}");
            }
        }
    }

    fn status_of(s: &State) -> Status {
        Status {
            enabled: s.config.enabled,
            shortcut: s.config.shortcut.clone(),
            default_shortcut: config::default_shortcut().into(),
            hide_on_blur: s.config.hide_on_blur,
            registered: s.registered.is_some(),
            error: s.error.clone(),
        }
    }
}

/// Map global-hotkey's registration errors (surfaced by the plugin as strings) to what the user
/// needs to know. Our own registrations are checked before calling the OS, so "already
/// registered" here means another application holds it:
///  - Windows: `RegisterHotKey` → ERROR_HOTKEY_ALREADY_REGISTERED → "HotKey already registered"
///  - macOS: `RegisterEventHotKey` refusing → "Unable to register hotkey: RegisterEventHotKey failed"
pub fn classify_register_error(text: &str) -> RegisterError {
    let lower = text.to_lowercase();
    if lower.contains("unknown scancode") || lower.contains("unknown vkcode") {
        RegisterError::Other("that key can’t be used for a global shortcut on this system".into())
    } else if lower.contains("already registered") || lower.contains("registereventhotkey failed") || lower.contains("unable to register") || lower.contains("os error") {
        RegisterError::Taken
    } else {
        RegisterError::Other(text.to_string())
    }
}

/// The real registrar, backed by tauri-plugin-global-shortcut.
pub struct PluginRegistrar<Rt: tauri::Runtime>(pub tauri::AppHandle<Rt>);

impl<Rt: tauri::Runtime> Registrar for PluginRegistrar<Rt> {
    fn register(&self, accelerator: &str) -> Result<(), RegisterError> {
        use tauri_plugin_global_shortcut::GlobalShortcutExt;
        let shortcut = Shortcut::from_str(accelerator).map_err(|e| RegisterError::Other(e.to_string()))?;
        let gs = self.0.global_shortcut();
        if gs.is_registered(shortcut) {
            return Err(RegisterError::AlreadyOurs);
        }
        gs.register(shortcut).map_err(|e| classify_register_error(&e.to_string()))
    }

    fn unregister(&self, accelerator: &str) {
        use tauri_plugin_global_shortcut::GlobalShortcutExt;
        if let Ok(shortcut) = Shortcut::from_str(accelerator) {
            let _ = self.0.global_shortcut().unregister(shortcut);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::sync::Arc;

    /// Fake OS: tracks registrations, refuses combinations "owned by other apps", and records
    /// every call so double registration would be visible.
    #[derive(Clone, Default)]
    struct FakeOs {
        inner: Arc<Mutex<FakeState>>,
    }
    #[derive(Default)]
    struct FakeState {
        registered: HashSet<String>,
        taken_by_others: HashSet<String>,
        register_calls: Vec<String>,
    }
    impl FakeOs {
        fn take(&self, accel: &str) {
            self.inner.lock().unwrap().taken_by_others.insert(accel.into());
        }
        fn registered(&self) -> Vec<String> {
            let mut v: Vec<_> = self.inner.lock().unwrap().registered.iter().cloned().collect();
            v.sort();
            v
        }
        fn calls(&self) -> usize {
            self.inner.lock().unwrap().register_calls.len()
        }
    }
    impl Registrar for FakeOs {
        fn register(&self, accel: &str) -> Result<(), RegisterError> {
            let mut s = self.inner.lock().unwrap();
            s.register_calls.push(accel.into());
            if s.taken_by_others.contains(accel) {
                return Err(RegisterError::Taken);
            }
            if !s.registered.insert(accel.into()) {
                return Err(RegisterError::AlreadyOurs);
            }
            Ok(())
        }
        fn unregister(&self, accel: &str) {
            self.inner.lock().unwrap().registered.remove(accel);
        }
    }

    fn manager(os: &FakeOs, config: QuickCaptureConfig) -> ShortcutManager<FakeOs> {
        ShortcutManager::new(os.clone(), None, config)
    }

    #[test]
    fn registers_the_saved_shortcut_on_start_exactly_once() {
        let os = FakeOs::default();
        let m = manager(&os, QuickCaptureConfig::default());
        let status = m.start();
        assert!(status.registered && status.error.is_none());
        assert_eq!(os.registered(), vec![config::default_shortcut().to_string()]);
        // Starting again (e.g. a second setup pass) does not double-register.
        m.start();
        assert_eq!(os.calls(), 1);
    }

    #[test]
    fn the_same_combination_spelled_differently_is_not_registered_twice() {
        let os = FakeOs::default();
        let m = manager(&os, QuickCaptureConfig { shortcut: "Shift+Alt+Space".into(), ..Default::default() });
        m.start();
        m.update(Patch { shortcut: Some("alt+shift+space".into()), ..Default::default() }).unwrap();
        assert_eq!(os.calls(), 1);
        assert!(m.status().registered);
    }

    #[test]
    fn os_registration_errors_are_explained() {
        assert_eq!(classify_register_error("HotKey already registered: HotKey { mods: ALT, key: Space, id: 1 }"), RegisterError::Taken);
        assert_eq!(classify_register_error("Unable to register hotkey: RegisterEventHotKey failed for Space"), RegisterError::Taken);
        assert_eq!(classify_register_error("Access is denied. (os error 5)"), RegisterError::Taken);
        assert!(matches!(classify_register_error("Unable to register hotkey: Unknown VKCode for F24"), RegisterError::Other(_)));
        assert!(RegisterError::Taken.message().contains("already being used by another application"));
    }

    #[test]
    fn disabled_config_registers_nothing() {
        let os = FakeOs::default();
        let m = manager(&os, QuickCaptureConfig { enabled: false, ..Default::default() });
        assert!(!m.start().registered);
        assert!(os.registered().is_empty());
    }

    #[test]
    fn changing_the_shortcut_swaps_registrations() {
        let os = FakeOs::default();
        let m = manager(&os, QuickCaptureConfig::default());
        m.start();
        let status = m.update(Patch { shortcut: Some("Ctrl+Shift+K".into()), ..Default::default() }).unwrap();
        assert_eq!(status.shortcut, "Ctrl+Shift+K");
        assert_eq!(os.registered(), vec!["Ctrl+Shift+K".to_string()]);
    }

    #[test]
    fn a_conflicting_shortcut_is_refused_and_the_old_one_keeps_working() {
        let os = FakeOs::default();
        os.take("Ctrl+Alt+J");
        let m = manager(&os, QuickCaptureConfig::default());
        m.start();
        let err = m.update(Patch { shortcut: Some("Ctrl+Alt+J".into()), ..Default::default() }).unwrap_err();
        assert!(err.contains("already being used by another application"), "{err}");
        assert_eq!(m.status().shortcut, config::default_shortcut());
        assert_eq!(os.registered(), vec![config::default_shortcut().to_string()]);
    }

    #[test]
    fn rejects_shortcuts_without_a_real_modifier() {
        let os = FakeOs::default();
        let m = manager(&os, QuickCaptureConfig::default());
        m.start();
        assert!(m.update(Patch { shortcut: Some("Shift+K".into()), ..Default::default() }).is_err());
        assert!(m.update(Patch { shortcut: Some("K".into()), ..Default::default() }).is_err());
        assert!(m.update(Patch { shortcut: Some("Nonsense+Key".into()), ..Default::default() }).is_err());
        assert!(m.update(Patch { shortcut: Some("F13".into()), ..Default::default() }).is_ok(), "F-keys may stand alone");
        assert!(validate("Fn").is_err());
    }

    #[test]
    fn disable_releases_and_enable_restores() {
        let os = FakeOs::default();
        let m = manager(&os, QuickCaptureConfig::default());
        m.start();
        let off = m.update(Patch { enabled: Some(false), ..Default::default() }).unwrap();
        assert!(!off.enabled && !off.registered);
        assert!(os.registered().is_empty());
        let on = m.update(Patch { enabled: Some(true), ..Default::default() }).unwrap();
        assert!(on.enabled && on.registered);
        assert_eq!(os.registered().len(), 1);
    }

    #[test]
    fn enabling_a_taken_default_reports_instead_of_failing_silently() {
        let os = FakeOs::default();
        os.take(config::default_shortcut());
        let m = manager(&os, QuickCaptureConfig { enabled: false, ..Default::default() });
        m.start();
        let status = m.update(Patch { enabled: Some(true), ..Default::default() }).unwrap();
        assert!(status.enabled && !status.registered);
        assert!(status.error.unwrap().contains("another application"));
    }

    #[test]
    fn pause_releases_while_recording_then_restores() {
        let os = FakeOs::default();
        let m = manager(&os, QuickCaptureConfig::default());
        m.start();
        assert!(!m.pause(true).registered);
        assert!(os.registered().is_empty());
        assert!(m.pause(false).registered);
        assert_eq!(os.registered().len(), 1);
    }

    #[test]
    fn a_shortcut_recorded_while_paused_is_still_checked_and_applied_on_resume() {
        let os = FakeOs::default();
        os.take("Ctrl+Alt+J");
        let m = manager(&os, QuickCaptureConfig::default());
        m.start();
        m.pause(true);
        assert!(m.update(Patch { shortcut: Some("Ctrl+Alt+J".into()), ..Default::default() }).is_err());
        assert!(os.registered().is_empty(), "trial registration leaves nothing behind");
        m.update(Patch { shortcut: Some("Ctrl+Alt+K".into()), ..Default::default() }).unwrap();
        assert!(os.registered().is_empty(), "still paused");
        let status = m.pause(false);
        assert!(status.registered && status.shortcut == "Ctrl+Alt+K");
        assert_eq!(os.registered(), vec!["Ctrl+Alt+K".to_string()]);
    }

    #[test]
    fn reset_restores_the_default_and_persists() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("quick-capture.json");
        let os = FakeOs::default();
        let m = ShortcutManager::new(os.clone(), Some(path.clone()), QuickCaptureConfig { enabled: false, shortcut: "Ctrl+Shift+K".into(), hide_on_blur: false });
        m.start();
        let status = m.reset();
        assert!(status.enabled && status.registered);
        assert_eq!(status.shortcut, config::default_shortcut());
        let saved = config::load(&path);
        assert_eq!(saved.shortcut, config::default_shortcut());
        assert!(saved.enabled);
        assert!(!saved.hide_on_blur, "reset only touches the shortcut");
    }

    #[test]
    fn preferences_are_restored_on_relaunch() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("quick-capture.json");
        let os = FakeOs::default();
        let first = ShortcutManager::new(os.clone(), Some(path.clone()), config::load(&path));
        first.start();
        first.update(Patch { shortcut: Some("Ctrl+Alt+K".into()), hide_on_blur: Some(false), ..Default::default() }).unwrap();
        first.shutdown();
        assert!(os.registered().is_empty(), "unregistered on shutdown");

        let second = ShortcutManager::new(os.clone(), Some(path.clone()), config::load(&path));
        let status = second.start();
        assert_eq!(status.shortcut, "Ctrl+Alt+K");
        assert!(!status.hide_on_blur);
        assert_eq!(os.registered(), vec!["Ctrl+Alt+K".to_string()]);
    }
}
