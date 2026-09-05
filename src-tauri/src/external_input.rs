use std::{
    collections::{HashSet, VecDeque},
    ffi::OsStr,
    path::Path,
    sync::Mutex,
};

use reqwest::Url;
use serde::Serialize;

use crate::{catalog, x_downloader};

pub const X_PROTOCOL_SCHEME: &str = "pixvault-x";
pub const MAX_PENDING_EXTERNAL_MEDIA: usize = 128;
const MAX_PENDING_X_URLS: usize = 32;
const MAX_EXTERNAL_ARGUMENTS_PER_BATCH: usize = 512;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalMediaInput {
    pub path: String,
    pub name: String,
    pub kind: String,
}

#[derive(Default)]
struct PendingExternalInput {
    pending_x_urls: VecDeque<String>,
    pending_media: VecDeque<ExternalMediaInput>,
}

#[derive(Default)]
pub struct ExternalInputState {
    pending: Mutex<PendingExternalInput>,
}

impl ExternalInputState {
    pub fn take_pending_x_url(&self) -> Result<Option<String>, String> {
        self.pending
            .lock()
            .map(|mut pending| pending.pending_x_urls.pop_front())
            .map_err(|_| "External input state is unavailable".to_owned())
    }

    /// Retains supported inputs from either the initial process arguments or a
    /// later single-instance callback. Unsupported arguments are deliberately
    /// ignored because Windows may include the executable or unrelated flags.
    /// Returns the number of media paths newly added to the bounded queue.
    pub fn ingest_arguments<I, S>(&self, arguments: I) -> Result<usize, String>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let mut x_urls = Vec::new();
        let mut media = Vec::new();
        for argument in arguments.into_iter().take(MAX_EXTERNAL_ARGUMENTS_PER_BATCH) {
            let argument = argument.as_ref();
            if let Some(x_url) = argument.to_str().and_then(parse_external_x_input) {
                x_urls.push(x_url);
                continue;
            }
            if let Some(input) = parse_external_media_input(argument) {
                media.push(input);
            }
        }

        let mut pending = self
            .pending
            .lock()
            .map_err(|_| "External input state is unavailable".to_owned())?;
        let mut seen_x_urls = pending
            .pending_x_urls
            .iter()
            .cloned()
            .collect::<HashSet<_>>();
        for x_url in x_urls {
            if pending.pending_x_urls.len() >= MAX_PENDING_X_URLS {
                break;
            }
            if seen_x_urls.insert(x_url.clone()) {
                pending.pending_x_urls.push_back(x_url);
            }
        }

        let mut seen = pending
            .pending_media
            .iter()
            .map(external_media_dedupe_key)
            .collect::<HashSet<_>>();
        let mut accepted = 0;
        for input in media {
            if pending.pending_media.len() >= MAX_PENDING_EXTERNAL_MEDIA {
                break;
            }
            if seen.insert(external_media_dedupe_key(&input)) {
                pending.pending_media.push_back(input);
                accepted += 1;
            }
        }
        Ok(accepted)
    }

    pub fn take_pending_external_media(&self) -> Result<Vec<ExternalMediaInput>, String> {
        self.pending
            .lock()
            .map(|mut pending| pending.pending_media.drain(..).collect())
            .map_err(|_| "External input state is unavailable".to_owned())
    }
}

/// Resolves a command-line value into a safe, catalog-supported media file.
/// Only an already existing absolute regular file is accepted. Canonicalizing
/// here gives every later consumer one stable path and prevents relative path
/// traversal from depending on the process working directory.
pub fn parse_external_media_input(value: &OsStr) -> Option<ExternalMediaInput> {
    let value = value.to_str()?;
    if value.chars().any(char::is_control) {
        return None;
    }
    let input = Path::new(value);
    if !input.is_absolute() {
        return None;
    }
    let canonical = std::fs::canonicalize(input).ok()?;
    if !canonical.is_file() {
        return None;
    }
    let path = canonical.to_str()?;
    let name = canonical.file_name()?.to_str()?;
    if path.chars().any(char::is_control) || name.chars().any(char::is_control) {
        return None;
    }
    let (kind, _, _) = catalog::classify_media(&canonical)?;
    Some(ExternalMediaInput {
        path: path.to_owned(),
        name: name.to_owned(),
        kind: kind.to_owned(),
    })
}

#[cfg(windows)]
fn external_media_dedupe_key(input: &ExternalMediaInput) -> String {
    input.path.to_lowercase()
}

#[cfg(not(windows))]
fn external_media_dedupe_key(input: &ExternalMediaInput) -> String {
    input.path.clone()
}

pub fn parse_external_x_input(value: &str) -> Option<String> {
    if let Ok(canonical) = x_downloader::canonical_post_url(value) {
        return Some(canonical);
    }
    let deep_link = Url::parse(value).ok()?;
    if deep_link.scheme() != X_PROTOCOL_SCHEME || deep_link.host_str() != Some("open") {
        return None;
    }
    let source = deep_link
        .query_pairs()
        .find_map(|(key, value)| (key == "url").then(|| value.into_owned()))?;
    x_downloader::canonical_post_url(&source).ok()
}

#[cfg(windows)]
pub fn register_windows_protocol() -> Result<(), String> {
    use std::{os::windows::ffi::OsStrExt, path::Path};
    use windows_sys::Win32::System::Registry::{
        HKEY, HKEY_CURRENT_USER, REG_SZ, RegCloseKey, RegCreateKeyW, RegSetValueExW,
    };

    fn wide(value: &std::ffi::OsStr) -> Vec<u16> {
        value.encode_wide().chain(std::iter::once(0)).collect()
    }

    fn set_value(subkey: &str, name: Option<&str>, value: &std::ffi::OsStr) -> Result<(), String> {
        let key_path = wide(std::ffi::OsStr::new(subkey));
        let value_name = name.map(|name| wide(std::ffi::OsStr::new(name)));
        let value = wide(value);
        let mut key: HKEY = std::ptr::null_mut();
        // SAFETY: All strings are NUL-terminated UTF-16, the output HKEY is
        // initialized by RegCreateKeyW, and the key is closed on every path.
        let created = unsafe { RegCreateKeyW(HKEY_CURRENT_USER, key_path.as_ptr(), &mut key) };
        if created != 0 {
            return Err(format!(
                "Cannot create the PixVault URL protocol key ({created})"
            ));
        }
        let name_pointer = value_name
            .as_ref()
            .map_or(std::ptr::null(), |name| name.as_ptr());
        let byte_length = u32::try_from(value.len().saturating_mul(size_of::<u16>()))
            .map_err(|_| "PixVault URL protocol value is too large".to_owned())?;
        // SAFETY: key is valid, name/value pointers remain alive for the call,
        // and byte_length includes the terminating UTF-16 NUL.
        let saved = unsafe {
            RegSetValueExW(
                key,
                name_pointer,
                0,
                REG_SZ,
                value.as_ptr().cast::<u8>(),
                byte_length,
            )
        };
        // SAFETY: key was returned by RegCreateKeyW above.
        unsafe { RegCloseKey(key) };
        if saved != 0 {
            return Err(format!("Cannot save the PixVault URL protocol ({saved})"));
        }
        Ok(())
    }

    let executable = std::env::current_exe()
        .map_err(|error| format!("Cannot resolve the PixVault executable: {error}"))?;
    let command = format!("\"{}\" \"%1\"", executable.display());
    let base = format!("Software\\Classes\\{X_PROTOCOL_SCHEME}");
    set_value(
        &base,
        None,
        std::ffi::OsStr::new("URL:PixVault X Downloader"),
    )?;
    set_value(&base, Some("URL Protocol"), std::ffi::OsStr::new(""))?;
    set_value(
        &format!("{base}\\DefaultIcon"),
        None,
        Path::new(&executable).as_os_str(),
    )?;
    set_value(
        &format!("{base}\\shell\\open\\command"),
        None,
        std::ffi::OsStr::new(&command),
    )
}

#[cfg(not(windows))]
pub fn register_windows_protocol() -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{
        ffi::{OsStr, OsString},
        fs,
        path::{Path, PathBuf},
        sync::Arc,
    };

    use super::*;

    fn media_file(directory: &Path, name: &str) -> PathBuf {
        let path = directory.join(name);
        fs::write(&path, b"external media fixture").expect("write external media fixture");
        path
    }

    #[test]
    fn accepts_direct_and_encoded_x_post_urls_only() {
        assert_eq!(
            parse_external_x_input("https://twitter.com/example/status/123"),
            Some("https://x.com/i/web/status/123".to_owned())
        );
        assert_eq!(
            parse_external_x_input(
                "pixvault-x://open?url=https%3A%2F%2Fx.com%2Fexample%2Fstatus%2F456"
            ),
            Some("https://x.com/i/web/status/456".to_owned())
        );
        assert_eq!(
            parse_external_x_input("pixvault-x://open?url=https://example.com"),
            None
        );
        assert_eq!(
            parse_external_x_input("pixvault-x://other?url=https://x.com/a/status/1"),
            None
        );
    }

    #[test]
    fn accepts_every_catalog_media_extension_and_reports_its_kind() {
        let directory = tempfile::tempdir().expect("temporary external media directory");
        let extensions = [
            ("jpg", "image"),
            ("jpeg", "image"),
            ("png", "image"),
            ("webp", "image"),
            ("bmp", "image"),
            ("heic", "image"),
            ("heif", "image"),
            ("avif", "image"),
            ("tif", "image"),
            ("tiff", "image"),
            ("gif", "gif"),
            ("mp4", "video"),
            ("m4v", "video"),
            ("mov", "video"),
            ("mkv", "video"),
            ("webm", "video"),
            ("avi", "video"),
            ("wmv", "video"),
            ("mpeg", "video"),
            ("mpg", "video"),
            ("ts", "video"),
            ("m2ts", "video"),
            ("pdf", "pdf"),
            ("zip", "zip"),
            ("cbz", "zip"),
        ];
        for (index, (extension, expected_kind)) in extensions.into_iter().enumerate() {
            let name = format!("fixture-{index}.{extension}");
            let path = media_file(directory.path(), &name);
            let parsed = parse_external_media_input(path.as_os_str())
                .unwrap_or_else(|| panic!("accept supported extension {extension}"));
            assert_eq!(parsed.name, name);
            assert_eq!(parsed.kind, expected_kind);
            assert_eq!(Path::new(&parsed.path), path.canonicalize().unwrap());
        }

        let uppercase = media_file(directory.path(), "UPPER.WEBP");
        assert_eq!(
            parse_external_media_input(uppercase.as_os_str())
                .expect("accept uppercase extension")
                .kind,
            "image"
        );
    }

    #[test]
    fn rejects_non_media_and_unsafe_command_line_values() {
        let directory = tempfile::tempdir().expect("temporary external media directory");
        let unsupported = media_file(directory.path(), "notes.txt");
        let missing = directory.path().join("missing.webp");
        let relative = Path::new("..").join("traversal.webp");
        let absolute_with_control = format!("{}\nphoto.webp", directory.path().display());

        assert!(parse_external_media_input(unsupported.as_os_str()).is_none());
        assert!(parse_external_media_input(missing.as_os_str()).is_none());
        assert!(parse_external_media_input(directory.path().as_os_str()).is_none());
        assert!(parse_external_media_input(relative.as_os_str()).is_none());
        assert!(parse_external_media_input(OsStr::new("--inspect")).is_none());
        assert!(parse_external_media_input(OsStr::new("file:///C:/photo.webp")).is_none());
        assert!(parse_external_media_input(OsStr::new("https://example.com/photo.webp")).is_none());
        assert!(parse_external_media_input(OsStr::new(&absolute_with_control)).is_none());
    }

    #[cfg(windows)]
    #[test]
    fn rejects_non_unicode_windows_arguments_without_lossy_conversion() {
        use std::os::windows::ffi::OsStringExt;

        let invalid = OsString::from_wide(&[
            u16::from(b'C'),
            u16::from(b':'),
            u16::from(b'\\'),
            0xd800,
            u16::from(b'.'),
            u16::from(b'j'),
            u16::from(b'p'),
            u16::from(b'g'),
        ]);
        assert!(parse_external_media_input(&invalid).is_none());
    }

    #[test]
    fn queues_unique_media_in_argument_order_and_drains_once() {
        let directory = tempfile::tempdir().expect("temporary external media directory");
        let first = media_file(directory.path(), "first.webp");
        let second = media_file(directory.path(), "second.gif");
        let third = media_file(directory.path(), "third.mp4");
        let arguments = vec![
            OsString::from("pixvault.exe"),
            first.clone().into_os_string(),
            second.clone().into_os_string(),
            first.into_os_string(),
            OsString::from("--flag"),
            third.clone().into_os_string(),
        ];
        let state = ExternalInputState::default();

        assert_eq!(state.ingest_arguments(arguments).unwrap(), 3);
        assert_eq!(
            state
                .ingest_arguments([second.as_os_str(), third.as_os_str()])
                .unwrap(),
            0
        );
        let queued = state.take_pending_external_media().unwrap();
        assert_eq!(
            queued
                .iter()
                .map(|item| item.name.as_str())
                .collect::<Vec<_>>(),
            ["first.webp", "second.gif", "third.mp4"]
        );
        assert!(state.take_pending_external_media().unwrap().is_empty());
    }

    #[test]
    fn bounds_the_pending_queue_and_accepts_more_after_it_is_drained() {
        let directory = tempfile::tempdir().expect("temporary external media directory");
        let paths = (0..MAX_PENDING_EXTERNAL_MEDIA + 7)
            .map(|index| media_file(directory.path(), &format!("{index:03}.jpg")))
            .collect::<Vec<_>>();
        let state = ExternalInputState::default();

        assert_eq!(
            state.ingest_arguments(&paths).unwrap(),
            MAX_PENDING_EXTERNAL_MEDIA
        );
        let queued = state.take_pending_external_media().unwrap();
        assert_eq!(queued.len(), MAX_PENDING_EXTERNAL_MEDIA);
        assert_eq!(queued.first().unwrap().name, "000.jpg");
        assert_eq!(queued.last().unwrap().name, "127.jpg");
        assert_eq!(
            state
                .ingest_arguments(paths[MAX_PENDING_EXTERNAL_MEDIA..].iter())
                .unwrap(),
            7
        );
    }

    #[test]
    fn queues_x_inputs_without_overwriting_an_earlier_request() {
        let directory = tempfile::tempdir().expect("temporary external media directory");
        let media = media_file(directory.path(), "photo.webp");
        let state = ExternalInputState::default();
        let first_x = OsString::from("pixvault-x://open?url=https://x.com/a/status/101");
        let later_x = OsString::from("https://twitter.com/b/status/202");

        assert_eq!(
            state
                .ingest_arguments([first_x.as_os_str(), media.as_os_str()])
                .unwrap(),
            1
        );
        state.ingest_arguments([later_x]).unwrap();
        assert_eq!(
            state.take_pending_x_url().unwrap(),
            Some("https://x.com/i/web/status/101".to_owned())
        );
        assert_eq!(
            state.take_pending_x_url().unwrap(),
            Some("https://x.com/i/web/status/202".to_owned())
        );
        assert_eq!(state.take_pending_external_media().unwrap().len(), 1);
        assert_eq!(state.take_pending_x_url().unwrap(), None);
    }

    #[test]
    fn reports_a_poisoned_queue_instead_of_panicking() {
        let state = Arc::new(ExternalInputState::default());
        let poison_target = Arc::clone(&state);
        let _ = std::thread::spawn(move || {
            let _pending = poison_target.pending.lock().expect("lock queue to poison");
            panic!("poison external input queue");
        })
        .join();

        assert!(state.take_pending_x_url().is_err());
        assert!(state.take_pending_external_media().is_err());
        assert!(
            state
                .ingest_arguments([OsString::from("--ignored")])
                .is_err()
        );
    }
}
