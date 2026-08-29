use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs::{self, File},
    io::{BufReader, Read, Write},
    panic::{AssertUnwindSafe, catch_unwind},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use image::{
    AnimationDecoder, DynamicImage, ImageReader, Rgb, RgbImage,
    codecs::gif::GifDecoder,
    imageops::{FilterType, overlay, resize},
};
use ort::{
    session::{Session, builder::GraphOptimizationLevel},
    value::TensorRef,
};
use reqwest::{StatusCode, blocking::Client, header::RANGE};
use rusqlite::{
    OptionalExtension, TransactionBehavior, params, params_from_iter, types::Value as SqlValue,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

use crate::{catalog, db::AppState, feature_vectors};

pub const AI_PROGRESS_EVENT: &str = "ai-analysis-progress";

const MODEL_REPOSITORY: &str = "SmilingWolf/wd-v1-4-moat-tagger-v2";
const MODEL_REVISION: &str = "8452cddf280b952281b6e102411c50e981cb2908";
const MODEL_DISPLAY_NAME: &str = "WD v1.4 MOAT Tagger V2";
const MODEL_LICENSE: &str = "Apache-2.0";
const MODEL_FILE_NAME: &str = "wd-v1-4-moat-tagger-v2.onnx";
const TAGS_FILE_NAME: &str = "selected_tags.csv";
const MODEL_BYTES: u64 = 326_197_340;
const TAGS_BYTES: u64 = 253_906;
const TOTAL_DOWNLOAD_BYTES: u64 = MODEL_BYTES + TAGS_BYTES;
const MODEL_SHA256: &str = "b8cef913be4c9e8d93f9f903e74271416502ce0b4b04df0ff1e2f00df488aa03";
const TAGS_SHA256: &str = "8c8750600db36233a1b274ac88bd46289e588b338218c2e4c62bbc9f2b516368";
const STANDARD_THRESHOLD: f32 = 0.60;
const RATING_THRESHOLD: f32 = 0.30;
const STANDARD_MAX_TAGS: usize = 40;
const DETAILED_MAX_TAGS: usize = 120;
const INPUT_SIZE: u32 = 448;
const CANCELLED_ERROR: &str = "__pixvault_ai_cancelled__";

const MODEL_ASSET: ModelAsset = ModelAsset {
    display_name: "AIモデル",
    file_name: MODEL_FILE_NAME,
    url: "https://huggingface.co/SmilingWolf/wd-v1-4-moat-tagger-v2/resolve/8452cddf280b952281b6e102411c50e981cb2908/model.onnx",
    bytes: MODEL_BYTES,
    sha256: MODEL_SHA256,
};

const TAGS_ASSET: ModelAsset = ModelAsset {
    display_name: "タグ定義",
    file_name: TAGS_FILE_NAME,
    url: "https://huggingface.co/SmilingWolf/wd-v1-4-moat-tagger-v2/resolve/8452cddf280b952281b6e102411c50e981cb2908/selected_tags.csv",
    bytes: TAGS_BYTES,
    sha256: TAGS_SHA256,
};

#[derive(Clone)]
pub struct AiRuntimeState {
    inner: Arc<AiRuntimeInner>,
}

struct AiRuntimeInner {
    model_directory: PathBuf,
    active_job: Mutex<Option<ActiveJob>>,
    progress: Mutex<AiAnalysisProgress>,
    persistence_gate: Mutex<()>,
    session: Mutex<Option<Session>>,
    labels: Mutex<Option<Arc<Vec<ModelLabel>>>>,
}

struct ActiveJob {
    id: String,
    cancel: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAnalysisProgress {
    pub job_id: Option<String>,
    pub phase: String,
    pub message: String,
    pub current_item: usize,
    pub total_items: usize,
    pub current_name: Option<String>,
    pub current_path: Option<String>,
    pub downloaded_bytes: u64,
    pub download_total_bytes: u64,
    pub analyzed_items: usize,
    pub failed_items: usize,
    pub skipped_items: usize,
    pub analysis_level: String,
    pub started_at_ms: Option<i64>,
    pub finished_at_ms: Option<i64>,
    pub detected_tags: usize,
    pub category_counts: Vec<AiCategoryCount>,
    pub preview_name: Option<String>,
    pub preview_tags: Vec<AiTagPreview>,
    /// Only the latest completed item is included in an event. The frontend
    /// keeps a small bounded history for the expanded monitor.
    pub latest_completed_item: Option<AiCompletedItem>,
    /// The UI is already terminal, but an uninterruptible native call from the
    /// cancelled worker has not returned yet. A new job must not start.
    pub cleanup_pending: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiCategoryCount {
    pub category: String,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiTagPreview {
    pub name: String,
    pub category: String,
    pub confidence: f32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiCompletedItem {
    pub media_id: String,
    pub name: String,
    pub path: String,
    pub age_rating: String,
    pub tags: Vec<AiTagPreview>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiModelStatus {
    pub installed: bool,
    pub verified: bool,
    pub model_name: &'static str,
    pub repository: &'static str,
    pub revision: &'static str,
    pub license: &'static str,
    pub model_bytes: u64,
    pub tags_bytes: u64,
    pub total_download_bytes: u64,
    pub install_directory: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiJobStart {
    pub job_id: String,
    pub total_items: usize,
    pub skipped_items: usize,
    pub analysis_level: String,
}

#[derive(Debug, Clone, Deserialize, Default, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct AiAnalysisScope {
    pub root_id: Option<String>,
    pub folder_path: Option<String>,
    pub include_subfolders: bool,
    /// Inclusive Unix timestamp in milliseconds.
    pub modified_from: Option<i64>,
    /// Exclusive Unix timestamp in milliseconds.
    pub modified_before: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiAnalysisScopePreview {
    pub analyzable_items: usize,
}

#[derive(Debug, Clone)]
struct MediaTarget {
    id: String,
    name: String,
    kind: String,
    path: PathBuf,
}

#[derive(Debug)]
enum AnalysisTargetSource {
    Resolved {
        targets: Vec<MediaTarget>,
        skipped_items: usize,
    },
    Scope {
        scope: AiAnalysisScope,
        total_items: usize,
    },
}

#[derive(Debug, Default)]
struct AnalysisJobStats {
    analyzed_items: usize,
    failed_items: usize,
    skipped_items: usize,
    detected_tags: usize,
    category_counts: BTreeMap<String, usize>,
    last_failure: Option<String>,
}

#[derive(Debug)]
struct ScopedTargetRow {
    row_id: i64,
    id: String,
    name: String,
    kind: String,
    root_path: String,
    relative_path: String,
}

#[derive(Debug)]
struct ModelAsset {
    display_name: &'static str,
    file_name: &'static str,
    url: &'static str,
    bytes: u64,
    sha256: &'static str,
}

#[derive(Debug, Clone)]
struct ModelLabel {
    name: String,
    category: u8,
}

#[derive(Debug, Deserialize)]
struct CsvLabel {
    name: String,
    category: u8,
}

#[derive(Debug)]
struct DetectedTag {
    name: String,
    confidence: f32,
    category: &'static str,
}

#[derive(Debug)]
struct AnalysisOutput {
    tags: Vec<DetectedTag>,
    age_rating: &'static str,
    analysis_level: AnalysisLevel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AnalysisLevel {
    Standard,
    Detailed,
}

impl AnalysisLevel {
    fn parse(value: Option<&str>) -> Result<Self, String> {
        match value
            .unwrap_or("standard")
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "" | "standard" => Ok(Self::Standard),
            "detailed" => Ok(Self::Detailed),
            _ => Err("分析レベルは standard または detailed を指定してください".to_owned()),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Standard => "standard",
            Self::Detailed => "detailed",
        }
    }

    fn display_name(self) -> &'static str {
        match self {
            Self::Standard => "標準",
            Self::Detailed => "詳細",
        }
    }

    fn threshold(self, _category: u8) -> f32 {
        // Both analysis levels keep only tags that are at least 60% reliable.
        // Detailed analysis still differs by returning more tags and category
        // metadata, but it must not persist low-confidence guesses.
        STANDARD_THRESHOLD
    }

    fn max_tags(self) -> usize {
        match self {
            Self::Standard => STANDARD_MAX_TAGS,
            Self::Detailed => DETAILED_MAX_TAGS,
        }
    }
}

impl AiAnalysisProgress {
    fn idle() -> Self {
        Self {
            job_id: None,
            phase: "idle".to_owned(),
            message: "AI分析は待機中です".to_owned(),
            current_item: 0,
            total_items: 0,
            current_name: None,
            current_path: None,
            downloaded_bytes: 0,
            download_total_bytes: TOTAL_DOWNLOAD_BYTES,
            analyzed_items: 0,
            failed_items: 0,
            skipped_items: 0,
            analysis_level: AnalysisLevel::Standard.as_str().to_owned(),
            started_at_ms: None,
            finished_at_ms: None,
            detected_tags: 0,
            category_counts: Vec::new(),
            preview_name: None,
            preview_tags: Vec::new(),
            latest_completed_item: None,
            cleanup_pending: false,
            error: None,
        }
    }
}

impl AiRuntimeState {
    pub fn new(model_directory: PathBuf) -> Self {
        // Configure ONNX Runtime before the first session is created. The
        // bundled runtime does not send telemetry.
        let _ = ort::init()
            .with_name("pixvault-ai")
            .with_telemetry(false)
            .commit();
        Self {
            inner: Arc::new(AiRuntimeInner {
                model_directory,
                active_job: Mutex::new(None),
                progress: Mutex::new(AiAnalysisProgress::idle()),
                persistence_gate: Mutex::new(()),
                session: Mutex::new(None),
                labels: Mutex::new(None),
            }),
        }
    }

    fn begin_job(
        &self,
        total_items: usize,
        skipped_items: usize,
        analysis_level: AnalysisLevel,
    ) -> Result<(String, Arc<AtomicBool>, Arc<AtomicBool>), String> {
        let mut active = self
            .inner
            .active_job
            .lock()
            .map_err(|_| "AI job state is unavailable".to_owned())?;
        if active.is_some() {
            let progress = self
                .inner
                .progress
                .lock()
                .map_err(|_| "AI progress state is unavailable".to_owned())?;
            return Err(if progress.cleanup_pending {
                "キャンセルしたAI分析の停止処理中です。完了してから再度開始してください".to_owned()
            } else {
                "別のAI分析が実行中です".to_owned()
            });
        }
        let job_id = Uuid::new_v4().to_string();
        let cancel = Arc::new(AtomicBool::new(false));
        let paused = Arc::new(AtomicBool::new(false));
        *active = Some(ActiveJob {
            id: job_id.clone(),
            cancel: Arc::clone(&cancel),
            paused: Arc::clone(&paused),
        });
        let mut progress = self
            .inner
            .progress
            .lock()
            .map_err(|_| "AI progress state is unavailable".to_owned())?;
        *progress = AiAnalysisProgress {
            job_id: Some(job_id.clone()),
            phase: "queued".to_owned(),
            message: format!("{}AI分析を準備しています", analysis_level.display_name()),
            total_items,
            skipped_items,
            analysis_level: analysis_level.as_str().to_owned(),
            started_at_ms: Some(catalog::now_millis()),
            cleanup_pending: false,
            ..AiAnalysisProgress::idle()
        };
        Ok((job_id, cancel, paused))
    }

    fn update_running_state(
        &self,
        job_id: &str,
        cancel: &AtomicBool,
        update: impl FnOnce(&mut AiAnalysisProgress),
    ) -> Option<AiAnalysisProgress> {
        let mut progress = self.inner.progress.lock().ok()?;
        if progress.job_id.as_deref() != Some(job_id)
            || cancel.load(Ordering::SeqCst)
            || matches!(
                progress.phase.as_str(),
                "paused" | "cancelling" | "cancelled"
            )
        {
            return None;
        }
        update(&mut progress);
        Some(progress.clone())
    }

    fn update_running_progress(
        &self,
        app: &AppHandle,
        job_id: &str,
        cancel: &AtomicBool,
        update: impl FnOnce(&mut AiAnalysisProgress),
    ) {
        if let Some(snapshot) = self.update_running_state(job_id, cancel, update) {
            let _ = app.emit(AI_PROGRESS_EVENT, snapshot);
        }
    }

    fn request_cancel(
        &self,
        requested_job_id: Option<&str>,
    ) -> Result<Option<AiAnalysisProgress>, String> {
        let mut active = self
            .inner
            .active_job
            .lock()
            .map_err(|_| "AI job state is unavailable".to_owned())?;
        let Some(active_job) = active.as_mut() else {
            return Ok(None);
        };
        if requested_job_id.is_some_and(|id| id != active_job.id) {
            return Ok(None);
        }

        // Signal first so an in-flight transaction sees cancellation at its
        // next guarded write/commit boundary.
        active_job.cancel.store(true, Ordering::SeqCst);
        // Persistence holds this gate only for the short SQLite transaction.
        // Waiting here creates a commit barrier: after cancellation is
        // acknowledged, no tag transaction from this job can still commit.
        let _persistence_guard = self
            .inner
            .persistence_gate
            .lock()
            .map_err(|_| "AI persistence state is unavailable".to_owned())?;
        let mut progress = self
            .inner
            .progress
            .lock()
            .map_err(|_| "AI progress state is unavailable".to_owned())?;
        progress.phase = "cancelled".to_owned();
        progress.message = "AI分析をキャンセルしました".to_owned();
        progress.current_name = None;
        progress.current_path = None;
        progress.finished_at_ms = Some(catalog::now_millis());
        progress.cleanup_pending = true;
        progress.error = None;
        Ok(Some(progress.clone()))
    }

    fn set_paused(
        &self,
        requested_job_id: Option<&str>,
        paused: bool,
    ) -> Result<Option<AiAnalysisProgress>, String> {
        let active = self
            .inner
            .active_job
            .lock()
            .map_err(|_| "AI job state is unavailable".to_owned())?;
        let Some(active_job) = active.as_ref() else {
            return Ok(None);
        };
        if requested_job_id.is_some_and(|id| id != active_job.id)
            || active_job.cancel.load(Ordering::SeqCst)
        {
            return Ok(None);
        }
        active_job.paused.store(paused, Ordering::SeqCst);
        let mut progress = self
            .inner
            .progress
            .lock()
            .map_err(|_| "AI progress state is unavailable".to_owned())?;
        if progress.job_id.as_deref() != Some(active_job.id.as_str()) {
            return Ok(None);
        }
        if paused {
            progress.phase = "paused".to_owned();
            progress.message = "AI・ベクトル分析を一時停止しています".to_owned();
        } else {
            progress.phase = "queued".to_owned();
            progress.message = "AI・ベクトル分析を再開しています".to_owned();
        }
        Ok(Some(progress.clone()))
    }

    fn finish_job_state(
        &self,
        job_id: &str,
        update: impl FnOnce(&mut AiAnalysisProgress),
    ) -> Option<AiAnalysisProgress> {
        let mut active = self.inner.active_job.lock().ok()?;
        if !active.as_ref().is_some_and(|job| job.id == job_id) {
            return None;
        }
        let mut progress = self.inner.progress.lock().ok()?;
        if progress.job_id.as_deref() != Some(job_id) {
            return None;
        }
        update(&mut progress);
        progress.finished_at_ms = Some(catalog::now_millis());
        progress.cleanup_pending = false;
        *active = None;
        Some(progress.clone())
    }

    fn finish_job_with_progress(
        &self,
        app: &AppHandle,
        job_id: &str,
        update: impl FnOnce(&mut AiAnalysisProgress),
    ) {
        if let Some(snapshot) = self.finish_job_state(job_id, update) {
            let _ = app.emit(AI_PROGRESS_EVENT, snapshot);
        }
    }
}

#[tauri::command]
pub fn get_ai_model_status(state: State<'_, AiRuntimeState>) -> AiModelStatus {
    let model_path = state.inner.model_directory.join(MODEL_FILE_NAME);
    let tags_path = state.inner.model_directory.join(TAGS_FILE_NAME);
    let model_installed = has_expected_size(&model_path, MODEL_BYTES);
    let tags_installed = has_expected_size(&tags_path, TAGS_BYTES);
    AiModelStatus {
        installed: model_installed && tags_installed,
        verified: model_installed
            && tags_installed
            && has_verification_marker(&model_path, MODEL_SHA256)
            && has_verification_marker(&tags_path, TAGS_SHA256),
        model_name: MODEL_DISPLAY_NAME,
        repository: MODEL_REPOSITORY,
        revision: MODEL_REVISION,
        license: MODEL_LICENSE,
        model_bytes: MODEL_BYTES,
        tags_bytes: TAGS_BYTES,
        total_download_bytes: TOTAL_DOWNLOAD_BYTES,
        install_directory: state.inner.model_directory.to_string_lossy().into_owned(),
    }
}

#[tauri::command]
pub fn get_ai_analysis_status(
    state: State<'_, AiRuntimeState>,
) -> Result<AiAnalysisProgress, String> {
    state
        .inner
        .progress
        .lock()
        .map(|progress| progress.clone())
        .map_err(|_| "AI progress state is unavailable".to_owned())
}

#[tauri::command]
pub fn cancel_ai_analysis(
    app: AppHandle,
    state: State<'_, AiRuntimeState>,
    job_id: Option<String>,
) -> Result<bool, String> {
    let Some(snapshot) = state.request_cancel(job_id.as_deref())? else {
        return Ok(false);
    };
    let _ = app.emit(AI_PROGRESS_EVENT, snapshot);
    Ok(true)
}

#[tauri::command]
pub fn set_ai_analysis_paused(
    app: AppHandle,
    state: State<'_, AiRuntimeState>,
    job_id: Option<String>,
    paused: bool,
) -> Result<bool, String> {
    let Some(snapshot) = state.set_paused(job_id.as_deref(), paused)? else {
        return Ok(false);
    };
    let _ = app.emit(AI_PROGRESS_EVENT, snapshot);
    Ok(true)
}

#[tauri::command]
pub fn preview_ai_analysis_scope(
    catalog_state: State<'_, AppState>,
    scope: AiAnalysisScope,
) -> Result<AiAnalysisScopePreview, String> {
    Ok(AiAnalysisScopePreview {
        analyzable_items: count_scope_targets(&catalog_state, &scope)?,
    })
}

#[tauri::command]
pub fn start_ai_analysis(
    app: AppHandle,
    catalog_state: State<'_, AppState>,
    ai_state: State<'_, AiRuntimeState>,
    media_ids: Option<Vec<String>>,
    scope: Option<AiAnalysisScope>,
    analysis_level: Option<String>,
    total_items_hint: Option<usize>,
) -> Result<AiJobStart, String> {
    let analysis_level = AnalysisLevel::parse(analysis_level.as_deref())?;
    let (target_source, total_items, skipped_items) = match scope {
        Some(scope) => {
            let scope = normalized_scope(&scope)?;
            // The modal already previews this exact scope. Reusing that count
            // avoids running another potentially expensive COUNT before the
            // command can return and the background progress UI can start.
            let total_items = match total_items_hint.filter(|count| *count > 0) {
                Some(count) => count,
                None => count_scope_targets(&catalog_state, &scope)?,
            };
            (
                AnalysisTargetSource::Scope { scope, total_items },
                total_items,
                0,
            )
        }
        None => {
            let (targets, skipped_items) =
                resolve_targets(&catalog_state, media_ids.unwrap_or_default())?;
            let total_items = targets.len();
            (
                AnalysisTargetSource::Resolved {
                    targets,
                    skipped_items,
                },
                total_items,
                skipped_items,
            )
        }
    };
    if total_items == 0 {
        return Err("AI分析できる画像またはGIFが選択されていません".to_owned());
    }

    let runtime = ai_state.inner().clone();
    let (job_id, cancel, paused) = runtime.begin_job(total_items, skipped_items, analysis_level)?;
    if let Ok(progress) = runtime
        .inner
        .progress
        .lock()
        .map(|progress| progress.clone())
    {
        let _ = app.emit(AI_PROGRESS_EVENT, progress);
    }
    let spawned_job_id = job_id.clone();
    let spawned_runtime = runtime.clone();
    let spawned_app = app.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let result = catch_unwind(AssertUnwindSafe(|| {
            run_analysis_job(
                &spawned_app,
                &spawned_runtime,
                &spawned_job_id,
                &cancel,
                &paused,
                target_source,
                analysis_level,
            )
        }))
        .unwrap_or_else(|_| Err("AI分析ワーカーが予期せず停止しました".to_owned()));
        let cancelled = cancel.load(Ordering::SeqCst);
        spawned_runtime.finish_job_with_progress(&spawned_app, &spawned_job_id, move |progress| {
            match result {
                _ if cancelled => {
                    progress.phase = "cancelled".to_owned();
                    progress.message = "AI分析をキャンセルしました".to_owned();
                    progress.current_name = None;
                    progress.current_path = None;
                    progress.error = None;
                }
                Ok((analyzed_items, failed_items)) => {
                    progress.phase = "completed".to_owned();
                    progress.message = if failed_items == 0 {
                        format!("{analyzed_items}件のAI分析が完了しました")
                    } else {
                        format!(
                            "{analyzed_items}件を分析しました（{}件は読み込めませんでした）",
                            failed_items
                        )
                    };
                    progress.current_name = None;
                    progress.current_path = None;
                    progress.current_item = progress.total_items;
                    progress.analyzed_items = analyzed_items;
                    progress.failed_items = failed_items;
                    progress.error = None;
                }
                Err(error) if error == CANCELLED_ERROR => {
                    progress.phase = "cancelled".to_owned();
                    progress.message = "AI分析をキャンセルしました".to_owned();
                    progress.current_name = None;
                    progress.current_path = None;
                    progress.error = None;
                }
                Err(error) => {
                    progress.phase = "failed".to_owned();
                    progress.message = "AI分析に失敗しました".to_owned();
                    progress.current_name = None;
                    progress.current_path = None;
                    progress.error = Some(error);
                }
            }
        });
    });

    Ok(AiJobStart {
        job_id,
        total_items,
        skipped_items,
        analysis_level: analysis_level.as_str().to_owned(),
    })
}

fn normalized_scope(scope: &AiAnalysisScope) -> Result<AiAnalysisScope, String> {
    let root_id = scope
        .root_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let folder_path = scope
        .folder_path
        .as_deref()
        .map(|value| value.replace('\\', "/"))
        .map(|value| value.trim_matches('/').to_owned());
    if folder_path.is_some() && root_id.is_none() {
        return Err("サブフォルダーを指定する場合は登録フォルダーも選択してください".to_owned());
    }
    if folder_path.as_deref().is_some_and(|path| {
        !path.is_empty() && {
            path.split('/')
                .any(|component| component.is_empty() || component == "." || component == "..")
        }
    }) {
        return Err("AI分析のフォルダーパスが不正です".to_owned());
    }
    if let (Some(from), Some(before)) = (scope.modified_from, scope.modified_before)
        && from >= before
    {
        return Err("AI分析の終了日時は開始日時より後にしてください".to_owned());
    }
    Ok(AiAnalysisScope {
        root_id,
        folder_path,
        include_subfolders: scope.include_subfolders,
        modified_from: scope.modified_from,
        modified_before: scope.modified_before,
    })
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn scope_filter(scope: &AiAnalysisScope) -> Result<(String, Vec<SqlValue>), String> {
    let scope = normalized_scope(scope)?;
    let mut conditions = vec![
        "r.enabled = 1".to_owned(),
        "m.is_missing = 0".to_owned(),
        "m.media_kind IN ('image', 'gif')".to_owned(),
    ];
    let mut values = Vec::new();
    if let Some(root_id) = scope.root_id {
        conditions.push("m.root_id = ?".to_owned());
        values.push(SqlValue::Text(root_id));
    }
    if let Some(folder_path) = scope.folder_path {
        const FOLDER_EXPRESSION: &str = "(
            CASE
                WHEN m.relative_path = m.file_name THEN ''
                ELSE substr(
                    m.relative_path,
                    1,
                    length(m.relative_path) - length(m.file_name) - 1
                )
            END COLLATE NOCASE
        )";
        if scope.include_subfolders {
            conditions.push(format!(
                "({FOLDER_EXPRESSION} = ? OR {FOLDER_EXPRESSION} LIKE ? ESCAPE '\\')"
            ));
            values.push(SqlValue::Text(folder_path.clone()));
            values.push(SqlValue::Text(format!("{}/%", escape_like(&folder_path))));
        } else {
            conditions.push(format!("{FOLDER_EXPRESSION} = ?"));
            values.push(SqlValue::Text(folder_path));
        }
    }
    if let Some(modified_from) = scope.modified_from {
        conditions.push("m.modified_at >= ?".to_owned());
        values.push(SqlValue::Integer(modified_from));
    }
    if let Some(modified_before) = scope.modified_before {
        conditions.push("m.modified_at < ?".to_owned());
        values.push(SqlValue::Integer(modified_before));
    }
    Ok((conditions.join(" AND "), values))
}

fn count_scope_targets(state: &AppState, scope: &AiAnalysisScope) -> Result<usize, String> {
    let (filter, values) = scope_filter(scope)?;
    let connection = state.database.lock()?;
    let count = connection
        .query_row(
            &format!(
                "SELECT COUNT(*)
                 FROM media_items m
                 JOIN library_roots r ON r.id = m.root_id
                 WHERE {filter}"
            ),
            params_from_iter(values),
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("AI分析の対象件数を確認できません: {error}"))?;
    Ok(usize::try_from(count).unwrap_or_default())
}

const SCOPE_TARGET_BATCH_SIZE: usize = 64;

fn load_scope_target_rows(
    state: &AppState,
    scope: &AiAnalysisScope,
    after_row_id: i64,
) -> Result<Vec<ScopedTargetRow>, String> {
    let (filter, mut values) = scope_filter(scope)?;
    values.push(SqlValue::Integer(after_row_id));
    values.push(SqlValue::Integer(
        i64::try_from(SCOPE_TARGET_BATCH_SIZE).unwrap_or(i64::MAX),
    ));
    let connection = state.database.lock()?;
    let mut statement = connection
        .prepare(&format!(
            "SELECT m.rowid, m.id, m.file_name, m.media_kind, r.path, m.relative_path
             FROM media_items m
             JOIN library_roots r ON r.id = m.root_id
             WHERE {filter} AND m.rowid > ?
             ORDER BY m.rowid
             LIMIT ?"
        ))
        .map_err(|error| format!("AI分析対象の検索を準備できません: {error}"))?;
    let mapped = statement
        .query_map(params_from_iter(values), |row| {
            Ok(ScopedTargetRow {
                row_id: row.get(0)?,
                id: row.get(1)?,
                name: row.get(2)?,
                kind: row.get(3)?,
                root_path: row.get(4)?,
                relative_path: row.get(5)?,
            })
        })
        .map_err(|error| format!("AI分析対象を検索できません: {error}"))?;
    mapped
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("AI分析対象を読み取れません: {error}"))
}

fn resolve_scoped_target(
    row: ScopedTargetRow,
    canonical_roots: &mut HashMap<String, Option<PathBuf>>,
) -> Option<MediaTarget> {
    let ScopedTargetRow {
        row_id: _,
        id,
        name,
        kind,
        root_path,
        relative_path,
    } = row;
    let relative = Path::new(&relative_path);
    let invalid_relative = relative.is_absolute()
        || relative.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        });
    if invalid_relative {
        return None;
    }
    let canonical_root = canonical_roots
        .entry(root_path)
        .or_insert_with_key(|root| PathBuf::from(root).canonicalize().ok())
        .clone()?;
    let candidate = canonical_root.join(relative);
    let canonical_target = candidate.canonicalize().ok()?;
    if !canonical_target.is_file()
        || canonical_target == canonical_root
        || !canonical_target.starts_with(&canonical_root)
    {
        return None;
    }
    Some(MediaTarget {
        id,
        name,
        kind,
        path: canonical_target,
    })
}

fn resolve_targets(
    state: &AppState,
    media_ids: Vec<String>,
) -> Result<(Vec<MediaTarget>, usize), String> {
    let mut seen = HashSet::new();
    let media_ids = media_ids
        .into_iter()
        .filter(|id| !id.trim().is_empty() && seen.insert(id.clone()))
        .collect::<Vec<_>>();
    let connection = state.database.lock()?;
    let mut candidates = Vec::new();
    let mut skipped = 0;
    for media_id in media_ids {
        let row: Option<(String, String, bool)> = connection
            .query_row(
                "SELECT media_kind, file_name, is_missing
                 FROM media_items
                 WHERE id = ?1",
                [&media_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|error| format!("Failed to resolve AI analysis media: {error}"))?;
        match row {
            Some((kind, name, false)) if kind == "image" || kind == "gif" => {
                candidates.push((media_id, kind, name));
            }
            _ => skipped += 1,
        }
    }
    drop(connection);

    let mut targets = Vec::new();
    for (id, kind, name) in candidates {
        match catalog::resolve_media_path_for_recycle(state, &id) {
            Ok((_, path)) => targets.push(MediaTarget {
                id,
                name,
                kind,
                path,
            }),
            Err(_) => skipped += 1,
        }
    }
    Ok((targets, skipped))
}

fn run_analysis_job(
    app: &AppHandle,
    runtime: &AiRuntimeState,
    job_id: &str,
    cancel: &AtomicBool,
    paused: &AtomicBool,
    target_source: AnalysisTargetSource,
    analysis_level: AnalysisLevel,
) -> Result<(usize, usize), String> {
    wait_if_paused(cancel, paused)?;
    let labels = prepare_runtime(app, runtime, job_id, cancel)?;
    wait_if_paused(cancel, paused)?;
    let mut stats = AnalysisJobStats::default();
    match target_source {
        AnalysisTargetSource::Resolved {
            targets,
            skipped_items,
        } => {
            stats.skipped_items = skipped_items;
            let total_items = targets.len();
            for (index, target) in targets.iter().enumerate() {
                wait_if_paused(cancel, paused)?;
                analyze_target(
                    app,
                    runtime,
                    job_id,
                    cancel,
                    paused,
                    &labels,
                    target,
                    index + 1,
                    total_items,
                    analysis_level,
                    &mut stats,
                )?;
            }
        }
        AnalysisTargetSource::Scope { scope, total_items } => {
            let catalog_state = app.state::<AppState>();
            let mut after_row_id = 0_i64;
            let mut current_item = 0_usize;
            let mut canonical_roots = HashMap::<String, Option<PathBuf>>::new();
            loop {
                wait_if_paused(cancel, paused)?;
                // The catalog mutex is held only while this small page is read.
                // Inference, image decoding and filesystem canonicalization all
                // happen after the guard has been released.
                let rows = load_scope_target_rows(&catalog_state, &scope, after_row_id)?;
                if rows.is_empty() {
                    break;
                }
                after_row_id = rows.last().map(|row| row.row_id).unwrap_or(after_row_id);
                for row in rows {
                    wait_if_paused(cancel, paused)?;
                    current_item += 1;
                    let candidate_path =
                        PathBuf::from(&row.root_path).join(Path::new(&row.relative_path));
                    runtime.update_running_progress(app, job_id, cancel, |progress| {
                        progress.phase = "preprocessing".to_owned();
                        progress.message =
                            format!("画像を確認しています（{current_item}/{total_items}）");
                        progress.current_item = current_item;
                        progress.current_name = Some(row.name.clone());
                        progress.current_path = Some(candidate_path.to_string_lossy().into_owned());
                        apply_stats_to_progress(progress, &stats);
                    });
                    let Some(target) = resolve_scoped_target(row, &mut canonical_roots) else {
                        stats.skipped_items += 1;
                        runtime.update_running_progress(app, job_id, cancel, |progress| {
                            progress.phase = "preprocessing".to_owned();
                            progress.message = format!(
                                "対象外のファイルをスキップしました（{current_item}/{total_items}）"
                            );
                            progress.current_item = current_item;
                            apply_stats_to_progress(progress, &stats);
                        });
                        continue;
                    };
                    analyze_target(
                        app,
                        runtime,
                        job_id,
                        cancel,
                        paused,
                        &labels,
                        &target,
                        current_item,
                        total_items,
                        analysis_level,
                        &mut stats,
                    )?;
                }
                std::thread::yield_now();
            }
            if current_item != total_items {
                runtime.update_running_progress(app, job_id, cancel, |progress| {
                    progress.total_items = current_item;
                    progress.current_item = current_item;
                });
            }
        }
    }

    wait_if_paused(cancel, paused)?;
    if stats.analyzed_items == 0 && (stats.failed_items > 0 || stats.skipped_items > 0) {
        return Err(stats.last_failure.unwrap_or_else(|| {
            "対象ファイルへアクセスできず、AI分析を実行できませんでした".to_owned()
        }));
    }
    Ok((stats.analyzed_items, stats.failed_items))
}

fn apply_stats_to_progress(progress: &mut AiAnalysisProgress, stats: &AnalysisJobStats) {
    progress.analyzed_items = stats.analyzed_items;
    progress.failed_items = stats.failed_items;
    progress.skipped_items = stats.skipped_items;
    progress.detected_tags = stats.detected_tags;
    progress.category_counts = stats
        .category_counts
        .iter()
        .map(|(category, count)| AiCategoryCount {
            category: category.clone(),
            count: *count,
        })
        .collect();
}

#[allow(clippy::too_many_arguments)]
fn analyze_target(
    app: &AppHandle,
    runtime: &AiRuntimeState,
    job_id: &str,
    cancel: &AtomicBool,
    paused: &AtomicBool,
    labels: &[ModelLabel],
    target: &MediaTarget,
    current_item: usize,
    total_items: usize,
    analysis_level: AnalysisLevel,
    stats: &mut AnalysisJobStats,
) -> Result<(), String> {
    wait_if_paused(cancel, paused)?;
    runtime.update_running_progress(app, job_id, cancel, |progress| {
        progress.phase = "preprocessing".to_owned();
        progress.message = format!("画像を準備しています（{current_item}/{total_items}）");
        progress.current_item = current_item;
        progress.current_name = Some(target.name.clone());
        progress.current_path = Some(target.path.to_string_lossy().into_owned());
        progress.latest_completed_item = None;
        apply_stats_to_progress(progress, stats);
    });

    let input = match preprocess_media(target, cancel) {
        Ok(input) => input,
        Err(error) if error == CANCELLED_ERROR => return Err(error),
        Err(error) => {
            stats.failed_items += 1;
            stats.last_failure = Some(error);
            runtime.update_running_progress(app, job_id, cancel, |progress| {
                progress.phase = "preprocessing".to_owned();
                progress.message =
                    format!("画像を読み込めませんでした（{current_item}/{total_items}）");
                apply_stats_to_progress(progress, stats);
            });
            return Ok(());
        }
    };
    wait_if_paused(cancel, paused)?;

    runtime.update_running_progress(app, job_id, cancel, |progress| {
        progress.phase = "analyzing".to_owned();
        progress.message =
            format!("AI・ベクトル特徴を解析しています（{current_item}/{total_items}）");
    });
    let catalog_state = app.state::<AppState>();
    let catalog_ref: &AppState = &catalog_state;
    let (inference_result, vector_result) = std::thread::scope(|scope| {
        let vector_task = scope.spawn(|| {
            feature_vectors::ensure_media_vector(
                catalog_ref,
                &runtime.inner.model_directory,
                &target.id,
            )
        });
        let inference = run_inference(runtime, labels, &input, analysis_level);
        let vector = vector_task.join().unwrap_or_else(|_| {
            Err("Visual vector analysis thread stopped unexpectedly".to_owned())
        });
        (inference, vector)
    });
    if let Err(vector_error) = vector_result {
        // Tag analysis remains useful even when a damaged source cannot be
        // vectorized. The vector table records ordinary decode failures and
        // the background backfill can retry stale infrastructure failures.
        eprintln!(
            "Visual vector analysis failed for {}: {vector_error}",
            target.id
        );
    }
    let output = match inference_result {
        Ok(output) => output,
        Err(error) => {
            stats.failed_items += 1;
            stats.last_failure = Some(error);
            runtime.update_running_progress(app, job_id, cancel, |progress| {
                progress.phase = "analyzing".to_owned();
                progress.message = format!("AI解析に失敗しました（{current_item}/{total_items}）");
                apply_stats_to_progress(progress, stats);
            });
            return Ok(());
        }
    };
    wait_if_paused(cancel, paused)?;

    runtime.update_running_progress(app, job_id, cancel, |progress| {
        progress.phase = "saving".to_owned();
        progress.message = format!("タグを保存しています（{current_item}/{total_items}）");
    });
    let persistence_guard = runtime
        .inner
        .persistence_gate
        .lock()
        .map_err(|_| "AI persistence state is unavailable".to_owned())?;
    wait_if_paused(cancel, paused)?;
    let saved = match persist_analysis(&catalog_state, &target.id, &output, cancel) {
        Ok(()) => {
            stats.analyzed_items += 1;
            stats.detected_tags += output.tags.len();
            for tag in &output.tags {
                *stats
                    .category_counts
                    .entry(tag.category.to_owned())
                    .or_default() += 1;
            }
            true
        }
        Err(error) if error == CANCELLED_ERROR => {
            drop(persistence_guard);
            return Err(error);
        }
        Err(error) => {
            stats.failed_items += 1;
            stats.last_failure = Some(error);
            false
        }
    };
    drop(persistence_guard);
    runtime.update_running_progress(app, job_id, cancel, |progress| {
        progress.message = if saved {
            format!("分析結果を反映しました（{current_item}/{total_items}）")
        } else {
            format!("分析結果を保存できませんでした（{current_item}/{total_items}）")
        };
        apply_stats_to_progress(progress, stats);
        if saved {
            progress.preview_name = Some(target.name.clone());
            progress.preview_tags = output
                .tags
                .iter()
                .take(12)
                .map(|tag| AiTagPreview {
                    name: tag.name.clone(),
                    category: tag.category.to_owned(),
                    confidence: tag.confidence,
                })
                .collect();
            progress.latest_completed_item = Some(AiCompletedItem {
                media_id: target.id.clone(),
                name: target.name.clone(),
                path: target.path.to_string_lossy().into_owned(),
                age_rating: output.age_rating.to_owned(),
                tags: output
                    .tags
                    .iter()
                    .take(24)
                    .map(|tag| AiTagPreview {
                        name: tag.name.clone(),
                        category: tag.category.to_owned(),
                        confidence: tag.confidence,
                    })
                    .collect(),
            });
        }
    });
    Ok(())
}

fn prepare_runtime(
    app: &AppHandle,
    runtime: &AiRuntimeState,
    job_id: &str,
    cancel: &AtomicBool,
) -> Result<Arc<Vec<ModelLabel>>, String> {
    let labels_cached = runtime
        .inner
        .labels
        .lock()
        .map_err(|_| "AI label cache is unavailable".to_owned())?
        .clone();
    let session_cached = runtime
        .inner
        .session
        .lock()
        .map_err(|_| "AI session cache is unavailable".to_owned())?
        .is_some();
    if let (Some(labels), true) = (labels_cached, session_cached) {
        return Ok(labels);
    }

    fs::create_dir_all(&runtime.inner.model_directory).map_err(|error| {
        format!(
            "AIモデル保存先を作成できません（{}）: {error}",
            runtime.inner.model_directory.display()
        )
    })?;
    ensure_asset(app, runtime, job_id, cancel, &MODEL_ASSET, 0)?;
    ensure_asset(app, runtime, job_id, cancel, &TAGS_ASSET, MODEL_BYTES)?;
    check_cancelled(cancel)?;

    // Do not use the mutex guard as the `match` scrutinee directly. A
    // scrutinee temporary lives through the whole match expression, so the
    // cache-miss arm would deadlock when it locks `labels` again to store the
    // freshly parsed definitions.
    let cached_labels = {
        runtime
            .inner
            .labels
            .lock()
            .map_err(|_| "AI label cache is unavailable".to_owned())?
            .clone()
    };
    let labels = match cached_labels {
        Some(labels) => labels,
        None => {
            runtime.update_running_progress(app, job_id, cancel, |progress| {
                progress.phase = "loading".to_owned();
                progress.message =
                    "AIタグ定義（モデル出力とタグ名の対応表）を読み込んでいます".to_owned();
                progress.job_id = Some(job_id.to_owned());
            });
            let loaded = Arc::new(load_labels(
                &runtime.inner.model_directory.join(TAGS_FILE_NAME),
            )?);
            check_cancelled(cancel)?;
            *runtime
                .inner
                .labels
                .lock()
                .map_err(|_| "AI label cache is unavailable".to_owned())? =
                Some(Arc::clone(&loaded));
            loaded
        }
    };

    let mut session = runtime
        .inner
        .session
        .lock()
        .map_err(|_| "AI session cache is unavailable".to_owned())?;
    if session.is_none() {
        runtime.update_running_progress(app, job_id, cancel, |progress| {
            progress.phase = "loading".to_owned();
            progress.message = "AIモデルをメモリに読み込んでいます".to_owned();
            progress.job_id = Some(job_id.to_owned());
        });
        let thread_count = std::thread::available_parallelism()
            .map(usize::from)
            .unwrap_or(2)
            .clamp(1, 4);
        let loaded = Session::builder()
            .map_err(|error| format!("ONNX Runtimeを初期化できません: {error}"))?
            .with_optimization_level(GraphOptimizationLevel::All)
            .map_err(|error| format!("AIモデル最適化を設定できません: {error}"))?
            .with_intra_threads(thread_count)
            .map_err(|error| format!("AI推論スレッドを設定できません: {error}"))?
            .commit_from_file(runtime.inner.model_directory.join(MODEL_FILE_NAME))
            .map_err(|error| format!("AIモデルを読み込めません: {error}"))?;
        check_cancelled(cancel)?;
        *session = Some(loaded);
    }
    Ok(labels)
}

fn ensure_asset(
    app: &AppHandle,
    runtime: &AiRuntimeState,
    job_id: &str,
    cancel: &AtomicBool,
    asset: &ModelAsset,
    progress_offset: u64,
) -> Result<(), String> {
    let path = runtime.inner.model_directory.join(asset.file_name);
    if path.exists() {
        runtime.update_running_progress(app, job_id, cancel, |progress| {
            progress.phase = "verifying".to_owned();
            progress.message = format!("{}を検証しています", asset.display_name);
            progress.job_id = Some(job_id.to_owned());
            progress.downloaded_bytes = progress_offset;
            progress.download_total_bytes = TOTAL_DOWNLOAD_BYTES;
        });
        if has_expected_size(&path, asset.bytes)
            && verify_sha256(&path, asset.sha256, cancel, |verified| {
                runtime.update_running_progress(app, job_id, cancel, |progress| {
                    progress.downloaded_bytes = progress_offset + verified.min(asset.bytes);
                });
            })?
        {
            check_cancelled(cancel)?;
            write_verification_marker(&path, asset.sha256)?;
            return Ok(());
        }
        remove_if_exists(&path)?;
        remove_if_exists(&verification_marker_path(&path))?;
    }

    download_asset(app, runtime, job_id, cancel, asset, progress_offset, &path)
}

fn download_asset(
    app: &AppHandle,
    runtime: &AiRuntimeState,
    job_id: &str,
    cancel: &AtomicBool,
    asset: &ModelAsset,
    progress_offset: u64,
    destination: &Path,
) -> Result<(), String> {
    check_cancelled(cancel)?;
    let part_path = destination.with_extension(format!(
        "{}.part",
        destination
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("download")
    ));
    remove_if_exists(&part_path)?;

    runtime.update_running_progress(app, job_id, cancel, |progress| {
        progress.phase = "downloading".to_owned();
        progress.message = format!("{}をダウンロードしています", asset.display_name);
        progress.job_id = Some(job_id.to_owned());
        progress.downloaded_bytes = progress_offset;
        progress.download_total_bytes = TOTAL_DOWNLOAD_BYTES;
    });

    let client = Client::builder()
        .connect_timeout(Duration::from_secs(30))
        // Assets are fetched in bounded range requests below. This timeout
        // limits how long cancellation can be delayed by one network request.
        .timeout(Duration::from_secs(45))
        .user_agent("PixVault-for-Windows/0.1 AI-model-downloader")
        .build()
        .map_err(|error| format!("AIモデル用HTTPクライアントを作成できません: {error}"))?;
    let mut output = File::create(&part_path)
        .map_err(|error| format!("AIモデルの一時ファイルを作成できません: {error}"))?;
    let mut hasher = Sha256::new();
    let mut received = 0_u64;
    let mut last_reported = 0_u64;
    const DOWNLOAD_RANGE_BYTES: u64 = 2 * 1024 * 1024;

    let download_result = (|| -> Result<(), String> {
        while received < asset.bytes {
            check_cancelled(cancel)?;
            let range_end = received
                .saturating_add(DOWNLOAD_RANGE_BYTES - 1)
                .min(asset.bytes - 1);
            let response = client
                .get(asset.url)
                .header(RANGE, format!("bytes={received}-{range_end}"))
                .send()
                .map_err(|error| format!("{}の受信に失敗しました: {error}", asset.display_name))?;
            let whole_asset_response = response.status() == StatusCode::OK
                && received == 0
                && range_end + 1 == asset.bytes;
            if response.status() != StatusCode::PARTIAL_CONTENT && !whole_asset_response {
                return Err(format!(
                    "{}の配布サーバーが中断可能なダウンロードに対応していません（HTTP {}）",
                    asset.display_name,
                    response.status()
                ));
            }
            let chunk = response
                .bytes()
                .map_err(|error| format!("{}の受信に失敗しました: {error}", asset.display_name))?;
            check_cancelled(cancel)?;
            let expected = usize::try_from(range_end - received + 1)
                .map_err(|_| "AIモデルの受信サイズが大きすぎます".to_owned())?;
            if chunk.len() != expected {
                return Err(format!(
                    "{}の受信サイズが不正です（期待値: {expected} bytes、実際: {} bytes）",
                    asset.display_name,
                    chunk.len()
                ));
            }
            output
                .write_all(&chunk)
                .map_err(|error| format!("AIモデルを書き込めません: {error}"))?;
            hasher.update(&chunk);
            received = range_end + 1;
            if received.saturating_sub(last_reported) >= 2 * 1024 * 1024 || received == asset.bytes
            {
                last_reported = received;
                runtime.update_running_progress(app, job_id, cancel, |progress| {
                    progress.downloaded_bytes = progress_offset + received.min(asset.bytes);
                });
            }
        }
        output
            .flush()
            .map_err(|error| format!("AIモデルを保存できません: {error}"))?;
        output
            .sync_all()
            .map_err(|error| format!("AIモデルを確定できません: {error}"))?;
        if received != asset.bytes {
            return Err(format!(
                "{}のサイズが不正です（期待値: {} bytes、実際: {} bytes）",
                asset.display_name, asset.bytes, received
            ));
        }
        let digest = format!("{:x}", hasher.finalize());
        if !digest.eq_ignore_ascii_case(asset.sha256) {
            return Err(format!("{}のSHA-256検証に失敗しました", asset.display_name));
        }
        check_cancelled(cancel)?;
        Ok(())
    })();
    drop(output);

    if let Err(error) = download_result {
        let _ = remove_if_exists(&part_path);
        return Err(error);
    }
    check_cancelled(cancel).inspect_err(|_| {
        let _ = remove_if_exists(&part_path);
    })?;
    remove_if_exists(destination)?;
    fs::rename(&part_path, destination)
        .map_err(|error| format!("AIモデルをインストールできません: {error}"))?;
    check_cancelled(cancel)?;
    write_verification_marker(destination, asset.sha256)?;
    Ok(())
}

fn verify_sha256(
    path: &Path,
    expected: &str,
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(u64),
) -> Result<bool, String> {
    let mut file =
        File::open(path).map_err(|error| format!("AIモデルを検証用に開けません: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    let mut read_bytes = 0_u64;
    loop {
        check_cancelled(cancel)?;
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("AIモデルの検証中に読み込みに失敗しました: {error}"))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
        read_bytes += count as u64;
        if read_bytes % (4 * 1024 * 1024) < count as u64 {
            on_progress(read_bytes);
        }
    }
    on_progress(read_bytes);
    Ok(format!("{:x}", hasher.finalize()).eq_ignore_ascii_case(expected))
}

fn load_labels(path: &Path) -> Result<Vec<ModelLabel>, String> {
    let mut reader =
        csv::Reader::from_path(path).map_err(|error| format!("AIタグ定義を開けません: {error}"))?;
    let labels = reader
        .deserialize::<CsvLabel>()
        .map(|row| {
            row.map(|label| ModelLabel {
                name: label.name,
                category: label.category,
            })
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("AIタグ定義を解析できません: {error}"))?;
    if labels.is_empty() {
        return Err("AIタグ定義が空です".to_owned());
    }
    Ok(labels)
}

fn preprocess_media(target: &MediaTarget, cancel: &AtomicBool) -> Result<Vec<f32>, String> {
    check_cancelled(cancel)?;
    let image = if target.kind == "gif" {
        let file = File::open(&target.path)
            .map_err(|error| format!("GIFを開けません（{}）: {error}", target.name))?;
        let decoder = GifDecoder::new(BufReader::new(file))
            .map_err(|error| format!("GIFをデコードできません（{}）: {error}", target.name))?;
        let frame = decoder
            .into_frames()
            .next()
            .ok_or_else(|| format!("GIFにフレームがありません（{}）", target.name))?
            .map_err(|error| format!("GIFフレームを読めません（{}）: {error}", target.name))?;
        DynamicImage::ImageRgba8(frame.into_buffer())
    } else {
        ImageReader::open(&target.path)
            .map_err(|error| format!("画像を開けません（{}）: {error}", target.name))?
            .with_guessed_format()
            .map_err(|error| format!("画像形式を判定できません（{}）: {error}", target.name))?
            .decode()
            .map_err(|error| format!("画像をデコードできません（{}）: {error}", target.name))?
    };
    check_cancelled(cancel)?;
    Ok(to_model_input(image))
}

fn to_model_input(image: DynamicImage) -> Vec<f32> {
    let rgba = image.to_rgba8();
    let mut composited = RgbImage::new(rgba.width().max(1), rgba.height().max(1));
    for (x, y, pixel) in rgba.enumerate_pixels() {
        let alpha = u16::from(pixel[3]);
        let blend = |channel: u8| -> u8 {
            let value = u16::from(channel) * alpha + 255 * (255 - alpha);
            ((value + 127) / 255) as u8
        };
        composited.put_pixel(
            x,
            y,
            Rgb([blend(pixel[0]), blend(pixel[1]), blend(pixel[2])]),
        );
    }

    let width = composited.width().max(1);
    let height = composited.height().max(1);
    let scale = (INPUT_SIZE as f64 / width as f64).min(INPUT_SIZE as f64 / height as f64);
    let resized_width = ((width as f64 * scale).round() as u32).clamp(1, INPUT_SIZE);
    let resized_height = ((height as f64 * scale).round() as u32).clamp(1, INPUT_SIZE);
    let resized = resize(
        &composited,
        resized_width,
        resized_height,
        FilterType::Lanczos3,
    );
    let mut canvas = RgbImage::from_pixel(INPUT_SIZE, INPUT_SIZE, Rgb([255, 255, 255]));
    overlay(
        &mut canvas,
        &resized,
        i64::from((INPUT_SIZE - resized_width) / 2),
        i64::from((INPUT_SIZE - resized_height) / 2),
    );

    let mut input = Vec::with_capacity((INPUT_SIZE * INPUT_SIZE * 3) as usize);
    for pixel in canvas.pixels() {
        // The model's reference implementation uses OpenCV BGR values in the
        // 0..255 range and NHWC layout.
        input.push(f32::from(pixel[2]));
        input.push(f32::from(pixel[1]));
        input.push(f32::from(pixel[0]));
    }
    input
}

fn run_inference(
    runtime: &AiRuntimeState,
    labels: &[ModelLabel],
    input: &[f32],
    analysis_level: AnalysisLevel,
) -> Result<AnalysisOutput, String> {
    let tensor = TensorRef::from_array_view((
        [1_usize, INPUT_SIZE as usize, INPUT_SIZE as usize, 3_usize],
        input,
    ))
    .map_err(|error| format!("AI入力テンソルを作成できません: {error}"))?;
    let mut session = runtime
        .inner
        .session
        .lock()
        .map_err(|_| "AI session cache is unavailable".to_owned())?;
    let session = session
        .as_mut()
        .ok_or_else(|| "AIモデルが読み込まれていません".to_owned())?;
    let outputs = session
        .run(ort::inputs![tensor])
        .map_err(|error| format!("AI推論に失敗しました: {error}"))?;
    let (_, scores) = outputs[0]
        .try_extract_tensor::<f32>()
        .map_err(|error| format!("AI出力を読み取れません: {error}"))?;
    if scores.len() != labels.len() {
        return Err(format!(
            "AIモデルとタグ定義の件数が一致しません（{} / {}）",
            scores.len(),
            labels.len()
        ));
    }
    Ok(select_output(labels, scores, analysis_level))
}

fn select_output(
    labels: &[ModelLabel],
    scores: &[f32],
    analysis_level: AnalysisLevel,
) -> AnalysisOutput {
    let mut tags = labels
        .iter()
        .zip(scores)
        .filter_map(|(label, &confidence)| {
            (label.category != 9
                && confidence.is_finite()
                && confidence >= analysis_level.threshold(label.category))
            .then(|| DetectedTag {
                name: label.name.clone(),
                confidence,
                category: tag_category(label.category),
            })
        })
        .collect::<Vec<_>>();
    tags.sort_by(|left, right| right.confidence.total_cmp(&left.confidence));
    tags.truncate(analysis_level.max_tags());

    let age_rating = labels
        .iter()
        .zip(scores)
        .filter(|(label, score)| {
            label.category == 9 && score.is_finite() && **score >= RATING_THRESHOLD
        })
        .max_by(|(left_label, left_score), (right_label, right_score)| {
            left_score.total_cmp(right_score).then_with(|| {
                rating_severity(&left_label.name).cmp(&rating_severity(&right_label.name))
            })
        })
        .map(|(label, _)| rating_from_label(&label.name))
        .unwrap_or("SFW");

    AnalysisOutput {
        tags,
        age_rating,
        analysis_level,
    }
}

fn tag_category(category: u8) -> &'static str {
    match category {
        0 => "general",
        1 => "artist",
        3 => "copyright",
        4 => "character",
        5 => "meta",
        _ => "other",
    }
}

fn rating_from_label(name: &str) -> &'static str {
    match name.to_ascii_lowercase().as_str() {
        "explicit" => "R18",
        "questionable" => "R15",
        _ => "SFW",
    }
}

fn rating_severity(name: &str) -> u8 {
    match rating_from_label(name) {
        "R18" => 2,
        "R15" => 1,
        _ => 0,
    }
}

fn persist_analysis(
    state: &AppState,
    media_id: &str,
    output: &AnalysisOutput,
    cancel: &AtomicBool,
) -> Result<(), String> {
    check_cancelled(cancel)?;
    let mut connection = state.database.lock()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("AI分析結果の保存を開始できません: {error}"))?;
    let exists: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM media_items WHERE id = ?1)",
            [media_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("AI分析対象を確認できません: {error}"))?;
    if !exists {
        return Err("AI分析対象がカタログから削除されています".to_owned());
    }

    check_cancelled(cancel)?;
    transaction
        .execute(
            "DELETE FROM media_tags WHERE media_id = ?1 AND source = 'ai'",
            [media_id],
        )
        .map_err(|error| format!("以前のAIタグを削除できません: {error}"))?;
    let now = catalog::now_millis();
    for tag in &output.tags {
        check_cancelled(cancel)?;
        let existing_id: Option<String> = transaction
            .query_row(
                "SELECT id FROM tags WHERE name = ?1 COLLATE NOCASE",
                [&tag.name],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("既存タグを確認できません: {error}"))?;
        let tag_id = existing_id.unwrap_or_else(|| Uuid::new_v4().to_string());
        transaction
            .execute(
                "INSERT INTO tags(id, name, color, created_at, updated_at)
                 VALUES (?1, ?2, NULL, ?3, ?3)
                 ON CONFLICT(name) DO NOTHING",
                params![tag_id, tag.name, now],
            )
            .map_err(|error| format!("AIタグを作成できません: {error}"))?;
        let persisted_id: String = transaction
            .query_row(
                "SELECT id FROM tags WHERE name = ?1 COLLATE NOCASE",
                [&tag.name],
                |row| row.get(0),
            )
            .map_err(|error| format!("AIタグIDを取得できません: {error}"))?;
        transaction
            .execute(
                "INSERT INTO media_tags(
                    media_id, tag_id, source, confidence, created_at, ai_category
                 )
                 VALUES (?1, ?2, 'ai', ?3, ?4, ?5)
                 ON CONFLICT(media_id, tag_id) DO UPDATE SET
                    source = CASE
                        WHEN media_tags.source = 'ai' THEN excluded.source
                        ELSE media_tags.source
                    END,
                    confidence = CASE
                        WHEN media_tags.source = 'ai' THEN excluded.confidence
                        ELSE media_tags.confidence
                    END,
                    ai_category = CASE
                        WHEN media_tags.source = 'ai' THEN excluded.ai_category
                        ELSE media_tags.ai_category
                    END",
                params![media_id, persisted_id, tag.confidence, now, tag.category],
            )
            .map_err(|error| format!("AIタグをメディアに設定できません: {error}"))?;
    }

    check_cancelled(cancel)?;
    transaction
        .execute(
            "INSERT INTO media_metadata(
                media_id, age_rating, age_rating_source, is_ai_analyzed,
                ai_analysis_model, ai_analyzed_at, ai_analysis_level, updated_at
             )
             VALUES (?1, ?2, 'ai', 1, ?3, ?4, ?5, ?4)
             ON CONFLICT(media_id) DO UPDATE SET
                age_rating = CASE
                    WHEN media_metadata.age_rating_source = 'user'
                        THEN media_metadata.age_rating
                    ELSE excluded.age_rating
                END,
                age_rating_source = CASE
                    WHEN media_metadata.age_rating_source = 'user'
                        THEN media_metadata.age_rating_source
                    ELSE 'ai'
                END,
                is_ai_analyzed = 1,
                ai_analysis_model = excluded.ai_analysis_model,
                ai_analyzed_at = excluded.ai_analyzed_at,
                ai_analysis_level = excluded.ai_analysis_level,
                updated_at = excluded.updated_at",
            params![
                media_id,
                output.age_rating,
                format!("{MODEL_REPOSITORY}@{MODEL_REVISION}"),
                now,
                output.analysis_level.as_str()
            ],
        )
        .map_err(|error| format!("AI分析メタデータを保存できません: {error}"))?;
    check_cancelled(cancel)?;
    transaction
        .commit()
        .map_err(|error| format!("AI分析結果を確定できません: {error}"))
}

fn check_cancelled(cancel: &AtomicBool) -> Result<(), String> {
    if cancel.load(Ordering::SeqCst) {
        Err(CANCELLED_ERROR.to_owned())
    } else {
        Ok(())
    }
}

fn wait_if_paused(cancel: &AtomicBool, paused: &AtomicBool) -> Result<(), String> {
    while paused.load(Ordering::SeqCst) {
        check_cancelled(cancel)?;
        std::thread::sleep(Duration::from_millis(80));
    }
    check_cancelled(cancel)
}

fn has_expected_size(path: &Path, expected: u64) -> bool {
    fs::metadata(path)
        .map(|metadata| metadata.is_file() && metadata.len() == expected)
        .unwrap_or(false)
}

fn verification_marker_path(path: &Path) -> PathBuf {
    path.with_extension(format!(
        "{}.sha256",
        path.extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("file")
    ))
}

fn has_verification_marker(path: &Path, expected: &str) -> bool {
    fs::read_to_string(verification_marker_path(path))
        .map(|content| content.trim().eq_ignore_ascii_case(expected))
        .unwrap_or(false)
}

fn write_verification_marker(path: &Path, sha256: &str) -> Result<(), String> {
    let marker_path = verification_marker_path(path);
    let mut marker = File::create(&marker_path)
        .map_err(|error| format!("AIモデル検証情報を保存できません: {error}"))?;
    marker
        .write_all(sha256.as_bytes())
        .and_then(|_| marker.flush())
        .map_err(|error| format!("AIモデル検証情報を書き込めません: {error}"))
}

fn remove_if_exists(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("一時AIモデルを削除できません: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgba, RgbaImage};

    #[test]
    #[ignore = "requires the downloaded 326 MB WD model; set PIXVAULT_AI_MODEL_DIR"]
    fn installed_model_runs_end_to_end() {
        let model_directory = std::env::var_os("PIXVAULT_AI_MODEL_DIR")
            .map(PathBuf::from)
            .expect("PIXVAULT_AI_MODEL_DIR must point to the downloaded AI model directory");
        let labels = load_labels(&model_directory.join(TAGS_FILE_NAME))
            .expect("downloaded tag definitions should load");
        let runtime = AiRuntimeState::new(model_directory.clone());
        let session = Session::builder()
            .expect("ONNX Runtime should initialize")
            .with_optimization_level(GraphOptimizationLevel::All)
            .expect("graph optimization should configure")
            .with_intra_threads(1)
            .expect("inference thread count should configure")
            .commit_from_file(model_directory.join(MODEL_FILE_NAME))
            .expect("downloaded WD model should load");
        *runtime
            .inner
            .session
            .lock()
            .expect("AI session cache should be available") = Some(session);

        let input = to_model_input(DynamicImage::ImageRgba8(RgbaImage::from_pixel(
            24,
            24,
            Rgba([190, 130, 220, 255]),
        )));
        let output = run_inference(&runtime, &labels, &input, AnalysisLevel::Standard)
            .expect("the downloaded WD model should execute and match its tag definitions");
        assert!(matches!(output.age_rating, "SFW" | "R15" | "R18"));
    }

    #[test]
    fn converts_transparency_to_white_bgr_input() {
        let image = DynamicImage::ImageRgba8(RgbaImage::from_pixel(1, 1, Rgba([10, 20, 30, 0])));
        let input = to_model_input(image);
        assert_eq!(input.len(), (INPUT_SIZE * INPUT_SIZE * 3) as usize);
        assert_eq!(&input[0..3], &[255.0, 255.0, 255.0]);
    }

    #[test]
    fn maps_real_wd_rating_labels() {
        let labels = vec![
            ModelLabel {
                name: "general".to_owned(),
                category: 9,
            },
            ModelLabel {
                name: "questionable".to_owned(),
                category: 9,
            },
            ModelLabel {
                name: "explicit".to_owned(),
                category: 9,
            },
        ];
        assert_eq!(
            select_output(&labels, &[0.1, 0.7, 0.2], AnalysisLevel::Standard).age_rating,
            "R15"
        );
        assert_eq!(
            select_output(&labels, &[0.1, 0.2, 0.8], AnalysisLevel::Standard).age_rating,
            "R18"
        );
    }

    #[test]
    fn all_levels_require_sixty_percent_confidence() {
        let labels = vec![
            ModelLabel {
                name: "blue_hair".to_owned(),
                category: 0,
            },
            ModelLabel {
                name: "example_character".to_owned(),
                category: 4,
            },
            ModelLabel {
                name: "low_score".to_owned(),
                category: 0,
            },
        ];
        let scores = [0.61, 0.72, 0.59];
        let standard = select_output(&labels, &scores, AnalysisLevel::Standard);
        let detailed = select_output(&labels, &scores, AnalysisLevel::Detailed);

        assert_eq!(standard.tags.len(), 2);
        assert_eq!(detailed.tags.len(), 2);
        assert_eq!(detailed.tags[0].category, "character");
        assert_eq!(detailed.tags[1].category, "general");
        assert!(detailed.tags.iter().all(|tag| tag.confidence >= 0.60));
        assert_eq!(detailed.analysis_level, AnalysisLevel::Detailed);
    }

    #[test]
    fn detailed_level_retains_more_high_confidence_tags() {
        let labels = (0..45)
            .map(|index| ModelLabel {
                name: format!("tag_{index:02}"),
                category: 0,
            })
            .collect::<Vec<_>>();
        let scores = vec![0.9; labels.len()];
        assert_eq!(
            select_output(&labels, &scores, AnalysisLevel::Standard)
                .tags
                .len(),
            STANDARD_MAX_TAGS
        );
        assert_eq!(
            select_output(&labels, &scores, AnalysisLevel::Detailed)
                .tags
                .len(),
            labels.len()
        );
    }

    #[test]
    fn analysis_level_defaults_to_standard_for_older_clients() {
        assert_eq!(AnalysisLevel::parse(None).unwrap(), AnalysisLevel::Standard);
        assert_eq!(
            AnalysisLevel::parse(Some("detailed")).unwrap(),
            AnalysisLevel::Detailed
        );
        assert!(AnalysisLevel::parse(Some("unknown")).is_err());
    }

    #[test]
    fn cancellation_is_terminal_immediately_and_blocks_replacement_until_cleanup() {
        let directory = tempfile::tempdir().expect("temporary AI directory");
        let runtime = AiRuntimeState::new(directory.path().join("models"));
        let (job_id, cancel, _paused) = runtime
            .begin_job(3, 0, AnalysisLevel::Standard)
            .expect("start first job");

        assert!(
            runtime
                .request_cancel(Some("another-job"))
                .expect("mismatched cancellation")
                .is_none()
        );
        assert!(!cancel.load(Ordering::SeqCst));

        let cancelled = runtime
            .request_cancel(Some(&job_id))
            .expect("cancel request")
            .expect("active job snapshot");
        assert_eq!(cancelled.phase, "cancelled");
        assert!(cancelled.cleanup_pending);
        assert!(cancel.load(Ordering::SeqCst));

        let late_progress = runtime.update_running_state(&job_id, &cancel, |progress| {
            progress.phase = "analyzing".to_owned();
            progress.message = "must not revive".to_owned();
        });
        assert!(late_progress.is_none());
        assert_eq!(
            runtime.inner.progress.lock().expect("progress lock").phase,
            "cancelled"
        );

        let replacement_error = runtime
            .begin_job(1, 0, AnalysisLevel::Detailed)
            .expect_err("replacement must wait for cleanup");
        assert!(replacement_error.contains("停止処理中"));

        assert!(runtime.finish_job_state("another-job", |_| {}).is_none());
        let cleaned = runtime
            .finish_job_state(&job_id, |progress| {
                progress.phase = "cancelled".to_owned();
                progress.message = "AI分析をキャンセルしました".to_owned();
            })
            .expect("finish cancelled job");
        assert!(!cleaned.cleanup_pending);

        runtime
            .begin_job(1, 0, AnalysisLevel::Detailed)
            .expect("replacement starts after cleanup");
    }

    #[test]
    fn pause_blocks_progress_updates_until_resumed() {
        let directory = tempfile::tempdir().expect("temporary AI directory");
        let runtime = AiRuntimeState::new(directory.path().join("models"));
        let (job_id, cancel, paused) = runtime
            .begin_job(2, 0, AnalysisLevel::Standard)
            .expect("start job");

        let snapshot = runtime
            .set_paused(Some(&job_id), true)
            .expect("pause request")
            .expect("paused snapshot");
        assert_eq!(snapshot.phase, "paused");
        assert!(paused.load(Ordering::SeqCst));
        assert!(
            runtime
                .update_running_state(&job_id, &cancel, |progress| {
                    progress.phase = "analyzing".to_owned();
                })
                .is_none()
        );

        let snapshot = runtime
            .set_paused(Some(&job_id), false)
            .expect("resume request")
            .expect("resumed snapshot");
        assert_eq!(snapshot.phase, "queued");
        assert!(!paused.load(Ordering::SeqCst));
        assert!(
            runtime
                .update_running_state(&job_id, &cancel, |progress| {
                    progress.phase = "analyzing".to_owned();
                })
                .is_some()
        );
    }

    #[test]
    fn replaces_only_ai_tags_and_preserves_manual_rating() {
        let state = AppState::in_memory().expect("database should initialize");
        {
            let connection = state.database.lock().expect("database lock");
            connection
                .execute_batch(
                    "INSERT INTO library_roots(
                        id, path, display_name, enabled, created_at, updated_at
                     ) VALUES ('root', 'C:\\media', 'media', 1, 1, 1);
                     INSERT INTO media_items(
                        id, root_id, relative_path, file_name, extension, media_kind,
                        mime_type, byte_size, modified_at, first_seen_at, last_seen_at,
                        updated_at
                     ) VALUES (
                        'media', 'root', 'image.png', 'image.png', 'png', 'image',
                        'image/png', 1, 1, 1, 1, 1
                     );
                     INSERT INTO media_metadata(
                        media_id, age_rating, age_rating_source, updated_at
                     ) VALUES ('media', 'R18', 'user', 1);
                     INSERT INTO tags(id, name, created_at, updated_at)
                     VALUES
                        ('manual', 'manual_tag', 1, 1),
                        ('old-ai', 'obsolete_ai_tag', 1, 1);
                     INSERT INTO media_tags(media_id, tag_id, source, confidence, created_at)
                     VALUES
                        ('media', 'manual', 'user', NULL, 1),
                        ('media', 'old-ai', 'ai', 0.9, 1);",
                )
                .expect("seed AI persistence test");
        }

        persist_analysis(
            &state,
            "media",
            &AnalysisOutput {
                tags: vec![
                    DetectedTag {
                        name: "manual_tag".to_owned(),
                        confidence: 0.98,
                        category: "general",
                    },
                    DetectedTag {
                        name: "new_ai_tag".to_owned(),
                        confidence: 0.91,
                        category: "character",
                    },
                ],
                age_rating: "SFW",
                analysis_level: AnalysisLevel::Detailed,
            },
            &AtomicBool::new(false),
        )
        .expect("persist AI output");

        let connection = state.database.lock().expect("database lock");
        let (rating, rating_source): (String, String) = connection
            .query_row(
                "SELECT age_rating, age_rating_source
                 FROM media_metadata
                 WHERE media_id = 'media'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("rating result");
        assert_eq!((rating.as_str(), rating_source.as_str()), ("R18", "user"));

        let manual_source: String = connection
            .query_row(
                "SELECT source FROM media_tags WHERE media_id = 'media' AND tag_id = 'manual'",
                [],
                |row| row.get(0),
            )
            .expect("manual tag remains");
        assert_eq!(manual_source, "user");
        let obsolete_count: u32 = connection
            .query_row(
                "SELECT COUNT(*) FROM media_tags
                 WHERE media_id = 'media' AND tag_id = 'old-ai'",
                [],
                |row| row.get(0),
            )
            .expect("obsolete AI tag count");
        assert_eq!(obsolete_count, 0);
        let new_source: String = connection
            .query_row(
                "SELECT mt.source
                 FROM media_tags mt
                 JOIN tags t ON t.id = mt.tag_id
                 WHERE mt.media_id = 'media' AND t.name = 'new_ai_tag'",
                [],
                |row| row.get(0),
            )
            .expect("new AI tag");
        assert_eq!(new_source, "ai");
        let (category, level): (String, String) = connection
            .query_row(
                "SELECT mt.ai_category, mm.ai_analysis_level
                 FROM media_tags mt
                 JOIN tags t ON t.id = mt.tag_id
                 JOIN media_metadata mm ON mm.media_id = mt.media_id
                 WHERE mt.media_id = 'media' AND t.name = 'new_ai_tag'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("detailed AI metadata");
        assert_eq!(
            (category.as_str(), level.as_str()),
            ("character", "detailed")
        );
        drop(connection);

        let media = catalog::list_media_items(&state, None)
            .expect("catalog media with AI tags")
            .remove(0);
        let ai_tag = media
            .tags
            .iter()
            .find(|tag| tag.name == "new_ai_tag")
            .expect("serialized AI tag");
        assert_eq!(ai_tag.source.as_deref(), Some("ai"));
        assert_eq!(ai_tag.confidence, Some(0.91));
        assert_eq!(ai_tag.ai_category.as_deref(), Some("character"));
    }

    #[test]
    fn scoped_count_filters_images_by_folder_descendants_and_period() {
        let state = AppState::in_memory().expect("database should initialize");
        {
            let connection = state.database.lock().expect("database lock");
            connection
                .execute_batch(
                    "INSERT INTO library_roots(
                        id, path, display_name, enabled, created_at, updated_at
                     ) VALUES
                        ('root-a', 'C:\\media-a', 'A', 1, 1, 1),
                        ('root-b', 'C:\\media-b', 'B', 1, 1, 1);
                     INSERT INTO media_items(
                        id, root_id, relative_path, file_name, extension, media_kind,
                        mime_type, byte_size, modified_at, first_seen_at, last_seen_at,
                        updated_at
                     ) VALUES
                        ('direct', 'root-a', 'art/direct.png', 'direct.png', 'png', 'image',
                         'image/png', 1, 200, 1, 1, 1),
                        ('nested', 'root-a', 'art/reference/nested.gif', 'nested.gif', 'gif', 'gif',
                         'image/gif', 1, 250, 1, 1, 1),
                        ('old', 'root-a', 'art/old.png', 'old.png', 'png', 'image',
                         'image/png', 1, 50, 1, 1, 1),
                        ('video', 'root-a', 'art/video.mp4', 'video.mp4', 'mp4', 'video',
                         'video/mp4', 1, 220, 1, 1, 1),
                        ('other-root', 'root-b', 'art/other.png', 'other.png', 'png', 'image',
                         'image/png', 1, 220, 1, 1, 1),
                        ('root-direct', 'root-a', 'root.png', 'root.png', 'png', 'image',
                         'image/png', 1, 220, 1, 1, 1);",
                )
                .expect("seed scoped analysis count");
        }

        let scope = AiAnalysisScope {
            root_id: Some("root-a".to_owned()),
            folder_path: Some("art".to_owned()),
            include_subfolders: true,
            modified_from: Some(100),
            modified_before: Some(300),
        };
        assert_eq!(count_scope_targets(&state, &scope).unwrap(), 2);

        let direct_only = AiAnalysisScope {
            include_subfolders: false,
            ..scope
        };
        assert_eq!(count_scope_targets(&state, &direct_only).unwrap(), 1);

        let root_direct_only = AiAnalysisScope {
            root_id: Some("root-a".to_owned()),
            folder_path: Some(String::new()),
            include_subfolders: false,
            modified_from: None,
            modified_before: None,
        };
        assert_eq!(count_scope_targets(&state, &root_direct_only).unwrap(), 1);
    }

    #[test]
    fn scoped_targets_are_loaded_in_bounded_keyset_pages() {
        let state = AppState::in_memory().expect("database should initialize");
        {
            let connection = state.database.lock().expect("database lock");
            connection
                .execute(
                    "INSERT INTO library_roots(
                        id, path, display_name, enabled, created_at, updated_at
                     ) VALUES ('root', 'C:\\media', 'media', 1, 1, 1)",
                    [],
                )
                .expect("seed root");
            for index in 0..130 {
                let id = format!("media-{index:03}");
                let file_name = format!("image-{index:03}.png");
                connection
                    .execute(
                        "INSERT INTO media_items(
                            id, root_id, relative_path, file_name, extension, media_kind,
                            mime_type, byte_size, modified_at, first_seen_at, last_seen_at,
                            updated_at
                         ) VALUES (?1, 'root', ?2, ?2, 'png', 'image',
                            'image/png', 1, ?3, 1, 1, 1)",
                        params![id, file_name, index],
                    )
                    .expect("seed scoped target");
            }
        }
        let scope = AiAnalysisScope {
            root_id: Some("root".to_owned()),
            include_subfolders: true,
            ..AiAnalysisScope::default()
        };
        let first = load_scope_target_rows(&state, &scope, 0).expect("first target page");
        assert_eq!(first.len(), SCOPE_TARGET_BATCH_SIZE);
        let first_cursor = first.last().expect("first cursor").row_id;
        let second =
            load_scope_target_rows(&state, &scope, first_cursor).expect("second target page");
        assert_eq!(second.len(), SCOPE_TARGET_BATCH_SIZE);
        assert!(second.first().expect("second row").row_id > first_cursor);
        let second_cursor = second.last().expect("second cursor").row_id;
        let third =
            load_scope_target_rows(&state, &scope, second_cursor).expect("third target page");
        assert_eq!(third.len(), 2);
        let final_cursor = third.last().expect("final cursor").row_id;
        assert!(
            load_scope_target_rows(&state, &scope, final_cursor)
                .expect("empty target page")
                .is_empty()
        );
    }

    #[test]
    fn cancelled_persistence_does_not_change_existing_ai_tags() {
        let state = AppState::in_memory().expect("database should initialize");
        {
            let connection = state.database.lock().expect("database lock");
            connection
                .execute_batch(
                    "INSERT INTO library_roots(
                        id, path, display_name, enabled, created_at, updated_at
                     ) VALUES ('root', 'C:\\media', 'media', 1, 1, 1);
                     INSERT INTO media_items(
                        id, root_id, relative_path, file_name, extension, media_kind,
                        mime_type, byte_size, modified_at, first_seen_at, last_seen_at,
                        updated_at
                     ) VALUES (
                        'media', 'root', 'image.png', 'image.png', 'png', 'image',
                        'image/png', 1, 1, 1, 1, 1
                     );
                     INSERT INTO tags(id, name, created_at, updated_at)
                     VALUES ('old-ai', 'old_ai_tag', 1, 1);
                     INSERT INTO media_tags(media_id, tag_id, source, confidence, created_at)
                     VALUES ('media', 'old-ai', 'ai', 0.9, 1);",
                )
                .expect("seed cancellation persistence test");
        }

        let cancel = AtomicBool::new(true);
        let result = persist_analysis(
            &state,
            "media",
            &AnalysisOutput {
                tags: vec![DetectedTag {
                    name: "new_ai_tag".to_owned(),
                    confidence: 0.95,
                    category: "general",
                }],
                age_rating: "SFW",
                analysis_level: AnalysisLevel::Standard,
            },
            &cancel,
        );
        assert_eq!(result.unwrap_err(), CANCELLED_ERROR);

        let connection = state.database.lock().expect("database lock");
        let old_count: u32 = connection
            .query_row(
                "SELECT COUNT(*) FROM media_tags
                 WHERE media_id = 'media' AND tag_id = 'old-ai'",
                [],
                |row| row.get(0),
            )
            .expect("old tag count");
        assert_eq!(old_count, 1);
    }
}
