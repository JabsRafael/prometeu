//! Capture only after an explicit click. macOS lets the person choose a window or cancel.
//! Delivery goes through the Cloud with the account credential, which never leaves this process.
use crate::{cloud, i18n, paths};
use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::Method;
use serde_json::Value;
use std::time::Duration;

/// The Cloud forwards text and image to GitHub inside the request, so allow more than the usual
/// account call. Without an account the person is asked to connect one; nothing is sent.
#[tauri::command(async)]
pub async fn feedback_send(report: Value) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some((code, value)) = cloud::api(
            Method::POST,
            "/api/feedback",
            Some(report),
            Duration::from_secs(60),
        )?
        else {
            return Err(i18n::t("feedback.needAccount"));
        };
        match code {
            200 | 201 => Ok(()),
            401 => Err(i18n::t("feedback.needAccount")),
            429 => Err(i18n::t("feedback.rateLimit")),
            409 if value["error"] == "uncertain" => Err(i18n::ta(
                "feedback.uncertain",
                &[("id", value["id"].as_str().unwrap_or_default().into())],
            )),
            _ => Err(i18n::t("feedback.sendError")),
        }
    })
    .await
    .map_err(|_| i18n::t("feedback.sendError"))?
}

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
