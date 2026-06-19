fn main() {
    let windows = tauri_build::WindowsAttributes::new().window_icon_path("C:/Users/masa/nexus_lingua_icon.ico");
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
        .expect("failed to run tauri-build");
}
