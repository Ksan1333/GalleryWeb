use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, RecvTimeoutError, TrySendError},
    },
    time::{Duration, Instant},
};

use notify::{
    Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher,
    event::{CreateKind, ModifyKind, RemoveKind},
};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::{ai, background_activity, catalog, db::AppState, media_folders};

pub const LIBRARY_WATCH_EVENT: &str = "library-watch-updated";
const PENDING_ANALYSIS_KEY: &str = "watcher.pendingAnalysisIds";
const CHANGE_STABILITY_DELAY: Duration = Duration::from_millis(1_200);
const CONTROL_REFRESH_INTERVAL: Duration = Duration::from_secs(30);
const AUTO_ANALYSIS_POLL_INTERVAL: Duration = Duration::from_secs(1);
const AUTO_ANALYSIS_BATCH: usize = 64;
const WATCH_EVENT_BUFFER: usize = 1_024;

#[derive(Debug, Clone, PartialEq, Eq)]
struct WatchedRoot {
    id: String,
    path: PathBuf,
}

#[derive(Debug, Clone, Copy)]
struct PendingRootChange {
    changed_at: Instant,
    refresh_hierarchy: bool,
}

#[derive(Debug)]
struct ActiveAutoAnalysis {
    job_id: String,
    media_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryWatchEvent {
    root_id: String,
    inserted: u64,
    updated: u64,
    missing: u64,
    queued_for_analysis: usize,
}

pub fn start(app: AppHandle, database_path: std::path::PathBuf) {
    if let Err(error) = std::thread::Builder::new()
        .name("pixvault-folder-watcher".to_owned())
        .spawn(move || run(app, database_path))
    {
        eprintln!("Cannot start the registered-folder watcher: {error}");
    }
}

fn run(app: AppHandle, database_path: std::path::PathBuf) {
    let Ok(state) = AppState::open(&database_path) else {
        return;
    };
    let (event_sender, event_receiver) =
        mpsc::sync_channel::<notify::Result<Event>>(WATCH_EVENT_BUFFER);
    let event_overflowed = Arc::new(AtomicBool::new(false));
    let callback_overflowed = Arc::clone(&event_overflowed);
    let mut watcher = match notify::recommended_watcher(move |event| {
        if let Err(TrySendError::Full(_)) = event_sender.try_send(event) {
            callback_overflowed.store(true, Ordering::Release);
        }
    }) {
        Ok(watcher) => watcher,
        Err(error) => {
            eprintln!("Cannot initialize the registered-folder watcher: {error}");
            return;
        }
    };

    let mut preferences = preference_flags(&state);
    let mut watched_roots = HashMap::<String, WatchedRoot>::new();
    let mut pending_changes = HashMap::<String, PendingRootChange>::new();
    let mut pending_analysis = load_pending_analysis(&state);
    let mut active_auto_analysis: Option<ActiveAutoAnalysis> = None;
    let mut retry_auto_after = Instant::now();
    let mut next_control_refresh = Instant::now();
    let mut next_analysis_poll = Instant::now();

    loop {
        let now = Instant::now();
        if now >= next_control_refresh {
            preferences = preference_flags(&state);
            sync_watched_roots(
                &mut watcher,
                &state,
                preferences.watch_folders,
                &mut watched_roots,
                &mut pending_changes,
            );
            next_control_refresh = now + CONTROL_REFRESH_INTERVAL;
        }

        if now >= next_analysis_poll {
            update_active_auto_analysis(
                &app,
                &state,
                &mut pending_analysis,
                &mut active_auto_analysis,
                &mut retry_auto_after,
            );
            if preferences.auto_analyze
                && active_auto_analysis.is_none()
                && !pending_analysis.is_empty()
                && now >= retry_auto_after
            {
                start_pending_auto_analysis(
                    &app,
                    &pending_analysis,
                    &mut active_auto_analysis,
                    &mut retry_auto_after,
                );
            }
            next_analysis_poll = now + AUTO_ANALYSIS_POLL_INTERVAL;
        }

        if event_overflowed.swap(false, Ordering::AcqRel) && preferences.watch_folders {
            let received_at = Instant::now();
            for root_id in watched_roots.keys().cloned().collect::<Vec<_>>() {
                record_root_change(&mut pending_changes, root_id, received_at, true);
            }
        }

        let due_roots = take_stable_root_changes(&mut pending_changes, &watched_roots, now);
        if !due_roots.is_empty() {
            background_activity::wait_until_quiet(
                Duration::from_millis(650),
                Duration::from_millis(100),
            );
            for (root_id, refresh_hierarchy) in due_roots {
                scan_changed_root(
                    &app,
                    &state,
                    &root_id,
                    refresh_hierarchy,
                    preferences,
                    &mut pending_analysis,
                );
            }
        }

        let timeout = next_wake_timeout(
            Instant::now(),
            next_control_refresh,
            next_analysis_poll,
            &pending_changes,
        );
        match event_receiver.recv_timeout(timeout) {
            Ok(Ok(event)) => {
                if preferences.watch_folders && event_is_relevant(&event) {
                    let received_at = Instant::now();
                    let refresh_hierarchy = event_changes_folder_hierarchy(&event);
                    for root_id in roots_for_event(&event, &watched_roots) {
                        record_root_change(
                            &mut pending_changes,
                            root_id,
                            received_at,
                            refresh_hierarchy,
                        );
                    }
                }
            }
            Ok(Err(error)) => eprintln!("Registered-folder watcher error: {error}"),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                eprintln!("Registered-folder watcher stopped unexpectedly");
                return;
            }
        }
    }
}

fn sync_watched_roots(
    watcher: &mut RecommendedWatcher,
    state: &AppState,
    watch_folders: bool,
    watched_roots: &mut HashMap<String, WatchedRoot>,
    pending_changes: &mut HashMap<String, PendingRootChange>,
) {
    if !watch_folders {
        unwatch_all(watcher, watched_roots, pending_changes);
        return;
    }

    let records = match catalog::list_enabled_library_root_records(state) {
        Ok(records) => records,
        Err(error) => {
            eprintln!("Cannot refresh registered-folder watches: {error}");
            return;
        }
    };
    let desired_roots = records
        .into_iter()
        .map(|root| {
            (
                root.id.clone(),
                WatchedRoot {
                    id: root.id,
                    path: PathBuf::from(root.path),
                },
            )
        })
        .collect::<HashMap<_, _>>();

    let obsolete_ids = watched_roots
        .iter()
        .filter_map(|(root_id, current)| {
            (desired_roots.get(root_id) != Some(current) || !current.path.is_dir())
                .then(|| root_id.clone())
        })
        .collect::<Vec<_>>();
    for root_id in obsolete_ids {
        if let Some(root) = watched_roots.remove(&root_id) {
            let _ = watcher.unwatch(&root.path);
        }
        pending_changes.remove(&root_id);
    }

    for (root_id, root) in desired_roots {
        if watched_roots.contains_key(&root_id) {
            continue;
        }
        if !root.path.is_dir() {
            // Unavailable removable and network roots are retried at the next
            // control refresh without marking their catalog entries missing.
            continue;
        }
        match watcher.watch(&root.path, RecursiveMode::Recursive) {
            Ok(()) => {
                watched_roots.insert(root_id, root);
            }
            Err(error) => eprintln!(
                "Cannot watch registered folder {}: {error}",
                root.path.display()
            ),
        }
    }
    pending_changes.retain(|root_id, _| watched_roots.contains_key(root_id));
}

fn unwatch_all(
    watcher: &mut RecommendedWatcher,
    watched_roots: &mut HashMap<String, WatchedRoot>,
    pending_changes: &mut HashMap<String, PendingRootChange>,
) {
    for (_, root) in watched_roots.drain() {
        let _ = watcher.unwatch(&root.path);
    }
    pending_changes.clear();
}

fn event_is_relevant(event: &Event) -> bool {
    event.need_rescan() || !matches!(event.kind, EventKind::Access(_))
}

fn event_changes_folder_hierarchy(event: &Event) -> bool {
    if event.need_rescan() {
        return true;
    }
    match event.kind {
        EventKind::Access(_) => false,
        EventKind::Create(CreateKind::File) | EventKind::Remove(RemoveKind::File) => false,
        EventKind::Create(CreateKind::Folder) | EventKind::Remove(RemoveKind::Folder) => true,
        EventKind::Modify(ModifyKind::Data(_) | ModifyKind::Metadata(_)) => false,
        EventKind::Modify(ModifyKind::Name(_)) => true,
        EventKind::Create(CreateKind::Any | CreateKind::Other)
        | EventKind::Modify(ModifyKind::Any | ModifyKind::Other) => {
            event.paths.is_empty() || !event.paths.iter().all(|path| path.is_file())
        }
        EventKind::Remove(RemoveKind::Any | RemoveKind::Other) => {
            event.paths.is_empty()
                || !event
                    .paths
                    .iter()
                    .all(|path| catalog::classify_media(path).is_some())
        }
        EventKind::Any | EventKind::Other => true,
    }
}

fn roots_for_event(event: &Event, watched_roots: &HashMap<String, WatchedRoot>) -> HashSet<String> {
    if event.need_rescan() || (event.paths.is_empty() && matches!(event.kind, EventKind::Other)) {
        return watched_roots.keys().cloned().collect();
    }
    event
        .paths
        .iter()
        .filter_map(|path| {
            watched_roots
                .values()
                .filter(|root| path_is_within_root(path, &root.path))
                .max_by_key(|root| root.path.components().count())
                .map(|root| root.id.clone())
        })
        .collect()
}

#[cfg(windows)]
fn path_is_within_root(path: &Path, root: &Path) -> bool {
    fn comparable_path(path: &Path) -> String {
        let value = path.to_string_lossy().replace('/', "\\");
        let value = if let Some(unc_path) = value.strip_prefix(r"\\?\UNC\") {
            format!(r"\\{unc_path}")
        } else {
            value.strip_prefix(r"\\?\").unwrap_or(&value).to_owned()
        };
        value.trim_end_matches('\\').to_lowercase()
    }

    let path = comparable_path(path);
    let root = comparable_path(root);
    path == root
        || path
            .strip_prefix(&root)
            .is_some_and(|suffix| suffix.starts_with('\\'))
}

#[cfg(not(windows))]
fn path_is_within_root(path: &Path, root: &Path) -> bool {
    path.starts_with(root)
}

fn record_root_change(
    pending_changes: &mut HashMap<String, PendingRootChange>,
    root_id: String,
    changed_at: Instant,
    refresh_hierarchy: bool,
) {
    pending_changes
        .entry(root_id)
        .and_modify(|pending| {
            pending.changed_at = changed_at;
            pending.refresh_hierarchy |= refresh_hierarchy;
        })
        .or_insert(PendingRootChange {
            changed_at,
            refresh_hierarchy,
        });
}

fn take_stable_root_changes(
    pending_changes: &mut HashMap<String, PendingRootChange>,
    watched_roots: &HashMap<String, WatchedRoot>,
    now: Instant,
) -> Vec<(String, bool)> {
    let mut due = pending_changes
        .iter()
        .filter_map(|(root_id, pending)| {
            (watched_roots.contains_key(root_id)
                && now.saturating_duration_since(pending.changed_at) >= CHANGE_STABILITY_DELAY)
                .then(|| (root_id.clone(), pending.refresh_hierarchy))
        })
        .collect::<Vec<_>>();
    due.sort_unstable_by(|left, right| left.0.cmp(&right.0));
    for (root_id, _) in &due {
        pending_changes.remove(root_id);
    }
    due
}

fn next_wake_timeout(
    now: Instant,
    next_control_refresh: Instant,
    next_analysis_poll: Instant,
    pending_changes: &HashMap<String, PendingRootChange>,
) -> Duration {
    let mut next_wake = next_control_refresh.min(next_analysis_poll);
    if let Some(change_wake) = pending_changes
        .values()
        .map(|pending| pending.changed_at + CHANGE_STABILITY_DELAY)
        .min()
    {
        next_wake = next_wake.min(change_wake);
    }
    next_wake.saturating_duration_since(now)
}

fn scan_changed_root(
    app: &AppHandle,
    state: &AppState,
    root_id: &str,
    refresh_hierarchy: bool,
    preferences: WatchPreferences,
    pending_analysis: &mut HashSet<String>,
) {
    let scan_started_at = catalog::now_millis();
    match catalog::scan_library(state, Some(root_id)) {
        Ok(report) => {
            let new_ids = query_new_analyzable_ids(state, scan_started_at);
            if preferences.auto_analyze && !new_ids.is_empty() {
                pending_analysis.extend(new_ids);
                persist_pending_analysis(state, pending_analysis);
            }
            if refresh_hierarchy {
                let _ = media_folders::refresh_folder_hierarchy_cache(state, Some(root_id));
            }
            crate::invalidate_media_presence_cache();
            let _ = app.emit(
                LIBRARY_WATCH_EVENT,
                LibraryWatchEvent {
                    root_id: root_id.to_owned(),
                    inserted: report.inserted,
                    updated: report.updated,
                    missing: report.missing,
                    queued_for_analysis: pending_analysis.len(),
                },
            );
        }
        Err(error) => eprintln!("Registered-folder rescan failed: {error}"),
    }
}

#[derive(Debug, Clone, Copy)]
struct WatchPreferences {
    watch_folders: bool,
    auto_analyze: bool,
}

fn preference_flags(state: &AppState) -> WatchPreferences {
    let mut flags = WatchPreferences {
        watch_folders: true,
        auto_analyze: false,
    };
    if let Ok(entries) = catalog::get_preferences(state) {
        for entry in entries {
            match entry.key.as_str() {
                "watchFolders" => {
                    flags.watch_folders = entry.value.as_bool().unwrap_or(flags.watch_folders)
                }
                "autoAnalyze" => {
                    flags.auto_analyze = entry.value.as_bool().unwrap_or(flags.auto_analyze)
                }
                _ => {}
            }
        }
    }
    flags
}

fn query_new_analyzable_ids(state: &AppState, scan_started_at: i64) -> Vec<String> {
    let Ok(connection) = state.database.lock() else {
        return Vec::new();
    };
    let Ok(mut statement) = connection.prepare(
        "SELECT m.id
         FROM media_items m
         LEFT JOIN media_metadata mm ON mm.media_id = m.id
         WHERE m.is_missing = 0
           AND m.media_kind IN ('image', 'gif')
           AND m.first_seen_at >= ?1
           AND COALESCE(mm.is_ai_analyzed, 0) = 0
         ORDER BY m.first_seen_at, m.id
         LIMIT 1000",
    ) else {
        return Vec::new();
    };
    statement
        .query_map([scan_started_at], |row| row.get::<_, String>(0))
        .ok()
        .into_iter()
        .flat_map(|rows| rows.filter_map(Result::ok))
        .collect()
}

fn load_pending_analysis(state: &AppState) -> HashSet<String> {
    catalog::get_preferences(state)
        .ok()
        .and_then(|entries| {
            entries
                .into_iter()
                .find(|entry| entry.key == PENDING_ANALYSIS_KEY)
        })
        .and_then(|entry| entry.value.as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|value| value.as_str().map(ToOwned::to_owned))
        .filter(|value| !value.is_empty() && value.len() <= 128)
        .take(10_000)
        .collect()
}

fn persist_pending_analysis(state: &AppState, pending: &HashSet<String>) {
    let mut media_ids = pending.iter().cloned().collect::<Vec<_>>();
    media_ids.sort_unstable();
    let _ = catalog::set_preference(
        state,
        PENDING_ANALYSIS_KEY,
        Value::Array(media_ids.into_iter().map(Value::String).collect()),
    );
}

fn start_pending_auto_analysis(
    app: &AppHandle,
    pending: &HashSet<String>,
    active: &mut Option<ActiveAutoAnalysis>,
    retry_after: &mut Instant,
) {
    let mut media_ids = pending
        .iter()
        .take(AUTO_ANALYSIS_BATCH)
        .cloned()
        .collect::<Vec<_>>();
    media_ids.sort_unstable();
    let catalog_state = app.state::<AppState>();
    let ai_state = app.state::<ai::AiRuntimeState>();
    match ai::start_ai_analysis(
        app.clone(),
        catalog_state,
        ai_state,
        Some(media_ids.clone()),
        None,
        Some("standard".to_owned()),
        Some(media_ids.len()),
    ) {
        Ok(job) => {
            *active = Some(ActiveAutoAnalysis {
                job_id: job.job_id,
                media_ids,
            });
        }
        Err(_) => *retry_after = Instant::now() + Duration::from_secs(20),
    }
}

fn update_active_auto_analysis(
    app: &AppHandle,
    state: &AppState,
    pending: &mut HashSet<String>,
    active: &mut Option<ActiveAutoAnalysis>,
    retry_after: &mut Instant,
) {
    let Some(job) = active.as_ref() else {
        return;
    };
    let Ok(progress) = ai::get_ai_analysis_status(app.state::<ai::AiRuntimeState>()) else {
        return;
    };
    if progress.job_id.as_deref() != Some(job.job_id.as_str()) {
        return;
    }
    match progress.phase.as_str() {
        "completed" => {
            for media_id in &job.media_ids {
                pending.remove(media_id);
            }
            persist_pending_analysis(state, pending);
            *active = None;
        }
        "failed" | "cancelled" => {
            *active = None;
            *retry_after = Instant::now() + Duration::from_secs(60);
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_path_is_assigned_only_to_the_most_specific_registered_root() {
        let base = PathBuf::from("library");
        let nested = base.join("Nested");
        let watched_roots = [
            (
                "base".to_owned(),
                WatchedRoot {
                    id: "base".to_owned(),
                    path: base,
                },
            ),
            (
                "nested".to_owned(),
                WatchedRoot {
                    id: "nested".to_owned(),
                    path: nested.clone(),
                },
            ),
            (
                "other".to_owned(),
                WatchedRoot {
                    id: "other".to_owned(),
                    path: PathBuf::from("library-other"),
                },
            ),
        ]
        .into_iter()
        .collect();
        let event = Event::new(EventKind::Any).add_path(nested.join("image.jpg"));

        let roots = roots_for_event(&event, &watched_roots);
        assert_eq!(roots, HashSet::from(["nested".to_owned()]));
    }

    #[test]
    fn debounce_waits_for_quiet_time_after_the_latest_event() {
        let started_at = Instant::now();
        let watched_roots = [(
            "root".to_owned(),
            WatchedRoot {
                id: "root".to_owned(),
                path: PathBuf::from(r"C:\Library"),
            },
        )]
        .into_iter()
        .collect();
        let mut pending = HashMap::from([(
            "root".to_owned(),
            PendingRootChange {
                changed_at: started_at,
                refresh_hierarchy: false,
            },
        )]);

        record_root_change(
            &mut pending,
            "root".to_owned(),
            started_at + Duration::from_millis(800),
            false,
        );
        assert!(
            take_stable_root_changes(
                &mut pending,
                &watched_roots,
                started_at + CHANGE_STABILITY_DELAY
            )
            .is_empty()
        );
        assert_eq!(
            take_stable_root_changes(
                &mut pending,
                &watched_roots,
                started_at + Duration::from_millis(2_000)
            ),
            vec![("root".to_owned(), false)]
        );
    }

    #[test]
    fn coalesced_events_preserve_the_need_for_a_hierarchy_refresh() {
        let started_at = Instant::now();
        let mut pending = HashMap::new();

        record_root_change(&mut pending, "root".to_owned(), started_at, true);
        record_root_change(
            &mut pending,
            "root".to_owned(),
            started_at + Duration::from_millis(500),
            false,
        );

        let change = pending.get("root").expect("pending root");
        assert_eq!(change.changed_at, started_at + Duration::from_millis(500));
        assert!(change.refresh_hierarchy);
    }

    #[test]
    fn ordinary_file_changes_do_not_rebuild_the_folder_hierarchy() {
        let create =
            Event::new(EventKind::Create(CreateKind::File)).add_path(PathBuf::from("image.jpg"));
        let modify = Event::new(EventKind::Modify(ModifyKind::Data(
            notify::event::DataChange::Content,
        )))
        .add_path(PathBuf::from("image.jpg"));
        let remove =
            Event::new(EventKind::Remove(RemoveKind::File)).add_path(PathBuf::from("image.jpg"));

        assert!(!event_changes_folder_hierarchy(&create));
        assert!(!event_changes_folder_hierarchy(&modify));
        assert!(!event_changes_folder_hierarchy(&remove));
    }

    #[test]
    fn folder_and_rename_events_rebuild_the_folder_hierarchy() {
        let folder =
            Event::new(EventKind::Create(CreateKind::Folder)).add_path(PathBuf::from("new-folder"));
        let rename = Event::new(EventKind::Modify(ModifyKind::Name(
            notify::event::RenameMode::Both,
        )))
        .add_path(PathBuf::from("old-folder"))
        .add_path(PathBuf::from("new-folder"));

        assert!(event_changes_folder_hierarchy(&folder));
        assert!(event_changes_folder_hierarchy(&rename));
    }

    #[test]
    fn access_only_events_do_not_schedule_catalog_scans() {
        let event = Event::new(EventKind::Access(notify::event::AccessKind::Read));
        assert!(!event_is_relevant(&event));
    }

    #[test]
    fn rescan_notice_invalidates_every_registered_root() {
        let watched_roots = [
            (
                "one".to_owned(),
                WatchedRoot {
                    id: "one".to_owned(),
                    path: PathBuf::from("one"),
                },
            ),
            (
                "two".to_owned(),
                WatchedRoot {
                    id: "two".to_owned(),
                    path: PathBuf::from("two"),
                },
            ),
        ]
        .into_iter()
        .collect();
        let event = Event::new(EventKind::Other).set_flag(notify::event::Flag::Rescan);

        assert_eq!(
            roots_for_event(&event, &watched_roots),
            HashSet::from(["one".to_owned(), "two".to_owned()])
        );
    }

    #[test]
    fn auto_analysis_queue_uses_the_persisted_analysis_flag() {
        let state = AppState::in_memory().expect("in-memory catalog");
        state
            .database
            .lock()
            .expect("database")
            .execute_batch(
                "INSERT INTO library_roots(id, path, display_name, enabled, created_at, updated_at)
                 VALUES ('root', 'C:\\fixture', 'fixture', 1, 1, 1);
                 INSERT INTO media_items(
                     id, root_id, relative_path, file_name, extension, media_kind,
                     mime_type, byte_size, modified_at, first_seen_at, last_seen_at, updated_at
                 ) VALUES
                     ('new', 'root', 'new.png', 'new.png', 'png', 'image', 'image/png', 1, 100, 100, 100, 100),
                     ('done', 'root', 'done.gif', 'done.gif', 'gif', 'gif', 'image/gif', 1, 100, 100, 100, 100);
                 INSERT INTO media_metadata(media_id, is_ai_analyzed, updated_at)
                 VALUES ('new', 0, 100), ('done', 1, 100);",
            )
            .expect("fixtures");

        assert_eq!(query_new_analyzable_ids(&state, 100), vec!["new"]);
    }
}
