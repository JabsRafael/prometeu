//! Capture only after an explicit click. macOS lets the person choose a window or cancel.
use crate::{i18n, paths};
use base64::{engine::general_purpose::STANDARD, Engine};

#[tauri::command]
pub async fn feedback_capture() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let directory =
            std::env::temp_dir().join(format!("prometeu-feedback-{}", uuid::Uuid::new_v4()));
        paths::ensure_private_dir(&directory).map_err(|_| i18n::t("feedback.captureError"))?;
        let file = directory.join("capture.png");
        let result = (|| {
            let output = std::process::Command::new("/usr/sbin/screencapture")
                .args(["-i", "-W", "-x", "-t", "png"])
                .arg(&file)
                .output()
                .map_err(|_| i18n::t("feedback.captureError"))?;
            if !output.status.success() {
                return Err(i18n::t("feedback.captureError"));
            }
            if !file.exists() {
                return Ok(None);
            }
            let bytes = std::fs::read(&file).map_err(|_| i18n::t("feedback.captureError"))?;
            if bytes.len() > 5 * 1024 * 1024 {
                return Err(i18n::t("feedback.invalidImage"));
            }
            Ok(Some(STANDARD.encode(bytes)))
        })();
        let _ = std::fs::remove_dir_all(directory);
        result
    })
    .await
    .map_err(|_| i18n::t("feedback.captureError"))?
}
