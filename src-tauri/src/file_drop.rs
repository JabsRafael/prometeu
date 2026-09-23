//! Finder files already have paths; screenshot thumbnails provide promises. AppKit materializes
//! those promises before the UI attaches their paths.
use serde::Serialize;
#[cfg(target_os = "macos")]
use tauri::Window;
use tauri::{DragDropEvent, Emitter, PhysicalPosition, Webview, WebviewEvent};

#[derive(Clone, Default, Serialize)]
pub(crate) struct Drag {
    #[serde(rename = "type")]
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    position: Option<PhysicalPosition<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<String>,
    paths: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

pub fn install(app: &tauri::AppHandle) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        if let Some(view) = app.get_webview("main") {
            view.with_webview(|view| unsafe {
                // The handle belongs to WKWebView, an NSView subclass. This closure runs on the
                // main thread as required by AppKit.
                let view = &*view.inner().cast::<objc2_app_kit::NSView>();
                view.registerForDraggedTypes(
                    &objc2_app_kit::NSFilePromiseReceiver::readableDraggedTypes(),
                );
            })?;
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
    Ok(())
}

pub fn on_webview_event(webview: &Webview, event: &WebviewEvent) {
    if webview.label() != "main" {
        return;
    }
    // With unstable enabled, even Tauri's main webview is a WindowChild. Drag events bypass
    // WindowEvent listeners.
    let WebviewEvent::DragDrop(event) = event else {
        return;
    };
    let window = webview.window();
    let mut drag = Drag::default();
    match event {
        DragDropEvent::Enter { paths, position } => {
            drag.kind = "enter";
            drag.position = Some(*position);
            drag.paths = paths
                .iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect();
            #[cfg(target_os = "macos")]
            macos::capture();
        }
        DragDropEvent::Over { position } => {
            drag.kind = "over";
            drag.position = Some(*position);
        }
        DragDropEvent::Drop { paths, position } => {
            #[cfg(target_os = "macos")]
            if macos::receive(&window, *position) {
                return;
            }
            drag.kind = "drop";
            drag.position = Some(*position);
            drag.paths = paths
                .iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect();
        }
        DragDropEvent::Leave => {
            drag.kind = "leave";
            #[cfg(target_os = "macos")]
            macos::clear();
        }
        _ => return,
    }
    let _ = window.emit("file-drag", drag);
}

/// Clipboard files and images carry no path inside the webview. Materialize them like promised
/// drops so every attachment path reaching an agent comes from this Mac's private directory.
/// Tauri runs synchronous commands on the main thread, which AppKit requires for pasteboard reads;
/// only the current clipboard item is written, so the pause stays imperceptible.
#[tauri::command]
pub fn paste_files() -> Result<Vec<String>, String> {
    #[cfg(target_os = "macos")]
    return macos::paste();
    #[cfg(not(target_os = "macos"))]
    Ok(Vec::new())
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use objc2::{rc::Retained, ClassType};
    use objc2_app_kit::{
        NSBitmapImageFileType, NSBitmapImageRep, NSFilePromiseReceiver, NSPasteboard,
        NSPasteboardNameDrag, NSPasteboardTypePNG, NSPasteboardTypeTIFF,
    };
    use objc2_foundation::{NSArray, NSDictionary, NSError, NSOperationQueue, NSString, NSURL};
    use std::{
        cell::RefCell,
        path::Path,
        ptr::NonNull,
        sync::mpsc,
        time::{Duration, Instant},
    };

    thread_local! {
        // Window and AppKit events run on the main thread. Retain promise receivers for the gesture
        // instead of querying a later pasteboard.
        static RECEIVERS: RefCell<Vec<Retained<NSFilePromiseReceiver>>> = const { RefCell::new(Vec::new()) };
    }

    fn promises(pasteboard: &NSPasteboard) -> Vec<Retained<NSFilePromiseReceiver>> {
        let classes = NSArray::from_slice(&[NSFilePromiseReceiver::class()]);
        // The requested class implements NSPasteboardReading and requires no options.
        unsafe { pasteboard.readObjectsForClasses_options(&classes, None) }
            .map(|objects| {
                objects
                    .into_iter()
                    .filter_map(|object| object.downcast().ok())
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn capture() {
        let pasteboard = NSPasteboard::pasteboardWithName(unsafe { NSPasteboardNameDrag });
        RECEIVERS.with(|receivers| *receivers.borrow_mut() = promises(&pasteboard));
    }

    pub fn clear() {
        RECEIVERS.with(|receivers| receivers.borrow_mut().clear());
    }

    fn received_path(url: &NSURL, directory: &Path) -> Result<String, String> {
        let path = url
            .path()
            .filter(|_| url.isFileURL())
            .ok_or("chat.drop.failed")?;
        let path = std::path::PathBuf::from(path.to_string())
            .canonicalize()
            .map_err(|e| e.to_string())?;
        let root = directory.canonicalize().map_err(|e| e.to_string())?;
        if !path.starts_with(root) || !path.is_file() {
            return Err("chat.drop.failed".into());
        }
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
        Ok(path.to_string_lossy().into_owned())
    }

    /// Files copied in Finder already exist; keep their own paths instead of duplicating them.
    fn copied_files(pasteboard: &NSPasteboard) -> Vec<String> {
        let classes = NSArray::from_slice(&[NSURL::class()]);
        unsafe { pasteboard.readObjectsForClasses_options(&classes, None) }
            .map(|objects| {
                objects
                    .into_iter()
                    .filter_map(|object| {
                        let url: Retained<NSURL> = object.downcast().ok()?;
                        url.path().filter(|_| url.isFileURL())
                    })
                    .map(|path| path.to_string())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Screenshots and image editors often publish TIFF only. Agents read PNG, so convert once here
    /// rather than handing a format the CLI rejects.
    fn copied_png(pasteboard: &NSPasteboard) -> Option<Vec<u8>> {
        if let Some(png) = pasteboard.dataForType(unsafe { NSPasteboardTypePNG }) {
            return Some(png.to_vec());
        }
        let tiff = pasteboard.dataForType(unsafe { NSPasteboardTypeTIFF })?;
        let rep = NSBitmapImageRep::imageRepWithData(&tiff)?;
        let png = unsafe {
            rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())
        }?;
        Some(png.to_vec())
    }

    pub fn paste() -> Result<Vec<String>, String> {
        let pasteboard = NSPasteboard::generalPasteboard();
        let files = copied_files(&pasteboard);
        if !files.is_empty() {
            return Ok(files);
        }
        let Some(png) = copied_png(&pasteboard) else {
            return Ok(Vec::new());
        };
        let directory = crate::paths::root()
            .join("attachments")
            .join(uuid::Uuid::new_v4().to_string());
        let file = directory.join("pasted.png");
        crate::paths::write_private_bytes(&file, &png)?;
        Ok(vec![file.to_string_lossy().into_owned()])
    }

    pub fn receive(window: &Window, position: PhysicalPosition<f64>) -> bool {
        let receivers = RECEIVERS.with(|receivers| receivers.take());
        if receivers.is_empty() {
            return false;
        }
        let id = uuid::Uuid::new_v4().to_string();
        let directory = crate::paths::root().join("attachments").join(&id);
        let mut drag = Drag {
            kind: "pending",
            position: Some(position),
            id: Some(id),
            ..Drag::default()
        };
        let _ = window.emit("file-drag", &drag);
        drag.kind = "received";
        if let Err(error) = crate::paths::ensure_private_dir(&directory) {
            drag.error = Some(error);
            let _ = window.emit("file-drag", drag);
            return true;
        }
        let destination = NSURL::fileURLWithPath_isDirectory(
            &NSString::from_str(&directory.to_string_lossy()),
            true,
        );
        let queue = NSOperationQueue::new();
        let (send, receive) = mpsc::channel();
        let mut count = 0;
        for receiver in receivers {
            let send = send.clone();
            let directory = directory.clone();
            let keep_receiver = receiver.clone();
            let reader = block2::RcBlock::new(move |url: NonNull<NSURL>, error: *mut NSError| {
                let _keep_alive = &keep_receiver;
                // AppKit guarantees URL and error validity during the callback. Copy only strings
                // so Cocoa objects never cross threads.
                let result = unsafe {
                    if let Some(error) = error.as_ref() {
                        Err(error.localizedDescription().to_string())
                    } else {
                        received_path(url.as_ref(), &directory)
                    }
                };
                let _ = send.send(result);
            });
            unsafe {
                receiver.receivePromisedFilesAtDestination_options_operationQueue_reader(
                    &destination,
                    &NSDictionary::new(),
                    &queue,
                    &reader,
                );
            }
            // fileNames becomes available only after requesting the promise. A legacy promise may
            // provide multiple files for one item.
            count += receiver.fileNames().len().max(1);
        }
        drop(send);
        let window = window.clone();
        std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(30);
            for _ in 0..count {
                match receive.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                    Ok(Ok(path)) => drag.paths.push(path),
                    Ok(Err(error)) => drag.error = Some(error),
                    Err(_) => {
                        drag.error = Some("chat.drop.failed".into());
                        break;
                    }
                }
            }
            let _ = window.emit("file-drag", drag);
        });
        true
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn received_files_must_exist_inside_the_destination() {
            let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
            std::fs::create_dir(&root).unwrap();
            let file = root.join("Captura de Tela.png");
            std::fs::write(&file, b"captura").unwrap();
            let url = NSURL::fileURLWithPath(&NSString::from_str(&file.to_string_lossy()));
            assert!(received_path(&url, &root)
                .unwrap()
                .ends_with("Captura de Tela.png"));
            let destination = root.join("destino");
            std::fs::create_dir(&destination).unwrap();
            assert!(received_path(&url, &destination).is_err());
            let link = destination.join("atalho.png");
            std::os::unix::fs::symlink(&file, &link).unwrap();
            let link_url = NSURL::fileURLWithPath(&NSString::from_str(&link.to_string_lossy()));
            assert!(received_path(&link_url, &destination).is_err());
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(file).unwrap().permissions().mode() & 0o777,
                0o600
            );
            std::fs::remove_dir_all(root).unwrap();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn promises_preserve_the_id_from_start_to_received_file() {
        let mut drag = Drag {
            kind: "pending",
            id: Some("captura".into()),
            position: Some(PhysicalPosition::new(120.0, 340.0)),
            ..Drag::default()
        };
        let start = serde_json::to_value(&drag).unwrap();
        assert_eq!(start["type"], "pending");
        assert_eq!(start["position"]["x"], 120.0);
        drag.kind = "received";
        drag.paths.push("/tmp/captura.png".into());
        let end = serde_json::to_value(&drag).unwrap();
        assert_eq!(start["id"], end["id"]);
        assert_eq!(end["paths"][0], "/tmp/captura.png");
    }
}
