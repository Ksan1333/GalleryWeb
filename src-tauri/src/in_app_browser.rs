use std::net::IpAddr;

use serde::Deserialize;
use tauri::{
    LogicalPosition, LogicalSize, Manager, Position, Rect, Size, Url, WebviewUrl,
    webview::{NewWindowResponse, WebviewBuilder},
};

const BROWSER_WEBVIEW_LABEL: &str = "pixvault-web-browser";
const MAIN_WINDOW_LABEL: &str = "main";
const MIN_BROWSER_WIDTH: f64 = 240.0;
const MIN_BROWSER_HEIGHT: f64 = 160.0;

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

fn is_internal_host(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".localhost") {
        return true;
    }
    let address_host = host
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(&host);
    let Ok(address) = address_host.parse::<IpAddr>() else {
        return false;
    };
    match address {
        IpAddr::V4(address) => {
            address.is_loopback()
                || address.is_private()
                || address.is_link_local()
                || address.is_broadcast()
                || address.is_unspecified()
        }
        IpAddr::V6(address) => {
            let first_segment = address.segments()[0];
            address.is_loopback()
                || address.is_unspecified()
                || first_segment & 0xfe00 == 0xfc00
                || first_segment & 0xffc0 == 0xfe80
        }
    }
}

fn is_safe_web_url(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some_and(|host| !is_internal_host(host))
        && url.username().is_empty()
        && url.password().is_none()
}

fn validate_web_url(value: &str) -> Result<Url, String> {
    let url = value
        .trim()
        .parse::<Url>()
        .map_err(|_| "有効なWebページのURLではありません。".to_owned())?;

    if !is_safe_web_url(&url) {
        return Err(
            "アプリ内ブラウザーで開けるのは、認証情報を含まず、PC内部を参照しない http:// または https:// URLだけです。"
                .to_owned(),
        );
    }

    Ok(url)
}

fn is_allowed_navigation(url: &Url) -> bool {
    is_safe_web_url(url)
}

fn validated_browser_bounds(window: &tauri::Window, bounds: BrowserBounds) -> Result<Rect, String> {
    if !bounds.x.is_finite()
        || !bounds.y.is_finite()
        || !bounds.width.is_finite()
        || !bounds.height.is_finite()
    {
        return Err("ブラウザーの表示領域が不正です。".to_owned());
    }

    let scale_factor = window
        .scale_factor()
        .map_err(|error| format!("画面の拡大率を取得できませんでした: {error}"))?;
    let inner_size = window
        .inner_size()
        .map_err(|error| format!("アプリの表示領域を取得できませんでした: {error}"))?
        .to_logical::<f64>(scale_factor);

    let x = bounds.x.clamp(0.0, inner_size.width);
    let y = bounds.y.clamp(0.0, inner_size.height);
    let available_width = (inner_size.width - x).max(0.0);
    let available_height = (inner_size.height - y).max(0.0);
    let width = bounds.width.clamp(0.0, available_width);
    let height = bounds.height.clamp(0.0, available_height);

    if width < MIN_BROWSER_WIDTH || height < MIN_BROWSER_HEIGHT {
        return Err("アプリ内ブラウザーの表示領域が小さすぎます。".to_owned());
    }

    Ok(Rect {
        position: Position::Logical(LogicalPosition::new(x, y)),
        size: Size::Logical(LogicalSize::new(width, height)),
    })
}

fn embedded_browser(app: &tauri::AppHandle) -> Result<tauri::Webview, String> {
    app.get_webview(BROWSER_WEBVIEW_LABEL)
        .ok_or_else(|| "アプリ内ブラウザーが開いていません。".to_owned())
}

#[tauri::command]
pub(crate) async fn open_in_app_browser(
    app: tauri::AppHandle,
    url: String,
    bounds: BrowserBounds,
) -> Result<(), String> {
    let url = validate_web_url(&url)?;
    let main = app
        .get_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "PixVaultのメイン画面が見つかりません。".to_owned())?;
    let bounds = validated_browser_bounds(&main, bounds)?;

    if let Some(browser) = app.get_webview(BROWSER_WEBVIEW_LABEL) {
        browser.set_bounds(bounds).map_err(|error| {
            format!("アプリ内ブラウザーの表示領域を更新できませんでした: {error}")
        })?;
        browser
            .navigate(url)
            .map_err(|error| format!("アプリ内ブラウザーを移動できませんでした: {error}"))?;
        browser
            .show()
            .map_err(|error| format!("アプリ内ブラウザーを表示できませんでした: {error}"))?;
        browser
            .set_focus()
            .map_err(|error| format!("アプリ内ブラウザーを前面に出せませんでした: {error}"))?;
        return Ok(());
    }

    // Keep new-tab links inside the embedded browser and visually align remote
    // pages with PixVault. This script is installed for every top-level navigation.
    const EMBEDDED_BROWSER_SCRIPT: &str = r#"
      (() => {
        const installScrollbarTheme = () => {
          if (!document.documentElement || document.getElementById("pixvault-browser-theme")) return;
          const style = document.createElement("style");
          style.id = "pixvault-browser-theme";
          style.textContent = `
            :root { color-scheme: dark; }
            * {
              scrollbar-width: thin !important;
              scrollbar-color: rgba(162, 116, 220, .72) rgba(15, 12, 21, .9) !important;
            }
            *::-webkit-scrollbar { width: 10px !important; height: 10px !important; }
            *::-webkit-scrollbar-track { background: rgba(15, 12, 21, .9) !important; }
            *::-webkit-scrollbar-thumb {
              border: 2px solid rgba(15, 12, 21, .9) !important;
              border-radius: 999px !important;
              background: linear-gradient(180deg, #a878e4, #67418f) !important;
            }
            *::-webkit-scrollbar-corner { background: rgba(15, 12, 21, .9) !important; }
          `;
          document.documentElement.appendChild(style);
        };
        installScrollbarTheme();
        document.addEventListener("DOMContentLoaded", installScrollbarTheme, { once: true });
        window.addEventListener("click", (event) => {
          const element = event.target instanceof Element
            ? event.target.closest("a[target]")
            : null;
          if (element) element.setAttribute("target", "_self");
        }, true);
      })();
    "#;

    let builder = WebviewBuilder::new(BROWSER_WEBVIEW_LABEL, WebviewUrl::External(url))
        .initialization_script(EMBEDDED_BROWSER_SCRIPT)
        .on_navigation(is_allowed_navigation)
        .on_new_window(|_, _| NewWindowResponse::Deny);

    let browser = main
        .add_child(builder, bounds.position, bounds.size)
        .map_err(|error| format!("アプリ内ブラウザーを開けませんでした: {error}"))?;
    browser
        .set_focus()
        .map_err(|error| format!("アプリ内ブラウザーを前面に出せませんでした: {error}"))?;

    Ok(())
}

#[tauri::command]
pub(crate) async fn get_in_app_browser_url(app: tauri::AppHandle) -> Result<String, String> {
    let browser = embedded_browser(&app)?;
    let url = browser
        .url()
        .map_err(|error| format!("現在ページのURLを取得できませんでした: {error}"))?;
    validate_web_url(url.as_str()).map(|url| url.to_string())
}

#[tauri::command]
pub(crate) async fn set_in_app_browser_bounds(
    app: tauri::AppHandle,
    bounds: BrowserBounds,
) -> Result<(), String> {
    let main = app
        .get_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "PixVaultのメイン画面が見つかりません。".to_owned())?;
    let bounds = validated_browser_bounds(&main, bounds)?;
    let browser = embedded_browser(&app)?;
    browser
        .set_bounds(bounds)
        .map_err(|error| format!("アプリ内ブラウザーの表示領域を更新できませんでした: {error}"))
}

#[tauri::command]
pub(crate) async fn control_in_app_browser(
    app: tauri::AppHandle,
    action: String,
) -> Result<(), String> {
    let browser = embedded_browser(&app)?;
    match action.as_str() {
        "back" => browser
            .eval("history.back()")
            .map_err(|error| format!("前のページへ戻れませんでした: {error}")),
        "forward" => browser
            .eval("history.forward()")
            .map_err(|error| format!("次のページへ進めませんでした: {error}")),
        "reload" => browser
            .reload()
            .map_err(|error| format!("ページを再読み込みできませんでした: {error}")),
        _ => Err("未対応のブラウザー操作です。".to_owned()),
    }
}

#[tauri::command]
pub(crate) async fn close_in_app_browser(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(browser) = app.get_webview(BROWSER_WEBVIEW_LABEL) {
        browser
            .close()
            .map_err(|error| format!("アプリ内ブラウザーを閉じられませんでした: {error}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{BrowserBounds, is_allowed_navigation, validate_web_url};

    #[test]
    fn accepts_regular_http_and_https_pages() {
        let https =
            validate_web_url("https://www.google.com/search?q=pixvault").expect("https URL");
        let http = validate_web_url("http://example.com/profile").expect("http URL");
        assert!(is_allowed_navigation(&https));
        assert!(is_allowed_navigation(&http));
    }

    #[test]
    fn rejects_non_web_and_credential_urls() {
        assert!(validate_web_url("file:///C:/secret.txt").is_err());
        assert!(validate_web_url("javascript:alert(1)").is_err());
        assert!(validate_web_url("https://user:password@example.com/").is_err());
        assert!(validate_web_url("not a url").is_err());
    }

    #[test]
    fn rejects_internal_and_private_network_origins() {
        assert!(validate_web_url("http://localhost/").is_err());
        assert!(validate_web_url("https://tauri.localhost/index.html").is_err());
        assert!(validate_web_url("http://127.0.0.1:1420/").is_err());
        assert!(validate_web_url("http://192.168.1.1/").is_err());
        assert!(validate_web_url("http://[::1]/").is_err());
        assert!(validate_web_url("http://[fe80::1]/").is_err());
    }

    #[test]
    fn browser_bounds_reject_non_finite_values_before_window_access() {
        let bounds = BrowserBounds {
            x: f64::NAN,
            y: 0.0,
            width: 800.0,
            height: 600.0,
        };
        assert!(!bounds.x.is_finite());
    }
}
