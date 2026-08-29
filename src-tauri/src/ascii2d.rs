use std::{
    fs::{self, File},
    io::{Cursor, Read},
    path::Path,
    time::Duration,
};

use image::{ImageFormat, ImageReader};
use reqwest::{
    Url,
    blocking::{
        Client, Response,
        multipart::{Form, Part},
    },
    header::{ACCEPT, ORIGIN, REFERER},
    redirect::Policy,
};

const ASCII2D_ORIGIN: &str = "https://ascii2d.net";
const ASCII2D_HOME_URL: &str = "https://ascii2d.net/";
const ASCII2D_FILE_SEARCH_URL: &str = "https://ascii2d.net/search/file";

/// Absolute application-side ceiling, even if the upstream service raises its
/// own limit in the future.
pub const HARD_MAX_UPLOAD_BYTES: u64 = 40 * 1024 * 1024;

/// ascii2d's current official readme documents a 10 MB maximum for local files.
/// Keep this separate from the application ceiling so an upstream change is
/// explicit and reviewable.
const ASCII2D_DOCUMENTED_MAX_BYTES: u64 = 10 * 1024 * 1024;
const MAX_UPLOAD_FORM_BYTES: u64 = 1024 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

/// Uploads a supported local image through ascii2d's official browser form and
/// returns the resulting ascii2d search URL.
///
/// ascii2d does not currently document this form as a versioned public API.
/// Consequently this adapter fetches the live form first, preserves its session
/// cookie and CSRF token, verifies the expected action, and fails closed if the
/// form contract or redirect destination changes.
pub fn search_image(path: &Path) -> Result<String, String> {
    let image = read_and_validate_image(path)?;
    let client = build_client()?;

    let landing = client
        .get(ASCII2D_HOME_URL)
        .header(ACCEPT, "text/html,application/xhtml+xml")
        .send()
        .map_err(|error| sanitized_request_error("load ascii2d's upload form", &error))?;

    if !landing.status().is_success() {
        return Err(format!(
            "ascii2d's upload form is unavailable (HTTP {}).",
            landing.status().as_u16()
        ));
    }

    let upload_form_html = read_limited_html(landing)?;
    let csrf_token = extract_file_upload_token(&upload_form_html)
        .map_err(|_| "ascii2d's upload form could not be verified.".to_owned())?;

    let upload_part = Part::bytes(image.bytes)
        .file_name(format!("upload.{}", image.kind.preferred_extension()))
        .mime_str(image.kind.mime_type())
        .map_err(|_| "Could not prepare the image upload.".to_owned())?;

    let form = Form::new()
        .text("utf8", "✓")
        .text("authenticity_token", csrf_token)
        .part("file", upload_part)
        .text("search", "");

    let response = client
        .post(ASCII2D_FILE_SEARCH_URL)
        .header(ACCEPT, "text/html,application/xhtml+xml")
        .header(ORIGIN, ASCII2D_ORIGIN)
        .header(REFERER, ASCII2D_HOME_URL)
        .multipart(form)
        .send()
        .map_err(|error| sanitized_request_error("upload the image to ascii2d", &error))?;

    let status = response.status();
    let result_url = response.url().clone();
    if !status.is_success() {
        return Err(format!(
            "ascii2d rejected the image (HTTP {}).",
            status.as_u16()
        ));
    }

    validate_result_url(&result_url)?;
    Ok(result_url.to_string())
}

fn build_client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .cookie_store(true)
        .redirect(ascii2d_redirect_policy())
        .user_agent(concat!(
            "PixVault/",
            env!("CARGO_PKG_VERSION"),
            " ascii2d-browser-form-adapter"
        ))
        .build()
        .map_err(|_| "Could not initialize the ascii2d client.".to_owned())
}

fn ascii2d_redirect_policy() -> Policy {
    Policy::custom(|attempt| {
        if attempt.previous().len() >= 5 {
            return attempt.error("ascii2d redirect limit exceeded");
        }

        let destination = attempt.url();
        if is_ascii2d_origin(destination) {
            attempt.follow()
        } else {
            // Never resend an uploaded image, cookie, or form token to another
            // origin. The caller will reject the remaining 3xx response.
            attempt.stop()
        }
    })
}

fn sanitized_request_error(action: &str, error: &reqwest::Error) -> String {
    if error.is_timeout() {
        format!("Timed out while trying to {action}.")
    } else if error.is_connect() {
        format!("Could not connect to ascii2d while trying to {action}.")
    } else if error.is_redirect() {
        format!("ascii2d returned an invalid redirect while trying to {action}.")
    } else {
        format!("Failed to {action}.")
    }
}

fn read_limited_html(response: Response) -> Result<String, String> {
    let mut reader = response.take(MAX_UPLOAD_FORM_BYTES + 1);
    let mut bytes = Vec::new();
    reader
        .read_to_end(&mut bytes)
        .map_err(|_| "Could not read ascii2d's upload form.".to_owned())?;

    if bytes.len() as u64 > MAX_UPLOAD_FORM_BYTES {
        return Err("ascii2d's upload form was unexpectedly large.".to_owned());
    }

    String::from_utf8(bytes).map_err(|_| "ascii2d's upload form was not valid UTF-8.".to_owned())
}

fn validate_result_url(url: &Url) -> Result<(), String> {
    let path = url.path();
    let is_search_result = path.starts_with("/search/")
        && path != "/search/file"
        && path != "/search/uri"
        && path.len() > "/search/".len();

    if !is_ascii2d_origin(url)
        || url.query().is_some()
        || url.fragment().is_some()
        || !is_search_result
    {
        return Err("ascii2d did not return a verified search result URL.".to_owned());
    }

    Ok(())
}

fn is_ascii2d_origin(url: &Url) -> bool {
    url.scheme() == "https"
        && url.host_str() == Some("ascii2d.net")
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
}

struct ValidatedImage {
    bytes: Vec<u8>,
    kind: SupportedImage,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SupportedImage {
    Jpeg,
    Png,
    Webp,
}

impl SupportedImage {
    fn detect(bytes: &[u8]) -> Option<Self> {
        if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
            Some(Self::Jpeg)
        } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            Some(Self::Png)
        } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
            Some(Self::Webp)
        } else {
            None
        }
    }

    fn image_format(self) -> ImageFormat {
        match self {
            Self::Jpeg => ImageFormat::Jpeg,
            Self::Png => ImageFormat::Png,
            Self::Webp => ImageFormat::WebP,
        }
    }

    fn accepts_extension(self, extension: &str) -> bool {
        match self {
            Self::Jpeg => matches!(extension, "jpg" | "jpeg" | "jpe" | "jfif"),
            Self::Png => extension == "png",
            Self::Webp => extension == "webp",
        }
    }

    fn preferred_extension(self) -> &'static str {
        match self {
            Self::Jpeg => "jpg",
            Self::Png => "png",
            Self::Webp => "webp",
        }
    }

    fn mime_type(self) -> &'static str {
        match self {
            Self::Jpeg => "image/jpeg",
            Self::Png => "image/png",
            Self::Webp => "image/webp",
        }
    }
}

fn read_and_validate_image(path: &Path) -> Result<ValidatedImage, String> {
    let metadata =
        fs::metadata(path).map_err(|_| "Could not inspect the selected image.".to_owned())?;
    if !metadata.is_file() {
        return Err("The selected image is not a regular file.".to_owned());
    }
    if metadata.len() == 0 {
        return Err("The selected image is empty.".to_owned());
    }
    if metadata.len() > HARD_MAX_UPLOAD_BYTES {
        return Err(format!(
            "The selected image exceeds the {} MB application limit.",
            HARD_MAX_UPLOAD_BYTES / 1024 / 1024
        ));
    }
    if metadata.len() > ASCII2D_DOCUMENTED_MAX_BYTES {
        return Err(format!(
            "ascii2d currently accepts local images up to {} MB.",
            ASCII2D_DOCUMENTED_MAX_BYTES / 1024 / 1024
        ));
    }

    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| "The selected image needs a supported file extension.".to_owned())?;

    // Bound the read independently of metadata to remain safe if the file is
    // replaced or extended between inspection and reading.
    let file = File::open(path).map_err(|_| "Could not open the selected image.".to_owned())?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(ASCII2D_DOCUMENTED_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Could not read the selected image.".to_owned())?;

    if bytes.len() as u64 > ASCII2D_DOCUMENTED_MAX_BYTES {
        return Err(format!(
            "ascii2d currently accepts local images up to {} MB.",
            ASCII2D_DOCUMENTED_MAX_BYTES / 1024 / 1024
        ));
    }

    let kind = SupportedImage::detect(&bytes)
        .ok_or_else(|| "ascii2d supports JPEG, PNG, and WebP local image uploads.".to_owned())?;
    if !kind.accepts_extension(&extension) {
        return Err("The selected image's extension does not match its contents.".to_owned());
    }

    let (width, height) =
        ImageReader::with_format(Cursor::new(bytes.as_slice()), kind.image_format())
            .into_dimensions()
            .map_err(|_| "The selected image is damaged or invalid.".to_owned())?;
    if width == 0 || height == 0 {
        return Err("The selected image has invalid dimensions.".to_owned());
    }

    Ok(ValidatedImage { bytes, kind })
}

fn extract_file_upload_token(html: &str) -> Result<String, &'static str> {
    let form = find_form_by_id(html, "file_upload").ok_or("file upload form not found")?;
    let opening_tag_end = form.find('>').ok_or("file upload form tag is incomplete")?;
    let opening_tag = &form[..=opening_tag_end];
    let action = attribute_value(opening_tag, "action").ok_or("form action not found")?;
    let action = decode_html_attribute(action);
    if action != "/search/file" && action != ASCII2D_FILE_SEARCH_URL {
        return Err("unexpected file upload form action");
    }

    let mut cursor = opening_tag_end + 1;
    while let Some(relative_start) = form[cursor..].find("<input") {
        let tag_start = cursor + relative_start;
        let Some(relative_end) = form[tag_start..].find('>') else {
            return Err("input tag is incomplete");
        };
        let tag_end = tag_start + relative_end;
        let input_tag = &form[tag_start..=tag_end];

        if attribute_value(input_tag, "name") == Some("authenticity_token") {
            let token =
                attribute_value(input_tag, "value").ok_or("authenticity token has no value")?;
            let token = decode_html_attribute(token);
            if token.is_empty() || token.len() > 4096 {
                return Err("authenticity token has an invalid length");
            }
            return Ok(token);
        }

        cursor = tag_end + 1;
    }

    Err("authenticity token not found")
}

fn find_form_by_id<'a>(html: &'a str, expected_id: &str) -> Option<&'a str> {
    let mut cursor = 0;
    while let Some(relative_start) = html[cursor..].find("<form") {
        let form_start = cursor + relative_start;
        let opening_tag_end = form_start + html[form_start..].find('>')?;
        let opening_tag = &html[form_start..=opening_tag_end];

        if attribute_value(opening_tag, "id") == Some(expected_id) {
            let closing_start =
                opening_tag_end + 1 + html[opening_tag_end + 1..].find("</form>")?;
            let form_end = closing_start + "</form>".len();
            return Some(&html[form_start..form_end]);
        }

        cursor = opening_tag_end + 1;
    }

    None
}

fn attribute_value<'a>(tag: &'a str, wanted_name: &str) -> Option<&'a str> {
    let bytes = tag.as_bytes();
    let mut cursor = 0;

    while cursor < bytes.len() {
        while cursor < bytes.len()
            && (bytes[cursor].is_ascii_whitespace() || matches!(bytes[cursor], b'<' | b'>' | b'/'))
        {
            cursor += 1;
        }

        let name_start = cursor;
        while cursor < bytes.len()
            && (bytes[cursor].is_ascii_alphanumeric()
                || matches!(bytes[cursor], b'-' | b'_' | b':'))
        {
            cursor += 1;
        }
        if name_start == cursor {
            cursor += 1;
            continue;
        }
        let name = &tag[name_start..cursor];

        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        if cursor >= bytes.len() || bytes[cursor] != b'=' {
            continue;
        }
        cursor += 1;
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        if cursor >= bytes.len() {
            return None;
        }

        let (value_start, value_end) = if matches!(bytes[cursor], b'"' | b'\'') {
            let quote = bytes[cursor];
            cursor += 1;
            let start = cursor;
            while cursor < bytes.len() && bytes[cursor] != quote {
                cursor += 1;
            }
            if cursor >= bytes.len() {
                return None;
            }
            (start, cursor)
        } else {
            let start = cursor;
            while cursor < bytes.len()
                && !bytes[cursor].is_ascii_whitespace()
                && bytes[cursor] != b'>'
            {
                cursor += 1;
            }
            (start, cursor)
        };

        if name.eq_ignore_ascii_case(wanted_name) {
            return Some(&tag[value_start..value_end]);
        }

        cursor = value_end.saturating_add(1);
    }

    None
}

fn decode_html_attribute(value: &str) -> String {
    // These are the entities relevant to a quoted HTML attribute. Decode once,
    // matching browser HTML parsing rather than recursively interpreting input.
    value
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_token_only_from_expected_file_form() {
        let html = r#"
            <form id="other" action="/search/file" method="post">
              <input name="authenticity_token" value="wrong">
            </form>
            <form enctype="multipart/form-data" id="file_upload"
                  action="/search/file" method="post">
              <input name="utf8" type="hidden" value="✓">
              <input type="hidden" name="authenticity_token"
                     value="abc+/=&amp;rest">
              <input id="file-form" name="file" type="file">
            </form>
        "#;

        assert_eq!(
            extract_file_upload_token(html),
            Ok("abc+/=&rest".to_owned())
        );
    }

    #[test]
    fn rejects_an_unexpected_form_action() {
        let html = r#"
            <form id='file_upload' action='https://example.test/collect'>
              <input value='secret' name='authenticity_token'>
            </form>
        "#;

        assert!(extract_file_upload_token(html).is_err());
    }

    #[test]
    fn detects_only_ascii2d_supported_image_signatures() {
        assert_eq!(
            SupportedImage::detect(b"\xff\xd8\xff\xe0rest"),
            Some(SupportedImage::Jpeg)
        );
        assert_eq!(
            SupportedImage::detect(b"\x89PNG\r\n\x1a\nrest"),
            Some(SupportedImage::Png)
        );
        assert_eq!(
            SupportedImage::detect(b"RIFF\x00\x00\x00\x00WEBPrest"),
            Some(SupportedImage::Webp)
        );
        assert_eq!(SupportedImage::detect(b"GIF89a"), None);
    }

    #[test]
    fn accepts_only_verified_ascii2d_result_urls() {
        assert!(
            validate_result_url(&Url::parse("https://ascii2d.net/search/color/example").unwrap())
                .is_ok()
        );
        assert!(
            validate_result_url(&Url::parse("https://example.test/search/color/id").unwrap())
                .is_err()
        );
        assert!(
            validate_result_url(&Url::parse("https://ascii2d.net/search/file").unwrap()).is_err()
        );
    }
}
