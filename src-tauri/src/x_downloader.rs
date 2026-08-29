use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

use reqwest::{
    Url,
    blocking::{Client, Response},
    header::{CONTENT_TYPE, USER_AGENT},
};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::{
    catalog,
    db::AppState,
    models::{XHistoryInput, XHistoryItem},
    video_decode,
};

const MAX_X_MEDIA_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_X_METADATA_BYTES: u64 = 8 * 1024 * 1024;
const MAX_X_MEDIA_ITEMS: usize = 16;
const MAX_PENDING_X_GIFS: usize = 128;
const SYNDICATION_ENDPOINT: &str = "https://cdn.syndication.twimg.com/tweet-result";
const FXTWITTER_ENDPOINT: &str = "https://api.fxtwitter.com/status";
const SYNDICATION_FEATURES: &str = "tfw_timeline_list:;tfw_follower_count_sunset:true;\
tfw_tweet_edit_backend:on;tfw_refsrc_session:on;\
tfw_fosnr_soft_interventions_enabled:on;tfw_show_birdwatch_pivots_enabled:on;\
tfw_show_business_verified_badge:on;tfw_duplicate_scribes_to_settings:on;\
tfw_use_profile_image_shape_enabled:on;tfw_show_blue_verified_badge:on;\
tfw_legacy_timeline_sunset:true;tfw_show_gov_verified_badge:on;\
tfw_show_business_affiliate_badge:on;tfw_tweet_edit_frontend:on";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XDownloadResult {
    pub history: XHistoryItem,
    pub files: Vec<String>,
    pub media_count: usize,
    pub media: Vec<XDownloadedMedia>,
    pub duplicate_count: usize,
    pub duplicate_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XDownloadedMedia {
    pub media_id: String,
    pub kind: String,
    pub path: String,
    pub final_path: Option<String>,
    pub gif_finalize_token: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XGifFinalizeResult {
    pub path: String,
    pub history: Option<XHistoryItem>,
    pub removed_source: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XPostInspection {
    pub source_url: String,
    pub post_id: String,
    pub author: String,
    pub post_text: String,
    pub media: Vec<XMediaItem>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XMediaItem {
    pub id: String,
    pub kind: String,
    pub preview_url: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub variants: Vec<XMediaVariant>,
    pub already_downloaded: bool,
    pub existing_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct XMediaVariant {
    pub id: String,
    pub label: String,
    pub url: String,
    pub extension: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub bitrate: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct XMediaSelection {
    pub media_id: String,
    pub variant_id: String,
}

#[derive(Debug, Clone)]
struct ResolvedXMedia {
    media_id: String,
    kind: String,
    variant: XMediaVariant,
}

#[derive(Debug, Clone)]
struct PendingGifFinalize {
    source_path: PathBuf,
    output_path: PathBuf,
    history_id: String,
    history_source_url: String,
    history_media_url: Option<String>,
    history_author: Option<String>,
    history_post_text: Option<String>,
    history_error_message: Option<String>,
    history_created_at: i64,
    history_completed_at: Option<i64>,
    is_history_primary: bool,
    media_key: String,
    destination_dir: String,
    variant_url: String,
    media_kind: String,
    registered_at: i64,
}

static PENDING_X_GIF_FINALIZATIONS: OnceLock<Mutex<HashMap<String, PendingGifFinalize>>> =
    OnceLock::new();

pub fn inspect_x_post(source_url: &str) -> Result<XPostInspection, String> {
    let (post_id, source_url) = parse_post_url(source_url)?;
    let metadata_client = build_metadata_client()?;
    let payload = fetch_post_payload(&metadata_client, &post_id)?;
    inspection_from_payload(source_url, post_id, &payload)
}

pub fn inspect_x_post_for_destination(
    state: &AppState,
    source_url: &str,
    destination: Option<&Path>,
) -> Result<XPostInspection, String> {
    let mut inspection = inspect_x_post(source_url)?;
    let Some(destination) = destination.filter(|path| path.is_dir()) else {
        return Ok(inspection);
    };
    let destination = destination.canonicalize().map_err(|error| {
        format!(
            "Xメディアの保存先 {} を確認できませんでした: {error}",
            destination.display()
        )
    })?;
    for media in &mut inspection.media {
        if let Some(path) =
            find_completed_duplicate(state, &inspection.source_url, &media.id, &destination)?
        {
            media.already_downloaded = true;
            media.existing_path = Some(path.to_string_lossy().into_owned());
        }
    }
    Ok(inspection)
}

pub(crate) fn canonical_post_url(source_url: &str) -> Result<String, String> {
    parse_post_url(source_url).map(|(_, canonical)| canonical)
}

fn find_completed_duplicate(
    state: &AppState,
    source_url: &str,
    media_key: &str,
    destination: &Path,
) -> Result<Option<PathBuf>, String> {
    let destination = destination.to_string_lossy();
    let connection = state.database.lock()?;
    let local_path = connection
        .query_row(
            "SELECT local_path
             FROM x_downloaded_media
             WHERE source_url = ?1
               AND media_key = ?2
               AND destination_dir = ?3
               AND status = 'completed'",
            params![source_url, media_key, destination.as_ref()],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Xメディアの重複履歴を確認できませんでした: {error}"))?;
    Ok(local_path.map(PathBuf::from).filter(|path| path.is_file()))
}

#[allow(clippy::too_many_arguments)]
fn record_x_media_status(
    state: &AppState,
    source_url: &str,
    media_key: &str,
    destination: &Path,
    history_id: &str,
    variant_url: &str,
    local_path: &Path,
    media_kind: &str,
    status: &str,
) -> Result<(), String> {
    let now = now_millis();
    let completed_at = (status == "completed").then_some(now);
    state
        .database
        .lock()?
        .execute(
            "INSERT INTO x_downloaded_media(
                 source_url, media_key, destination_dir, history_id, variant_url,
                 local_path, media_kind, status, created_at, completed_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(source_url, media_key, destination_dir) DO UPDATE SET
                 history_id = excluded.history_id,
                 variant_url = excluded.variant_url,
                 local_path = excluded.local_path,
                 media_kind = excluded.media_kind,
                 status = excluded.status,
                 completed_at = excluded.completed_at",
            params![
                source_url,
                media_key,
                destination.to_string_lossy().as_ref(),
                history_id,
                variant_url,
                local_path.to_string_lossy().as_ref(),
                media_kind,
                status,
                now,
                completed_at,
            ],
        )
        .map_err(|error| format!("Xメディアの重複履歴を更新できませんでした: {error}"))?;
    Ok(())
}

pub fn download_x_post(
    state: &AppState,
    source_url: &str,
    destination: &Path,
    selections: Option<&[XMediaSelection]>,
) -> Result<XDownloadResult, String> {
    let (post_id, source_url) = parse_post_url(source_url)?;
    fs::create_dir_all(destination).map_err(|error| {
        format!(
            "Xメディアの保存先 {} を作成できませんでした: {error}",
            destination.display()
        )
    })?;
    let destination = destination.canonicalize().map_err(|error| {
        format!(
            "Xメディアの保存先 {} を開けませんでした: {error}",
            destination.display()
        )
    })?;
    if !destination.is_dir() {
        return Err("Xメディアの保存先がフォルダーではありません。".to_owned());
    }

    let history_id = Uuid::new_v4().to_string();
    let started_at = now_millis();
    let resolving = XHistoryInput {
        id: Some(history_id.clone()),
        source_url: source_url.clone(),
        media_url: None,
        local_path: None,
        author: None,
        post_text: None,
        status: Some("resolving".to_owned()),
        error_message: None,
        created_at: Some(started_at),
        completed_at: None,
    };
    catalog::upsert_x_history(state, resolving)?;

    let result = download_x_post_inner(
        state,
        &history_id,
        &post_id,
        &source_url,
        &destination,
        started_at,
        selections,
    );
    if let Err(error) = &result {
        let _ = catalog::upsert_x_history(
            state,
            XHistoryInput {
                id: Some(history_id),
                source_url,
                media_url: None,
                local_path: None,
                author: None,
                post_text: None,
                status: Some("failed".to_owned()),
                error_message: Some(error.clone()),
                created_at: Some(started_at),
                completed_at: Some(now_millis()),
            },
        );
    }
    result
}

fn download_x_post_inner(
    state: &AppState,
    history_id: &str,
    post_id: &str,
    source_url: &str,
    destination: &Path,
    started_at: i64,
    selections: Option<&[XMediaSelection]>,
) -> Result<XDownloadResult, String> {
    let metadata_client = build_metadata_client()?;
    // Media URLs are accepted only from twimg.com. Refusing redirects keeps a
    // valid CDN URL from becoming an unchecked download target.
    let media_client = Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(180))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| format!("Xメディア用の通信を準備できませんでした: {error}"))?;
    // The post is fetched again here instead of trusting media URLs returned to
    // the frontend by `inspect_x_post`. Only IDs that still exist in this fresh
    // response can be selected.
    let payload = fetch_post_payload(&metadata_client, post_id)?;
    let inspection = inspection_from_payload(source_url.to_owned(), post_id.to_owned(), &payload)?;
    let candidates = resolve_selected_variants(&inspection.media, selections)?;
    let safe_author = sanitize_file_component(&inspection.author, 48);
    let mut downloads = Vec::new();
    let mut duplicate_paths = Vec::new();
    let mut failures = Vec::new();
    for (index, candidate) in candidates.iter().take(MAX_X_MEDIA_ITEMS).enumerate() {
        if let Some(existing_path) =
            find_completed_duplicate(state, source_url, &candidate.media_id, destination)?
        {
            duplicate_paths.push(existing_path.to_string_lossy().into_owned());
            continue;
        }
        let base_name = download_stem(&safe_author, post_id, index);
        let gif_finalize_token = (candidate.kind == "gif").then(|| Uuid::new_v4().to_string());
        let final_path = gif_finalize_token
            .as_ref()
            .map(|_| available_destination(destination, &base_name, "gif"));
        let destination_path = if let Some(token) = gif_finalize_token.as_deref() {
            destination.join(format!(".{base_name}.{token}.gif-source.mp4"))
        } else {
            available_destination(destination, &base_name, &candidate.variant.extension)
        };
        record_x_media_status(
            state,
            source_url,
            &candidate.media_id,
            destination,
            history_id,
            &candidate.variant.url,
            &destination_path,
            &candidate.kind,
            "pending",
        )?;
        match download_media_file(&media_client, &candidate.variant, &destination_path) {
            Ok(()) => {
                if gif_finalize_token.is_none() {
                    record_x_media_status(
                        state,
                        source_url,
                        &candidate.media_id,
                        destination,
                        history_id,
                        &candidate.variant.url,
                        &destination_path,
                        &candidate.kind,
                        "completed",
                    )?;
                }
                downloads.push((
                    candidate.clone(),
                    destination_path,
                    final_path,
                    gif_finalize_token,
                ));
            }
            Err(error) => {
                let _ = record_x_media_status(
                    state,
                    source_url,
                    &candidate.media_id,
                    destination,
                    history_id,
                    &candidate.variant.url,
                    &destination_path,
                    &candidate.kind,
                    "failed",
                );
                failures.push(error);
            }
        }
    }
    if downloads.is_empty() && duplicate_paths.is_empty() {
        return Err(failures
            .into_iter()
            .next()
            .unwrap_or_else(|| "Xメディアを保存できませんでした。".to_owned()));
    }

    let first_file = downloads
        .first()
        .map(|(_, path, _, _)| path.to_string_lossy().into_owned())
        .or_else(|| duplicate_paths.first().cloned())
        .ok_or_else(|| "Xメディアの保存結果を確認できませんでした。".to_owned())?;
    let first_url = downloads
        .first()
        .map(|(candidate, _, _, _)| candidate.variant.url.clone());
    let mut summary = inspection.post_text.clone();
    if !duplicate_paths.is_empty() {
        summary.push_str(&format!(
            "\n保存済みの{}件は重複ダウンロードを省略しました。",
            duplicate_paths.len()
        ));
    }
    if !failures.is_empty() {
        summary.push_str(&format!("\n{}件は保存できませんでした。", failures.len()));
    }
    let history = catalog::upsert_x_history(
        state,
        XHistoryInput {
            id: Some(history_id.to_owned()),
            source_url: source_url.to_owned(),
            media_url: first_url,
            local_path: Some(first_file),
            author: Some(inspection.author),
            post_text: Some(summary),
            status: Some("completed".to_owned()),
            error_message: (!failures.is_empty()).then(|| failures.join("\n")),
            created_at: Some(started_at),
            completed_at: Some(now_millis()),
        },
    )?;
    let media = downloads
        .iter()
        .map(|(candidate, path, final_path, token)| XDownloadedMedia {
            media_id: candidate.media_id.clone(),
            kind: candidate.kind.clone(),
            path: path.to_string_lossy().into_owned(),
            final_path: final_path
                .as_ref()
                .map(|path| path.to_string_lossy().into_owned()),
            gif_finalize_token: token.clone(),
        })
        .collect::<Vec<_>>();
    for (index, (candidate, source_path, output_path, token)) in downloads.iter().enumerate() {
        let (Some(output_path), Some(token)) = (output_path, token) else {
            continue;
        };
        register_pending_gif(
            token.clone(),
            PendingGifFinalize {
                source_path: source_path.clone(),
                output_path: output_path.clone(),
                history_id: history.id.clone(),
                history_source_url: history.source_url.clone(),
                history_media_url: Some(candidate.variant.url.clone()),
                history_author: history.author.clone(),
                history_post_text: history.post_text.clone(),
                history_error_message: history.error_message.clone(),
                history_created_at: history.created_at,
                history_completed_at: history.completed_at,
                is_history_primary: index == 0,
                media_key: candidate.media_id.clone(),
                destination_dir: destination.to_string_lossy().into_owned(),
                variant_url: candidate.variant.url.clone(),
                media_kind: candidate.kind.clone(),
                registered_at: now_millis(),
            },
        )?;
    }
    Ok(XDownloadResult {
        history,
        media_count: downloads.len(),
        duplicate_count: duplicate_paths.len(),
        duplicate_paths,
        files: downloads
            .iter()
            .map(|(_, path, _, _)| path.to_string_lossy().into_owned())
            .collect(),
        media,
    })
}

fn pending_x_gifs() -> &'static Mutex<HashMap<String, PendingGifFinalize>> {
    PENDING_X_GIF_FINALIZATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn register_pending_gif(token: String, pending: PendingGifFinalize) -> Result<(), String> {
    let mut entries = pending_x_gifs()
        .lock()
        .map_err(|_| "GIF変換の承認情報を保存できませんでした".to_owned())?;
    let expiry = now_millis().saturating_sub(60 * 60 * 1_000);
    entries.retain(|_, entry| entry.registered_at >= expiry);
    while entries.len() >= MAX_PENDING_X_GIFS {
        let Some(oldest_token) = entries
            .iter()
            .min_by_key(|(_, entry)| entry.registered_at)
            .map(|(token, _)| token.clone())
        else {
            break;
        };
        entries.remove(&oldest_token);
    }
    entries.insert(token, pending);
    Ok(())
}

pub fn finalize_x_gif(state: &AppState, token: &str) -> Result<XGifFinalizeResult, String> {
    let pending = pending_x_gifs()
        .lock()
        .map_err(|_| "GIF変換の承認情報を確認できませんでした".to_owned())?
        .remove(token)
        .ok_or_else(|| {
            "GIF変換の承認が見つからないか、すでに使用されています。もう一度投稿を解析してください"
                .to_owned()
        })?;

    let result = finalize_x_gif_inner(state, &pending);
    if result.is_err() && !pending.output_path.exists() {
        if let Ok(mut entries) = pending_x_gifs().lock() {
            entries.insert(token.to_owned(), pending);
        }
    }
    result
}

pub fn fail_x_gif_finalization(
    state: &AppState,
    token: &str,
    message: &str,
) -> Result<XHistoryItem, String> {
    let pending = pending_x_gifs()
        .lock()
        .map_err(|_| "GIF変換の承認情報を確認できませんでした".to_owned())?
        .remove(token)
        .ok_or_else(|| {
            "GIF変換の承認が見つからないか、すでに使用されています。もう一度投稿を解析してください"
                .to_owned()
        })?;
    let current = catalog::list_x_history(state, Some(2_000))?
        .into_iter()
        .find(|item| item.id == pending.history_id)
        .ok_or_else(|| "Xダウンロード履歴が見つかりませんでした".to_owned())?;
    let message = message.trim().chars().take(800).collect::<String>();
    let failure = format!(
        "GIF変換に失敗しました: {}\n変換元の一時動画は次の場所に残しています: {}",
        if message.is_empty() {
            "原因を確認できませんでした"
        } else {
            &message
        },
        pending.source_path.display()
    );
    let error_message = current
        .error_message
        .filter(|value| !value.trim().is_empty())
        .map_or_else(|| failure.clone(), |value| format!("{value}\n{failure}"));
    let _ = record_x_media_status(
        state,
        &pending.history_source_url,
        &pending.media_key,
        Path::new(&pending.destination_dir),
        &pending.history_id,
        &pending.variant_url,
        &pending.source_path,
        &pending.media_kind,
        "failed",
    );
    catalog::upsert_x_history(
        state,
        XHistoryInput {
            id: Some(current.id),
            source_url: current.source_url,
            media_url: current.media_url,
            local_path: (!pending.is_history_primary)
                .then_some(current.local_path)
                .flatten(),
            author: current.author,
            post_text: current.post_text,
            status: Some("failed".to_owned()),
            error_message: Some(error_message),
            created_at: Some(current.created_at),
            completed_at: Some(now_millis()),
        },
    )
}

fn finalize_x_gif_inner(
    state: &AppState,
    pending: &PendingGifFinalize,
) -> Result<XGifFinalizeResult, String> {
    if !pending.source_path.is_file() {
        return Err(
            "GIF変換元の一時動画が見つかりません。もう一度ダウンロードしてください".to_owned(),
        );
    }
    let source_parent = pending
        .source_path
        .parent()
        .ok_or_else(|| "GIF変換元の保存先を確認できませんでした".to_owned())?
        .canonicalize()
        .map_err(|error| format!("GIF変換元の保存先を確認できませんでした: {error}"))?;
    let output_parent = pending
        .output_path
        .parent()
        .ok_or_else(|| "GIFの保存先を確認できませんでした".to_owned())?
        .canonicalize()
        .map_err(|error| format!("GIFの保存先を確認できませんでした: {error}"))?;
    if source_parent != output_parent {
        return Err("GIFはダウンロードした一時動画と同じフォルダーにのみ保存できます".to_owned());
    }

    let output_path = if pending.output_path.exists() {
        let stem = pending
            .output_path
            .file_stem()
            .and_then(|value| value.to_str())
            .ok_or_else(|| "GIFのファイル名を確認できませんでした".to_owned())?;
        available_destination(&output_parent, stem, "gif")
    } else {
        pending.output_path.clone()
    };
    video_decode::convert_h264_mp4_to_gif(&pending.source_path, &output_path)?;
    let removed_source = fs::remove_file(&pending.source_path).is_ok();
    record_x_media_status(
        state,
        &pending.history_source_url,
        &pending.media_key,
        Path::new(&pending.destination_dir),
        &pending.history_id,
        &pending.variant_url,
        &output_path,
        &pending.media_kind,
        "completed",
    )?;
    let history = if pending.is_history_primary {
        Some(catalog::upsert_x_history(
            state,
            XHistoryInput {
                id: Some(pending.history_id.clone()),
                source_url: pending.history_source_url.clone(),
                media_url: pending.history_media_url.clone(),
                local_path: Some(output_path.to_string_lossy().into_owned()),
                author: pending.history_author.clone(),
                post_text: pending.history_post_text.clone(),
                status: Some("completed".to_owned()),
                error_message: pending.history_error_message.clone(),
                created_at: Some(pending.history_created_at),
                completed_at: pending.history_completed_at.or_else(|| Some(now_millis())),
            },
        )?)
    } else {
        None
    };
    Ok(XGifFinalizeResult {
        path: output_path.to_string_lossy().into_owned(),
        history,
        removed_source,
    })
}

fn build_metadata_client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|error| format!("Xダウンロード用の通信を準備できませんでした: {error}"))
}

fn fetch_post_payload(client: &Client, post_id: &str) -> Result<Value, String> {
    let syndication_result = fetch_syndication_payload(client, post_id);
    if let Ok(payload) = &syndication_result {
        let is_tombstone = payload
            .get("__typename")
            .and_then(Value::as_str)
            .is_some_and(|value| value == "TweetTombstone");
        if !is_tombstone && !extract_media_items(payload).is_empty() {
            return Ok(payload.clone());
        }
    }

    let primary_error = match syndication_result {
        Ok(payload)
            if payload
                .get("__typename")
                .and_then(Value::as_str)
                .is_some_and(|value| value == "TweetTombstone") =>
        {
            "Xの埋め込みAPIではこの投稿が表示制限されています".to_owned()
        }
        Ok(_) => "Xの埋め込みAPIからメディアを取得できませんでした".to_owned(),
        Err(error) => error,
    };
    match fetch_fxtwitter_payload(client, post_id) {
        Ok(payload) if !extract_media_items(&payload).is_empty() => Ok(payload),
        Ok(_) => Err("このX投稿にダウンロードできる画像・GIF・動画がありません。".to_owned()),
        Err(fallback_error) => Err(format!(
            "{primary_error}。公開フォールバックも失敗しました: {fallback_error}"
        )),
    }
}

fn fetch_syndication_payload(client: &Client, post_id: &str) -> Result<Value, String> {
    let token = syndication_token(post_id)?;
    let response = client
        .get(SYNDICATION_ENDPOINT)
        .query(&[
            ("id", post_id),
            ("lang", "ja"),
            ("features", SYNDICATION_FEATURES),
            ("token", token.as_str()),
        ])
        .header(USER_AGENT, "Googlebot")
        .send()
        .map_err(|error| format!("X投稿を取得できませんでした: {error}"))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(
            "X投稿が見つかりません。削除済み・非公開・年齢制限付きの可能性があります。".to_owned(),
        );
    }
    read_json_response(response, "X投稿")
}

fn fetch_fxtwitter_payload(client: &Client, post_id: &str) -> Result<Value, String> {
    let endpoint = format!("{FXTWITTER_ENDPOINT}/{post_id}");
    let response = client
        .get(endpoint)
        .header(USER_AGENT, "PixVault-for-Windows/0.1 X-media-downloader")
        .send()
        .map_err(|error| format!("X公開フォールバックへ接続できませんでした: {error}"))?;
    let payload = read_json_response(response, "X公開フォールバック")?;
    let code = payload.get("code").and_then(Value::as_u64).unwrap_or(200);
    if code != 200 {
        let message = payload
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("投稿を取得できませんでした")
            .trim()
            .chars()
            .take(240)
            .collect::<String>();
        return Err(format!(
            "X公開フォールバックがエラーを返しました（{code}）: {message}"
        ));
    }
    let tweet = payload
        .get("tweet")
        .or_else(|| payload.get("status"))
        .filter(|value| value.is_object())
        .ok_or_else(|| "X公開フォールバックの投稿データがありません。".to_owned())?;
    let returned_id = tweet.get("id").and_then(|value| {
        value
            .as_str()
            .map(str::to_owned)
            .or_else(|| value.as_u64().map(|id| id.to_string()))
    });
    if returned_id
        .as_deref()
        .is_some_and(|returned_id| returned_id != post_id)
    {
        return Err("X公開フォールバックから別の投稿データが返されました。".to_owned());
    }
    Ok(payload)
}

fn read_json_response(response: Response, label: &str) -> Result<Value, String> {
    if response
        .content_length()
        .is_some_and(|bytes| bytes > MAX_X_METADATA_BYTES)
    {
        return Err(format!("{label}の応答が8 MBの上限を超えています。"));
    }
    let status = response.status();
    let mut source = response.take(MAX_X_METADATA_BYTES + 1);
    let mut response_body = Vec::new();
    source
        .read_to_end(&mut response_body)
        .map_err(|error| format!("{label}の応答を読み取れませんでした: {error}"))?;
    if response_body.len() as u64 > MAX_X_METADATA_BYTES {
        return Err(format!("{label}の応答が8 MBの上限を超えています。"));
    }
    if !status.is_success() {
        return Err(format!("{label}の取得に失敗しました（{status}）。"));
    }
    serde_json::from_slice(&response_body)
        .map_err(|error| format!("{label}の応答形式を解析できませんでした: {error}"))
}

fn inspection_from_payload(
    source_url: String,
    post_id: String,
    payload: &Value,
) -> Result<XPostInspection, String> {
    let media = extract_media_items(payload);
    if media.is_empty() {
        return Err("このX投稿にダウンロードできる画像・GIF・動画がありません。".to_owned());
    }
    let post = payload
        .get("tweet")
        .or_else(|| payload.get("status"))
        .unwrap_or(payload);
    let author = post
        .pointer("/user/screen_name")
        .and_then(Value::as_str)
        .or_else(|| post.pointer("/author/screen_name").and_then(Value::as_str))
        .or_else(|| post.pointer("/author/username").and_then(Value::as_str))
        .or_else(|| post.pointer("/user/name").and_then(Value::as_str))
        .or_else(|| post.pointer("/author/name").and_then(Value::as_str))
        .unwrap_or("x")
        .to_owned();
    let post_text = post
        .get("text")
        .or_else(|| post.pointer("/raw_text/text"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned();
    Ok(XPostInspection {
        source_url,
        post_id,
        author,
        post_text,
        media,
    })
}

fn resolve_selected_variants(
    media: &[XMediaItem],
    selections: Option<&[XMediaSelection]>,
) -> Result<Vec<ResolvedXMedia>, String> {
    let Some(selections) = selections else {
        return Ok(media
            .iter()
            .take(MAX_X_MEDIA_ITEMS)
            .filter_map(|item| {
                item.variants
                    .first()
                    .cloned()
                    .map(|variant| ResolvedXMedia {
                        media_id: item.id.clone(),
                        kind: item.kind.clone(),
                        variant,
                    })
            })
            .collect());
    };
    if selections.is_empty() {
        return Err("ダウンロードするメディアを1件以上選択してください。".to_owned());
    }
    if selections.len() > MAX_X_MEDIA_ITEMS {
        return Err(format!(
            "一度に選択できるメディアは{MAX_X_MEDIA_ITEMS}件までです。"
        ));
    }
    let mut seen = HashSet::new();
    let mut resolved = Vec::with_capacity(selections.len());
    for selection in selections {
        if !seen.insert(selection.media_id.as_str()) {
            return Err("同じメディアが重複して選択されています。".to_owned());
        }
        let item = media
            .iter()
            .find(|item| item.id == selection.media_id)
            .ok_or_else(|| {
                "選択したメディアが投稿内に見つかりません。投稿を再解析してください。".to_owned()
            })?;
        let variant = item
            .variants
            .iter()
            .find(|variant| variant.id == selection.variant_id)
            .ok_or_else(|| {
                "選択した画質が投稿内に見つかりません。投稿を再解析してください。".to_owned()
            })?;
        if !Url::parse(&variant.url)
            .ok()
            .is_some_and(|url| is_allowed_media_url(&url))
        {
            return Err("安全でないメディアURLはダウンロードできません。".to_owned());
        }
        resolved.push(ResolvedXMedia {
            media_id: item.id.clone(),
            kind: item.kind.clone(),
            variant: variant.clone(),
        });
    }
    Ok(resolved)
}

fn parse_post_url(value: &str) -> Result<(String, String), String> {
    let url = Url::parse(value.trim())
        .map_err(|_| "X（旧Twitter）の投稿URLを入力してください。".to_owned())?;
    if url.scheme() != "https" {
        return Err("X投稿URLはHTTPSで入力してください。".to_owned());
    }
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    if !matches!(
        host.as_str(),
        "x.com" | "www.x.com" | "twitter.com" | "www.twitter.com" | "mobile.twitter.com"
    ) {
        return Err("x.com または twitter.com の投稿URLだけを指定できます。".to_owned());
    }
    let segments: Vec<_> = url
        .path_segments()
        .into_iter()
        .flatten()
        .filter(|segment| !segment.is_empty())
        .collect();
    let status_index = segments
        .iter()
        .position(|segment| segment.eq_ignore_ascii_case("status"))
        .ok_or_else(|| "Xの投稿URLにstatus IDがありません。".to_owned())?;
    let post_id = segments
        .get(status_index + 1)
        .filter(|value| {
            !value.is_empty() && value.chars().all(|character| character.is_ascii_digit())
        })
        .ok_or_else(|| "Xの投稿IDを読み取れませんでした。".to_owned())?;
    if post_id.len() > 40 {
        return Err("Xの投稿IDが長すぎます。".to_owned());
    }
    Ok((
        (*post_id).to_owned(),
        format!("https://x.com/i/web/status/{post_id}"),
    ))
}

fn syndication_token(post_id: &str) -> Result<String, String> {
    let post_id = post_id
        .parse::<f64>()
        .map_err(|_| "Xの投稿IDを数値として読み取れませんでした。".to_owned())?;
    let value = post_id / 1e15 * std::f64::consts::PI;
    Ok(js_number_to_radix(value, 36)
        .chars()
        .filter(|character| *character != '0' && *character != '.')
        .collect())
}

fn js_number_to_radix(value: f64, radix: u32) -> String {
    const ALPHABET: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value == 0.0 {
        return "0".to_owned();
    }
    let sign = value.is_sign_negative();
    let value = value.abs();
    let mut integer = value.trunc() as u64;
    let mut fraction = value.fract();
    let next = f64::from_bits(value.to_bits().saturating_add(1));
    let mut delta = ((next - value) / 2.0).max(f64::from_bits(1));
    let mut fractional_digits = Vec::<u32>::new();
    while fraction >= delta && fractional_digits.len() < 64 {
        delta *= f64::from(radix);
        let expanded = fraction * f64::from(radix);
        let digit = expanded.trunc() as u32;
        fraction = expanded.fract();
        fractional_digits.push(digit);
        let needs_rounding = fraction > 0.5 || (fraction == 0.5 && digit & 1 == 1);
        if needs_rounding && fraction + delta > 1.0 {
            let mut carried = false;
            for index in (0..fractional_digits.len()).rev() {
                if fractional_digits[index] + 1 < radix {
                    fractional_digits[index] += 1;
                    carried = true;
                    break;
                }
                fractional_digits.pop();
            }
            if !carried {
                integer += 1;
            }
            break;
        }
    }

    let mut integer_digits = Vec::new();
    loop {
        integer_digits.push((integer % u64::from(radix)) as u32);
        integer /= u64::from(radix);
        if integer == 0 {
            break;
        }
    }
    integer_digits.reverse();
    let mut result = String::new();
    if sign {
        result.push('-');
    }
    result.extend(
        integer_digits
            .into_iter()
            .map(|digit| ALPHABET[digit as usize] as char),
    );
    if !fractional_digits.is_empty() {
        result.push('.');
        result.extend(
            fractional_digits
                .into_iter()
                .map(|digit| ALPHABET[digit as usize] as char),
        );
    }
    result
}

fn extract_media_items(payload: &Value) -> Vec<XMediaItem> {
    let mut items = Vec::new();
    if let Some(media) = payload.get("mediaDetails").and_then(Value::as_array) {
        append_media_details(media, &mut items);
    }
    if let Some(media) = payload
        .pointer("/quoted_tweet/mediaDetails")
        .and_then(Value::as_array)
    {
        append_media_details(media, &mut items);
    }
    for post in [Some(payload), payload.get("tweet"), payload.get("status")]
        .into_iter()
        .flatten()
    {
        append_fxtwitter_status(post, &mut items, 0);
    }
    if items.is_empty() {
        if let Some(photos) = payload.get("photos").and_then(Value::as_array) {
            for photo in photos {
                if let Some(url) = photo.get("url").and_then(Value::as_str) {
                    if let Some(item) = photo_item(
                        format!("media-{:02}", items.len() + 1),
                        url,
                        value_u32(photo.get("width")),
                        value_u32(photo.get("height")),
                    ) {
                        items.push(item);
                    }
                }
            }
        }
        if let Some(variants) = payload.pointer("/video/variants").and_then(Value::as_array) {
            let preview = payload
                .pointer("/video/poster")
                .or_else(|| payload.pointer("/video/posterUrl"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            if let Some(item) = video_item(
                format!("media-{:02}", items.len() + 1),
                "video",
                preview,
                variants,
                None,
                None,
            ) {
                items.push(item);
            }
        }
    }
    let mut seen = HashSet::new();
    items.retain(|item| {
        item.variants
            .first()
            .is_some_and(|variant| seen.insert(variant.url.clone()))
    });
    items.truncate(MAX_X_MEDIA_ITEMS);
    for (index, item) in items.iter_mut().enumerate() {
        item.id = format!("media-{:02}", index + 1);
    }
    items
}

fn append_fxtwitter_status(status: &Value, items: &mut Vec<XMediaItem>, depth: usize) {
    if let Some(media) = status.pointer("/media/all").and_then(Value::as_array) {
        append_fxtwitter_media(media, items);
    }
    if depth >= 2 {
        return;
    }
    for quote in [status.get("quote"), status.get("quoted_tweet")]
        .into_iter()
        .flatten()
        .filter(|value| value.is_object())
    {
        append_fxtwitter_status(quote, items, depth + 1);
    }
}

fn append_fxtwitter_media(media: &[Value], items: &mut Vec<XMediaItem>) {
    for item in media {
        let width = value_u32(item.get("width"))
            .or_else(|| value_u32(item.pointer("/original_info/width")));
        let height = value_u32(item.get("height"))
            .or_else(|| value_u32(item.pointer("/original_info/height")));
        let id = format!("media-{:02}", items.len() + 1);
        match item.get("type").and_then(Value::as_str) {
            Some("photo" | "image") => {
                if let Some(url) = item.get("url").and_then(Value::as_str) {
                    if let Some(media_item) = photo_item(id, url, width, height) {
                        items.push(media_item);
                    }
                }
            }
            Some(kind @ ("video" | "gif" | "animated_gif")) => {
                let mut variants = item
                    .get("variants")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                if variants.is_empty() {
                    variants.extend(
                        item.get("formats")
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten()
                            .filter_map(|format| {
                                let url = format.get("url").and_then(Value::as_str)?;
                                let container = format
                                    .get("container")
                                    .and_then(Value::as_str)
                                    .unwrap_or("mp4");
                                Some(serde_json::json!({
                                    "url": url,
                                    "content_type": if container.eq_ignore_ascii_case("mp4") {
                                        "video/mp4"
                                    } else {
                                        container
                                    },
                                    "bitrate": format.get("bitrate").cloned().unwrap_or(Value::Null),
                                }))
                            }),
                    );
                }
                if variants.is_empty() {
                    if let Some(url) = item.get("url").and_then(Value::as_str) {
                        variants.push(serde_json::json!({
                            "url": url,
                            "content_type": item
                                .get("format")
                                .and_then(Value::as_str)
                                .unwrap_or("video/mp4"),
                        }));
                    }
                }
                let preview = item
                    .get("thumbnail_url")
                    .or_else(|| item.get("thumbnailUrl"))
                    .or_else(|| item.get("media_url_https"))
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if let Some(media_item) = video_item(
                    id,
                    if matches!(kind, "gif" | "animated_gif") {
                        "gif"
                    } else {
                        "video"
                    },
                    preview,
                    &variants,
                    width,
                    height,
                ) {
                    items.push(media_item);
                }
            }
            _ => {}
        }
    }
}

fn append_media_details(media: &[Value], items: &mut Vec<XMediaItem>) {
    for item in media {
        let width = value_u32(item.pointer("/original_info/width"))
            .or_else(|| value_u32(item.pointer("/sizes/large/w")));
        let height = value_u32(item.pointer("/original_info/height"))
            .or_else(|| value_u32(item.pointer("/sizes/large/h")));
        let id = format!("media-{:02}", items.len() + 1);
        match item.get("type").and_then(Value::as_str) {
            Some("photo") => {
                if let Some(url) = item.get("media_url_https").and_then(Value::as_str) {
                    if let Some(media_item) = photo_item(id, url, width, height) {
                        items.push(media_item);
                    }
                }
            }
            Some(kind @ ("video" | "animated_gif")) => {
                if let Some(variants) = item
                    .pointer("/video_info/variants")
                    .and_then(Value::as_array)
                {
                    let preview = item
                        .get("media_url_https")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    if let Some(media_item) = video_item(
                        id,
                        if kind == "animated_gif" {
                            "gif"
                        } else {
                            "video"
                        },
                        preview,
                        variants,
                        width,
                        height,
                    ) {
                        items.push(media_item);
                    }
                }
            }
            _ => {}
        }
    }
}

fn photo_item(
    id: String,
    url: &str,
    width: Option<u32>,
    height: Option<u32>,
) -> Option<XMediaItem> {
    let parsed = Url::parse(url).ok()?;
    if !is_allowed_media_url(&parsed) {
        return None;
    }
    let extension = extension_from_url(&parsed).unwrap_or_else(|| "jpg".to_owned());
    let qualities = [
        ("orig", "オリジナル", None),
        ("large", "大（最大 2048px）", Some(2048)),
        ("medium", "中（最大 1200px）", Some(1200)),
        ("small", "小（最大 680px）", Some(680)),
    ];
    let variants = qualities
        .into_iter()
        .enumerate()
        .map(|(index, (quality, label, max_edge))| {
            let (variant_width, variant_height) = max_edge
                .and_then(|edge| limited_dimensions(width, height, edge))
                .map_or((width, height), |(next_width, next_height)| {
                    (Some(next_width), Some(next_height))
                });
            XMediaVariant {
                id: format!("quality-{:02}-{quality}", index + 1),
                label: label.to_owned(),
                url: with_query_pair(&parsed, "name", quality),
                extension: extension.clone(),
                width: variant_width,
                height: variant_height,
                bitrate: None,
            }
        })
        .collect();
    Some(XMediaItem {
        id,
        kind: "image".to_owned(),
        preview_url: with_query_pair(&parsed, "name", "small"),
        width,
        height,
        variants,
        already_downloaded: false,
        existing_path: None,
    })
}

fn video_item(
    id: String,
    kind: &str,
    preview_url: &str,
    variants: &[Value],
    width: Option<u32>,
    height: Option<u32>,
) -> Option<XMediaItem> {
    let mut parsed_variants: Vec<_> = variants
        .iter()
        .filter_map(|variant| {
            let content_type = variant
                .get("content_type")
                .or_else(|| variant.get("type"))
                .or_else(|| variant.get("format"))
                .or_else(|| variant.get("container"))
                .and_then(Value::as_str)?;
            if !content_type.eq_ignore_ascii_case("video/mp4")
                && !content_type.eq_ignore_ascii_case("mp4")
            {
                return None;
            }
            let url = variant
                .get("url")
                .or_else(|| variant.get("src"))
                .and_then(Value::as_str)?;
            let parsed = Url::parse(url).ok()?;
            if !is_allowed_media_url(&parsed) {
                return None;
            }
            let bitrate = variant.get("bitrate").and_then(Value::as_u64);
            let (variant_width, variant_height) =
                dimensions_from_video_url(&parsed).unwrap_or((width, height));
            Some(XMediaVariant {
                id: String::new(),
                label: video_quality_label(kind, variant_width, variant_height, bitrate),
                url: parsed.to_string(),
                extension: "mp4".to_owned(),
                width: variant_width,
                height: variant_height,
                bitrate,
            })
        })
        .collect();
    parsed_variants.sort_by(|left, right| {
        right
            .bitrate
            .unwrap_or(0)
            .cmp(&left.bitrate.unwrap_or(0))
            .then_with(|| {
                let right_pixels =
                    u64::from(right.width.unwrap_or(0)) * u64::from(right.height.unwrap_or(0));
                let left_pixels =
                    u64::from(left.width.unwrap_or(0)) * u64::from(left.height.unwrap_or(0));
                right_pixels.cmp(&left_pixels)
            })
            .then_with(|| left.url.cmp(&right.url))
    });
    let mut seen = HashSet::new();
    parsed_variants.retain(|variant| seen.insert(variant.url.clone()));
    for (index, variant) in parsed_variants.iter_mut().enumerate() {
        variant.id = format!("quality-{:02}-{}", index + 1, variant.bitrate.unwrap_or(0));
    }
    if parsed_variants.is_empty() {
        return None;
    }
    let preview_url = Url::parse(preview_url)
        .ok()
        .filter(is_allowed_media_url)
        .map(|url| with_query_pair(&url, "name", "small"))
        .unwrap_or_default();
    Some(XMediaItem {
        id,
        kind: kind.to_owned(),
        preview_url,
        width,
        height,
        variants: parsed_variants,
        already_downloaded: false,
        existing_path: None,
    })
}

fn value_u32(value: Option<&Value>) -> Option<u32> {
    value?.as_u64()?.try_into().ok()
}

fn limited_dimensions(
    width: Option<u32>,
    height: Option<u32>,
    max_edge: u32,
) -> Option<(u32, u32)> {
    let width = width?;
    let height = height?;
    let current_max = width.max(height);
    if current_max <= max_edge {
        return Some((width, height));
    }
    let scale = f64::from(max_edge) / f64::from(current_max);
    Some((
        (f64::from(width) * scale).round().max(1.0) as u32,
        (f64::from(height) * scale).round().max(1.0) as u32,
    ))
}

fn with_query_pair(url: &Url, key: &str, value: &str) -> String {
    let existing: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(name, _)| !name.eq_ignore_ascii_case(key))
        .map(|(name, value)| (name.into_owned(), value.into_owned()))
        .collect();
    let mut next = url.clone();
    next.set_query(None);
    {
        let mut pairs = next.query_pairs_mut();
        for (name, value) in existing {
            pairs.append_pair(&name, &value);
        }
        pairs.append_pair(key, value);
    }
    next.to_string()
}

fn dimensions_from_video_url(url: &Url) -> Option<(Option<u32>, Option<u32>)> {
    for segment in url.path_segments()?.rev() {
        let stem = segment.split('.').next().unwrap_or(segment);
        let Some((width, height)) = stem.split_once('x') else {
            continue;
        };
        let (Ok(width), Ok(height)) = (width.parse::<u32>(), height.parse::<u32>()) else {
            continue;
        };
        if width > 0 && height > 0 {
            return Some((Some(width), Some(height)));
        }
    }
    None
}

fn video_quality_label(
    kind: &str,
    width: Option<u32>,
    height: Option<u32>,
    bitrate: Option<u64>,
) -> String {
    let mut parts = Vec::new();
    if let (Some(width), Some(height)) = (width, height) {
        parts.push(format!("{width}×{height}"));
    }
    if let Some(bitrate) = bitrate.filter(|value| *value > 0) {
        parts.push(format!("{:.1} Mbps", bitrate as f64 / 1_000_000.0));
    }
    if parts.is_empty() {
        parts.push("MP4".to_owned());
    }
    if kind == "gif" {
        parts.push("X配信形式: MP4".to_owned());
    }
    parts.join(" · ")
}

fn extension_from_url(url: &Url) -> Option<String> {
    if let Some(format) = url
        .query_pairs()
        .find(|(key, _)| key.eq_ignore_ascii_case("format"))
        .map(|(_, value)| value.to_ascii_lowercase())
        .filter(|value| matches!(value.as_str(), "jpg" | "jpeg" | "png" | "webp"))
    {
        return Some(format);
    }
    let extension = Path::new(url.path())
        .extension()
        .and_then(|value| value.to_str())?
        .to_ascii_lowercase();
    matches!(extension.as_str(), "jpg" | "jpeg" | "png" | "webp").then_some(extension)
}

/*
 * Do not accept arbitrary media hosts. The inspection response may be shown in
 * the renderer, but the downloader resolves selections against a fresh payload
 * and applies this allow-list again before making any media request.
 */
fn is_allowed_media_url(url: &Url) -> bool {
    url.scheme() == "https"
        && url.host_str().is_some_and(|host| {
            host.eq_ignore_ascii_case("twimg.com")
                || host.to_ascii_lowercase().ends_with(".twimg.com")
        })
}

fn download_media_file(
    client: &Client,
    candidate: &XMediaVariant,
    destination: &Path,
) -> Result<(), String> {
    let response = client
        .get(&candidate.url)
        .header(USER_AGENT, "PixVault-for-Windows/0.1 X-media-downloader")
        .send()
        .map_err(|error| format!("Xメディアを取得できませんでした: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Xメディアの取得に失敗しました: {error}"))?;
    validate_media_response(&response)?;
    let temporary = destination.with_extension(format!("{}.part", candidate.extension));
    let result = (|| -> Result<(), String> {
        let mut source = response.take(MAX_X_MEDIA_BYTES + 1);
        let mut file = File::create(&temporary)
            .map_err(|error| format!("一時ファイルを作成できませんでした: {error}"))?;
        let bytes = io::copy(&mut source, &mut file)
            .map_err(|error| format!("Xメディアを保存できませんでした: {error}"))?;
        if bytes > MAX_X_MEDIA_BYTES {
            return Err("Xメディアが2 GBの上限を超えています。".to_owned());
        }
        file.flush()
            .map_err(|error| format!("Xメディアを書き込めませんでした: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("Xメディアを確定できませんでした: {error}"))?;
        fs::rename(&temporary, destination)
            .map_err(|error| format!("Xメディアの保存を完了できませんでした: {error}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn validate_media_response(response: &Response) -> Result<(), String> {
    if response
        .content_length()
        .is_some_and(|bytes| bytes > MAX_X_MEDIA_BYTES)
    {
        return Err("Xメディアが2 GBの上限を超えています。".to_owned());
    }
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !content_type.starts_with("image/") && !content_type.starts_with("video/") {
        return Err("Xからメディア以外の応答が返されました。".to_owned());
    }
    Ok(())
}

fn available_destination(directory: &Path, stem: &str, extension: &str) -> PathBuf {
    let initial = directory.join(format!("{stem}.{extension}"));
    if !initial.exists() {
        return initial;
    }
    for sequence in 2..10_000 {
        let candidate = directory.join(format!("{stem}_{sequence}.{extension}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    directory.join(format!("{stem}_{}.{}", Uuid::new_v4(), extension))
}

fn sanitize_file_component(value: &str, max_chars: usize) -> String {
    let sanitized: String = value
        .chars()
        .filter(|character| !character.is_control())
        .map(|character| {
            if matches!(
                character,
                '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
            ) {
                '_'
            } else {
                character
            }
        })
        .take(max_chars)
        .collect();
    let sanitized = sanitized.trim_matches([' ', '.']);
    if sanitized.is_empty() {
        "x".to_owned()
    } else {
        sanitized.to_owned()
    }
}

fn download_stem(author: &str, post_id: &str, index: usize) -> String {
    if index == 0 {
        format!("{author}_{post_id}")
    } else {
        format!("{author}_{post_id}_{:02}", index + 1)
    }
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_supported_x_post_urls() {
        assert_eq!(
            parse_post_url("https://x.com/example/status/1346889436626259968?s=20")
                .expect("valid X URL")
                .0,
            "1346889436626259968"
        );
        assert_eq!(
            parse_post_url("https://twitter.com/i/web/status/20")
                .expect("valid Twitter URL")
                .0,
            "20"
        );
        assert!(parse_post_url("http://x.com/example/status/20").is_err());
        assert!(parse_post_url("https://example.com/example/status/20").is_err());
        assert!(parse_post_url("https://x.com/home").is_err());
    }

    #[test]
    fn matches_javascript_syndication_tokens() {
        assert_eq!(syndication_token("20").expect("token"), "6dq1a2xwd93");
        assert_eq!(
            syndication_token("1346889436626259968").expect("token"),
            "39jdlu2hpym"
        );
        assert_eq!(
            syndication_token("1900000000000000000").expect("token"),
            "4ltxr9b3f"
        );
    }

    #[test]
    fn extracts_mixed_media_and_all_available_qualities() {
        let payload = serde_json::json!({
            "mediaDetails": [
                {
                    "type": "photo",
                    "media_url_https": "https://pbs.twimg.com/media/example.jpg",
                    "original_info": { "width": 2400, "height": 1600 }
                },
                {
                    "type": "video",
                    "media_url_https": "https://pbs.twimg.com/ext_tw_video_thumb/poster.jpg",
                    "video_info": {
                        "variants": [
                            {
                                "content_type": "application/x-mpegURL",
                                "url": "https://video.twimg.com/ext_tw_video/example.m3u8"
                            },
                            {
                                "content_type": "video/mp4",
                                "bitrate": 256000,
                                "url": "https://video.twimg.com/ext_tw_video/320x180/small.mp4"
                            },
                            {
                                "content_type": "video/mp4",
                                "bitrate": 2176000,
                                "url": "https://video.twimg.com/ext_tw_video/1280x720/large.mp4"
                            }
                        ]
                    }
                },
                {
                    "type": "animated_gif",
                    "media_url_https": "https://pbs.twimg.com/tweet_video_thumb/gif.jpg",
                    "video_info": {
                        "variants": [
                            {
                                "content_type": "video/mp4",
                                "url": "https://video.twimg.com/tweet_video/gif.mp4"
                            }
                        ]
                    }
                }
            ]
        });
        let media = extract_media_items(&payload);
        assert_eq!(media.len(), 3);
        assert_eq!(media[0].kind, "image");
        assert_eq!(media[0].variants.len(), 4);
        assert!(media[0].variants[0].url.contains("name=orig"));
        assert_eq!(media[1].kind, "video");
        assert_eq!(media[1].variants.len(), 2);
        assert_eq!(media[1].variants[0].bitrate, Some(2_176_000));
        assert_eq!(media[1].variants[0].width, Some(1280));
        assert_eq!(media[2].kind, "gif");
        assert_eq!(media[2].variants[0].extension, "mp4");
        assert!(media[2].variants[0].label.contains("X配信形式: MP4"));
    }

    #[test]
    fn extracts_the_sensitive_multi_gif_fallback_shape() {
        let payload = serde_json::json!({
            "code": 200,
            "message": "OK",
            "tweet": {
                "id": "2081950343177376211",
                "text": "Wip",
                "possibly_sensitive": true,
                "author": {
                    "screen_name": "notdodo_x",
                    "name": "dodo"
                },
                "media": {
                    "all": [
                        {
                            "id": "2081950312164667392",
                            "url": "https://video.twimg.com/tweet_video/HOSSxzyWsAAL9Ta.mp4",
                            "thumbnail_url": "https://pbs.twimg.com/tweet_video_thumb/HOSSxzyWsAAL9Ta.jpg",
                            "width": 2000,
                            "height": 1666,
                            "format": "video/mp4",
                            "type": "gif",
                            "variants": [{
                                "url": "https://video.twimg.com/tweet_video/HOSSxzyWsAAL9Ta.mp4",
                                "bitrate": 0,
                                "content_type": "video/mp4"
                            }]
                        },
                        {
                            "id": "2081950328434356224",
                            "url": "https://video.twimg.com/tweet_video/HOSSywZWcAARy14.mp4",
                            "thumbnail_url": "https://pbs.twimg.com/tweet_video_thumb/HOSSywZWcAARy14.jpg",
                            "width": 2000,
                            "height": 1666,
                            "format": "video/mp4",
                            "type": "gif",
                            "variants": [{
                                "url": "https://video.twimg.com/tweet_video/HOSSywZWcAARy14.mp4",
                                "bitrate": 0,
                                "content_type": "video/mp4"
                            }]
                        }
                    ]
                }
            }
        });
        let inspection = inspection_from_payload(
            "https://x.com/i/web/status/2081950343177376211".to_owned(),
            "2081950343177376211".to_owned(),
            &payload,
        )
        .expect("fallback inspection");
        assert_eq!(inspection.author, "notdodo_x");
        assert_eq!(inspection.post_text, "Wip");
        assert_eq!(inspection.media.len(), 2);
        assert!(inspection.media.iter().all(|item| item.kind == "gif"));
        assert!(
            inspection
                .media
                .iter()
                .all(|item| item.width == Some(2000) && item.height == Some(1666))
        );
        assert_eq!(
            inspection.media[0].variants[0].url,
            "https://video.twimg.com/tweet_video/HOSSxzyWsAAL9Ta.mp4"
        );
        assert_eq!(
            inspection.media[1].variants[0].url,
            "https://video.twimg.com/tweet_video/HOSSywZWcAARy14.mp4"
        );
    }

    #[test]
    fn extracts_new_fallback_mixed_media_and_quoted_post_recursively() {
        let payload = serde_json::json!({
            "code": 200,
            "status": {
                "id": "900",
                "text": "mixed",
                "author": { "username": "creator" },
                "media": {
                    "all": [
                        {
                            "type": "photo",
                            "url": "https://pbs.twimg.com/media/main?format=png&name=orig",
                            "width": 1200,
                            "height": 800
                        },
                        {
                            "type": "video",
                            "url": "https://video.twimg.com/ext_tw_video/900/video.mp4",
                            "thumbnailUrl": "https://pbs.twimg.com/ext_tw_video_thumb/900/poster.jpg",
                            "width": 640,
                            "height": 360,
                            "formats": [{
                                "url": "https://video.twimg.com/ext_tw_video/900/640x360/video.mp4",
                                "container": "mp4",
                                "bitrate": 832000
                            }]
                        }
                    ]
                },
                "quote": {
                    "id": "899",
                    "media": {
                        "all": [
                            {
                                "type": "gif",
                                "url": "https://video.twimg.com/tweet_video/quoted.mp4",
                                "thumbnail_url": "https://pbs.twimg.com/tweet_video_thumb/quoted.jpg",
                                "format": "video/mp4",
                                "width": 500,
                                "height": 500
                            },
                            {
                                "type": "photo",
                                "url": "https://pbs.twimg.com/media/quoted.jpg",
                                "width": 1000,
                                "height": 1500
                            }
                        ]
                    }
                }
            }
        });
        let inspection = inspection_from_payload(
            "https://x.com/i/web/status/900".to_owned(),
            "900".to_owned(),
            &payload,
        )
        .expect("new fallback inspection");
        assert_eq!(inspection.author, "creator");
        assert_eq!(
            inspection
                .media
                .iter()
                .map(|item| item.kind.as_str())
                .collect::<Vec<_>>(),
            ["image", "video", "gif", "image"]
        );
        assert_eq!(inspection.media[0].variants[0].extension, "png");
        assert_eq!(inspection.media[1].variants[0].bitrate, Some(832_000));
        assert_eq!(inspection.media[2].variants[0].extension, "mp4");
    }

    #[test]
    fn fallback_rejects_non_twimg_media_urls() {
        let payload = serde_json::json!({
            "code": 200,
            "tweet": {
                "id": "901",
                "author": { "screen_name": "creator" },
                "media": {
                    "all": [
                        {
                            "type": "photo",
                            "url": "https://attacker.example/not-an-image.jpg"
                        },
                        {
                            "type": "gif",
                            "url": "https://attacker.example/not-a-gif.mp4",
                            "format": "video/mp4"
                        },
                        {
                            "type": "photo",
                            "url": "https://pbs.twimg.com/media/safe.jpg"
                        }
                    ]
                }
            }
        });
        let media = extract_media_items(&payload);
        assert_eq!(media.len(), 1);
        assert_eq!(media[0].kind, "image");
        assert!(
            media[0]
                .variants
                .iter()
                .all(|variant| variant.url.starts_with("https://pbs.twimg.com/"))
        );
    }

    #[test]
    #[ignore = "requires the live public X and FxTwitter endpoints"]
    fn live_sensitive_multi_gif_post_uses_public_fallback() {
        let inspection = inspect_x_post("https://x.com/notdodo_x/status/2081950343177376211")
            .expect("live fallback inspection");
        assert_eq!(inspection.post_id, "2081950343177376211");
        assert_eq!(inspection.author, "notdodo_x");
        assert_eq!(inspection.media.len(), 2);
        assert!(inspection.media.iter().all(|item| item.kind == "gif"));
        assert!(
            inspection
                .media
                .iter()
                .flat_map(|item| &item.variants)
                .all(|variant| variant.url.starts_with("https://video.twimg.com/"))
        );
    }

    #[test]
    #[ignore = "downloads live media from the public X CDN"]
    fn live_sensitive_multi_gif_post_downloads_and_converts_both_gifs() {
        let directory = tempfile::tempdir().expect("live X download directory");
        let state = AppState::in_memory().expect("in-memory catalog");
        let result = download_x_post(
            &state,
            "https://x.com/notdodo_x/status/2081950343177376211",
            directory.path(),
            None,
        )
        .expect("live multi-GIF download");
        assert_eq!(result.media_count, 2);
        assert_eq!(result.media.len(), 2);
        for media in result.media {
            assert_eq!(media.kind, "gif");
            assert!(media.gif_finalize_token.is_some());
            assert!(
                media
                    .final_path
                    .as_deref()
                    .is_some_and(|path| path.ends_with(".gif"))
            );
            let source = fs::read(&media.path).expect("downloaded MP4 conversion source");
            assert!(source.windows(4).any(|window| window == b"ftyp"));
            let token = media
                .gif_finalize_token
                .as_deref()
                .expect("native conversion token");
            let finalized = finalize_x_gif(&state, token).expect("native GIF conversion");
            let gif = fs::read(&finalized.path).expect("converted GIF");
            assert!(gif.starts_with(b"GIF89a"));
            assert_eq!(gif.last(), Some(&0x3b));
            assert!(finalized.removed_source);
            assert!(!Path::new(&media.path).exists());
        }
    }

    #[test]
    fn resolves_only_server_provided_selection_ids() {
        let media = vec![XMediaItem {
            id: "media-01".to_owned(),
            kind: "image".to_owned(),
            preview_url: "https://pbs.twimg.com/media/example.jpg?name=small".to_owned(),
            width: None,
            height: None,
            variants: vec![XMediaVariant {
                id: "quality-01-orig".to_owned(),
                label: "オリジナル".to_owned(),
                url: "https://pbs.twimg.com/media/example.jpg?name=orig".to_owned(),
                extension: "jpg".to_owned(),
                width: None,
                height: None,
                bitrate: None,
            }],
            already_downloaded: false,
            existing_path: None,
        }];
        let selected = resolve_selected_variants(
            &media,
            Some(&[XMediaSelection {
                media_id: "media-01".to_owned(),
                variant_id: "quality-01-orig".to_owned(),
            }]),
        )
        .expect("valid selection");
        assert_eq!(selected.len(), 1);
        assert!(
            resolve_selected_variants(
                &media,
                Some(&[XMediaSelection {
                    media_id: "media-01".to_owned(),
                    variant_id: "https://attacker.example/file".to_owned(),
                }]),
            )
            .is_err()
        );
    }

    #[test]
    fn names_first_file_without_an_index_and_following_files_with_two_digits() {
        assert_eq!(download_stem("creator", "123", 0), "creator_123");
        assert_eq!(download_stem("creator", "123", 1), "creator_123_02");
        assert_eq!(download_stem("creator", "123", 9), "creator_123_10");
    }

    #[test]
    fn duplicate_tracking_requires_a_completed_file_in_the_same_destination() {
        let directory = tempfile::tempdir().expect("duplicate fixture directory");
        let other_directory = tempfile::tempdir().expect("other destination");
        let state = AppState::in_memory().expect("in-memory catalog");
        let file = directory.path().join("creator_123.jpg");
        fs::write(&file, b"image").expect("fixture image");
        catalog::upsert_x_history(
            &state,
            XHistoryInput {
                id: Some("history-duplicate".to_owned()),
                source_url: "https://x.com/i/web/status/123".to_owned(),
                media_url: None,
                local_path: Some(file.to_string_lossy().into_owned()),
                author: None,
                post_text: None,
                status: Some("completed".to_owned()),
                error_message: None,
                created_at: Some(1),
                completed_at: Some(2),
            },
        )
        .expect("history");
        record_x_media_status(
            &state,
            "https://x.com/i/web/status/123",
            "media-01",
            directory.path(),
            "history-duplicate",
            "https://pbs.twimg.com/media/example.jpg?name=orig",
            &file,
            "image",
            "completed",
        )
        .expect("record completed media");

        assert_eq!(
            find_completed_duplicate(
                &state,
                "https://x.com/i/web/status/123",
                "media-01",
                directory.path(),
            )
            .expect("same destination"),
            Some(file.clone())
        );
        assert!(
            find_completed_duplicate(
                &state,
                "https://x.com/i/web/status/123",
                "media-01",
                other_directory.path(),
            )
            .expect("other destination")
            .is_none()
        );
        fs::remove_file(&file).expect("remove fixture");
        assert!(
            find_completed_duplicate(
                &state,
                "https://x.com/i/web/status/123",
                "media-01",
                directory.path(),
            )
            .expect("missing file")
            .is_none()
        );
    }

    #[test]
    fn failed_native_conversion_keeps_each_source_and_token_isolated() {
        let directory = tempfile::tempdir().expect("GIF fixture directory");
        let state = AppState::in_memory().expect("in-memory catalog");
        let source_one = directory.path().join(".creator_123.one.gif-source.mp4");
        let source_two = directory.path().join(".creator_123.two.gif-source.mp4");
        let output_one = directory.path().join("creator_123.gif");
        let output_two = directory.path().join("creator_123_02.gif");
        fs::write(&source_one, b"mp4-one").expect("first source");
        fs::write(&source_two, b"mp4-two").expect("second source");
        let history = catalog::upsert_x_history(
            &state,
            XHistoryInput {
                id: Some("history-gif-success".to_owned()),
                source_url: "https://x.com/i/web/status/123".to_owned(),
                media_url: Some("https://video.twimg.com/one.mp4".to_owned()),
                local_path: Some(source_one.to_string_lossy().into_owned()),
                author: Some("creator".to_owned()),
                post_text: Some("post".to_owned()),
                status: Some("completed".to_owned()),
                error_message: None,
                created_at: Some(1),
                completed_at: Some(2),
            },
        )
        .expect("history");
        for (token, source_path, output_path, primary) in [
            (
                "gif-token-one",
                source_one.clone(),
                output_one.clone(),
                true,
            ),
            (
                "gif-token-two",
                source_two.clone(),
                output_two.clone(),
                false,
            ),
        ] {
            register_pending_gif(
                token.to_owned(),
                PendingGifFinalize {
                    source_path,
                    output_path,
                    history_id: history.id.clone(),
                    history_source_url: history.source_url.clone(),
                    history_media_url: history.media_url.clone(),
                    history_author: history.author.clone(),
                    history_post_text: history.post_text.clone(),
                    history_error_message: None,
                    history_created_at: history.created_at,
                    history_completed_at: history.completed_at,
                    is_history_primary: primary,
                    media_key: format!("media-{token}"),
                    destination_dir: directory.path().to_string_lossy().into_owned(),
                    variant_url: "https://video.twimg.com/example.mp4".to_owned(),
                    media_kind: "gif".to_owned(),
                    registered_at: now_millis(),
                },
            )
            .expect("register token");
        }

        assert!(finalize_x_gif(&state, "gif-token-one").is_err());
        assert!(finalize_x_gif(&state, "gif-token-two").is_err());
        assert!(source_one.is_file());
        assert!(source_two.is_file());
        assert!(!output_one.exists());
        assert!(!output_two.exists());

        fail_x_gif_finalization(&state, "gif-token-one", "decoder failed")
            .expect("fail first token");
        fail_x_gif_finalization(&state, "gif-token-two", "decoder failed")
            .expect("fail second token");
        assert!(finalize_x_gif(&state, "gif-token-one").is_err());
    }

    #[test]
    #[ignore = "set PIXVAULT_X_GIF_SOURCE to an external X GIF source MP4"]
    fn native_finalization_converts_an_external_source_copy_without_touching_the_original() {
        let original = PathBuf::from(
            std::env::var("PIXVAULT_X_GIF_SOURCE")
                .expect("PIXVAULT_X_GIF_SOURCE must identify an X GIF source MP4"),
        );
        assert!(original.is_file(), "external source must exist");
        let directory = tempfile::tempdir().expect("external GIF fixture directory");
        let source = directory.path().join(".external.gif-source.mp4");
        let output = directory.path().join("external.gif");
        fs::copy(&original, &source).expect("copy external source");
        let state = AppState::in_memory().expect("in-memory catalog");
        let history = catalog::upsert_x_history(
            &state,
            XHistoryInput {
                id: Some("history-external-gif".to_owned()),
                source_url: "https://x.com/i/web/status/2081950343177376211".to_owned(),
                media_url: Some("https://video.twimg.com/external.mp4".to_owned()),
                local_path: Some(source.to_string_lossy().into_owned()),
                author: Some("notdodo_x".to_owned()),
                post_text: None,
                status: Some("completed".to_owned()),
                error_message: None,
                created_at: Some(1),
                completed_at: Some(2),
            },
        )
        .expect("external history");
        let token = format!("external-{}", Uuid::new_v4());
        register_pending_gif(
            token.clone(),
            PendingGifFinalize {
                source_path: source.clone(),
                output_path: output.clone(),
                history_id: history.id,
                history_source_url: history.source_url,
                history_media_url: history.media_url,
                history_author: history.author,
                history_post_text: history.post_text,
                history_error_message: None,
                history_created_at: history.created_at,
                history_completed_at: history.completed_at,
                is_history_primary: true,
                media_key: "media-external".to_owned(),
                destination_dir: directory.path().to_string_lossy().into_owned(),
                variant_url: "https://video.twimg.com/external.mp4".to_owned(),
                media_kind: "gif".to_owned(),
                registered_at: now_millis(),
            },
        )
        .expect("register external token");

        let finalized = finalize_x_gif(&state, &token).expect("native external conversion");
        let gif = fs::read(&finalized.path).expect("external converted GIF");
        assert!(gif.starts_with(b"GIF89a"));
        assert_eq!(gif.last(), Some(&0x3b));
        assert!(finalized.removed_source);
        assert!(!source.exists());
        assert!(original.is_file(), "original source must remain untouched");
    }

    #[test]
    fn failed_primary_gif_is_explicit_and_keeps_recovery_video() {
        let directory = tempfile::tempdir().expect("GIF fixture directory");
        let state = AppState::in_memory().expect("in-memory catalog");
        let source = directory.path().join(".creator_456.gif-source.mp4");
        fs::write(&source, b"recovery-video").expect("source");
        let history = catalog::upsert_x_history(
            &state,
            XHistoryInput {
                id: Some("history-gif-failure".to_owned()),
                source_url: "https://x.com/i/web/status/456".to_owned(),
                media_url: Some("https://video.twimg.com/failure.mp4".to_owned()),
                local_path: Some(source.to_string_lossy().into_owned()),
                author: Some("creator".to_owned()),
                post_text: None,
                status: Some("completed".to_owned()),
                error_message: None,
                created_at: Some(1),
                completed_at: Some(2),
            },
        )
        .expect("history");
        register_pending_gif(
            "gif-token-failure".to_owned(),
            PendingGifFinalize {
                source_path: source.clone(),
                output_path: directory.path().join("creator_456.gif"),
                history_id: history.id,
                history_source_url: history.source_url,
                history_media_url: history.media_url,
                history_author: history.author,
                history_post_text: history.post_text,
                history_error_message: None,
                history_created_at: history.created_at,
                history_completed_at: history.completed_at,
                is_history_primary: true,
                media_key: "media-failure".to_owned(),
                destination_dir: directory.path().to_string_lossy().into_owned(),
                variant_url: "https://video.twimg.com/failure.mp4".to_owned(),
                media_kind: "gif".to_owned(),
                registered_at: now_millis(),
            },
        )
        .expect("register token");

        let failed = fail_x_gif_finalization(&state, "gif-token-failure", "decoder failed")
            .expect("mark failure");
        assert_eq!(failed.status, "failed");
        assert!(failed.local_path.is_none());
        assert!(
            failed
                .error_message
                .as_deref()
                .is_some_and(|message| message.contains("decoder failed"))
        );
        assert!(source.exists());
        assert!(fail_x_gif_finalization(&state, "gif-token-failure", "again").is_err());
    }
}
