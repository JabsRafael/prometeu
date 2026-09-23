//! Capture only after an explicit click. macOS lets the person choose a window or cancel.
//! Delivery goes through the Cloud with the account credential, which never leaves this process.
use crate::{cloud, i18n, paths};
use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::Method;
use serde::Serialize;
use serde_json::Value;
use std::{io::Read, path::Path, time::Duration};

const MAX_IMAGE_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Serialize)]
pub struct FeedbackImage {
    name: String,
    #[serde(rename = "type")]
    media_type: &'static str,
    data: String,
}

fn read_image(path: &Path) -> Result<FeedbackImage, String> {
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .and_then(|file| file.take(MAX_IMAGE_BYTES + 1).read_to_end(&mut bytes))
        .map_err(|_| i18n::t("feedback.invalidImage"))?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err(i18n::t("feedback.invalidImage"));
    }
    let media_type = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        "image/jpeg"
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        "image/webp"
    } else {
        return Err(i18n::t("feedback.invalidImage"));
    };
    Ok(FeedbackImage {
        name: path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("feedback")
            .to_string(),
        media_type,
        data: STANDARD.encode(bytes),
    })
}

#[tauri::command(async)]
pub async fn feedback_image(path: String) -> Result<FeedbackImage, String> {
    tauri::async_runtime::spawn_blocking(move || read_image(Path::new(&path)))
        .await
        .map_err(|_| i18n::t("feedback.invalidImage"))?
}

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
            if !capture(&file)? || !file.exists() {
                return Ok(None);
            }
            let bytes = std::fs::read(&file).map_err(|_| i18n::t("feedback.captureError"))?;
            if bytes.len() as u64 > MAX_IMAGE_BYTES {
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

/// Ok(false) means the person cancelled.
#[cfg(target_os = "macos")]
fn capture(file: &std::path::Path) -> Result<bool, String> {
    let output = std::process::Command::new("/usr/sbin/screencapture")
        .args(["-i", "-W", "-x", "-t", "png"])
        .arg(file)
        .output()
        .map_err(|_| i18n::t("feedback.captureError"))?;
    output
        .status
        .success()
        .then_some(true)
        .ok_or_else(|| i18n::t("feedback.captureError"))
}

/// Wayland only: slurp picks a region, grim captures it; Esc in slurp cancels.
#[cfg(not(target_os = "macos"))]
fn capture(file: &std::path::Path) -> Result<bool, String> {
    use crate::platform::has;
    let fail = || i18n::t("feedback.captureError");
    if std::env::var_os("WAYLAND_DISPLAY").is_none() || !has("slurp") || !has("grim") {
        return Err(fail());
    }
    let region = std::process::Command::new("slurp")
        .output()
        .map_err(|_| fail())?;
    let geometry = String::from_utf8_lossy(&region.stdout).trim().to_string();
    if !region.status.success() || geometry.is_empty() {
        return Ok(false);
    }
    let status = std::process::Command::new("grim")
        .args(["-t", "png", "-g", &geometry])
        .arg(file)
        .status()
        .map_err(|_| fail())?;
    status.success().then_some(true).ok_or_else(fail)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dropped_image_uses_signature_and_size_limit() {
        let directory =
            std::env::temp_dir().join(format!("prometeu-feedback-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let png = directory.join("print.bin");
        std::fs::write(&png, b"\x89PNG\r\n\x1a\ncontent").unwrap();
        let image = read_image(&png).unwrap();
        assert_eq!(image.media_type, "image/png");
        assert_eq!(image.name, "print.bin");
        let invalid = directory.join("invalid.png");
        std::fs::write(&invalid, b"not an image").unwrap();
        assert!(read_image(&invalid).is_err());
        let oversized = directory.join("oversized.png");
        let file = std::fs::File::create(&oversized).unwrap();
        file.set_len(MAX_IMAGE_BYTES + 1).unwrap();
        assert!(read_image(&oversized).is_err());
        let _ = std::fs::remove_dir_all(directory);
    }
}
