use std::{io::Read, time::Duration};

use reqwest::{
    Url,
    blocking::{Client, Response},
    redirect::Policy,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

const MAX_QUERY_CHARS: usize = 256;
const MAX_RESPONSE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_RESULTS: usize = 16;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(9);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(4);
const USER_AGENT: &str = "PixVault-for-Windows/0.1 (+local desktop search)";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchResult {
    pub url: String,
    pub title: String,
    pub snippet: Option<String>,
    pub display_url: String,
    pub thumbnail_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct BingRss {
    channel: BingChannel,
}

#[derive(Debug, Deserialize)]
struct BingChannel {
    #[serde(default)]
    item: Vec<BingItem>,
}

#[derive(Debug, Deserialize)]
struct BingItem {
    #[serde(default)]
    title: String,
    #[serde(default)]
    link: String,
    #[serde(default)]
    description: String,
}

pub fn search_web(query: &str, mode: Option<&str>) -> Result<Vec<WebSearchResult>, String> {
    let query = validate_query(query)?;
    let mode = match mode.unwrap_or("web").trim().to_ascii_lowercase().as_str() {
        "web" => "web",
        "image" => "image",
        _ => return Err("Search mode must be either 'web' or 'image'.".to_owned()),
    };

    if let Some(result) = direct_url_result(query)? {
        return Ok(vec![result]);
    }

    let client = Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .redirect(Policy::limited(2))
        .user_agent(USER_AGENT)
        .build()
        .map_err(|error| format!("Could not initialize web search: {error}"))?;

    if mode == "image" {
        search_wikimedia_images(&client, query)
    } else {
        search_bing_rss(&client, query)
    }
}

fn validate_query(query: &str) -> Result<&str, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("検索語またはURLを入力してください。".to_owned());
    }
    if query.chars().count() > MAX_QUERY_CHARS {
        return Err(format!(
            "検索語は{MAX_QUERY_CHARS}文字以内で入力してください。"
        ));
    }
    if query.chars().any(|character| character.is_control()) {
        return Err("検索語に制御文字は使用できません。".to_owned());
    }
    Ok(query)
}

fn direct_url_result(query: &str) -> Result<Option<WebSearchResult>, String> {
    if !looks_like_url(query) {
        return Ok(None);
    }
    let url = safe_http_url(query)?;
    let display_url = display_url(&url);
    let title = url
        .host_str()
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| display_url.clone());
    Ok(Some(WebSearchResult {
        url: url.into(),
        title,
        snippet: Some("入力されたURLを選択できます。ページ内容は自動取得していません。".to_owned()),
        display_url,
        thumbnail_url: None,
    }))
}

fn looks_like_url(value: &str) -> bool {
    let Some((scheme, remainder)) = value.split_once(':') else {
        return false;
    };
    if scheme.is_empty()
        || !scheme
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "+-.".contains(character))
    {
        return false;
    }

    let scheme = scheme.to_ascii_lowercase();
    matches!(
        scheme.as_str(),
        "http" | "https" | "javascript" | "data" | "file" | "vbscript" | "ftp" | "mailto"
    ) || remainder.starts_with("//")
}

fn search_bing_rss(client: &Client, query: &str) -> Result<Vec<WebSearchResult>, String> {
    let mut endpoint = Url::parse("https://www.bing.com/search")
        .map_err(|error| format!("Search endpoint is invalid: {error}"))?;
    endpoint
        .query_pairs_mut()
        .append_pair("format", "rss")
        .append_pair("q", query)
        .append_pair("count", &MAX_RESULTS.to_string());

    let response = client
        .get(endpoint)
        .header(
            "Accept",
            "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8",
        )
        .send()
        .map_err(|error| network_error("Web search request failed", error))?;
    ensure_provider_response(&response, &["www.bing.com", "bing.com"])?;
    let payload = read_limited_response(response)?;
    parse_bing_rss(&payload)
}

fn search_wikimedia_images(client: &Client, query: &str) -> Result<Vec<WebSearchResult>, String> {
    let mut endpoint = Url::parse("https://commons.wikimedia.org/w/api.php")
        .map_err(|error| format!("Image search endpoint is invalid: {error}"))?;
    endpoint
        .query_pairs_mut()
        .append_pair("action", "query")
        .append_pair("generator", "search")
        .append_pair("gsrsearch", query)
        .append_pair("gsrnamespace", "6")
        .append_pair("gsrlimit", &MAX_RESULTS.to_string())
        .append_pair("prop", "imageinfo")
        .append_pair("iiprop", "url|mime")
        .append_pair("iiurlwidth", "360")
        .append_pair("format", "json")
        .append_pair("formatversion", "2");

    let response = client
        .get(endpoint)
        .header("Accept", "application/json")
        .send()
        .map_err(|error| network_error("Image search request failed", error))?;
    ensure_provider_response(&response, &["commons.wikimedia.org"])?;
    let payload = read_limited_response(response)?;
    parse_wikimedia_images(&payload)
}

fn ensure_provider_response(response: &Response, allowed_hosts: &[&str]) -> Result<(), String> {
    if !response.status().is_success() {
        return Err(format!(
            "検索サービスがHTTP {}を返しました。",
            response.status().as_u16()
        ));
    }
    let host = response.url().host_str().unwrap_or_default();
    if !allowed_hosts
        .iter()
        .any(|allowed| host.eq_ignore_ascii_case(allowed))
    {
        return Err("検索サービスが許可されていないURLへ転送しました。".to_owned());
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES)
    {
        return Err("検索結果の応答サイズが上限を超えました。".to_owned());
    }
    Ok(())
}

fn read_limited_response(response: Response) -> Result<Vec<u8>, String> {
    let mut payload = Vec::new();
    response
        .take(MAX_RESPONSE_BYTES + 1)
        .read_to_end(&mut payload)
        .map_err(|error| format!("検索結果を読み取れませんでした: {error}"))?;
    if payload.len() as u64 > MAX_RESPONSE_BYTES {
        return Err("検索結果の応答サイズが上限を超えました。".to_owned());
    }
    Ok(payload)
}

fn parse_bing_rss(payload: &[u8]) -> Result<Vec<WebSearchResult>, String> {
    let xml = std::str::from_utf8(payload)
        .map_err(|_| "検索サービスが不正な文字コードを返しました。".to_owned())?;
    let rss: BingRss = quick_xml::de::from_str(xml)
        .map_err(|error| format!("検索結果XMLを解析できませんでした: {error}"))?;
    let mut results = Vec::new();

    for item in rss.channel.item {
        let Ok(url) = safe_http_url(item.link.trim()) else {
            continue;
        };
        if results
            .iter()
            .any(|result: &WebSearchResult| result.url == url.as_str())
        {
            continue;
        }
        let display_url = display_url(&url);
        let title = plain_text(&item.title, 180);
        let snippet = plain_text(&item.description, 420);
        results.push(WebSearchResult {
            url: url.into(),
            title: if title.is_empty() {
                display_url.clone()
            } else {
                title
            },
            snippet: (!snippet.is_empty()).then_some(snippet),
            display_url,
            thumbnail_url: None,
        });
        if results.len() >= MAX_RESULTS {
            break;
        }
    }
    Ok(results)
}

fn parse_wikimedia_images(payload: &[u8]) -> Result<Vec<WebSearchResult>, String> {
    let value: Value = serde_json::from_slice(payload)
        .map_err(|error| format!("画像検索結果JSONを解析できませんでした: {error}"))?;
    if let Some(message) = value
        .get("error")
        .and_then(|error| error.get("info"))
        .and_then(Value::as_str)
    {
        return Err(format!(
            "画像検索サービスからエラーが返されました: {message}"
        ));
    }

    let pages: Vec<&Value> = match value.pointer("/query/pages") {
        Some(Value::Array(pages)) => pages.iter().collect(),
        Some(Value::Object(pages)) => pages.values().collect(),
        _ => Vec::new(),
    };
    let mut results = Vec::new();

    for page in pages {
        let Some(info) = page
            .get("imageinfo")
            .and_then(Value::as_array)
            .and_then(|items| items.first())
        else {
            continue;
        };
        let Some(mime) = info.get("mime").and_then(Value::as_str) else {
            continue;
        };
        if !matches!(
            mime,
            "image/avif"
                | "image/gif"
                | "image/jpeg"
                | "image/png"
                | "image/svg+xml"
                | "image/webp"
        ) {
            continue;
        }
        let Some(raw_url) = info.get("url").and_then(Value::as_str) else {
            continue;
        };
        let Ok(url) = safe_http_url(raw_url) else {
            continue;
        };
        let thumbnail_url = info
            .get("thumburl")
            .and_then(Value::as_str)
            .and_then(|value| safe_http_url(value).ok())
            .map(Into::into);
        let display_url = display_url(&url);
        let title = page
            .get("title")
            .and_then(Value::as_str)
            .map(|value| value.strip_prefix("File:").unwrap_or(value))
            .map(|value| plain_text(value, 180))
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| display_url.clone());
        results.push(WebSearchResult {
            url: url.into(),
            title,
            snippet: Some("Wikimedia Commonsの画像検索結果".to_owned()),
            display_url,
            thumbnail_url,
        });
        if results.len() >= MAX_RESULTS {
            break;
        }
    }
    Ok(results)
}

fn safe_http_url(value: &str) -> Result<Url, String> {
    let mut url = Url::parse(value).map_err(|_| "URLの形式が正しくありません。".to_owned())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("URLはhttp://またはhttps://のみ使用できます。".to_owned());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("認証情報を含むURLは使用できません。".to_owned());
    }
    url.set_fragment(None);
    Ok(url)
}

fn display_url(url: &Url) -> String {
    let host = url.host_str().unwrap_or_default();
    let path = url.path().trim_end_matches('/');
    let value = if path.is_empty() || path == "/" {
        host.to_owned()
    } else {
        format!("{host}{path}")
    };
    truncate_chars(&value, 120)
}

fn plain_text(value: &str, max_chars: usize) -> String {
    let mut result = String::new();
    let mut inside_tag = false;
    let mut previous_whitespace = true;
    for character in value.chars() {
        match character {
            '<' => inside_tag = true,
            '>' if inside_tag => inside_tag = false,
            _ if inside_tag || character.is_control() => {}
            _ if character.is_whitespace() => {
                if !previous_whitespace {
                    result.push(' ');
                    previous_whitespace = true;
                }
            }
            _ => {
                result.push(character);
                previous_whitespace = false;
            }
        }
        if result.chars().count() >= max_chars {
            break;
        }
    }
    result.trim().to_owned()
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_owned();
    }
    let mut truncated: String = value.chars().take(max_chars.saturating_sub(1)).collect();
    truncated.push('…');
    truncated
}

fn network_error(context: &str, error: reqwest::Error) -> String {
    if error.is_timeout() {
        format!("{context}: タイムアウトしました。")
    } else if error.is_connect() {
        format!("{context}: ネットワークへ接続できません。")
    } else {
        format!("{context}: {error}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_safe_direct_web_urls() {
        let result = direct_url_result("https://example.com/page#section")
            .expect("safe URL")
            .expect("direct result");
        assert_eq!(result.url, "https://example.com/page");
        assert!(direct_url_result("javascript:alert(1)").is_err());
        assert!(direct_url_result("file:///C:/secret.txt").is_err());
        assert!(
            direct_url_result("creator name")
                .expect("search terms")
                .is_none()
        );
        assert!(
            direct_url_result("site:example.com creator")
                .expect("search operators")
                .is_none()
        );
    }

    #[test]
    fn parses_rss_and_discards_unsafe_or_duplicate_links() {
        let fixture = br#"<?xml version="1.0"?>
            <rss><channel>
              <item>
                <title>Safe &amp; useful</title>
                <link>https://example.com/a</link>
                <description>&lt;b&gt;A result&lt;/b&gt; summary.</description>
              </item>
              <item>
                <title>Duplicate</title>
                <link>https://example.com/a</link>
                <description>Ignored</description>
              </item>
              <item>
                <title>Unsafe</title>
                <link>javascript:alert(1)</link>
                <description>Ignored</description>
              </item>
            </channel></rss>"#;

        let results = parse_bing_rss(fixture).expect("parse fixture");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "Safe & useful");
        assert_eq!(results[0].snippet.as_deref(), Some("A result summary."));
    }

    #[test]
    fn parses_wikimedia_image_and_thumbnail_urls() {
        let fixture = br#"{
          "query": {
            "pages": [
              {
                "pageid": 1,
                "title": "File:Example image.jpg",
                "imageinfo": [{
                  "url": "https://upload.wikimedia.org/example.jpg",
                  "thumburl": "https://upload.wikimedia.org/thumb/example.jpg",
                  "mime": "image/jpeg"
                }]
              },
              {
                "pageid": 2,
                "title": "File:Not an image.pdf",
                "imageinfo": [{
                  "url": "https://upload.wikimedia.org/example.pdf",
                  "thumburl": "https://upload.wikimedia.org/thumb/example.pdf.jpg",
                  "mime": "application/pdf"
                }]
              }
            ]
          }
        }"#;

        let results = parse_wikimedia_images(fixture).expect("parse image fixture");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "Example image.jpg");
        assert_eq!(
            results[0].thumbnail_url.as_deref(),
            Some("https://upload.wikimedia.org/thumb/example.jpg")
        );
    }

    #[test]
    fn rejects_empty_long_and_control_character_queries() {
        assert!(validate_query("   ").is_err());
        assert!(validate_query(&"a".repeat(MAX_QUERY_CHARS + 1)).is_err());
        assert!(validate_query("hello\nworld").is_err());
    }
}
