use std::{
    fs::{self, File, OpenOptions},
    io::{self, BufReader, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

use gif::{Encoder as GifEncoder, Frame as GifFrame, Repeat};
use image::{DynamicImage, RgbImage, imageops::FilterType};
use mp4::{MediaType, Mp4Reader, Mp4Track};
use openh264::{
    OpenH264API,
    decoder::{DecodedYUV, Decoder, DecoderConfig, Flush},
    formats::YUVSource,
};
use uuid::Uuid;

// X serves animated GIF posts as MP4. Preserve substantially more of that
// source resolution and cadence when reconstructing the downloadable GIF.
const MAX_GIF_EDGE: u32 = 1280;
const MAX_GIF_FRAMES: u32 = 600;
const MAX_GIF_BYTES: u64 = 512 * 1024 * 1024;
const MAX_THUMBNAIL_SAMPLE_SCAN: u32 = 300;
const GIF_QUANTIZER_SPEED: i32 = 4;

struct H264TrackInfo {
    track_id: u32,
    sample_count: u32,
    duration_centiseconds: f64,
    converter: Mp4BitstreamConverter,
}

struct Mp4BitstreamConverter {
    length_size: usize,
    parameter_sets: Vec<Vec<u8>>,
    wrote_parameter_sets: bool,
}

impl Mp4BitstreamConverter {
    fn for_track(track: &Mp4Track) -> Result<Self, String> {
        let config = &track
            .trak
            .mdia
            .minf
            .stbl
            .stsd
            .avc1
            .as_ref()
            .ok_or_else(|| "動画トラックにH.264 AVC設定がありません".to_owned())?
            .avcc;
        let length_size = usize::from(config.length_size_minus_one) + 1;
        if !(1..=4).contains(&length_size) {
            return Err(format!(
                "MP4のNAL長フィールドが不正です: {length_size} bytes"
            ));
        }
        let parameter_sets = config
            .sequence_parameter_sets
            .iter()
            .chain(&config.picture_parameter_sets)
            .map(|unit| unit.bytes.clone())
            .filter(|unit| !unit.is_empty())
            .collect::<Vec<_>>();
        if parameter_sets.is_empty() {
            return Err("動画トラックにH.264のSPS/PPSがありません".to_owned());
        }
        Ok(Self {
            length_size,
            parameter_sets,
            wrote_parameter_sets: false,
        })
    }

    fn convert_packet(&mut self, packet: &[u8], output: &mut Vec<u8>) -> Result<(), String> {
        output.clear();
        if !self.wrote_parameter_sets {
            for parameter_set in &self.parameter_sets {
                output.extend_from_slice(&[0, 0, 0, 1]);
                output.extend_from_slice(parameter_set);
            }
            self.wrote_parameter_sets = true;
        }

        let mut cursor = 0usize;
        while cursor < packet.len() {
            let length_end = cursor
                .checked_add(self.length_size)
                .ok_or_else(|| "MP4のNAL位置がオーバーフローしました".to_owned())?;
            let length_bytes = packet
                .get(cursor..length_end)
                .ok_or_else(|| "MP4のNAL長フィールドが途中で切れています".to_owned())?;
            let mut nal_length = 0usize;
            for byte in length_bytes {
                nal_length = nal_length
                    .checked_mul(256)
                    .and_then(|value| value.checked_add(usize::from(*byte)))
                    .ok_or_else(|| "MP4のNALサイズが大きすぎます".to_owned())?;
            }
            if nal_length == 0 {
                return Err("MP4に空のH.264 NALユニットがあります".to_owned());
            }
            let nal_end = length_end
                .checked_add(nal_length)
                .ok_or_else(|| "MP4のNAL位置がオーバーフローしました".to_owned())?;
            let nal = packet
                .get(length_end..nal_end)
                .ok_or_else(|| "MP4のH.264 NALユニットが途中で切れています".to_owned())?;
            output.extend_from_slice(&[0, 0, 0, 1]);
            output.extend_from_slice(nal);
            cursor = nal_end;
        }
        Ok(())
    }
}

struct LimitedWriter {
    file: File,
    written: u64,
    limit: u64,
}

impl Write for LimitedWriter {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        if self
            .written
            .saturating_add(buffer.len() as u64)
            .gt(&self.limit)
        {
            return Err(io::Error::other(format!(
                "GIFが{} MBの上限を超えました",
                self.limit / 1024 / 1024
            )));
        }
        let written = self.file.write(buffer)?;
        self.written = self.written.saturating_add(written as u64);
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}

struct GifEncodingState {
    encoder: GifEncoder<LimitedWriter>,
    width: u16,
    height: u16,
    encoded_frames: u32,
}

pub fn first_h264_frame(source: &Path) -> Result<DynamicImage, String> {
    let (mut reader, mut track) = open_h264_mp4(source)?;
    let mut decoder = new_decoder()?;
    let mut annex_b = Vec::new();
    let sample_limit = track.sample_count.min(MAX_THUMBNAIL_SAMPLE_SCAN);

    for sample_id in 1..=sample_limit {
        let Some(sample) = reader
            .read_sample(track.track_id, sample_id)
            .map_err(|error| format!("動画フレームを読み込めませんでした: {error}"))?
        else {
            continue;
        };
        track
            .converter
            .convert_packet(&sample.bytes, &mut annex_b)?;
        if let Some(frame) = decoder
            .decode(&annex_b)
            .map_err(|error| format!("H.264動画をデコードできませんでした: {error}"))?
        {
            return decoded_frame_to_image(&frame);
        }
    }

    for frame in decoder
        .flush_remaining()
        .map_err(|error| format!("H.264動画の残りのフレームをデコードできませんでした: {error}"))?
    {
        return decoded_frame_to_image(&frame);
    }
    Err("動画からサムネイルに使えるフレームを取得できませんでした".to_owned())
}

pub fn convert_h264_mp4_to_gif(source: &Path, destination: &Path) -> Result<(), String> {
    if destination.exists() {
        return Err(format!(
            "GIFの保存先がすでに存在します: {}",
            destination.display()
        ));
    }
    let temporary = temporary_output_path(destination)?;
    let result = convert_h264_mp4_to_gif_inner(source, &temporary)
        .and_then(|()| validate_gif_file(&temporary))
        .and_then(|()| {
            fs::rename(&temporary, destination).map_err(|error| {
                format!(
                    "変換したGIFを確定できませんでした（{}）: {error}",
                    destination.display()
                )
            })
        });
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn convert_h264_mp4_to_gif_inner(source: &Path, temporary: &Path) -> Result<(), String> {
    let (mut reader, mut track) = open_h264_mp4(source)?;
    let mut decoder = new_decoder()?;
    let mut annex_b = Vec::new();
    let stride = track
        .sample_count
        .saturating_add(MAX_GIF_FRAMES - 1)
        .checked_div(MAX_GIF_FRAMES)
        .unwrap_or(1)
        .max(1);
    let frame_duration =
        if track.duration_centiseconds.is_finite() && track.duration_centiseconds > 0.0 {
            track.duration_centiseconds / f64::from(track.sample_count)
        } else {
            10.0
        };
    let mut decoded_frames = 0u32;
    let mut state = None;

    for sample_id in 1..=track.sample_count {
        let Some(sample) = reader
            .read_sample(track.track_id, sample_id)
            .map_err(|error| format!("GIF変換元の動画フレームを読み込めませんでした: {error}"))?
        else {
            continue;
        };
        track
            .converter
            .convert_packet(&sample.bytes, &mut annex_b)?;
        if let Some(frame) = decoder
            .decode(&annex_b)
            .map_err(|error| format!("GIF変換元のH.264動画をデコードできませんでした: {error}"))?
        {
            encode_selected_frame(
                &frame,
                decoded_frames,
                track.sample_count,
                stride,
                frame_duration,
                temporary,
                &mut state,
            )?;
            decoded_frames = decoded_frames.saturating_add(1);
        }
    }

    for frame in decoder
        .flush_remaining()
        .map_err(|error| format!("GIF変換元の残りのフレームをデコードできませんでした: {error}"))?
    {
        encode_selected_frame(
            &frame,
            decoded_frames,
            track.sample_count,
            stride,
            frame_duration,
            temporary,
            &mut state,
        )?;
        decoded_frames = decoded_frames.saturating_add(1);
    }

    let state = state.ok_or_else(|| "GIFに変換できる動画フレームがありませんでした".to_owned())?;
    if state.encoded_frames == 0 {
        return Err("GIFに変換できる動画フレームがありませんでした".to_owned());
    }
    let mut writer = state
        .encoder
        .into_inner()
        .map_err(|error| format!("GIFの終端を書き込めませんでした: {error}"))?;
    writer
        .flush()
        .map_err(|error| format!("GIFの書き込みを完了できませんでした: {error}"))?;
    writer
        .file
        .sync_all()
        .map_err(|error| format!("GIFをディスクへ同期できませんでした: {error}"))?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn encode_selected_frame(
    frame: &DecodedYUV<'_>,
    decoded_index: u32,
    total_frames: u32,
    stride: u32,
    frame_duration_centiseconds: f64,
    temporary: &Path,
    state: &mut Option<GifEncodingState>,
) -> Result<(), String> {
    if decoded_index % stride != 0
        || state
            .as_ref()
            .is_some_and(|value| value.encoded_frames >= MAX_GIF_FRAMES)
    {
        return Ok(());
    }

    let source = decoded_frame_to_image(frame)?.into_rgb8();
    let (target_width, target_height) = match state.as_ref() {
        Some(value) => (u32::from(value.width), u32::from(value.height)),
        None => bounded_dimensions(source.width(), source.height(), MAX_GIF_EDGE),
    };
    let pixels = if source.dimensions() == (target_width, target_height) {
        source
    } else {
        image::imageops::resize(&source, target_width, target_height, FilterType::Lanczos3)
    };

    if state.is_none() {
        let file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(temporary)
            .map_err(|error| {
                format!(
                    "GIFの一時ファイルを作成できませんでした（{}）: {error}",
                    temporary.display()
                )
            })?;
        let width = u16::try_from(target_width)
            .map_err(|_| "GIFの幅が対応上限を超えています".to_owned())?;
        let height = u16::try_from(target_height)
            .map_err(|_| "GIFの高さが対応上限を超えています".to_owned())?;
        let writer = LimitedWriter {
            file,
            written: 0,
            limit: MAX_GIF_BYTES,
        };
        let mut encoder = GifEncoder::new(writer, width, height, &[])
            .map_err(|error| format!("GIFエンコーダーを開始できませんでした: {error}"))?;
        encoder
            .set_repeat(Repeat::Infinite)
            .map_err(|error| format!("GIFのループ設定を書き込めませんでした: {error}"))?;
        *state = Some(GifEncodingState {
            encoder,
            width,
            height,
            encoded_frames: 0,
        });
    }

    let state = state
        .as_mut()
        .ok_or_else(|| "GIFエンコーダーを開始できませんでした".to_owned())?;
    let mut gif_frame = GifFrame::from_rgb_speed(
        state.width,
        state.height,
        pixels.as_raw(),
        GIF_QUANTIZER_SPEED,
    );
    gif_frame.delay = gif_delay(
        decoded_index,
        total_frames,
        stride,
        frame_duration_centiseconds,
    );
    state
        .encoder
        .write_frame(&gif_frame)
        .map_err(|error| format!("GIFフレームを書き込めませんでした: {error}"))?;
    state.encoded_frames = state.encoded_frames.saturating_add(1);
    Ok(())
}

fn open_h264_mp4(source: &Path) -> Result<(Mp4Reader<BufReader<File>>, H264TrackInfo), String> {
    let metadata = fs::metadata(source)
        .map_err(|error| format!("動画ファイルを確認できませんでした: {error}"))?;
    if !metadata.is_file() || metadata.len() == 0 {
        return Err(format!(
            "動画ファイルが見つからないか空です: {}",
            source.display()
        ));
    }
    let file =
        File::open(source).map_err(|error| format!("動画ファイルを開けませんでした: {error}"))?;
    let reader =
        mp4::read_mp4(file).map_err(|error| format!("MP4を解析できませんでした: {error}"))?;
    let track = reader
        .tracks()
        .values()
        .find(|track| track.media_type().ok() == Some(MediaType::H264))
        .ok_or_else(|| "この動画には対応するH.264映像トラックがありません".to_owned())?;
    let sample_count = track.sample_count();
    if sample_count == 0 {
        return Err("H.264映像トラックにフレームがありません".to_owned());
    }
    let info = H264TrackInfo {
        track_id: track.track_id(),
        sample_count,
        duration_centiseconds: track.duration().as_secs_f64() * 100.0,
        converter: Mp4BitstreamConverter::for_track(track)?,
    };
    Ok((reader, info))
}

fn new_decoder() -> Result<Decoder, String> {
    Decoder::with_api_config(
        OpenH264API::from_source(),
        DecoderConfig::new().flush_after_decode(Flush::NoFlush),
    )
    .map_err(|error| format!("H.264デコーダーを開始できませんでした: {error}"))
}

fn decoded_frame_to_image(frame: &DecodedYUV<'_>) -> Result<DynamicImage, String> {
    let (width, height) = frame.dimensions();
    let width = u32::try_from(width).map_err(|_| "動画フレームの幅が大きすぎます".to_owned())?;
    let height =
        u32::try_from(height).map_err(|_| "動画フレームの高さが大きすぎます".to_owned())?;
    if width == 0 || height == 0 || width > 16_384 || height > 16_384 {
        return Err(format!("動画フレームのサイズが不正です: {width}x{height}"));
    }
    let mut pixels = vec![0u8; frame.rgb8_len()];
    frame.write_rgb8(&mut pixels);
    let image = RgbImage::from_raw(width, height, pixels)
        .ok_or_else(|| "デコードした動画フレームのデータ長が不正です".to_owned())?;
    Ok(DynamicImage::ImageRgb8(image))
}

fn bounded_dimensions(width: u32, height: u32, max_edge: u32) -> (u32, u32) {
    let largest = width.max(height);
    if largest <= max_edge {
        return (width, height);
    }
    let scale = f64::from(max_edge) / f64::from(largest);
    (
        (f64::from(width) * scale).round().max(1.0) as u32,
        (f64::from(height) * scale).round().max(1.0) as u32,
    )
}

fn gif_delay(
    frame_index: u32,
    total_frames: u32,
    stride: u32,
    frame_duration_centiseconds: f64,
) -> u16 {
    let end_frame = frame_index.saturating_add(stride).min(total_frames.max(1));
    let start = (f64::from(frame_index) * frame_duration_centiseconds).round();
    let end = (f64::from(end_frame) * frame_duration_centiseconds).round();
    (end - start).round().clamp(2.0, f64::from(u16::MAX)) as u16
}

fn temporary_output_path(destination: &Path) -> Result<PathBuf, String> {
    let file_name = destination
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "GIFのファイル名を確認できませんでした".to_owned())?;
    Ok(destination.with_file_name(format!(".{file_name}.{}.part", Uuid::new_v4())))
}

fn validate_gif_file(path: &Path) -> Result<(), String> {
    let mut file =
        File::open(path).map_err(|error| format!("変換したGIFを確認できませんでした: {error}"))?;
    let length = file
        .metadata()
        .map_err(|error| format!("変換したGIFのサイズを確認できませんでした: {error}"))?
        .len();
    if !(14..=MAX_GIF_BYTES).contains(&length) {
        return Err("変換したGIFのファイルサイズが不正です".to_owned());
    }
    let mut header = [0u8; 10];
    file.read_exact(&mut header)
        .map_err(|error| format!("変換したGIFのヘッダーを確認できませんでした: {error}"))?;
    if !matches!(&header[..6], b"GIF87a" | b"GIF89a") {
        return Err("変換結果が有効なGIFではありません".to_owned());
    }
    let width = u16::from_le_bytes([header[6], header[7]]);
    let height = u16::from_le_bytes([header[8], header[9]]);
    if width == 0 || height == 0 {
        return Err("変換したGIFの画像サイズが不正です".to_owned());
    }
    file.seek(SeekFrom::End(-1))
        .map_err(|error| format!("変換したGIFの終端を確認できませんでした: {error}"))?;
    let mut trailer = [0u8; 1];
    file.read_exact(&mut trailer)
        .map_err(|error| format!("変換したGIFの終端を読み込めませんでした: {error}"))?;
    if trailer[0] != 0x3b {
        return Err("変換したGIFが正常に完了していません".to_owned());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    use mp4::{AvcConfig, Mp4Config, Mp4Sample, Mp4Writer, TrackConfig};
    use openh264::{
        encoder::Encoder,
        formats::{RgbSliceU8, YUVBuffer},
    };

    fn h264_nal_payload(nal: &[u8]) -> &[u8] {
        if nal.starts_with(&[0, 0, 0, 1]) {
            &nal[4..]
        } else if nal.starts_with(&[0, 0, 1]) {
            &nal[3..]
        } else {
            nal
        }
    }

    fn create_h264_mp4(path: &Path) {
        const WIDTH: usize = 64;
        const HEIGHT: usize = 48;
        let mut encoder = Encoder::new().expect("test H.264 encoder");
        let mut samples = Vec::new();
        let mut sps = None;
        let mut pps = None;

        for frame_index in 0..3u8 {
            let mut rgb = vec![0u8; WIDTH * HEIGHT * 3];
            for pixel in rgb.chunks_exact_mut(3) {
                pixel.copy_from_slice(&[
                    180u8.saturating_add(frame_index * 10),
                    30u8.saturating_add(frame_index * 20),
                    60,
                ]);
            }
            let yuv = YUVBuffer::from_rgb_source(RgbSliceU8::new(&rgb, (WIDTH, HEIGHT)));
            let stream = encoder.encode(&yuv).expect("encode test frame");
            let mut sample = Vec::new();
            let mut is_sync = false;
            for layer_index in 0..stream.num_layers() {
                let layer = stream.layer(layer_index).expect("encoded layer");
                for nal_index in 0..layer.nal_count() {
                    let payload = h264_nal_payload(layer.nal_unit(nal_index).expect("encoded NAL"));
                    let nal_type = payload.first().copied().unwrap_or(0) & 0x1f;
                    match nal_type {
                        7 => sps = Some(payload.to_vec()),
                        8 => pps = Some(payload.to_vec()),
                        _ if !payload.is_empty() => {
                            is_sync |= nal_type == 5;
                            sample.extend_from_slice(&(payload.len() as u32).to_be_bytes());
                            sample.extend_from_slice(payload);
                        }
                        _ => {}
                    }
                }
            }
            samples.push((sample, is_sync));
        }

        let config = Mp4Config {
            major_brand: "isom".parse().expect("major brand"),
            minor_version: 512,
            compatible_brands: vec![
                "isom".parse().expect("isom"),
                "iso2".parse().expect("iso2"),
                "avc1".parse().expect("avc1"),
                "mp41".parse().expect("mp41"),
            ],
            timescale: 1_000,
        };
        let cursor = Cursor::new(Vec::new());
        let mut writer = Mp4Writer::write_start(cursor, &config).expect("start MP4");
        writer
            .add_track(&TrackConfig::from(AvcConfig {
                width: WIDTH as u16,
                height: HEIGHT as u16,
                seq_param_set: sps.expect("SPS"),
                pic_param_set: pps.expect("PPS"),
            }))
            .expect("add MP4 track");
        for (index, (sample, is_sync)) in samples.into_iter().enumerate() {
            writer
                .write_sample(
                    1,
                    &Mp4Sample {
                        start_time: index as u64 * 100,
                        duration: 100,
                        rendering_offset: 0,
                        is_sync,
                        bytes: sample.into(),
                    },
                )
                .expect("write MP4 sample");
        }
        writer.write_end().expect("finish MP4");
        fs::write(path, writer.into_writer().into_inner()).expect("write MP4 fixture");
    }

    #[test]
    fn converts_length_prefixed_nals_and_rejects_truncation() {
        let mut converter = Mp4BitstreamConverter {
            length_size: 4,
            parameter_sets: vec![vec![0x67, 0x64], vec![0x68, 0xeb]],
            wrote_parameter_sets: false,
        };
        let mut output = Vec::new();
        converter
            .convert_packet(&[0, 0, 0, 2, 0x65, 0xaa, 0, 0, 0, 1, 0x06], &mut output)
            .expect("valid packet");
        assert_eq!(
            output,
            [
                0, 0, 0, 1, 0x67, 0x64, 0, 0, 0, 1, 0x68, 0xeb, 0, 0, 0, 1, 0x65, 0xaa, 0, 0, 0, 1,
                0x06,
            ]
        );

        let error = converter
            .convert_packet(&[0, 0, 0, 8, 0x65], &mut output)
            .expect_err("truncated NAL");
        assert!(error.contains("途中"));
    }

    #[test]
    fn gif_delay_uses_error_diffusion_and_accounts_for_skipped_frames() {
        assert_eq!(gif_delay(0, 60, 1, 100.0 / 30.0), 3);
        assert_eq!(gif_delay(1, 60, 1, 100.0 / 30.0), 4);
        assert_eq!(gif_delay(0, 900, 3, 100.0 / 30.0), 10);
    }

    #[test]
    fn failed_conversion_never_leaves_a_partial_destination() {
        let directory = tempfile::tempdir().expect("video conversion fixture");
        let source = directory.path().join("broken.mp4");
        let destination = directory.path().join("converted.gif");
        fs::write(&source, b"not an mp4").expect("invalid source");

        assert!(convert_h264_mp4_to_gif(&source, &destination).is_err());
        assert!(source.is_file());
        assert!(!destination.exists());
        assert!(
            fs::read_dir(directory.path())
                .expect("temporary directory")
                .flatten()
                .all(|entry| !entry.file_name().to_string_lossy().ends_with(".part"))
        );
    }

    #[test]
    fn decodes_thumbnail_and_converts_h264_mp4_to_looping_gif() {
        let directory = tempfile::tempdir().expect("video fixture directory");
        let source = directory.path().join("fixture.mp4");
        let destination = directory.path().join("fixture.gif");
        create_h264_mp4(&source);

        let thumbnail = first_h264_frame(&source).expect("decode thumbnail");
        assert_eq!((thumbnail.width(), thumbnail.height()), (64, 48));

        convert_h264_mp4_to_gif(&source, &destination).expect("native GIF conversion");
        assert!(source.is_file(), "converter must not delete its input");
        let bytes = fs::read(&destination).expect("converted GIF");
        assert!(bytes.starts_with(b"GIF89a"));
        assert_eq!(bytes.last(), Some(&0x3b));

        let mut options = gif::DecodeOptions::new();
        options.set_color_output(gif::ColorOutput::RGBA);
        let mut reader = options
            .read_info(Cursor::new(bytes))
            .expect("read converted GIF");
        let mut frame_count = 0;
        while reader
            .read_next_frame()
            .expect("decode converted frame")
            .is_some()
        {
            frame_count += 1;
        }
        assert_eq!(frame_count, 3);
    }
}
