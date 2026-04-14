use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::Manager;

pub struct PythonSidecar(pub Mutex<Option<Child>>);

fn spawn_python() -> Child {
    Command::new("python")
        .args([
            "-m",
            "uvicorn",
            "main:app",
            "--host",
            "127.0.0.1",
            "--port",
            "8765",
        ])
        .current_dir("../python")
        .spawn()
        .expect("Failed to start Python sidecar. Is Python in PATH?")
}

#[tauri::command]
fn check_backend() -> bool {
    true
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let child = spawn_python();
            app.manage(PythonSidecar(Mutex::new(Some(child))));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let state = window.app_handle().state::<PythonSidecar>();
                if let Ok(mut guard) = state.0.lock() {
                    if let Some(mut child) = guard.take() {
                        let _ = child.kill();
                    }
                };
            }
        })
        .invoke_handler(tauri::generate_handler![check_backend])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
