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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        if shortcut.key == Code::KeyT && shortcut.mods == Modifiers::ALT {
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
                        } else if shortcut.key == Code::KeyS && shortcut.mods == Modifiers::ALT {
                            // Snipping Tool を使った画像キャプチャ
                            trigger_snipping_tool(app.clone());
                        }
                    }
                })
                .build(),
        )
        .setup(|app| {
            // ショートカットの登録
            let shortcut_t = "Alt+T".parse::<Shortcut>().unwrap();
            let shortcut_s = "Alt+S".parse::<Shortcut>().unwrap();
            
            let _ = app.global_shortcut().register(shortcut_t);
            let _ = app.global_shortcut().register(shortcut_s);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![greet, start_capture])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
