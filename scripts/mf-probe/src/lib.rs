// Compile and exercise the production COM implementation without the full app.
#![cfg(windows)]
#[path = "../../../src-tauri/src/mf_engine.rs"]
mod engine;
