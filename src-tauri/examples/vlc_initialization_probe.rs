//! No GUI, media decoding, catalog access, or audible output.
fn main() -> Result<(), String> {
    let argument = std::env::args_os()
        .nth(1)
        .ok_or("Pass the bundled vlc directory")?;
    // Tauri resource_dir is canonical too. Do NOT normalize here: this must
    // exercise the production loader's handling of Windows verbatim paths.
    let directory = std::fs::canonicalize(argument).map_err(|error| error.to_string())?;
    galleryweb_lib::probe_vlc_runtime(&directory)?;
    println!(
        "PASS production libVLC initialization from canonical resource path: {}",
        directory.display()
    );
    Ok(())
}
