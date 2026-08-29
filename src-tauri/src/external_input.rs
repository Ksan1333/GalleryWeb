use std::sync::Mutex;

use reqwest::Url;

use crate::x_downloader;

pub const X_PROTOCOL_SCHEME: &str = "pixvault-x";

#[derive(Default)]
pub struct ExternalInputState {
    pending_x_url: Mutex<Option<String>>,
}

impl ExternalInputState {
    pub fn from_process_arguments() -> Self {
        let pending_x_url = std::env::args_os()
            .skip(1)
            .filter_map(|argument| argument.to_str().map(ToOwned::to_owned))
            .find_map(|argument| parse_external_x_input(&argument));
        Self {
            pending_x_url: Mutex::new(pending_x_url),
        }
    }

    pub fn take_pending_x_url(&self) -> Result<Option<String>, String> {
        self.pending_x_url
            .lock()
            .map(|mut pending| pending.take())
            .map_err(|_| "External X URL state is unavailable".to_owned())
    }
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
    use super::*;

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
}
