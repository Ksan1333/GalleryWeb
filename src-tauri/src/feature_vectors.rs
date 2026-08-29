use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    thread,
    time::Duration,
};

#[cfg(not(test))]
use std::{
    fs::{self, File},
    io::{Read, Write},
};

use image::imageops::FilterType;
#[cfg(not(test))]
use image::{
    DynamicImage, Rgb, RgbImage,
    imageops::{crop_imm, resize},
};
#[cfg(not(test))]
use ort::session::Session;
#[cfg(not(test))]
use ort::{session::builder::GraphOptimizationLevel, value::TensorRef};
#[cfg(not(test))]
use reqwest::blocking::Client;
use rusqlite::{Error as SqlError, ErrorCode, OptionalExtension, params, params_from_iter};
use serde::Serialize;
#[cfg(not(test))]
use sha2::{Digest, Sha256};

use crate::{background_activity, catalog, db::AppState, models::MediaItem, thumbnail_cache};

// Android uses MediaPipe ImageEmbedder with MobileNetV3 Small and returns an
// L2-normalized semantic embedding. The Windows build uses the pinned ONNX
// export of the same architecture and L2-normalizes its ImageNet semantic
// output. This replaces the legacy 8x8 color/luminance descriptor.
const MODEL_VERSION: i64 = 2;
const VECTOR_DIMENSIONS: usize = 1_000;
#[cfg(not(test))]
const VECTOR_INPUT_SIZE: u32 = 224;
#[cfg(not(test))]
const VECTOR_RESIZE_SIZE: u32 = 256;
#[cfg(not(test))]
const VECTOR_MODEL_FILE_NAME: &str = "mobilenetv3-small-semantic.onnx";
#[cfg(not(test))]
const VECTOR_MODEL_URL: &str = "https://huggingface.co/onnx-community/mobilenetv3_small_100.lamb_in1k/resolve/4569847969d3038b642f3385c9e515272e90dde2/onnx/model.onnx?download=true";
#[cfg(not(test))]
const VECTOR_MODEL_SHA256: &str =
    "d36eea8c3298d339c232581dff18beed6651eacd607d0a531b7bdb100f8dc713";
#[cfg(not(test))]
const VECTOR_MODEL_MAX_BYTES: u64 = 16 * 1024 * 1024;
const VISUAL_RECOMMENDATION_THRESHOLD: f32 = 0.4;
const VISUAL_RECOMMENDATION_LIMIT: u32 = 25;
const BACKFILL_BATCH_SIZE: u32 = 64;
const BACKFILL_ITEM_YIELD: Duration = Duration::from_millis(8);
const BACKFILL_BATCH_YIELD: Duration = Duration::from_millis(24);

#[derive(Default)]
struct BackfillControl {
    running: bool,
    requested: bool,
}

static BACKFILL_CONTROL: OnceLock<Mutex<BackfillControl>> = OnceLock::new();
#[cfg(not(test))]
static VECTOR_SESSION: OnceLock<Mutex<Option<Session>>> = OnceLock::new();

#[derive(Debug)]
struct VectorCandidate {
    media_id: String,
    absolute_path: PathBuf,
    modified_at: i64,
    byte_size: i64,
}

#[derive(Debug)]
struct ComputedVector {
    media_id: String,
    modified_at: i64,
    byte_size: i64,
    vector_blob: Option<Vec<u8>>,
    error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualRecommendation {
    pub item: MediaItem,
    pub similarity: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualRecommendationResult {
    pub recommendations: Vec<VisualRecommendation>,
    pub indexed_count: u64,
    pub candidate_count: u64,
    pub pending: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdjacentSimilarGroup {
    pub id: String,
    pub media_ids: Vec<String>,
    pub representative: MediaItem,
    pub minimum_similarity: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdjacentSimilarityResult {
    pub groups: Vec<AdjacentSimilarGroup>,
    pub indexed_count: u64,
    pub candidate_count: u64,
    pub pending: bool,
}

#[derive(Debug, Clone, PartialEq)]
struct AdjacentGroupIds {
    media_ids: Vec<String>,
    minimum_similarity: f32,
}

pub fn schedule_backfill(database_path: PathBuf, model_directory: PathBuf) {
    let should_start = {
        let Ok(mut control) = BACKFILL_CONTROL
            .get_or_init(|| Mutex::new(BackfillControl::default()))
            .lock()
        else {
            return;
        };
        control.requested = true;
        if control.running {
            false
        } else {
            control.running = true;
            true
        }
    };
    if !should_start {
        return;
    }

    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = run_scheduled_backfill(&database_path, &model_directory) {
            eprintln!("Visual vector backfill failed: {error}");
            if let Ok(mut control) = BACKFILL_CONTROL
                .get_or_init(|| Mutex::new(BackfillControl::default()))
                .lock()
            {
                control.running = false;
            }
        }
    });
}

pub fn get_adjacent_similarity_groups(
    state: &AppState,
    query: Option<crate::models::MediaQuery>,
    threshold: f32,
) -> Result<AdjacentSimilarityResult, String> {
    let candidates = catalog::list_similarity_candidates(state, query)?;
    let candidate_count = candidates.len() as u64;
    if candidates.len() < 2 {
        return Ok(AdjacentSimilarityResult {
            groups: Vec::new(),
            indexed_count: 0,
            candidate_count,
            pending: false,
        });
    }

    let mut vectors = HashMap::with_capacity(candidates.len());
    let mut resolved_count = 0_u64;
    {
        let connection = state.database.lock()?;
        for chunk in candidates.chunks(400) {
            let placeholders = std::iter::repeat_n("?", chunk.len())
                .collect::<Vec<_>>()
                .join(", ");
            let sql = format!(
                "SELECT m.id, v.vector_blob
                 FROM media_items m
                 JOIN media_visual_vectors v ON v.media_id = m.id
                 WHERE m.id IN ({placeholders})
                   AND v.model_version = {MODEL_VERSION}
                   AND v.dimensions = {VECTOR_DIMENSIONS}
                   AND v.source_modified_at = m.modified_at
                   AND v.source_byte_size = m.byte_size
                   AND (
                        v.vector_blob IS NULL
                        OR length(v.vector_blob) = {VECTOR_DIMENSIONS} * 4
                   )"
            );
            let mut statement = connection
                .prepare(&sql)
                .map_err(|error| format!("Failed to prepare adjacent vector query: {error}"))?;
            let rows = statement
                .query_map(
                    params_from_iter(chunk.iter().map(|item| item.id.as_str())),
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<Vec<u8>>>(1)?)),
                )
                .map_err(|error| format!("Failed to query adjacent vectors: {error}"))?;
            for row in rows {
                let (id, bytes) =
                    row.map_err(|error| format!("Failed to read adjacent vector: {error}"))?;
                resolved_count += 1;
                if let Some(vector) = bytes.as_deref().and_then(decode_vector) {
                    vectors.insert(id, vector);
                }
            }
        }
    }
    let indexed_count = vectors.len() as u64;
    let raw_groups = build_adjacent_group_ids(&candidates, &vectors, threshold.clamp(-1.0, 1.0));
    let representative_ids = raw_groups
        .iter()
        .filter_map(|group| group.media_ids.first().cloned())
        .collect::<Vec<_>>();
    let mut representatives = HashMap::new();
    for chunk in representative_ids.chunks(400) {
        for item in catalog::get_media_items_by_ids(state, chunk)? {
            representatives.insert(item.id.clone(), item);
        }
    }
    let groups = raw_groups
        .into_iter()
        .filter_map(|group| {
            let representative_id = group.media_ids.first()?;
            let representative = representatives.remove(representative_id)?;
            let last_id = group.media_ids.last()?.clone();
            Some(AdjacentSimilarGroup {
                id: format!(
                    "{}:{}:{}",
                    representative_id,
                    last_id,
                    group.media_ids.len()
                ),
                media_ids: group.media_ids,
                representative,
                minimum_similarity: group.minimum_similarity,
            })
        })
        .collect();
    Ok(AdjacentSimilarityResult {
        groups,
        indexed_count,
        candidate_count,
        pending: resolved_count < candidate_count,
    })
}

fn build_adjacent_group_ids(
    candidates: &[catalog::SimilarityCandidate],
    vectors: &HashMap<String, Vec<f32>>,
    threshold: f32,
) -> Vec<AdjacentGroupIds> {
    if candidates.len() < 2 {
        return Vec::new();
    }
    let mut groups = Vec::new();
    let mut current = vec![candidates[0].id.clone()];
    let mut minimum_similarity = 1.0_f32;
    for pair in candidates.windows(2) {
        let previous = &pair[0];
        let next = &pair[1];
        let similarity = vectors
            .get(&previous.id)
            .zip(vectors.get(&next.id))
            .map(|(left, right)| cosine_similarity(left, right));
        if similarity.is_some_and(|score| score >= threshold) {
            let score = similarity.unwrap_or(1.0);
            current.push(next.id.clone());
            minimum_similarity = minimum_similarity.min(score);
        } else {
            if current.len() >= 2 {
                groups.push(AdjacentGroupIds {
                    media_ids: std::mem::take(&mut current),
                    minimum_similarity,
                });
            }
            current = vec![next.id.clone()];
            minimum_similarity = 1.0;
        }
    }
    if current.len() >= 2 {
        groups.push(AdjacentGroupIds {
            media_ids: current,
            minimum_similarity,
        });
    }
    groups
}

fn run_scheduled_backfill(database_path: &Path, model_directory: &Path) -> Result<(), String> {
    let state = AppState::open(database_path)?;
    loop {
        if let Ok(mut control) = BACKFILL_CONTROL
            .get_or_init(|| Mutex::new(BackfillControl::default()))
            .lock()
        {
            control.requested = false;
        }

        loop {
            background_activity::wait_until_quiet(
                Duration::from_secs(3),
                Duration::from_millis(100),
            );
            let processed = backfill_batch(&state, model_directory, BACKFILL_BATCH_SIZE)?;
            if processed == 0 {
                break;
            }
            // Give catalog and viewer commands regular opportunities to acquire
            // SQLite and filesystem resources while a large library is indexed.
            thread::sleep(BACKFILL_BATCH_YIELD);
        }

        let Ok(mut control) = BACKFILL_CONTROL
            .get_or_init(|| Mutex::new(BackfillControl::default()))
            .lock()
        else {
            return Ok(());
        };
        if control.requested {
            continue;
        }
        control.running = false;
        return Ok(());
    }
}

fn backfill_batch(state: &AppState, model_directory: &Path, limit: u32) -> Result<usize, String> {
    let candidates = query_stale_candidates(state, limit)?;
    if candidates.is_empty() {
        checkpoint_wal_passive(state)?;
        return Ok(0);
    }
    ensure_vector_session(model_directory)?;
    let mut computed = Vec::with_capacity(candidates.len());
    for (index, candidate) in candidates.iter().enumerate() {
        background_activity::wait_until_quiet(Duration::from_secs(2), Duration::from_millis(80));
        computed.push(compute_candidate_vector(candidate, model_directory));
        // This indexer intentionally trades a small amount of throughput for
        // foreground responsiveness. Decoding large source images back-to-back
        // can otherwise monopolize disk and CPU while the user scrolls.
        if index + 1 < candidates.len() {
            thread::sleep(BACKFILL_ITEM_YIELD);
        }
    }
    persist_computed_vectors(state, &computed)?;
    // PASSIVE never waits for foreground readers or writers. Running it for an
    // empty batch is deliberate: it also recovers frames left by a previous
    // application run where all vectors are already current.
    checkpoint_wal_passive(state)?;
    Ok(candidates.len())
}

fn query_stale_candidates(state: &AppState, limit: u32) -> Result<Vec<VectorCandidate>, String> {
    let connection = state.database.lock()?;
    let mut statement = connection
        .prepare(
            "SELECT m.id, r.path, m.relative_path, m.modified_at, m.byte_size
             FROM media_items m
             JOIN library_roots r ON r.id = m.root_id
             LEFT JOIN media_visual_vectors v ON v.media_id = m.id
             WHERE r.enabled = 1
               AND m.is_missing = 0
               AND m.media_kind IN ('image', 'gif')
               AND (
                    v.media_id IS NULL
                    OR v.model_version <> ?1
                    OR v.dimensions <> ?2
                    OR (
                        v.vector_blob IS NOT NULL
                        AND length(v.vector_blob) <> ?2 * 4
                    )
                    OR v.source_modified_at <> m.modified_at
                    OR v.source_byte_size <> m.byte_size
               )
             ORDER BY m.updated_at DESC, m.id
             LIMIT ?3",
        )
        .map_err(|error| format!("Failed to prepare visual vector backfill query: {error}"))?;
    let rows = statement
        .query_map(
            params![
                MODEL_VERSION,
                VECTOR_DIMENSIONS as i64,
                i64::from(limit.clamp(1, 256)),
            ],
            |row| {
                let root_path = row.get::<_, String>(1)?;
                let relative_path = row.get::<_, String>(2)?;
                Ok(VectorCandidate {
                    media_id: row.get(0)?,
                    absolute_path: PathBuf::from(root_path).join(relative_path),
                    modified_at: row.get(3)?,
                    byte_size: row.get(4)?,
                })
            },
        )
        .map_err(|error| format!("Failed to query visual vector backfill: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to read visual vector candidates: {error}"))
}

fn query_stale_candidate_by_id(
    state: &AppState,
    media_id: &str,
) -> Result<Option<VectorCandidate>, String> {
    let connection = state.database.lock()?;
    connection
        .query_row(
            "SELECT m.id, r.path, m.relative_path, m.modified_at, m.byte_size
             FROM media_items m
             JOIN library_roots r ON r.id = m.root_id
             LEFT JOIN media_visual_vectors v ON v.media_id = m.id
             WHERE m.id = ?1
               AND r.enabled = 1
               AND m.is_missing = 0
               AND m.media_kind IN ('image', 'gif')
               AND (
                    v.media_id IS NULL
                    OR v.model_version <> ?2
                    OR v.dimensions <> ?3
                    OR (
                        v.vector_blob IS NOT NULL
                        AND length(v.vector_blob) <> ?3 * 4
                    )
                    OR v.source_modified_at <> m.modified_at
                    OR v.source_byte_size <> m.byte_size
               )",
            params![media_id, MODEL_VERSION, VECTOR_DIMENSIONS as i64],
            |row| {
                let root_path = row.get::<_, String>(1)?;
                let relative_path = row.get::<_, String>(2)?;
                Ok(VectorCandidate {
                    media_id: row.get(0)?,
                    absolute_path: PathBuf::from(root_path).join(relative_path),
                    modified_at: row.get(3)?,
                    byte_size: row.get(4)?,
                })
            },
        )
        .optional()
        .map_err(|error| format!("Failed to resolve current visual vector source: {error}"))
}

fn persist_candidate_vector(
    state: &AppState,
    model_directory: &Path,
    candidate: &VectorCandidate,
) -> Result<(), String> {
    ensure_vector_session(model_directory)?;
    let computed = compute_candidate_vector(candidate, model_directory);
    persist_computed_vectors(state, std::slice::from_ref(&computed))
}

/// Ensures the current image/GIF has a fresh recommendation vector.
///
/// Returns `true` when a stale or missing vector was computed and persisted,
/// and `false` when the cached vector was already current (or the media kind
/// is not eligible). This is intentionally callable from the AI analysis job
/// so tag inference and visual indexing advance together for every item.
pub fn ensure_media_vector(
    state: &AppState,
    model_directory: &Path,
    media_id: &str,
) -> Result<bool, String> {
    let Some(candidate) = query_stale_candidate_by_id(state, media_id)? else {
        return Ok(false);
    };
    persist_candidate_vector(state, model_directory, &candidate)?;
    Ok(true)
}

fn compute_candidate_vector(candidate: &VectorCandidate, model_directory: &Path) -> ComputedVector {
    let (vector_blob, error_message) =
        match compute_feature_vector(&candidate.absolute_path, model_directory) {
            Ok(vector) => (Some(encode_vector(&vector)), None),
            Err(error) => (None, Some(error)),
        };
    ComputedVector {
        media_id: candidate.media_id.clone(),
        modified_at: candidate.modified_at,
        byte_size: candidate.byte_size,
        vector_blob,
        error_message,
    }
}

fn persist_computed_vectors(state: &AppState, computed: &[ComputedVector]) -> Result<(), String> {
    if computed.is_empty() {
        return Ok(());
    }
    let mut connection = state.database.lock()?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Failed to start visual feature vector batch: {error}"))?;
    {
        let mut statement = transaction
            .prepare_cached(
                "INSERT INTO media_visual_vectors(
                    media_id, model_version, source_modified_at, source_byte_size,
                    dimensions, vector_blob, error_message, updated_at
                 )
                 SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
                 WHERE EXISTS (
                     SELECT 1
                     FROM media_items
                     WHERE id = ?1 AND modified_at = ?3 AND byte_size = ?4
                 )
                 ON CONFLICT(media_id) DO UPDATE SET
                model_version = excluded.model_version,
                source_modified_at = excluded.source_modified_at,
                source_byte_size = excluded.source_byte_size,
                dimensions = excluded.dimensions,
                vector_blob = excluded.vector_blob,
                error_message = excluded.error_message,
                updated_at = excluded.updated_at",
            )
            .map_err(|error| format!("Failed to prepare visual feature vector batch: {error}"))?;
        let updated_at = catalog::now_millis();
        for vector in computed {
            statement
                .execute(params![
                    &vector.media_id,
                    MODEL_VERSION,
                    vector.modified_at,
                    vector.byte_size,
                    VECTOR_DIMENSIONS as i64,
                    vector.vector_blob.as_deref(),
                    vector.error_message.as_deref(),
                    updated_at,
                ])
                .map_err(|error| format!("Failed to persist visual feature vector: {error}"))?;
        }
    }
    transaction
        .commit()
        .map_err(|error| format!("Failed to commit visual feature vector batch: {error}"))?;
    Ok(())
}

fn checkpoint_wal_passive(state: &AppState) -> Result<(), String> {
    let connection = state.database.lock()?;
    let result = connection.query_row("PRAGMA wal_checkpoint(PASSIVE)", [], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, i64>(2)?,
        ))
    });
    match result {
        // A non-zero busy result is expected when a foreground reader owns an
        // older snapshot. PASSIVE has still checkpointed every safe frame.
        Ok((_busy, _wal_frames, _checkpointed_frames)) => Ok(()),
        Err(error) if is_database_busy(&error) => Ok(()),
        Err(error) => Err(format!(
            "Failed to checkpoint the visual feature vector WAL: {error}"
        )),
    }
}

fn is_database_busy(error: &SqlError) -> bool {
    matches!(
        error,
        SqlError::SqliteFailure(details, _)
            if matches!(
                details.code,
                ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked
            )
    )
}

pub fn get_recommendations(
    state: &AppState,
    model_directory: &Path,
    media_id: &str,
    limit: u32,
) -> Result<VisualRecommendationResult, String> {
    if let Some(candidate) = query_stale_candidate_by_id(state, media_id)? {
        persist_candidate_vector(state, model_directory, &candidate)?;
    }

    let (current_resolved, current_blob) = {
        let connection = state.database.lock()?;
        connection
            .query_row(
                "SELECT CASE
                            WHEN v.media_id IS NOT NULL
                             AND v.model_version = ?2
                             AND v.dimensions = ?3
                             AND v.source_modified_at = m.modified_at
                             AND v.source_byte_size = m.byte_size
                             AND (
                                  v.vector_blob IS NULL
                                  OR length(v.vector_blob) = ?3 * 4
                             )
                            THEN 1 ELSE 0
                        END AS cache_resolved,
                        CASE
                            WHEN v.media_id IS NOT NULL
                             AND v.model_version = ?2
                             AND v.dimensions = ?3
                             AND v.source_modified_at = m.modified_at
                             AND v.source_byte_size = m.byte_size
                             AND length(v.vector_blob) = ?3 * 4
                            THEN v.vector_blob ELSE NULL
                        END AS vector_blob
                 FROM media_items m
                 LEFT JOIN media_visual_vectors v ON v.media_id = m.id
                 WHERE m.id = ?1
                   AND m.is_missing = 0
                   AND m.media_kind IN ('image', 'gif')",
                params![media_id, MODEL_VERSION, VECTOR_DIMENSIONS as i64],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)? != 0,
                        row.get::<_, Option<Vec<u8>>>(1)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| format!("Failed to resolve recommendation source: {error}"))?
            .ok_or_else(|| {
                "The selected image is unavailable for visual recommendations".to_owned()
            })?
    };

    let (candidate_count, resolved_count, indexed_count) = {
        let connection = state.database.lock()?;
        connection
            .query_row(
                "SELECT COUNT(*),
                        COALESCE(SUM(CASE
                            WHEN v.media_id IS NOT NULL
                             AND v.model_version = ?2
                             AND v.dimensions = ?3
                             AND v.source_modified_at = m.modified_at
                             AND v.source_byte_size = m.byte_size
                             AND (
                                  v.vector_blob IS NULL
                                  OR length(v.vector_blob) = ?3 * 4
                             )
                            THEN 1 ELSE 0 END), 0),
                        COALESCE(SUM(CASE
                            WHEN v.media_id IS NOT NULL
                             AND v.model_version = ?2
                             AND v.dimensions = ?3
                             AND v.source_modified_at = m.modified_at
                             AND v.source_byte_size = m.byte_size
                             AND v.vector_blob IS NOT NULL
                             AND length(v.vector_blob) = ?3 * 4
                            THEN 1 ELSE 0 END), 0)
                 FROM media_items m
                 JOIN library_roots r ON r.id = m.root_id
                 LEFT JOIN media_visual_vectors v ON v.media_id = m.id
                 WHERE r.enabled = 1
                   AND m.is_missing = 0
                   AND m.media_kind IN ('image', 'gif')
                   AND m.id <> ?1",
                params![media_id, MODEL_VERSION, VECTOR_DIMENSIONS as i64,],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?.max(0) as u64,
                        row.get::<_, i64>(1)?.max(0) as u64,
                        row.get::<_, i64>(2)?.max(0) as u64,
                    ))
                },
            )
            .map_err(|error| format!("Failed to count visual recommendation cache: {error}"))?
    };
    let pending = !current_resolved || resolved_count < candidate_count;
    let Some(current_vector) = current_blob.as_deref().and_then(decode_vector) else {
        return Ok(VisualRecommendationResult {
            recommendations: Vec::new(),
            indexed_count,
            candidate_count,
            pending,
        });
    };

    let mut scores = {
        let connection = state.database.lock()?;
        let mut statement = connection
            .prepare(
                "SELECT m.id, v.vector_blob
                 FROM media_items m
                 JOIN library_roots r ON r.id = m.root_id
                 JOIN media_visual_vectors v ON v.media_id = m.id
                 WHERE r.enabled = 1
                   AND m.is_missing = 0
                   AND m.media_kind IN ('image', 'gif')
                   AND m.id <> ?1
                   AND v.model_version = ?2
                   AND v.dimensions = ?3
                   AND v.source_modified_at = m.modified_at
                   AND v.source_byte_size = m.byte_size
                   AND v.vector_blob IS NOT NULL
                   AND length(v.vector_blob) = ?3 * 4",
            )
            .map_err(|error| format!("Failed to prepare visual recommendations: {error}"))?;
        let rows = statement
            .query_map(
                params![media_id, MODEL_VERSION, VECTOR_DIMENSIONS as i64,],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?)),
            )
            .map_err(|error| format!("Failed to query visual recommendations: {error}"))?;
        rows.filter_map(|row| {
            let (candidate_id, blob) = row.ok()?;
            let vector = decode_vector(&blob)?;
            let similarity = cosine_similarity(&current_vector, &vector);
            (similarity > VISUAL_RECOMMENDATION_THRESHOLD).then_some((candidate_id, similarity))
        })
        .collect::<Vec<_>>()
    };
    scores.sort_by(|left, right| {
        right
            .1
            .total_cmp(&left.1)
            .then_with(|| left.0.cmp(&right.0))
    });
    scores.truncate(limit.clamp(1, VISUAL_RECOMMENDATION_LIMIT) as usize);

    let ids = scores.iter().map(|(id, _)| id.clone()).collect::<Vec<_>>();
    let media_by_id = catalog::get_media_items_by_ids(state, &ids)?
        .into_iter()
        .map(|item| (item.id.clone(), item))
        .collect::<HashMap<_, _>>();
    let recommendations = scores
        .into_iter()
        .filter_map(|(id, similarity)| {
            media_by_id
                .get(&id)
                .cloned()
                .map(|item| VisualRecommendation {
                    item,
                    similarity: similarity.clamp(0.0, 1.0),
                })
        })
        .collect();

    Ok(VisualRecommendationResult {
        recommendations,
        indexed_count,
        candidate_count,
        pending,
    })
}

#[cfg(not(test))]
fn ensure_vector_session(model_directory: &Path) -> Result<(), String> {
    let mut cached = VECTOR_SESSION
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| "MobileNetV3 vector session is unavailable".to_owned())?;
    if cached.is_some() {
        return Ok(());
    }
    let model_path = ensure_vector_model(model_directory)?;
    let thread_count = std::thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(2)
        .clamp(1, 4);
    let session = Session::builder()
        .map_err(|error| format!("Cannot initialize the MobileNetV3 runtime: {error}"))?
        .with_optimization_level(GraphOptimizationLevel::All)
        .map_err(|error| format!("Cannot configure MobileNetV3 optimization: {error}"))?
        .with_intra_threads(thread_count)
        .map_err(|error| format!("Cannot configure MobileNetV3 threads: {error}"))?
        .commit_from_file(&model_path)
        .map_err(|error| format!("Cannot load the MobileNetV3 model: {error}"))?;
    *cached = Some(session);
    Ok(())
}

#[cfg(test)]
fn ensure_vector_session(_model_directory: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(not(test))]
fn ensure_vector_model(model_directory: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(model_directory)
        .map_err(|error| format!("Cannot create the visual model directory: {error}"))?;
    let destination = model_directory.join(VECTOR_MODEL_FILE_NAME);
    if destination.is_file() && sha256_matches(&destination, VECTOR_MODEL_SHA256)? {
        return Ok(destination);
    }
    if destination.exists() {
        fs::remove_file(&destination)
            .map_err(|error| format!("Cannot replace the invalid visual model: {error}"))?;
    }
    let temporary = model_directory.join(format!("{VECTOR_MODEL_FILE_NAME}.part"));
    if temporary.exists() {
        fs::remove_file(&temporary)
            .map_err(|error| format!("Cannot remove the stale visual model download: {error}"))?;
    }

    let client = Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|error| format!("Cannot prepare the visual model download: {error}"))?;
    let mut response = client
        .get(VECTOR_MODEL_URL)
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .map_err(|error| format!("Cannot download the MobileNetV3 model: {error}"))?;
    if response
        .content_length()
        .is_some_and(|bytes| bytes > VECTOR_MODEL_MAX_BYTES)
    {
        return Err("The MobileNetV3 download exceeds the 16 MB safety limit".to_owned());
    }
    let mut output = File::create(&temporary)
        .map_err(|error| format!("Cannot create the visual model download: {error}"))?;
    let mut hasher = Sha256::new();
    let mut received = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    let download_result = (|| -> Result<(), String> {
        loop {
            let read = response
                .read(&mut buffer)
                .map_err(|error| format!("Cannot read the visual model download: {error}"))?;
            if read == 0 {
                break;
            }
            received = received.saturating_add(read as u64);
            if received > VECTOR_MODEL_MAX_BYTES {
                return Err("The MobileNetV3 download exceeds the 16 MB safety limit".to_owned());
            }
            output
                .write_all(&buffer[..read])
                .map_err(|error| format!("Cannot save the visual model download: {error}"))?;
            hasher.update(&buffer[..read]);
        }
        output
            .flush()
            .and_then(|_| output.sync_all())
            .map_err(|error| format!("Cannot finalize the visual model download: {error}"))?;
        let digest = format!("{:x}", hasher.finalize());
        if !digest.eq_ignore_ascii_case(VECTOR_MODEL_SHA256) {
            return Err("The MobileNetV3 model failed SHA-256 verification".to_owned());
        }
        Ok(())
    })();
    drop(output);
    if let Err(error) = download_result {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    fs::rename(&temporary, &destination)
        .map_err(|error| format!("Cannot install the visual model atomically: {error}"))?;
    Ok(destination)
}

#[cfg(not(test))]
fn sha256_matches(path: &Path, expected: &str) -> Result<bool, String> {
    let mut input = File::open(path)
        .map_err(|error| format!("Cannot open the cached visual model: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = input
            .read(&mut buffer)
            .map_err(|error| format!("Cannot verify the cached visual model: {error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()).eq_ignore_ascii_case(expected))
}

#[cfg(not(test))]
fn to_mobilenet_input(source: DynamicImage) -> Vec<f32> {
    let rgba = source.to_rgba8();
    let mut composited = RgbImage::from_pixel(rgba.width(), rgba.height(), Rgb([255, 255, 255]));
    for (target, source) in composited.pixels_mut().zip(rgba.pixels()) {
        let alpha = u16::from(source[3]);
        for channel in 0..3 {
            let foreground = u16::from(source[channel]) * alpha;
            let background = 255_u16 * (255 - alpha);
            target[channel] = ((foreground + background + 127) / 255) as u8;
        }
    }
    let width = composited.width().max(1);
    let height = composited.height().max(1);
    let (resized_width, resized_height) = if width <= height {
        (
            VECTOR_RESIZE_SIZE,
            ((u64::from(height) * u64::from(VECTOR_RESIZE_SIZE) + u64::from(width) / 2)
                / u64::from(width)) as u32,
        )
    } else {
        (
            ((u64::from(width) * u64::from(VECTOR_RESIZE_SIZE) + u64::from(height) / 2)
                / u64::from(height)) as u32,
            VECTOR_RESIZE_SIZE,
        )
    };
    let resized = resize(
        &composited,
        resized_width.max(VECTOR_INPUT_SIZE),
        resized_height.max(VECTOR_INPUT_SIZE),
        FilterType::CatmullRom,
    );
    let left = resized.width().saturating_sub(VECTOR_INPUT_SIZE) / 2;
    let top = resized.height().saturating_sub(VECTOR_INPUT_SIZE) / 2;
    let pixels = crop_imm(&resized, left, top, VECTOR_INPUT_SIZE, VECTOR_INPUT_SIZE).to_image();
    let plane = (VECTOR_INPUT_SIZE * VECTOR_INPUT_SIZE) as usize;
    let mut input = vec![0.0_f32; plane * 3];
    const MEAN: [f32; 3] = [0.485, 0.456, 0.406];
    const STD: [f32; 3] = [0.229, 0.224, 0.225];
    for (index, pixel) in pixels.pixels().enumerate() {
        for channel in 0..3 {
            input[channel * plane + index] =
                (f32::from(pixel[channel]) / 255.0 - MEAN[channel]) / STD[channel];
        }
    }
    input
}

#[cfg(not(test))]
fn compute_feature_vector(path: &Path, model_directory: &Path) -> Result<Vec<f32>, String> {
    ensure_vector_session(model_directory)?;
    let input = to_mobilenet_input(thumbnail_cache::load_image_for_analysis(path)?);
    let tensor = TensorRef::from_array_view((
        [
            1_usize,
            3_usize,
            VECTOR_INPUT_SIZE as usize,
            VECTOR_INPUT_SIZE as usize,
        ],
        input.as_slice(),
    ))
    .map_err(|error| format!("Cannot create the MobileNetV3 input tensor: {error}"))?;
    let mut cached = VECTOR_SESSION
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| "MobileNetV3 vector session is unavailable".to_owned())?;
    let session = cached
        .as_mut()
        .ok_or_else(|| "MobileNetV3 vector session is not loaded".to_owned())?;
    let outputs = session
        .run(ort::inputs![tensor])
        .map_err(|error| format!("MobileNetV3 inference failed: {error}"))?;
    let (_, values) = outputs[0]
        .try_extract_tensor::<f32>()
        .map_err(|error| format!("Cannot read the MobileNetV3 output: {error}"))?;
    if values.len() != VECTOR_DIMENSIONS || values.iter().any(|value| !value.is_finite()) {
        return Err(format!(
            "Unexpected MobileNetV3 output dimensions: {}",
            values.len()
        ));
    }
    let magnitude = values.iter().map(|value| value * value).sum::<f32>().sqrt();
    if magnitude <= f32::EPSILON {
        return Err("MobileNetV3 returned an empty semantic vector".to_owned());
    }
    Ok(values.iter().map(|value| value / magnitude).collect())
}

#[cfg(test)]
fn compute_feature_vector(path: &Path, _model_directory: &Path) -> Result<Vec<f32>, String> {
    // Unit tests remain deterministic and offline. The ignored end-to-end test
    // below exercises the pinned ONNX model when a model directory is supplied.
    let pixels = thumbnail_cache::load_image_for_analysis(path)?
        .resize_exact(16, 16, FilterType::Triangle)
        .to_rgb8();
    let mut vector = vec![0.0_f32; VECTOR_DIMENSIONS];
    for pixel in pixels.pixels() {
        vector[0] += f32::from(pixel[0]);
        vector[1] += f32::from(pixel[1]);
        vector[2] += f32::from(pixel[2]);
    }
    let magnitude = vector.iter().map(|value| value * value).sum::<f32>().sqrt();
    if magnitude <= f32::EPSILON {
        return Ok(vector);
    }
    vector.iter_mut().for_each(|value| *value /= magnitude);
    Ok(vector)
}

fn encode_vector(vector: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(vector.len() * size_of::<f32>());
    for value in vector {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    bytes
}

fn decode_vector(bytes: &[u8]) -> Option<Vec<f32>> {
    if bytes.len() != VECTOR_DIMENSIONS * size_of::<f32>() {
        return None;
    }
    bytes
        .chunks_exact(size_of::<f32>())
        .map(|chunk| {
            let array: [u8; size_of::<f32>()] = chunk.try_into().ok()?;
            Some(f32::from_le_bytes(array))
        })
        .collect()
}

fn cosine_similarity(left: &[f32], right: &[f32]) -> f32 {
    let mut dot = 0.0_f32;
    let mut left_magnitude = 0.0_f32;
    let mut right_magnitude = 0.0_f32;
    for (left_value, right_value) in left.iter().zip(right) {
        dot += left_value * right_value;
        left_magnitude += left_value * left_value;
        right_magnitude += right_value * right_value;
    }
    if left_magnitude <= f32::EPSILON || right_magnitude <= f32::EPSILON {
        return 0.0;
    }
    (dot / (left_magnitude.sqrt() * right_magnitude.sqrt())).clamp(-1.0, 1.0)
}

#[cfg(test)]
mod tests {
    use std::{fs, path::Path};

    use image::{DynamicImage, Rgba, RgbaImage};
    use rusqlite::params;

    use super::*;

    fn write_color_image(path: &Path, color: [u8; 4]) {
        DynamicImage::ImageRgba8(RgbaImage::from_pixel(32, 32, Rgba(color)))
            .save(path)
            .expect("save visual vector fixture");
    }

    fn seed_root(state: &AppState, path: &Path) {
        let connection = state.database.lock().expect("fixture database");
        connection
            .execute(
                "INSERT INTO library_roots(
                    id, path, display_name, enabled, created_at, updated_at
                 ) VALUES ('root', ?1, 'root', 1, 1, 1)",
                [path.to_string_lossy().as_ref()],
            )
            .expect("seed library root");
    }

    fn seed_media(
        state: &AppState,
        id: &str,
        relative_path: &str,
        kind: &str,
        byte_size: i64,
        modified_at: i64,
    ) {
        let extension = Path::new(relative_path)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("png");
        let connection = state.database.lock().expect("fixture database");
        connection
            .execute(
                "INSERT INTO media_items(
                    id, root_id, relative_path, file_name, extension, media_kind,
                    mime_type, byte_size, modified_at, first_seen_at, last_seen_at,
                    updated_at
                 ) VALUES (?1, 'root', ?2, ?3, ?4, ?5, 'image/test', ?6, ?7, 1, 1, 1)",
                params![
                    id,
                    relative_path,
                    Path::new(relative_path)
                        .file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or(relative_path),
                    extension,
                    kind,
                    byte_size,
                    modified_at,
                ],
            )
            .expect("seed media item");
    }

    fn vector_cache_row(state: &AppState, media_id: &str) -> (i64, i64, bool, Option<String>) {
        let connection = state.database.lock().expect("fixture database");
        connection
            .query_row(
                "SELECT source_modified_at, source_byte_size,
                        vector_blob IS NOT NULL, error_message
                 FROM media_visual_vectors WHERE media_id = ?1",
                [media_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get::<_, i64>(2)? != 0,
                        row.get(3)?,
                    ))
                },
            )
            .expect("visual cache row")
    }

    #[test]
    fn vector_blob_round_trip_is_lossless() {
        let vector = (0..VECTOR_DIMENSIONS)
            .map(|index| index as f32 / VECTOR_DIMENSIONS as f32)
            .collect::<Vec<_>>();
        assert_eq!(decode_vector(&encode_vector(&vector)), Some(vector));
    }

    #[test]
    fn image_content_changes_visual_similarity() {
        let directory = tempfile::tempdir().expect("feature vector fixture");
        let red_path = directory.path().join("red.png");
        let blue_path = directory.path().join("blue.png");
        DynamicImage::ImageRgba8(RgbaImage::from_pixel(32, 32, Rgba([255, 0, 0, 255])))
            .save(&red_path)
            .expect("save red image");
        DynamicImage::ImageRgba8(RgbaImage::from_pixel(32, 32, Rgba([0, 0, 255, 255])))
            .save(&blue_path)
            .expect("save blue image");

        let red = compute_feature_vector(&red_path, Path::new(".")).expect("red vector");
        let red_again =
            compute_feature_vector(&red_path, Path::new(".")).expect("second red vector");
        let blue = compute_feature_vector(&blue_path, Path::new(".")).expect("blue vector");
        assert!(cosine_similarity(&red, &red_again) > 0.999);
        assert!(cosine_similarity(&red, &blue) < 0.8);
    }

    #[test]
    fn backfill_indexes_both_image_and_gif_media() {
        let directory = tempfile::tempdir().expect("backfill fixture");
        let image_path = directory.path().join("image.png");
        let gif_path = directory.path().join("animation.gif");
        write_color_image(&image_path, [230, 40, 80, 255]);
        write_color_image(&gif_path, [40, 100, 230, 255]);
        let state = AppState::in_memory().expect("catalog database");
        seed_root(&state, directory.path());
        seed_media(
            &state,
            "image",
            "image.png",
            "image",
            fs::metadata(&image_path).expect("image metadata").len() as i64,
            10,
        );
        seed_media(
            &state,
            "gif",
            "animation.gif",
            "gif",
            fs::metadata(&gif_path).expect("gif metadata").len() as i64,
            11,
        );

        assert_eq!(
            backfill_batch(&state, Path::new("."), 10).expect("backfill"),
            2
        );
        assert!(vector_cache_row(&state, "image").2);
        assert!(vector_cache_row(&state, "gif").2);
        assert_eq!(
            backfill_batch(&state, Path::new("."), 10).expect("cached backfill"),
            0
        );
    }

    #[test]
    fn vector_batch_rolls_back_all_rows_when_one_upsert_fails() {
        let directory = tempfile::tempdir().expect("transaction fixture");
        let state = AppState::in_memory().expect("catalog database");
        seed_root(&state, directory.path());
        seed_media(&state, "first", "first.png", "image", 10, 10);
        seed_media(&state, "second", "second.png", "image", 10, 10);
        {
            let connection = state.database.lock().expect("fixture database");
            connection
                .execute_batch(
                    "CREATE TRIGGER reject_second_vector
                     BEFORE INSERT ON media_visual_vectors
                     WHEN NEW.media_id = 'second'
                     BEGIN
                         SELECT RAISE(ABORT, 'reject second vector');
                     END;",
                )
                .expect("create rejection trigger");
        }

        let computed = vec![
            ComputedVector {
                media_id: "first".to_owned(),
                modified_at: 10,
                byte_size: 10,
                vector_blob: Some(vec![0; VECTOR_DIMENSIONS * size_of::<f32>()]),
                error_message: None,
            },
            ComputedVector {
                media_id: "second".to_owned(),
                modified_at: 10,
                byte_size: 10,
                vector_blob: Some(vec![0; VECTOR_DIMENSIONS * size_of::<f32>()]),
                error_message: None,
            },
        ];

        assert!(persist_computed_vectors(&state, &computed).is_err());
        let connection = state.database.lock().expect("fixture database");
        let stored: i64 = connection
            .query_row("SELECT COUNT(*) FROM media_visual_vectors", [], |row| {
                row.get(0)
            })
            .expect("count vector cache rows");
        assert_eq!(stored, 0);
    }

    #[test]
    fn empty_backfill_still_runs_a_passive_checkpoint() {
        let directory = tempfile::tempdir().expect("checkpoint fixture");
        let database_path = directory.path().join("catalog.db");
        let state = AppState::open(&database_path).expect("catalog database");

        assert_eq!(
            backfill_batch(&state, Path::new("."), 10).expect("empty backfill"),
            0
        );
        assert!(checkpoint_wal_passive(&state).is_ok());
    }

    #[test]
    fn fingerprint_recomputes_only_after_modified_time_or_size_changes() {
        let directory = tempfile::tempdir().expect("fingerprint fixture");
        let image_path = directory.path().join("image.png");
        write_color_image(&image_path, [120, 180, 70, 255]);
        let size = fs::metadata(&image_path).expect("image metadata").len() as i64;
        let state = AppState::in_memory().expect("catalog database");
        seed_root(&state, directory.path());
        seed_media(&state, "image", "image.png", "image", size, 20);

        assert_eq!(
            backfill_batch(&state, Path::new("."), 10).expect("initial backfill"),
            1
        );
        assert_eq!(
            backfill_batch(&state, Path::new("."), 10).expect("unchanged backfill"),
            0
        );

        {
            let connection = state.database.lock().expect("fixture database");
            connection
                .execute(
                    "UPDATE media_items SET modified_at = 21 WHERE id = 'image'",
                    [],
                )
                .expect("modify timestamp");
        }
        assert_eq!(
            backfill_batch(&state, Path::new("."), 10).expect("modified backfill"),
            1
        );
        assert_eq!(vector_cache_row(&state, "image").0, 21);

        {
            let connection = state.database.lock().expect("fixture database");
            connection
                .execute(
                    "UPDATE media_items SET byte_size = ?1 WHERE id = 'image'",
                    [size + 1],
                )
                .expect("modify size");
        }
        assert_eq!(
            backfill_batch(&state, Path::new("."), 10).expect("resized backfill"),
            1
        );
        assert_eq!(vector_cache_row(&state, "image").1, size + 1);
        assert_eq!(
            backfill_batch(&state, Path::new("."), 10).expect("stable backfill"),
            0
        );
    }

    #[test]
    fn persisted_vectors_are_reused_after_database_reopen() {
        let directory = tempfile::tempdir().expect("restart fixture");
        let library = directory.path().join("library");
        fs::create_dir(&library).expect("create library");
        let image_path = library.join("image.png");
        write_color_image(&image_path, [80, 140, 210, 255]);
        let size = fs::metadata(&image_path).expect("image metadata").len() as i64;
        let database_path = directory.path().join("catalog.db");

        {
            let state = AppState::open(&database_path).expect("first catalog open");
            seed_root(&state, &library);
            seed_media(&state, "image", "image.png", "image", size, 30);
            assert_eq!(
                backfill_batch(&state, Path::new("."), 10).expect("initial backfill"),
                1
            );
        }
        {
            let state = AppState::open(&database_path).expect("reopen catalog");
            assert!(vector_cache_row(&state, "image").2);
            assert_eq!(
                backfill_batch(&state, Path::new("."), 10).expect("restart backfill"),
                0
            );
        }
    }

    #[test]
    fn failed_and_oversized_sources_are_resolved_without_infinite_retry() {
        let directory = tempfile::tempdir().expect("failed source fixture");
        let corrupt_path = directory.path().join("corrupt.png");
        fs::write(&corrupt_path, b"not an image").expect("write corrupt source");
        let oversized_path = directory.path().join("oversized.png");
        let oversized = fs::File::create(&oversized_path).expect("create oversized source");
        oversized
            .set_len(41 * 1024 * 1024)
            .expect("size oversized source");
        let state = AppState::in_memory().expect("catalog database");
        seed_root(&state, directory.path());
        seed_media(&state, "corrupt", "corrupt.png", "image", 12, 40);
        seed_media(
            &state,
            "oversized",
            "oversized.png",
            "image",
            41 * 1024 * 1024,
            41,
        );

        assert_eq!(
            backfill_batch(&state, Path::new("."), 10).expect("failed backfill"),
            2
        );
        let corrupt = vector_cache_row(&state, "corrupt");
        let oversized = vector_cache_row(&state, "oversized");
        assert!(!corrupt.2 && corrupt.3.is_some());
        assert!(!oversized.2 && oversized.3.is_some());
        assert_eq!(
            backfill_batch(&state, Path::new("."), 10).expect("no failed retry"),
            0
        );
    }

    #[test]
    fn recommendations_match_android_across_registered_folders() {
        let directory = tempfile::tempdir().expect("folder recommendation fixture");
        let folder_a = directory.path().join("a");
        let folder_b = directory.path().join("b");
        fs::create_dir(&folder_a).expect("create folder a");
        fs::create_dir(&folder_b).expect("create folder b");
        let source_path = folder_a.join("source.png");
        let same_path = folder_a.join("same.png");
        let other_path = folder_b.join("other.png");
        write_color_image(&source_path, [200, 50, 70, 255]);
        write_color_image(&same_path, [198, 52, 72, 255]);
        write_color_image(&other_path, [200, 50, 70, 255]);
        let state = AppState::in_memory().expect("catalog database");
        seed_root(&state, directory.path());
        for (id, relative_path, path) in [
            ("source", "a/source.png", &source_path),
            ("same", "a/same.png", &same_path),
            ("other", "b/other.png", &other_path),
        ] {
            seed_media(
                &state,
                id,
                relative_path,
                "image",
                fs::metadata(path).expect("image metadata").len() as i64,
                50,
            );
        }
        assert_eq!(
            backfill_batch(&state, Path::new("."), 10).expect("folder backfill"),
            3
        );

        let result = get_recommendations(&state, Path::new("."), "source", 25)
            .expect("visual recommendations");
        assert_eq!(result.candidate_count, 2);
        assert_eq!(result.recommendations.len(), 2);
        assert_eq!(result.recommendations[0].item.id, "other");
    }

    #[test]
    fn adjacent_similarity_chains_and_splits_in_chronological_order() {
        let candidates = (1..=5)
            .map(|index| catalog::SimilarityCandidate {
                id: format!("media-{index}"),
            })
            .collect::<Vec<_>>();
        let vectors = HashMap::from([
            ("media-1".to_owned(), vec![1.0, 0.0]),
            ("media-2".to_owned(), vec![0.95, 0.05]),
            ("media-3".to_owned(), vec![0.9, 0.1]),
            ("media-4".to_owned(), vec![0.0, 1.0]),
            ("media-5".to_owned(), vec![0.1, 0.9]),
        ]);

        let groups = build_adjacent_group_ids(&candidates, &vectors, 0.9);

        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].media_ids, vec!["media-1", "media-2", "media-3"]);
        assert_eq!(groups[1].media_ids, vec!["media-4", "media-5"]);
        assert!(groups.iter().all(|group| group.minimum_similarity >= 0.9));
    }

    #[test]
    fn missing_adjacent_vector_breaks_a_similarity_chain() {
        let candidates = (1..=3)
            .map(|index| catalog::SimilarityCandidate {
                id: format!("media-{index}"),
            })
            .collect::<Vec<_>>();
        let vectors = HashMap::from([
            ("media-2".to_owned(), vec![1.0, 0.0]),
            ("media-3".to_owned(), vec![1.0, 0.0]),
        ]);

        let groups = build_adjacent_group_ids(&candidates, &vectors, 0.6);

        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].media_ids, vec!["media-2", "media-3"]);
    }

    #[test]
    fn adjacent_similarity_handles_ten_thousand_candidates_as_one_linear_chain() {
        let candidates = (0..10_000)
            .map(|index| catalog::SimilarityCandidate {
                id: format!("media-{index:05}"),
            })
            .collect::<Vec<_>>();
        let vectors = candidates
            .iter()
            .map(|candidate| (candidate.id.clone(), vec![1.0, 0.0]))
            .collect::<HashMap<_, _>>();

        let groups = build_adjacent_group_ids(&candidates, &vectors, 0.6);

        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].media_ids.len(), 10_000);
        assert_eq!(groups[0].media_ids.first().unwrap(), "media-00000");
        assert_eq!(groups[0].media_ids.last().unwrap(), "media-09999");
    }
}
