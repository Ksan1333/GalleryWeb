//! Synthetic H.264 test video. No user media or external encoder is used.
use mp4::{AvcConfig, Mp4Config, Mp4Sample, Mp4Writer, TrackConfig};
use openh264::{
    encoder::Encoder,
    formats::{RgbSliceU8, YUVBuffer},
};
use std::{fs, io::Cursor, path::Path};

fn h264_nal_payload(nal: &[u8]) -> &[u8] {
    if nal.starts_with(&[0, 0, 0, 1]) {
        &nal[4..]
    } else if nal.starts_with(&[0, 0, 1]) {
        &nal[3..]
    } else {
        nal
    }
}

pub(super) fn create_h264_mp4(path: &Path) {
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
