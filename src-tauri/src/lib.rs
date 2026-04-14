use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandChild;

pub struct PythonSidecar(pub Mutex<Option<CommandChild>>);

#[tauri::command]
fn check_backend() -> bool {
    true
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let resource_path = app.path().resource_dir().expect("Failed to find resources");
            let binary_name = if cfg!(target_os = "windows") { "engine.exe" } else { "engine" };
            
            // To ensure compatibility during hot-reloading dev environments (`npm run tauri dev`), 
            // the backend folder won't be compiled unless we run `build_backend.py`. 
            // We will safely execute it.
            let binary_path = resource_path.join("backend").join("engine").join(binary_name);
            
            if binary_path.exists() {
                let (_rx, child) = app.shell().command(binary_path.to_str().unwrap())
                    .spawn()
                    .expect("Failed to start backend");
                app.manage(PythonSidecar(Mutex::new(Some(child))));
            } else {
                println!("WARNING: Backend binary not found. Standard dev mode active (assumes manual `python main.py`).");
                app.manage(PythonSidecar(Mutex::new(None)));
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let state = window.app_handle().state::<PythonSidecar>();
                if let Ok(mut guard) = state.0.lock() {
                    if let Some(child) = guard.take() {
                        let _ = child.kill();
                    }
                };
            }
        })
        .invoke_handler(tauri::generate_handler![check_backend])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
