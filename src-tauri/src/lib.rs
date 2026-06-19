use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_global_shortcut::{Code, Modifiers, GlobalShortcutExt, Shortcut, ShortcutState};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

// 画像データをBase64エンコードするヘルパー
fn image_to_base64(img: tauri::image::Image) -> Result<String, String> {
    use base64::Engine;
    
    let width = img.width();
    let height = img.height();
    let rgba = img.rgba().to_vec();

    let image_buffer = image::RgbaImage::from_raw(width, height, rgba)
        .ok_or("Failed to create RgbaImage from raw data")?;

    let mut buffer = std::io::Cursor::new(Vec::new());
    image_buffer.write_to(&mut buffer, image::ImageFormat::Png).map_err(|e| e.to_string())?;

    let b64 = base64::engine::general_purpose::STANDARD.encode(buffer.into_inner());
    Ok(format!("data:image/png;base64,{}", b64))
}

// Windows標準のSnipping Tool(Win+Shift+S)を起動し、クリップボードを監視する
fn trigger_snipping_tool(app_handle: AppHandle) {
    std::thread::spawn(move || {
        // 1. クリップボードをクリアして、以前の画像が誤検出されないようにする
        let _ = app_handle.clipboard().clear();

        // 2. Win + Shift + S をエミュレート
        if let Ok(mut enigo) = enigo::Enigo::new(&enigo::Settings::default()) {
            use enigo::Keyboard;
            let _ = enigo.key(enigo::Key::Meta, enigo::Direction::Press);
            let _ = enigo.key(enigo::Key::Shift, enigo::Direction::Press);
            let _ = enigo.key(enigo::Key::S, enigo::Direction::Press);
            let _ = enigo.key(enigo::Key::S, enigo::Direction::Release);
            let _ = enigo.key(enigo::Key::Shift, enigo::Direction::Release);
            let _ = enigo.key(enigo::Key::Meta, enigo::Direction::Release);
        }

        // 3. クリップボードを監視（最大30秒）
        let start_time = Instant::now();
        let timeout = Duration::from_secs(30);

        // キャプチャUIが立ち上がるまでの余裕として少し待機
        std::thread::sleep(Duration::from_millis(500));

        while start_time.elapsed() < timeout {
            if let Ok(img) = app_handle.clipboard().read_image() {
                // 画像が取得できた場合
                if let Ok(b64) = image_to_base64(img) {
                    // フロントエンドに送信
                    let _ = app_handle.emit("image-captured", b64);
                    
                    // メインウィンドウを前面に表示
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.unminimize();
                        let _ = window.set_focus();
                    }
                }
                break; // 取得したらループを抜ける
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    });
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn start_capture(app_handle: AppHandle) {
    trigger_snipping_tool(app_handle);
}

// ショートカット状態を保持する構造体
struct ShortcutStateData {
    text_shortcut: String,
    capture_shortcut: String,
}

#[tauri::command]
fn update_shortcuts(app_handle: AppHandle, state: tauri::State<Mutex<ShortcutStateData>>, text: String, capture: String) -> Result<(), String> {
    let mut shortcuts = state.lock().unwrap();
    
    // 全て登録解除
    let _ = app_handle.global_shortcut().unregister_all();
    
    if let Ok(shortcut_t) = text.parse::<Shortcut>() {
        let _ = app_handle.global_shortcut().register(shortcut_t);
    }
    if let Ok(shortcut_s) = capture.parse::<Shortcut>() {
        let _ = app_handle.global_shortcut().register(shortcut_s);
    }
    
    shortcuts.text_shortcut = text;
    shortcuts.capture_shortcut = capture;
    
    Ok(())
}

#[tauri::command]
fn set_window_always_on_top(app_handle: AppHandle, always_on_top: bool) -> Result<(), String> {
    if let Some(window) = app_handle.get_webview_window("main") {
        window.set_always_on_top(always_on_top).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Mutex::new(ShortcutStateData {
            text_shortcut: "Alt+T".to_string(),
            capture_shortcut: "Alt+S".to_string(),
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        let state = app.state::<Mutex<ShortcutStateData>>();
                        let shortcuts = state.lock().unwrap();
                        
                        let text_shortcut = shortcuts.text_shortcut.parse::<Shortcut>();
                        let capture_shortcut = shortcuts.capture_shortcut.parse::<Shortcut>();

                        if let Ok(t_sc) = text_shortcut {
                            if shortcut == &t_sc {
                                // テキスト選択翻訳
                                let handle = app.clone();
                                std::thread::spawn(move || {
                                    if let Ok(mut enigo) = enigo::Enigo::new(&enigo::Settings::default()) {
                                        use enigo::Keyboard;
                                        let _ = enigo.key(enigo::Key::Control, enigo::Direction::Press);
                                        let _ = enigo.key(enigo::Key::C, enigo::Direction::Press);
                                        let _ = enigo.key(enigo::Key::C, enigo::Direction::Release);
                                        let _ = enigo.key(enigo::Key::Control, enigo::Direction::Release);
                                    }

                                    std::thread::sleep(Duration::from_millis(150));
                                    let text = handle.clipboard().read_text().unwrap_or_default();
                                    let _ = handle.emit("text-selected", text);

                                    if let Some(window) = handle.get_webview_window("main") {
                                        let _ = window.show();
                                        let _ = window.unminimize();
                                        let _ = window.set_focus();
                                    }
                                });
                                return;
                            }
                        }
                        
                        if let Ok(s_sc) = capture_shortcut {
                            if shortcut == &s_sc {
                                // Snipping Tool を使った画像キャプチャ
                                trigger_snipping_tool(app.clone());
                            }
                        }
                    }
                })
                .build(),
        )
        .setup(|app| {
            // 初期状態はフロントエンドから update_shortcuts が呼ばれるまでデフォルトを登録しない（またはデフォルトを登録する）
            // ここでは安全のため何もしない（フロントエンドの useEffect がすぐに呼び出す想定）
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![greet, start_capture, update_shortcuts, set_window_always_on_top])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
