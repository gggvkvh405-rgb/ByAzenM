#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::Manager;

struct Server(Mutex<Option<Child>>);

fn spawn_server(app: &tauri::AppHandle) -> Option<Child> {
    let dir = app.path_resolver().resource_dir().unwrap_or_else(|| std::env::current_dir().ok()?);
    let mut cmd = Command::new("node");
    cmd.arg("server/index.js")
        .env("PORT", "3000")
        .env("DISABLE_SQLITE", "1")
        .env("DISABLE_MULTER", "1")
        .env("CBOPKA_OPEN_BROWSER", "0")
        .env("CLIENT_DIST_PATH", dir.join("../../client/dist"))
        .current_dir(dir.join("../.."));
    cmd.spawn().ok()
}

fn main() {
    tauri::Builder::default()
        .manage(Server(Mutex::new(None)))
        .setup(|app| {
            if let Some(child) = spawn_server(&app.handle()) {
                *app.state::<Server>().0.lock().unwrap() = Some(child);
            }
            let window = app.get_window("main").unwrap();
            // Give the local server a moment, then show a real window — not a browser tab.
            std::thread::sleep(std::time::Duration::from_millis(700));
            let _ = window.show();
            Ok(())
        })
        .on_window_event(|event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event.event() {
                if let Some(child) = event.window().app_handle().state::<Server>().0.lock().unwrap().as_mut() {
                    let _ = child.kill();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Cbopka");
}
