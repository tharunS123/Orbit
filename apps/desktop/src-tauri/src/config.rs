//! Persisted Quick Capture preferences (`<app config dir>/quick-capture.json`).

use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::Path;

/// Default global shortcut. Mirrors `defaultQuickCaptureShortcut` in packages/shared/src/keyboard.ts.
pub fn default_shortcut() -> &'static str {
    if cfg!(target_os = "macos") {
        "Shift+Alt+Space"
    } else {
        "Ctrl+Alt+Space"
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct QuickCaptureConfig {
    pub enabled: bool,
    pub shortcut: String,
    pub hide_on_blur: bool,
}

impl Default for QuickCaptureConfig {
    fn default() -> Self {
        Self { enabled: true, shortcut: default_shortcut().to_string(), hide_on_blur: true }
    }
}

/// Load preferences; a missing or unreadable file falls back to defaults (never blocks startup).
pub fn load(path: &Path) -> QuickCaptureConfig {
    match fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str::<QuickCaptureConfig>(&raw)
            .ok()
            .filter(|c| !c.shortcut.trim().is_empty())
            .unwrap_or_default(),
        Err(_) => QuickCaptureConfig::default(),
    }
}

/// Save atomically (write a sibling temp file, then rename) so a crash can't leave half a file.
pub fn save(path: &Path, config: &QuickCaptureConfig) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(config)?)?;
    fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_the_platform_convention() {
        let c = QuickCaptureConfig::default();
        assert!(c.enabled && c.hide_on_blur);
        if cfg!(target_os = "macos") {
            assert_eq!(c.shortcut, "Shift+Alt+Space");
        } else {
            assert_eq!(c.shortcut, "Ctrl+Alt+Space");
        }
    }

    #[test]
    fn round_trips_and_survives_corruption() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("quick-capture.json");
        assert_eq!(load(&path), QuickCaptureConfig::default(), "missing file → defaults");

        let custom = QuickCaptureConfig { enabled: false, shortcut: "Ctrl+Shift+K".into(), hide_on_blur: false };
        save(&path, &custom).unwrap();
        assert_eq!(load(&path), custom);

        fs::write(&path, "{ not json").unwrap();
        assert_eq!(load(&path), QuickCaptureConfig::default(), "corrupt file → defaults");

        // Older files without newer fields keep what they have and default the rest.
        fs::write(&path, r#"{"shortcut":"Ctrl+Alt+K"}"#).unwrap();
        let partial = load(&path);
        assert_eq!(partial.shortcut, "Ctrl+Alt+K");
        assert!(partial.enabled && partial.hide_on_blur);
    }
}
