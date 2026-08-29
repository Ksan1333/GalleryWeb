use std::path::Path;

#[cfg(windows)]
use std::path::Prefix;

use crate::{
    catalog::{mark_media_recycled, resolve_library_folder, resolve_media_path_for_recycle},
    db::AppState,
    models::MutationResult,
};

pub fn open_library_folder_in_explorer(
    state: &AppState,
    root_id: &str,
    relative_path: &str,
) -> Result<(), String> {
    let target = resolve_library_folder(state, root_id, relative_path)?;
    open_explorer_target(&target, false)
}

pub fn reveal_media_in_explorer(state: &AppState, media_id: &str) -> Result<(), String> {
    let (_root, target) = resolve_media_path_for_recycle(state, media_id)?;
    open_explorer_target(&target, true)
}

#[cfg(windows)]
fn open_explorer_target(path: &Path, select_file: bool) -> Result<(), String> {
    use std::process::Command;

    let compatible = explorer_compatible_path(path);
    let mut command = Command::new("explorer.exe");
    if select_file {
        command.arg("/select,");
    }
    command.arg(&compatible);
    command.spawn().map_err(|error| {
        format!(
            "Windows エクスプローラーで {} を開けませんでした: {error}",
            compatible.display()
        )
    })?;
    Ok(())
}

#[cfg(windows)]
fn explorer_compatible_path(path: &Path) -> std::path::PathBuf {
    let value = path.to_string_lossy();
    if let Some(remainder) = value.strip_prefix(r"\\?\UNC\") {
        return std::path::PathBuf::from(format!(r"\\{remainder}"));
    }
    if let Some(remainder) = value.strip_prefix(r"\\?\") {
        return std::path::PathBuf::from(remainder);
    }
    path.to_path_buf()
}

#[cfg(target_os = "linux")]
fn open_explorer_target(path: &Path, select_file: bool) -> Result<(), String> {
    use std::process::Command;

    let target = if select_file {
        path.parent().unwrap_or(path)
    } else {
        path
    };
    Command::new("xdg-open")
        .arg(target)
        .spawn()
        .map_err(|error| {
            format!(
                "ファイルマネージャーで {} を開けませんでした: {error}",
                target.display()
            )
        })?;
    Ok(())
}

#[cfg(not(any(windows, target_os = "linux")))]
fn open_explorer_target(_path: &Path, _select_file: bool) -> Result<(), String> {
    Err("このOSではファイルマネージャー操作を利用できません。".to_owned())
}

pub fn recycle_media_item(state: &AppState, media_id: &str) -> Result<MutationResult, String> {
    let (_root, target) = resolve_media_path_for_recycle(state, media_id)?;
    ensure_recoverable_recycle_location(&target)?;

    // `trash::delete` invokes the operating system's recoverable trash operation. There is
    // intentionally no std::fs::remove_file fallback here: a recycle failure must stay visible.
    trash::delete(&target).map_err(|error| {
        format!(
            "{} をOSのごみ箱へ移動できませんでした。元ファイルは削除していません: {error}",
            target.display()
        )
    })?;
    mark_media_recycled(state, media_id)?;
    Ok(MutationResult { affected: 1 })
}

pub fn set_media_as_wallpaper(state: &AppState, media_id: &str) -> Result<(), String> {
    let (_root, target) = resolve_media_path_for_recycle(state, media_id)?;
    let extension = target
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if matches!(extension.as_str(), "jpg" | "jpeg" | "png" | "bmp") {
        return set_wallpaper_path(&target);
    }

    let metadata = target.metadata().map_err(|error| {
        format!(
            "Cannot inspect wallpaper image {}: {error}",
            target.display()
        )
    })?;
    if metadata.len() > 100 * 1024 * 1024 {
        return Err("Wallpaper source exceeds the 100 MB safety limit".to_owned());
    }
    let image = image::open(&target).map_err(|error| {
        format!(
            "Cannot decode wallpaper image {}: {error}",
            target.display()
        )
    })?;
    let cache_directory = state
        .database
        .path()
        .parent()
        .ok_or_else(|| "Application data directory is unavailable".to_owned())?
        .join("wallpapers");
    std::fs::create_dir_all(&cache_directory)
        .map_err(|error| format!("Cannot create wallpaper cache: {error}"))?;
    let safe_id: String = media_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '_'
            }
        })
        .collect();
    let converted = cache_directory.join(format!("{safe_id}.png"));
    image
        .save_with_format(&converted, image::ImageFormat::Png)
        .map_err(|error| format!("Cannot prepare Windows wallpaper: {error}"))?;
    set_wallpaper_path(&converted)
}

#[cfg(windows)]
fn set_wallpaper_path(path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SPI_SETDESKWALLPAPER, SPIF_SENDCHANGE, SPIF_UPDATEINIFILE, SystemParametersInfoW,
    };

    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if !matches!(extension.as_str(), "jpg" | "jpeg" | "png" | "bmp") {
        return Err("Windows wallpaper supports JPG, PNG, or BMP images".to_owned());
    }
    let mut wide_path = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    // SAFETY: wide_path is a writable, NUL-terminated UTF-16 path that remains alive for the call.
    let succeeded = unsafe {
        SystemParametersInfoW(
            SPI_SETDESKWALLPAPER,
            0,
            wide_path.as_mut_ptr().cast(),
            SPIF_UPDATEINIFILE | SPIF_SENDCHANGE,
        )
    };
    if succeeded == 0 {
        Err(format!(
            "Windows could not set {} as the desktop wallpaper",
            path.display()
        ))
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn set_wallpaper_path(_path: &Path) -> Result<(), String> {
    Err("Wallpaper changes are available only on Windows".to_owned())
}

#[cfg(windows)]
fn ensure_recoverable_recycle_location(path: &Path) -> Result<(), String> {
    use windows_sys::Win32::{
        Storage::FileSystem::GetDriveTypeW,
        System::WindowsProgramming::{DRIVE_FIXED, DRIVE_REMOVABLE},
    };

    let drive_letter = match path.components().next() {
        Some(std::path::Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::Disk(letter) | Prefix::VerbatimDisk(letter) => letter,
            Prefix::UNC(..) | Prefix::VerbatimUNC(..) => {
                return Err(
                    "Recycle Bin deletion is refused for network shares because recovery cannot be guaranteed"
                        .to_owned(),
                );
            }
            _ => {
                return Err(
                    "Recycle Bin deletion is refused for this unsupported Windows path".to_owned(),
                );
            }
        },
        _ => return Err("Recycle Bin deletion requires an absolute Windows drive path".to_owned()),
    };

    let root = [
        u16::from(drive_letter.to_ascii_uppercase()),
        u16::from(b':'),
        u16::from(b'\\'),
        0,
    ];
    // SAFETY: `root` is a valid, NUL-terminated UTF-16 drive root for GetDriveTypeW.
    let drive_type = unsafe { GetDriveTypeW(root.as_ptr()) };
    if drive_type != DRIVE_FIXED && drive_type != DRIVE_REMOVABLE {
        return Err(
            "Recycle Bin deletion is refused because this drive does not guarantee a recoverable local recycle operation"
                .to_owned(),
        );
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn ensure_recoverable_recycle_location(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("ごみ箱へ移動するには絶対パスが必要です".to_owned());
    }
    Ok(())
}

#[cfg(not(any(windows, target_os = "linux")))]
fn ensure_recoverable_recycle_location(_path: &Path) -> Result<(), String> {
    Err("このOSでは復元可能なごみ箱操作を利用できません".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn rejects_unc_recycle_targets() {
        let path = Path::new(r"\\server\share\image.jpg");
        assert!(ensure_recoverable_recycle_location(path).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn strips_verbatim_prefix_for_explorer() {
        assert_eq!(
            explorer_compatible_path(Path::new(r"\\?\C:\Users\Example\image.jpg")),
            Path::new(r"C:\Users\Example\image.jpg")
        );
        assert_eq!(
            explorer_compatible_path(Path::new(r"\\?\UNC\server\share\image.jpg")),
            Path::new(r"\\server\share\image.jpg")
        );
    }

    #[cfg(not(any(windows, target_os = "linux")))]
    #[test]
    fn rejects_recycle_on_other_platforms() {
        assert!(ensure_recoverable_recycle_location(Path::new("/tmp/image.jpg")).is_err());
    }
}
