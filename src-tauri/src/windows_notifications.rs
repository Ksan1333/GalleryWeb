use tauri::{AppHandle, Manager};

const TITLE_LIMIT: usize = 63;
const MESSAGE_LIMIT: usize = 255;

fn bounded_text(value: &str, limit: usize) -> String {
    value
        .trim()
        .chars()
        .filter(|character| !character.is_control() || *character == '\n')
        .take(limit)
        .collect()
}

#[cfg(windows)]
fn copy_utf16<const N: usize>(target: &mut [u16; N], value: &str) {
    let capacity = N.saturating_sub(1);
    let mut position = 0;
    for character in value.chars() {
        let mut encoded = [0_u16; 2];
        let units = character.encode_utf16(&mut encoded);
        if position + units.len() > capacity {
            break;
        }
        target[position..position + units.len()].copy_from_slice(units);
        position += units.len();
    }
}

#[cfg(windows)]
pub fn show(app: &AppHandle, title: &str, message: &str, tone: &str) -> Result<bool, String> {
    use std::{
        mem::size_of,
        sync::atomic::{AtomicU32, Ordering},
        time::Duration,
    };
    use windows_sys::Win32::{
        Foundation::HWND,
        UI::{
            Shell::{
                NIF_ICON, NIF_INFO, NIF_TIP, NIIF_ERROR, NIIF_INFO, NIIF_RESPECT_QUIET_TIME,
                NIIF_WARNING, NIM_ADD, NIM_DELETE, NIM_MODIFY, NOTIFYICONDATAW, Shell_NotifyIconW,
            },
            WindowsAndMessaging::{IDI_APPLICATION, LoadIconW},
        },
    };

    static NEXT_ID: AtomicU32 = AtomicU32::new(20_000);

    let title = bounded_text(title, TITLE_LIMIT);
    let message = bounded_text(message, MESSAGE_LIMIT);
    if title.is_empty() || message.is_empty() {
        return Err("Windows通知のタイトルと本文を入力してください".to_owned());
    }
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Windows通知を表示するアプリウィンドウが見つかりません".to_owned())?;
    let hwnd = window
        .hwnd()
        .map_err(|error| format!("Windows通知のウィンドウを取得できませんでした: {error}"))?;
    let hwnd = hwnd.0 as HWND;
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed).max(20_000);
    // SAFETY: IDI_APPLICATION is a system-owned icon resource and does not
    // need to be destroyed by this process.
    let icon = unsafe { LoadIconW(std::ptr::null_mut(), IDI_APPLICATION) };
    if icon.is_null() {
        return Err("Windows通知アイコンを準備できませんでした".to_owned());
    }

    let mut data = NOTIFYICONDATAW {
        cbSize: size_of::<NOTIFYICONDATAW>() as u32,
        hWnd: hwnd,
        uID: id,
        uFlags: NIF_ICON | NIF_TIP,
        hIcon: icon,
        ..Default::default()
    };
    copy_utf16(&mut data.szTip, "PixVault for Windows");
    // SAFETY: data contains the live Tauri HWND, a system icon and fully
    // initialized fixed-size UTF-16 buffers.
    if unsafe { Shell_NotifyIconW(NIM_ADD, &data) } == 0 {
        return Err("Windows通知を通知領域へ登録できませんでした".to_owned());
    }

    data.uFlags = NIF_INFO;
    data.dwInfoFlags = match tone {
        "error" => NIIF_ERROR,
        "warning" => NIIF_WARNING,
        _ => NIIF_INFO,
    } | NIIF_RESPECT_QUIET_TIME;
    copy_utf16(&mut data.szInfoTitle, &title);
    copy_utf16(&mut data.szInfo, &message);
    // SAFETY: the registered notification identity and all buffers remain
    // valid for the duration of this call. Explorer copies the strings.
    if unsafe { Shell_NotifyIconW(NIM_MODIFY, &data) } == 0 {
        // SAFETY: removes only the identity registered immediately above.
        unsafe { Shell_NotifyIconW(NIM_DELETE, &data) };
        return Err("Windows通知を表示できませんでした".to_owned());
    }

    let hwnd_value = hwnd as usize;
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(12));
        let cleanup = NOTIFYICONDATAW {
            cbSize: size_of::<NOTIFYICONDATAW>() as u32,
            hWnd: hwnd_value as HWND,
            uID: id,
            ..Default::default()
        };
        // SAFETY: removes the exact short-lived identity created above.
        unsafe { Shell_NotifyIconW(NIM_DELETE, &cleanup) };
    });
    Ok(true)
}

#[cfg(not(windows))]
pub fn show(_app: &AppHandle, title: &str, message: &str, _tone: &str) -> Result<bool, String> {
    if bounded_text(title, TITLE_LIMIT).is_empty()
        || bounded_text(message, MESSAGE_LIMIT).is_empty()
    {
        return Err("通知のタイトルと本文を入力してください".to_owned());
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notification_text_is_trimmed_bounded_and_control_safe() {
        assert_eq!(
            bounded_text("  完了\u{0000}\nしました  ", 8),
            "完了\nしました"
        );
        assert_eq!(bounded_text(&"a".repeat(100), 12).chars().count(), 12);
    }

    #[cfg(windows)]
    #[test]
    fn notification_utf16_never_splits_a_surrogate_pair() {
        let mut target = [0_u16; 3];
        copy_utf16(&mut target, "a😀b");
        assert_eq!(target, ['a' as u16, 0, 0]);
    }
}
