use std::{
    cmp::Ordering,
    fs::{self, File, OpenOptions},
    io::{BufWriter, Cursor, Read, Write},
    path::{Path, PathBuf},
};

use image::{DynamicImage, ImageReader, codecs::jpeg::JpegEncoder};
use uuid::Uuid;

use crate::video_decode;

const MAX_SOURCE_BYTES: u64 = 40 * 1024 * 1024;
const MAX_THUMBNAIL_EDGE: u32 = 480;
const JPEG_QUALITY: u8 = 82;
const MAX_PREVIEW_SOURCE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_PREVIEW_EDGE: u32 = 2_560;
const PREVIEW_JPEG_QUALITY: u8 = 91;

/// Generates a cached JPEG thumbnail for a supported source.
///
/// `Ok(true)` means a new destination was written. `Ok(false)` means the
/// destination already existed, the media kind is intentionally unsupported,
/// or an archive did not contain a supported image.
pub fn generate_thumbnail(source: &Path, kind: &str, destination: &Path) -> Result<bool, String> {
    if path_exists(destination)? {
        return Ok(false);
    }

    let normalized_kind = kind.trim().to_ascii_lowercase();
    let image = match normalized_kind.as_str() {
        "image" | "gif" => {
            let bytes = read_limited_file(source)?;
            decode_image(&bytes).map_err(|error| {
                format!(
                    "Failed to decode thumbnail source {}: {error}",
                    source.display()
                )
            })?
        }
        "zip" | "cbz" | "archive" => {
            let Some(image) = first_archive_image(source)? else {
                return Ok(false);
            };
            image
        }
        "video" => video_decode::first_h264_frame(source).map_err(|error| {
            format!(
                "Failed to decode video thumbnail source {}: {error}",
                source.display()
            )
        })?,
        "pdf" => return Ok(false),
        _ => return Ok(false),
    };

    write_image_atomic(&image, destination, MAX_THUMBNAIL_EDGE, JPEG_QUALITY)
}

/// Creates a larger, browser-compatible still image when WebView cannot
/// decode the original image/GIF directly.
pub fn generate_image_preview(
    source: &Path,
    kind: &str,
    destination: &Path,
) -> Result<bool, String> {
    if path_exists(destination)? {
        return Ok(false);
    }
    if !matches!(kind.trim().to_ascii_lowercase().as_str(), "image" | "gif") {
        return Ok(false);
    }
    let bytes = read_limited_file_with_limit(source, MAX_PREVIEW_SOURCE_BYTES)?;
    let image = decode_image(&bytes).map_err(|error| {
        format!(
            "Failed to decode image preview {}: {error}",
            source.display()
        )
    })?;
    write_image_atomic(&image, destination, MAX_PREVIEW_EDGE, PREVIEW_JPEG_QUALITY)
}

fn read_limited_file(path: &Path) -> Result<Vec<u8>, String> {
    read_limited_file_with_limit(path, MAX_SOURCE_BYTES)
}

fn read_limited_file_with_limit(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("Failed to inspect {}: {error}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!(
            "Thumbnail source is not a file: {}",
            path.display()
        ));
    }
    if metadata.len() > limit {
        return Err(format!(
            "Thumbnail source exceeds the {} MB limit: {}",
            limit / 1024 / 1024,
            path.display()
        ));
    }

    let file =
        File::open(path).map_err(|error| format!("Failed to open {}: {error}", path.display()))?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
    if bytes.len() as u64 > limit {
        return Err(format!(
            "Thumbnail source exceeds the {} MB limit: {}",
            limit / 1024 / 1024,
            path.display()
        ));
    }
    Ok(bytes)
}

fn first_archive_image(path: &Path) -> Result<Option<DynamicImage>, String> {
    let source =
        File::open(path).map_err(|error| format!("Failed to open {}: {error}", path.display()))?;
    let mut archive = zip::ZipArchive::new(source)
        .map_err(|error| format!("Failed to read archive {}: {error}", path.display()))?;
    let mut candidates = Vec::new();

    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| format!("Failed to inspect archive entry {index}: {error}"))?;
        let normalized_name = entry.name().replace('\\', "/");
        if entry.is_dir()
            || entry.size() > MAX_SOURCE_BYTES
            || is_macos_metadata_path(&normalized_name)
            || !is_supported_image_name(&normalized_name)
        {
            continue;
        }
        candidates.push((normalized_name, index));
    }

    candidates.sort_by(|left, right| natural_name_cmp(&left.0, &right.0));
    let mut last_decode_error = None;

    for (name, index) in candidates {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("Failed to open archive image {name}: {error}"))?;
        let mut bytes = Vec::with_capacity(entry.size().min(MAX_SOURCE_BYTES) as usize);
        entry
            .by_ref()
            .take(MAX_SOURCE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| format!("Failed to read archive image {name}: {error}"))?;
        if bytes.len() as u64 > MAX_SOURCE_BYTES {
            continue;
        }
        match decode_image(&bytes) {
            Ok(image) => return Ok(Some(image)),
            Err(error) => last_decode_error = Some(format!("{name}: {error}")),
        }
    }

    if let Some(error) = last_decode_error {
        return Err(format!(
            "Archive {} contains no decodable thumbnail image ({error})",
            path.display()
        ));
    }
    Ok(None)
}

fn decode_image(bytes: &[u8]) -> Result<DynamicImage, String> {
    let orientation = jpeg_exif_orientation(bytes).unwrap_or(1);
    let image = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|error| format!("Cannot determine image format: {error}"))?
        .decode()
        .map_err(|error| format!("Image decoder rejected the source: {error}"))?;
    Ok(apply_exif_orientation(image, orientation))
}

pub(crate) fn load_image_for_analysis(path: &Path) -> Result<DynamicImage, String> {
    let bytes = read_limited_file(path)?;
    decode_image(&bytes).map_err(|error| {
        format!(
            "Failed to decode visual feature source {}: {error}",
            path.display()
        )
    })
}

fn apply_exif_orientation(image: DynamicImage, orientation: u16) -> DynamicImage {
    match orientation {
        2 => image.fliph(),
        3 => image.rotate180(),
        4 => image.flipv(),
        5 => image.fliph().rotate270(),
        6 => image.rotate90(),
        7 => image.fliph().rotate90(),
        8 => image.rotate270(),
        _ => image,
    }
}

fn write_image_atomic(
    image: &DynamicImage,
    destination: &Path,
    max_edge: u32,
    jpeg_quality: u8,
) -> Result<bool, String> {
    if path_exists(destination)? {
        return Ok(false);
    }
    if let Some(parent) = destination
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Failed to create thumbnail directory {}: {error}",
                parent.display()
            )
        })?;
    }
    if path_exists(destination)? {
        return Ok(false);
    }

    let temporary = temporary_path(destination);
    let write_result = (|| -> Result<(), String> {
        let file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|error| {
                format!(
                    "Failed to create temporary thumbnail {}: {error}",
                    temporary.display()
                )
            })?;
        let mut writer = BufWriter::new(file);
        let thumbnail = image.thumbnail(max_edge, max_edge).to_rgb8();
        JpegEncoder::new_with_quality(&mut writer, jpeg_quality)
            .encode_image(&DynamicImage::ImageRgb8(thumbnail))
            .map_err(|error| format!("Failed to encode JPEG thumbnail: {error}"))?;
        writer
            .flush()
            .map_err(|error| format!("Failed to flush JPEG thumbnail: {error}"))?;
        drop(writer);

        if path_exists(destination)? {
            return Ok(());
        }
        match fs::rename(&temporary, destination) {
            Ok(()) => Ok(()),
            Err(_) if path_exists(destination)? => Ok(()),
            Err(error) => Err(format!(
                "Failed to finalize thumbnail {}: {error}",
                destination.display()
            )),
        }
    })();

    if let Err(error) = write_result {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    if path_exists(&temporary)? {
        let _ = fs::remove_file(&temporary);
        return Ok(false);
    }
    Ok(true)
}

fn temporary_path(destination: &Path) -> PathBuf {
    let file_name = destination
        .file_name()
        .map(|name| name.to_string_lossy())
        .unwrap_or_else(|| "thumbnail.jpg".into());
    destination.with_file_name(format!(".{file_name}.{}.tmp", Uuid::new_v4()))
}

fn path_exists(path: &Path) -> Result<bool, String> {
    path.try_exists()
        .map_err(|error| format!("Failed to inspect {}: {error}", path.display()))
}

fn is_macos_metadata_path(name: &str) -> bool {
    name.split('/')
        .any(|component| component.eq_ignore_ascii_case("__MACOSX"))
}

fn is_supported_image_name(name: &str) -> bool {
    let Some(extension) = Path::new(name).extension().and_then(|value| value.to_str()) else {
        return false;
    };
    matches!(
        extension.to_ascii_lowercase().as_str(),
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp"
    )
}

fn natural_name_cmp(left: &str, right: &str) -> Ordering {
    let left = left.as_bytes();
    let right = right.as_bytes();
    let (mut left_index, mut right_index) = (0, 0);

    while left_index < left.len() && right_index < right.len() {
        if left[left_index].is_ascii_digit() && right[right_index].is_ascii_digit() {
            let left_start = left_index;
            let right_start = right_index;
            while left_index < left.len() && left[left_index].is_ascii_digit() {
                left_index += 1;
            }
            while right_index < right.len() && right[right_index].is_ascii_digit() {
                right_index += 1;
            }

            let left_digits = &left[left_start..left_index];
            let right_digits = &right[right_start..right_index];
            let left_significant = trim_leading_zeroes(left_digits);
            let right_significant = trim_leading_zeroes(right_digits);
            let ordering = left_significant
                .len()
                .cmp(&right_significant.len())
                .then_with(|| left_significant.cmp(right_significant))
                .then_with(|| left_digits.len().cmp(&right_digits.len()));
            if ordering != Ordering::Equal {
                return ordering;
            }
            continue;
        }

        let ordering = left[left_index]
            .to_ascii_lowercase()
            .cmp(&right[right_index].to_ascii_lowercase());
        if ordering != Ordering::Equal {
            return ordering;
        }
        left_index += 1;
        right_index += 1;
    }

    left.len().cmp(&right.len())
}

fn trim_leading_zeroes(digits: &[u8]) -> &[u8] {
    let first_nonzero = digits
        .iter()
        .position(|digit| *digit != b'0')
        .unwrap_or(digits.len().saturating_sub(1));
    &digits[first_nonzero..]
}

fn jpeg_exif_orientation(bytes: &[u8]) -> Option<u16> {
    if !bytes.starts_with(&[0xff, 0xd8]) {
        return None;
    }

    let mut offset = 2;
    while offset + 4 <= bytes.len() {
        if bytes[offset] != 0xff {
            offset += 1;
            continue;
        }
        while offset < bytes.len() && bytes[offset] == 0xff {
            offset += 1;
        }
        let marker = *bytes.get(offset)?;
        offset += 1;
        if marker == 0xd9 || marker == 0xda {
            break;
        }
        if matches!(marker, 0x01 | 0xd0..=0xd7) {
            continue;
        }

        let segment_length = read_u16_be(bytes, offset)? as usize;
        if segment_length < 2 {
            return None;
        }
        let payload_start = offset.checked_add(2)?;
        let payload_end = offset.checked_add(segment_length)?;
        if payload_end > bytes.len() {
            return None;
        }
        if marker == 0xe1
            && bytes
                .get(payload_start..payload_start + 6)
                .is_some_and(|value| value == b"Exif\0\0")
        {
            return tiff_orientation(&bytes[payload_start + 6..payload_end]);
        }
        offset = payload_end;
    }
    None
}

fn tiff_orientation(bytes: &[u8]) -> Option<u16> {
    let byte_order = bytes.get(0..2)?;
    let little_endian = match byte_order {
        b"II" => true,
        b"MM" => false,
        _ => return None,
    };
    if read_u16(bytes, 2, little_endian)? != 42 {
        return None;
    }
    let ifd_offset = usize::try_from(read_u32(bytes, 4, little_endian)?).ok()?;
    let entry_count = usize::from(read_u16(bytes, ifd_offset, little_endian)?);
    let entries_start = ifd_offset.checked_add(2)?;

    for index in 0..entry_count {
        let entry = entries_start.checked_add(index.checked_mul(12)?)?;
        if entry.checked_add(12)? > bytes.len() {
            return None;
        }
        if read_u16(bytes, entry, little_endian)? != 0x0112 {
            continue;
        }
        let field_type = read_u16(bytes, entry + 2, little_endian)?;
        let count = read_u32(bytes, entry + 4, little_endian)?;
        if field_type != 3 || count == 0 {
            return None;
        }
        let orientation = read_u16(bytes, entry + 8, little_endian)?;
        return (1..=8).contains(&orientation).then_some(orientation);
    }
    None
}

fn read_u16_be(bytes: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_be_bytes(
        bytes.get(offset..offset + 2)?.try_into().ok()?,
    ))
}

fn read_u16(bytes: &[u8], offset: usize, little_endian: bool) -> Option<u16> {
    let value: [u8; 2] = bytes.get(offset..offset + 2)?.try_into().ok()?;
    Some(if little_endian {
        u16::from_le_bytes(value)
    } else {
        u16::from_be_bytes(value)
    })
}

fn read_u32(bytes: &[u8], offset: usize, little_endian: bool) -> Option<u32> {
    let value: [u8; 4] = bytes.get(offset..offset + 4)?.try_into().ok()?;
    Some(if little_endian {
        u32::from_le_bytes(value)
    } else {
        u32::from_be_bytes(value)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{GenericImageView, ImageBuffer, ImageFormat, Rgb};
    use tempfile::tempdir;
    use zip::{ZipWriter, write::SimpleFileOptions};

    fn encoded_image(width: u32, height: u32, color: [u8; 3], format: ImageFormat) -> Vec<u8> {
        let image = ImageBuffer::from_pixel(width, height, Rgb(color));
        let mut output = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(image)
            .write_to(&mut output, format)
            .expect("encode fixture image");
        output.into_inner()
    }

    #[test]
    fn creates_bounded_jpeg_and_does_not_replace_it() {
        let directory = tempdir().expect("temporary directory");
        let source = directory.path().join("large.png");
        let destination = directory.path().join("cache").join("thumb.jpg");
        fs::write(
            &source,
            encoded_image(960, 320, [210, 80, 120], ImageFormat::Png),
        )
        .expect("write source image");

        assert!(generate_thumbnail(&source, "image", &destination).expect("generate thumbnail"));
        let thumbnail = image::open(&destination).expect("open generated thumbnail");
        assert_eq!(thumbnail.dimensions(), (480, 160));

        let original = fs::read(&destination).expect("read generated thumbnail");
        assert!(!generate_thumbnail(&source, "image", &destination).expect("skip existing"));
        assert_eq!(
            fs::read(&destination).expect("read existing thumbnail"),
            original
        );
    }

    #[test]
    fn creates_browser_compatible_preview_from_tiff() {
        let directory = tempdir().expect("temporary directory");
        let source = directory.path().join("source.tiff");
        let destination = directory.path().join("preview.jpg");
        fs::write(
            &source,
            encoded_image(3_000, 1_000, [72, 126, 210], ImageFormat::Tiff),
        )
        .expect("write TIFF source");

        assert!(
            generate_image_preview(&source, "image", &destination).expect("generate image preview")
        );
        let preview = image::open(destination).expect("open generated preview");
        assert_eq!(preview.dimensions(), (2_560, 853));
    }

    #[test]
    fn archive_uses_natural_order_and_ignores_macos_metadata() {
        let directory = tempdir().expect("temporary directory");
        let source = directory.path().join("book.cbz");
        let destination = directory.path().join("book.jpg");
        let archive_file = File::create(&source).expect("create archive");
        let mut writer = ZipWriter::new(archive_file);
        let options = SimpleFileOptions::default();

        for (name, color) in [
            ("__MACOSX/._page1.png", [20, 20, 230]),
            ("pages/page10.png", [230, 20, 20]),
            ("pages/page2.png", [20, 230, 20]),
        ] {
            writer
                .start_file(name, options)
                .expect("start archive image");
            writer
                .write_all(&encoded_image(24, 24, color, ImageFormat::Png))
                .expect("write archive image");
        }
        writer.finish().expect("finish archive");

        assert!(generate_thumbnail(&source, "cbz", &destination).expect("generate cover"));
        let thumbnail = image::open(destination).expect("open cover").to_rgb8();
        let pixel = thumbnail.get_pixel(12, 12).0;
        assert!(
            pixel[1] > pixel[0].saturating_add(80) && pixel[1] > pixel[2].saturating_add(80),
            "page2 should be selected before page10: {pixel:?}"
        );
    }

    #[test]
    fn invalid_video_does_not_create_a_destination() {
        let directory = tempdir().expect("temporary directory");
        let source = directory.path().join("movie.mp4");
        let destination = directory.path().join("movie.jpg");
        fs::write(&source, b"not decoded").expect("write video placeholder");

        assert!(generate_thumbnail(&source, "video", &destination).is_err());
        assert!(!destination.exists());
    }

    #[test]
    fn oversized_standalone_images_are_rejected() {
        let directory = tempdir().expect("temporary directory");
        let source = directory.path().join("too-large.png");
        let destination = directory.path().join("thumb.jpg");
        let file = File::create(&source).expect("create oversized source");
        file.set_len(MAX_SOURCE_BYTES + 1)
            .expect("size oversized source");

        let error = generate_thumbnail(&source, "image", &destination)
            .expect_err("oversized image should fail");
        assert!(error.contains("40 MB"));
        assert!(!destination.exists());
    }

    #[test]
    fn reads_little_endian_exif_orientation() {
        let mut jpeg = vec![0xff, 0xd8, 0xff, 0xe1, 0x00, 0x22];
        jpeg.extend_from_slice(b"Exif\0\0");
        jpeg.extend_from_slice(b"II");
        jpeg.extend_from_slice(&42_u16.to_le_bytes());
        jpeg.extend_from_slice(&8_u32.to_le_bytes());
        jpeg.extend_from_slice(&1_u16.to_le_bytes());
        jpeg.extend_from_slice(&0x0112_u16.to_le_bytes());
        jpeg.extend_from_slice(&3_u16.to_le_bytes());
        jpeg.extend_from_slice(&1_u32.to_le_bytes());
        jpeg.extend_from_slice(&6_u16.to_le_bytes());
        jpeg.extend_from_slice(&0_u16.to_le_bytes());
        jpeg.extend_from_slice(&0_u32.to_le_bytes());

        assert_eq!(jpeg_exif_orientation(&jpeg), Some(6));
    }

    #[test]
    fn natural_order_compares_numeric_runs_by_value() {
        assert_eq!(natural_name_cmp("page2.png", "page10.png"), Ordering::Less);
        assert_eq!(
            natural_name_cmp("Page10.png", "page10.png"),
            Ordering::Equal
        );
    }
}
