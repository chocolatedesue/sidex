// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "linux")]
    {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    // `sidex --help` / `--version` / `--install-cli` must not open a window.
    let args: Vec<String> = std::env::args().skip(1).collect();
    if sidex_lib::cli::handle_early_cli(&args) {
        return;
    }

    sidex_lib::run();
}
