//! Reproducible thumbnail cache benchmark.
//!
//! This example intentionally includes the production thumbnail modules by
//! path, so it measures the same decoders, 480 px resize, JPEG encoder and
//! atomic writer without exposing implementation details from the app crate.
//! Fixture creation is excluded from all timings.
//!
//! "cache cold" means that the destination JPEG does not exist. It does not
//! attempt to flush the Windows filesystem cache. "generator warm" measures
//! the existing-destination probe. Tauri IPC and WebView image paint are
//! intentionally outside this native-core benchmark and require an app-level
//! trace.

#[path = "../src/filename_order.rs"]
mod filename_order;
#[path = "../src/thumbnail_cache.rs"]
mod thumbnail_cache;
#[path = "../src/video_decode.rs"]
mod video_decode;

use std::{
    collections::VecDeque,
    fs::{self, File},
    io::{Cursor, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
    time::Instant,
};

use image::{DynamicImage, Rgb, RgbImage, codecs::jpeg::JpegEncoder};
use mp4::{AvcConfig, Mp4Config, Mp4Sample, Mp4Writer, TrackConfig};
use openh264::{
    encoder::Encoder,
    formats::{RgbSliceU8, YUVBuffer},
};
use rusqlite::Connection;
use serde::Serialize;
use tempfile::tempdir;
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

const THUMBNAIL_EDGE: u32 = 480;
const THUMBNAIL_JPEG_QUALITY: u8 = 82;

#[derive(Clone)]
struct Fixture {
    name: &'static str,
    kind: &'static str,
    source: PathBuf,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LatencySummary {
    samples: usize,
    minimum_ms: f64,
    median_ms: f64,
    p95_ms: f64,
    maximum_ms: f64,
    mean_ms: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct KindBenchmark {
    kind: String,
    source_bytes: u64,
    thumbnail_bytes: u64,
    cache_cold: LatencySummary,
    generator_warm_path_probe: LatencySummary,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchBenchmark {
    items: usize,
    workers: usize,
    elapsed_ms: f64,
    items_per_second: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PipelineMicrobenchmarks {
    root_and_source_canonicalize: LatencySummary,
    sqlite_thumbnail_source_lookup: LatencySummary,
    cached_file_probe: LatencySummary,
    resize_and_jpeg_480: LatencySummary,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BenchmarkReport {
    generated_at: String,
    operating_system: String,
    architecture: String,
    logical_cpus: usize,
    rounds: usize,
    foreground_worker_limit: usize,
    thumbnail_edge: u32,
    jpeg_quality: u8,
    kinds: Vec<KindBenchmark>,
    pipeline: PipelineMicrobenchmarks,
    sequential_batch: BatchBenchmark,
    foreground_parallel_batch: BatchBenchmark,
}

fn elapsed_ms(started: Instant) -> f64 {
    started.elapsed().as_secs_f64() * 1_000.0
}

fn production_foreground_worker_limit(logical_cpus: usize) -> usize {
    match logical_cpus {
        0..=2 => 1,
        3..=4 => 2,
        5..=8 => 3,
        _ => 4,
    }
}

fn summarize(mut samples: Vec<f64>) -> LatencySummary {
    samples.sort_by(f64::total_cmp);
    let quantile = |fraction: f64| {
        let index = ((samples.len() as f64 * fraction).ceil() as usize)
            .saturating_sub(1)
            .min(samples.len().saturating_sub(1));
        samples[index]
    };
    let mean = samples.iter().sum::<f64>() / samples.len().max(1) as f64;
    LatencySummary {
        samples: samples.len(),
        minimum_ms: samples.first().copied().unwrap_or_default(),
        median_ms: quantile(0.50),
        p95_ms: quantile(0.95),
        maximum_ms: samples.last().copied().unwrap_or_default(),
        mean_ms: mean,
    }
}

fn create_image_fixture(path: &Path) -> Result<(), String> {
    let image = RgbImage::from_fn(2_400, 1_600, |x, y| {
        Rgb([
            ((x * 255) / 2_399) as u8,
            ((y * 255) / 1_599) as u8,
            (((x + y) * 127) / 3_998) as u8,
        ])
    });
    let output = File::create(path).map_err(|error| error.to_string())?;
    JpegEncoder::new_with_quality(output, 91)
        .encode_image(&DynamicImage::ImageRgb8(image))
        .map_err(|error| error.to_string())
}

fn create_gif_fixture(path: &Path) -> Result<(), String> {
    const WIDTH: u16 = 960;
    const HEIGHT: u16 = 540;
    let mut output = File::create(path).map_err(|error| error.to_string())?;
    let mut encoder =
        gif::Encoder::new(&mut output, WIDTH, HEIGHT, &[]).map_err(|error| error.to_string())?;
    encoder
        .set_repeat(gif::Repeat::Infinite)
        .map_err(|error| error.to_string())?;
    for frame_index in 0..12_u16 {
        let mut rgba = vec![0_u8; usize::from(WIDTH) * usize::from(HEIGHT) * 4];
        for (index, pixel) in rgba.chunks_exact_mut(4).enumerate() {
            let x = (index % usize::from(WIDTH)) as u16;
            let y = (index / usize::from(WIDTH)) as u16;
            pixel.copy_from_slice(&[
                ((x + frame_index * 29) % 256) as u8,
                ((y + frame_index * 17) % 256) as u8,
                ((x / 4 + y / 4 + frame_index * 11) % 256) as u8,
                255,
            ]);
        }
        let mut frame = gif::Frame::from_rgba_speed(WIDTH, HEIGHT, &mut rgba, 10);
        frame.delay = 4;
        encoder
            .write_frame(&frame)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn create_zip_fixture(path: &Path, page_bytes: &[u8]) -> Result<(), String> {
    let output = File::create(path).map_err(|error| error.to_string())?;
    let mut archive = ZipWriter::new(output);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    for page in 1..=24 {
        archive
            .start_file(format!("pages/page-{page:03}.jpg"), options)
            .map_err(|error| error.to_string())?;
        archive
            .write_all(page_bytes)
            .map_err(|error| error.to_string())?;
    }
    archive.finish().map_err(|error| error.to_string())?;
    Ok(())
}

fn h264_nal_payload(nal: &[u8]) -> &[u8] {
    if nal.starts_with(&[0, 0, 0, 1]) {
        &nal[4..]
    } else if nal.starts_with(&[0, 0, 1]) {
        &nal[3..]
    } else {
        nal
    }
}

fn create_video_fixture(path: &Path) -> Result<(), String> {
    const WIDTH: usize = 1_280;
    const HEIGHT: usize = 720;
    let mut encoder = Encoder::new().map_err(|error| error.to_string())?;
    let mut samples = Vec::new();
    let mut sps = None;
    let mut pps = None;

    for frame_index in 0..12_u8 {
        let mut rgb = vec![0_u8; WIDTH * HEIGHT * 3];
        for (index, pixel) in rgb.chunks_exact_mut(3).enumerate() {
            let x = index % WIDTH;
            let y = index / WIDTH;
            pixel.copy_from_slice(&[
                ((x + usize::from(frame_index) * 31) % 256) as u8,
                ((y + usize::from(frame_index) * 17) % 256) as u8,
                96,
            ]);
        }
        let yuv = YUVBuffer::from_rgb_source(RgbSliceU8::new(&rgb, (WIDTH, HEIGHT)));
        let stream = encoder.encode(&yuv).map_err(|error| error.to_string())?;
        let mut sample = Vec::new();
        let mut is_sync = false;
        for layer_index in 0..stream.num_layers() {
            let layer = stream
                .layer(layer_index)
                .ok_or_else(|| format!("video fixture layer {layer_index} is missing"))?;
            for nal_index in 0..layer.nal_count() {
                let payload = h264_nal_payload(layer.nal_unit(nal_index).ok_or_else(|| {
                    format!("video fixture layer {layer_index} NAL unit {nal_index} is missing")
                })?);
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
        major_brand: "isom".parse().map_err(|error| format!("{error}"))?,
        minor_version: 512,
        compatible_brands: ["isom", "iso2", "avc1", "mp41"]
            .into_iter()
            .map(|brand| brand.parse().map_err(|error| format!("{error}")))
            .collect::<Result<Vec<_>, String>>()?,
        timescale: 1_000,
    };
    let cursor = Cursor::new(Vec::new());
    let mut writer = Mp4Writer::write_start(cursor, &config).map_err(|error| error.to_string())?;
    writer
        .add_track(&TrackConfig::from(AvcConfig {
            width: WIDTH as u16,
            height: HEIGHT as u16,
            seq_param_set: sps.ok_or_else(|| "video fixture has no SPS".to_owned())?,
            pic_param_set: pps.ok_or_else(|| "video fixture has no PPS".to_owned())?,
        }))
        .map_err(|error| error.to_string())?;
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
            .map_err(|error| error.to_string())?;
    }
    writer.write_end().map_err(|error| error.to_string())?;
    fs::write(path, writer.into_writer().into_inner()).map_err(|error| error.to_string())
}

fn create_fixtures(directory: &Path) -> Result<Vec<Fixture>, String> {
    let image_path = directory.join("source.jpg");
    create_image_fixture(&image_path)?;
    let gif_path = directory.join("source.gif");
    create_gif_fixture(&gif_path)?;
    let zip_path = directory.join("source.cbz");
    create_zip_fixture(
        &zip_path,
        &fs::read(&image_path).map_err(|error| error.to_string())?,
    )?;
    let video_path = directory.join("source.mp4");
    create_video_fixture(&video_path)?;
    Ok(vec![
        Fixture {
            name: "image",
            kind: "image",
            source: image_path,
        },
        Fixture {
            name: "gif",
            kind: "gif",
            source: gif_path,
        },
        Fixture {
            name: "video",
            kind: "video",
            source: video_path,
        },
        Fixture {
            name: "zip",
            kind: "zip",
            source: zip_path,
        },
    ])
}

fn benchmark_kind(
    fixture: &Fixture,
    output_directory: &Path,
    rounds: usize,
) -> Result<KindBenchmark, String> {
    let mut cold = Vec::with_capacity(rounds);
    let mut warm = Vec::with_capacity(rounds);
    let mut output_bytes = 0;
    for round in 0..rounds {
        let destination = output_directory.join(format!("{}-{round}.jpg", fixture.name));
        let started = Instant::now();
        let generated =
            thumbnail_cache::generate_thumbnail(&fixture.source, fixture.kind, &destination)?;
        cold.push(elapsed_ms(started));
        if !generated {
            return Err(format!(
                "{} cold round did not generate a thumbnail",
                fixture.name
            ));
        }
        output_bytes = fs::metadata(&destination)
            .map_err(|error| error.to_string())?
            .len();

        let started = Instant::now();
        let generated =
            thumbnail_cache::generate_thumbnail(&fixture.source, fixture.kind, &destination)?;
        warm.push(elapsed_ms(started));
        if generated {
            return Err(format!(
                "{} warm round unexpectedly replaced its cache",
                fixture.name
            ));
        }
    }
    Ok(KindBenchmark {
        kind: fixture.name.to_owned(),
        source_bytes: fs::metadata(&fixture.source)
            .map_err(|error| error.to_string())?
            .len(),
        thumbnail_bytes: output_bytes,
        cache_cold: summarize(cold),
        generator_warm_path_probe: summarize(warm),
    })
}

fn benchmark_pipeline(
    root: &Path,
    image_fixture: &Fixture,
    cached_thumbnail: &Path,
    rounds: usize,
) -> Result<PipelineMicrobenchmarks, String> {
    let micro_rounds = rounds.saturating_mul(40).max(200);
    let relative_source = image_fixture
        .source
        .strip_prefix(root)
        .map_err(|error| error.to_string())?;
    let mut canonicalize = Vec::with_capacity(micro_rounds);
    for _ in 0..micro_rounds {
        let started = Instant::now();
        let canonical_root = root.canonicalize().map_err(|error| error.to_string())?;
        let canonical_source = canonical_root
            .join(relative_source)
            .canonicalize()
            .map_err(|error| error.to_string())?;
        if !canonical_source.starts_with(&canonical_root) {
            return Err("canonical fixture escaped its root".to_owned());
        }
        canonicalize.push(elapsed_ms(started));
    }

    let database = Mutex::new(Connection::open_in_memory().map_err(|error| error.to_string())?);
    {
        let connection = database.lock().map_err(|_| "database lock poisoned")?;
        connection
            .execute_batch(
                r#"CREATE TABLE library_roots(
                       id TEXT PRIMARY KEY, path TEXT, enabled INTEGER
                   );
                   CREATE TABLE media_items(
                       id TEXT PRIMARY KEY, root_id TEXT, relative_path TEXT,
                       media_kind TEXT, modified_at INTEGER, is_missing INTEGER
                   );"#,
            )
            .map_err(|error| error.to_string())?;
        connection
            .execute(
                "INSERT INTO library_roots VALUES ('root', ?1, 1)",
                [root.to_string_lossy().as_ref()],
            )
            .map_err(|error| error.to_string())?;
        connection
            .execute(
                "INSERT INTO media_items VALUES ('media', 'root', ?1, 'image', 1, 0)",
                [relative_source.to_string_lossy().as_ref()],
            )
            .map_err(|error| error.to_string())?;
    }
    let mut sqlite = Vec::with_capacity(micro_rounds);
    for _ in 0..micro_rounds {
        let started = Instant::now();
        let connection = database.lock().map_err(|_| "database lock poisoned")?;
        let _: (String, i64, String, String) = connection
            .query_row(
                r#"SELECT m.media_kind, m.modified_at, r.path, m.relative_path
                   FROM media_items m JOIN library_roots r ON r.id = m.root_id
                   WHERE m.id = ?1 AND m.is_missing = 0 AND r.enabled = 1"#,
                ["media"],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .map_err(|error| error.to_string())?;
        sqlite.push(elapsed_ms(started));
    }

    let mut file_probe = Vec::with_capacity(micro_rounds);
    for _ in 0..micro_rounds {
        let started = Instant::now();
        if !cached_thumbnail.is_file() {
            return Err("cached thumbnail disappeared during benchmark".to_owned());
        }
        file_probe.push(elapsed_ms(started));
    }

    let decoded = image::open(&image_fixture.source).map_err(|error| error.to_string())?;
    let mut resize_encode = Vec::with_capacity(rounds);
    for _ in 0..rounds {
        let started = Instant::now();
        let thumbnail = decoded.thumbnail(THUMBNAIL_EDGE, THUMBNAIL_EDGE).to_rgb8();
        let mut encoded = Vec::new();
        JpegEncoder::new_with_quality(&mut encoded, THUMBNAIL_JPEG_QUALITY)
            .encode_image(&DynamicImage::ImageRgb8(thumbnail))
            .map_err(|error| error.to_string())?;
        if encoded.is_empty() {
            return Err("JPEG benchmark produced no bytes".to_owned());
        }
        resize_encode.push(elapsed_ms(started));
    }

    Ok(PipelineMicrobenchmarks {
        root_and_source_canonicalize: summarize(canonicalize),
        sqlite_thumbnail_source_lookup: summarize(sqlite),
        cached_file_probe: summarize(file_probe),
        resize_and_jpeg_480: summarize(resize_encode),
    })
}

fn benchmark_batch(
    fixtures: &[Fixture],
    output_directory: &Path,
    items: usize,
    workers: usize,
) -> Result<BatchBenchmark, String> {
    let tasks = (0..items)
        .map(|index| {
            let fixture = fixtures[index % fixtures.len()].clone();
            (
                fixture.source,
                fixture.kind.to_owned(),
                output_directory.join(format!("{}-{index}.jpg", fixture.name)),
            )
        })
        .collect::<VecDeque<_>>();
    let queue = Arc::new(Mutex::new(tasks));
    let errors = Arc::new(Mutex::new(Vec::new()));
    let started = Instant::now();
    let mut handles = Vec::new();
    for _ in 0..workers {
        let queue = Arc::clone(&queue);
        let errors = Arc::clone(&errors);
        handles.push(thread::spawn(move || {
            loop {
                let task = queue.lock().ok().and_then(|mut queue| queue.pop_front());
                let Some((source, kind, destination)) = task else {
                    break;
                };
                if let Err(error) =
                    thumbnail_cache::generate_thumbnail(&source, &kind, &destination)
                {
                    if let Ok(mut errors) = errors.lock() {
                        errors.push(error);
                    }
                }
            }
        }));
    }
    for handle in handles {
        handle
            .join()
            .map_err(|_| "thumbnail benchmark worker panicked".to_owned())?;
    }
    let elapsed = elapsed_ms(started);
    let errors = errors
        .lock()
        .map_err(|_| "thumbnail error list lock poisoned")?;
    if !errors.is_empty() {
        return Err(errors.join("; "));
    }
    Ok(BatchBenchmark {
        items,
        workers,
        elapsed_ms: elapsed,
        items_per_second: items as f64 / (elapsed / 1_000.0),
    })
}

fn parse_arguments() -> Result<(usize, usize, Option<PathBuf>), String> {
    let mut rounds = 7_usize;
    let mut batch_items = 16_usize;
    let mut json_path = None;
    let mut arguments = std::env::args().skip(1);
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--rounds" => {
                rounds = arguments
                    .next()
                    .ok_or_else(|| "--rounds requires a number".to_owned())?
                    .parse()
                    .map_err(|_| "--rounds must be a positive number".to_owned())?;
            }
            "--batch-items" => {
                batch_items = arguments
                    .next()
                    .ok_or_else(|| "--batch-items requires a number".to_owned())?
                    .parse()
                    .map_err(|_| "--batch-items must be a positive number".to_owned())?;
            }
            "--json" => {
                json_path = Some(PathBuf::from(
                    arguments
                        .next()
                        .ok_or_else(|| "--json requires a path".to_owned())?,
                ));
            }
            "--help" | "-h" => {
                println!(
                    "Usage: cargo run --release --example thumbnail_benchmark -- \\\n                     [--rounds 7] [--batch-items 16] [--json report.json]"
                );
                std::process::exit(0);
            }
            _ => return Err(format!("Unknown argument: {argument}")),
        }
    }
    if rounds == 0 || batch_items == 0 {
        return Err("rounds and batch-items must be greater than zero".to_owned());
    }
    Ok((rounds, batch_items, json_path))
}

fn run() -> Result<(), String> {
    let (rounds, batch_items, json_path) = parse_arguments()?;
    let workspace = tempdir().map_err(|error| error.to_string())?;
    let source_directory = workspace.path().join("sources");
    fs::create_dir_all(&source_directory).map_err(|error| error.to_string())?;
    eprintln!("Preparing deterministic image/GIF/H.264/ZIP fixtures (not timed)...");
    let fixtures = create_fixtures(&source_directory)?;

    let cold_directory = workspace.path().join("cold");
    fs::create_dir_all(&cold_directory).map_err(|error| error.to_string())?;
    let mut kinds = Vec::new();
    for fixture in &fixtures {
        eprintln!("Benchmarking {}...", fixture.name);
        kinds.push(benchmark_kind(fixture, &cold_directory, rounds)?);
    }
    let image_fixture = fixtures
        .iter()
        .find(|fixture| fixture.kind == "image")
        .ok_or_else(|| "image fixture is missing".to_owned())?;
    let cached_thumbnail = cold_directory.join("image-0.jpg");
    let pipeline = benchmark_pipeline(&source_directory, image_fixture, &cached_thumbnail, rounds)?;

    let sequential_batch = benchmark_batch(
        &fixtures,
        &workspace.path().join("batch-one-worker"),
        batch_items,
        1,
    )?;
    let logical_cpus = thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(1);
    let foreground_worker_limit = production_foreground_worker_limit(logical_cpus);
    let foreground_parallel_batch = benchmark_batch(
        &fixtures,
        &workspace.path().join("batch-foreground-workers"),
        batch_items,
        foreground_worker_limit,
    )?;

    let report = BenchmarkReport {
        generated_at: format!("unix-ms:{}", chrono_free_unix_millis()),
        operating_system: std::env::consts::OS.to_owned(),
        architecture: std::env::consts::ARCH.to_owned(),
        logical_cpus,
        rounds,
        foreground_worker_limit,
        thumbnail_edge: THUMBNAIL_EDGE,
        jpeg_quality: THUMBNAIL_JPEG_QUALITY,
        kinds,
        pipeline,
        sequential_batch,
        foreground_parallel_batch,
    };
    let json = serde_json::to_string_pretty(&report).map_err(|error| error.to_string())?;
    println!("{json}");
    if let Some(path) = json_path {
        if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::write(&path, format!("{json}\n")).map_err(|error| error.to_string())?;
        eprintln!("Wrote {}", path.display());
    }
    Ok(())
}

fn chrono_free_unix_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn main() {
    if let Err(error) = run() {
        eprintln!("Thumbnail benchmark failed: {error}");
        std::process::exit(1);
    }
}
