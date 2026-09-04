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
const CHANGE_STABILITY_DELAY: Duration = Duration::from_millis(400);
const CONTROL_REFRESH_INTERVAL: Duration = Duration::from_secs(2);
const AUTO_ANALYSIS_POLL_INTERVAL: Duration = Duration::from_secs(1);
const AUTO_ANALYSIS_BATCH: usize = 64;
const WATCH_EVENT_BUFFER: usize = 1_024;
const RECONCILIATION_START_DELAY: Duration = Duration::from_secs(8);
const RECONCILIATION_QUIET_PERIOD: Duration = Duration::from_secs(2);
const RECONCILIATION_MAX_DELAY: Duration = Duration::from_secs(30);
const RECONCILIATION_POLL_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, PartialEq, Eq)]
struct WatchedRoot {
    id: String,
    path: PathBuf,
    recursive: bool,
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
    // None means a full reconciliation requested by a notification/overflow.
    let mut pending_paths = HashMap::<String, Option<HashSet<PathBuf>>>::new();
    // Startup/reconnect baselines are independent of real notifications. A
    // create/delete arriving during the grace period stays incremental.
    let mut pending_reconciliations = HashMap::<String, Instant>::new();
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
                &mut pending_paths,
                &mut pending_reconciliations,
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
            for root_id in watched_roots
                .values()
                .map(|root| root.id.clone())
                .collect::<HashSet<_>>()
            {
                pending_paths.insert(root_id.clone(), None);
                record_root_change(&mut pending_changes, root_id, received_at, true);
            }
        }

        let due_roots = take_stable_root_changes(&mut pending_changes, &watched_roots, now);
        if !due_roots.is_empty() {
            for (root_id, refresh_hierarchy) in due_roots {
                let paths = pending_paths
                    .remove(&root_id)
                    .flatten()
                    .map(|paths| paths.into_iter().collect::<Vec<_>>());
                if paths.is_none() {
                    pending_reconciliations.remove(&root_id);
                }
                scan_changed_root(
                    &app,
                    &state,
                    &root_id,
                    refresh_hierarchy,
                    preferences,
                    &mut pending_analysis,
                    paths.as_deref(),
                );
            }
        }

        if let Some(root_id) = take_due_reconciliation(
            &mut pending_reconciliations,
            &watched_roots,
            Instant::now(),
            background_activity::is_foreground_active(RECONCILIATION_QUIET_PERIOD),
        ) {
            scan_changed_root(
                &app,
                &state,
                &root_id,
                true,
                preferences,
                &mut pending_analysis,
                None,
            );
        }

        let timeout = next_wake_timeout(
            Instant::now(),
            next_control_refresh,
            next_analysis_poll,
            &pending_changes,
            &pending_reconciliations,
        );
        match event_receiver.recv_timeout(timeout) {
            Ok(Ok(event)) => {
                if preferences.watch_folders && event_is_relevant(&event) {
                    let received_at = Instant::now();
                    let refresh_hierarchy = event_changes_folder_hierarchy(&event);
                    for root_id in roots_for_event(&event, &watched_roots) {
                        if event.need_rescan() || event.paths.is_empty() {
                            pending_paths.insert(root_id.clone(), None);
                        } else if let Some(paths) = pending_paths
                            .entry(root_id.clone())
                            .or_insert_with(|| Some(HashSet::new()))
                        {
                            paths.extend(
                                event
                                    .paths
                                    .iter()
                                    .filter(|path| {
                                        watched_roots.values().any(|root| {
                                            root.id == root_id
                                                && path_is_within_root(path, &root.path)
                                        })
                                    })
                                    .cloned(),
                            );
                            if paths.len() > WATCH_EVENT_BUFFER {
                                pending_paths.insert(root_id.clone(), None);
                            }
                        }
                        record_root_change(
                            &mut pending_changes,
                            root_id,
                            received_at,
                            refresh_hierarchy,
                        );
                    }
                }
            }
            Ok(Err(error)) => {
                eprintln!("Folder watcher error: {error}");
                event_overflowed.store(true, Ordering::Release);
            }
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
    pending_paths: &mut HashMap<String, Option<HashSet<PathBuf>>>,
    pending_reconciliations: &mut HashMap<String, Instant>,
) {
    if !watch_folders {
        unwatch_all(watcher, watched_roots, pending_changes);
        pending_paths.clear();
        pending_reconciliations.clear();
        return;
    }

    let records = match catalog::list_enabled_library_root_records(state) {
        Ok(records) => records,
        Err(error) => {
            eprintln!("Cannot refresh registered-folder watches: {error}");
            return;
        }
    };
    let priority_paths = records
        .iter()
        .filter(|root| root.is_priority)
        .map(|root| PathBuf::from(&root.path))
        .collect::<Vec<_>>();
    let mut desired_roots = records
        .into_iter()
        .map(|root| {
            (
                root.id.clone(),
                WatchedRoot {
                    recursive: priority_paths
                        .iter()
                        .any(|parent| Path::new(&root.path).starts_with(parent)),
                    id: root.id,
                    path: PathBuf::from(root.path),
                },
            )
        })
        .collect::<HashMap<_, _>>();
    let owners = desired_roots.values().cloned().collect::<Vec<_>>();
    if let Ok(preferences) = catalog::get_preferences(state) {
        for entry in preferences {
            if !entry.key.starts_with("folder.visited.") {
                continue;
            }
            let Some(root_id) = entry.value["rootId"].as_str() else {
                continue;
            };
            let Some(path) = entry.value["path"].as_str().map(PathBuf::from) else {
                continue;
            };
            let Some(root) = desired_roots.get(root_id) else {
                continue;
            };
            if root.recursive || !path_is_within_root(&path, &root.path) || path == root.path {
                continue;
            }
            if owners
                .iter()
                .filter(|owner| path_is_within_root(&path, &owner.path))
                .max_by_key(|owner| owner.path.components().count())
                .is_some_and(|owner| owner.id != root_id)
            {
                continue;
            }
            let id = root_id.to_owned();
            desired_roots.insert(
                entry.key,
                WatchedRoot {
                    id,
                    path,
                    recursive: false,
                },
            );
        }
    }

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
        match watcher.watch(
            &root.path,
            if root.recursive {
                RecursiveMode::Recursive
            } else {
                RecursiveMode::NonRecursive
            },
        ) {
            Ok(()) => {
                pending_reconciliations
                    .entry(root.id.clone())
                    .or_insert_with(Instant::now);
                watched_roots.insert(root_id, root);
            }
            Err(error) => eprintln!(
                "Cannot watch registered folder {}: {error}",
                root.path.display()
            ),
        }
    }
    pending_changes.retain(|root_id, _| watched_roots.values().any(|root| &root.id == root_id));
    pending_paths.retain(|root_id, _| pending_changes.contains_key(root_id));
    pending_reconciliations
        .retain(|root_id, _| watched_roots.values().any(|root| &root.id == root_id));
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
    if event.need_rescan() {
        return true;
    }
    match event.kind {
        EventKind::Access(_) => false,
        EventKind::Modify(ModifyKind::Data(_) | ModifyKind::Metadata(_)) => {
            // A child change also updates the directory's timestamp. That
            // notification must not turn a one-file edit into a root scan.
            event.paths.is_empty()
                || event
                    .paths
                    .iter()
                    .any(|path| !path.is_dir() && catalog::classify_media(path).is_some())
        }
        EventKind::Create(CreateKind::File) | EventKind::Remove(RemoveKind::File) => event
            .paths
            .iter()
            .any(|path| catalog::classify_media(path).is_some()),
        _ => true,
    }
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
        return watched_roots.values().map(|root| root.id.clone()).collect();
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
            // Keep the first arrival time: a continuous download must not
            // postpone all updates forever.
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
            (watched_roots.values().any(|root| &root.id == root_id)
                && now.saturating_duration_since(pending.changed_at) >= CHANGE_STABILITY_DELAY)
                .then(|| (root_id.clone(), pending.refresh_hierarchy))
        })
        .collect::<Vec<_>>();
    due.sort_unstable_by_key(|entry| {
        (
            !watched_roots
                .values()
                .any(|root| root.id == entry.0 && root.recursive),
            entry.0.clone(),
        )
    });
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
    pending_reconciliations: &HashMap<String, Instant>,
) -> Duration {
    let mut next_wake = next_control_refresh.min(next_analysis_poll);
    if let Some(change_wake) = pending_changes
        .values()
        .map(|pending| pending.changed_at + CHANGE_STABILITY_DELAY)
        .min()
    {
        next_wake = next_wake.min(change_wake);
    }
    if let Some(reconcile_wake) = pending_reconciliations
        .values()
        .map(|queued_at| {
            (*queued_at + RECONCILIATION_START_DELAY).max(now + RECONCILIATION_POLL_INTERVAL)
        })
        .min()
    {
        // Once eligible, poll instead of retaining a deadline in the past;
        // foreground interaction must not turn an idle wait into a busy loop.
        next_wake = next_wake.min(reconcile_wake);
    }
    next_wake.saturating_duration_since(now)
}

fn take_due_reconciliation(
    pending: &mut HashMap<String, Instant>,
    watched_roots: &HashMap<String, WatchedRoot>,
    now: Instant,
    foreground_active: bool,
) -> Option<String> {
    let root_id = pending
        .iter()
        .filter(|(root_id, queued_at)| {
            let age = now.saturating_duration_since(**queued_at);
            watched_roots.values().any(|root| &root.id == *root_id)
                && age >= RECONCILIATION_START_DELAY
                && (!foreground_active || age >= RECONCILIATION_MAX_DELAY)
        })
        .min_by_key(|(root_id, queued_at)| {
            (
                !watched_roots
                    .values()
                    .any(|root| &root.id == *root_id && root.recursive),
                **queued_at,
                (*root_id).clone(),
            )
        })
        .map(|(root_id, _)| root_id.clone())?;
    pending.remove(&root_id);
    Some(root_id)
}

fn scan_changed_root(
    app: &AppHandle,
    state: &AppState,
    root_id: &str,
    refresh_hierarchy: bool,
    preferences: WatchPreferences,
    pending_analysis: &mut HashSet<String>,
    changed_paths: Option<&[PathBuf]>,
) {
    let scan_started_at = catalog::now_millis();
    let result = match changed_paths {
        Some(paths) => catalog::reconcile_changed_paths(state, root_id, paths)
            .or_else(|_| catalog::scan_library(state, Some(root_id))),
        None => catalog::scan_library(state, Some(root_id)),
    };
    match result {
        Ok(report) => {
            let new_ids = if preferences.auto_analyze && report.inserted > 0 {
                query_new_analyzable_ids(state, scan_started_at)
            } else {
                Vec::new()
            };
            if preferences.auto_analyze && !new_ids.is_empty() {
                pending_analysis.extend(new_ids);
                persist_pending_analysis(state, pending_analysis);
            }
            if refresh_hierarchy {
                // Invalidate lazily; enumerating the whole hierarchy for each
                // renamed file defeats incremental event processing.
                let _ = media_folders::invalidate_folder_hierarchy_cache(state, Some(root_id));
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

    fn reconciliation_test_roots() -> HashMap<String, WatchedRoot> {
        HashMap::from([(
            "root".to_owned(),
            WatchedRoot {
                id: "root".to_owned(),
                path: PathBuf::from("fixture"),
                recursive: true,
            },
        )])
    }

    #[test]
    fn initial_reconciliation_waits_for_startup_and_idle_but_cannot_starve() {
        let started = Instant::now();
        let roots = reconciliation_test_roots();
        let mut pending = HashMap::from([("root".to_owned(), started)]);
        assert_eq!(
            take_due_reconciliation(&mut pending, &roots, started, false),
            None
        );
        assert_eq!(
            take_due_reconciliation(
                &mut pending,
                &roots,
                started + RECONCILIATION_START_DELAY,
                true
            ),
            None
        );
        assert!(pending.contains_key("root"));
        assert_eq!(
            take_due_reconciliation(
                &mut pending,
                &roots,
                started + RECONCILIATION_START_DELAY,
                false
            ),
            Some("root".to_owned())
        );
        assert!(pending.is_empty());
        pending.insert("root".to_owned(), started);
        assert_eq!(
            take_due_reconciliation(
                &mut pending,
                &roots,
                started + RECONCILIATION_MAX_DELAY,
                true
            ),
            Some("root".to_owned())
        );
    }

    #[test]
    fn live_changes_remain_prompt_while_initial_reconciliation_is_deferred() {
        let started = Instant::now();
        let roots = reconciliation_test_roots();
        let mut baseline = HashMap::from([("root".to_owned(), started)]);
        let mut changes = HashMap::new();
        record_root_change(&mut changes, "root".to_owned(), started, false);
        let now = started + CHANGE_STABILITY_DELAY;
        assert_eq!(
            take_stable_root_changes(&mut changes, &roots, now),
            vec![("root".to_owned(), false)]
        );
        assert_eq!(
            take_due_reconciliation(&mut baseline, &roots, now, true),
            None
        );
        assert!(baseline.contains_key("root"));
    }

    #[test]
    fn deferred_reconciliation_does_not_busy_poll_or_include_unwatched_roots() {
        let started = Instant::now();
        let now = started + RECONCILIATION_START_DELAY;
        let mut baseline = HashMap::from([("root".to_owned(), started)]);
        let timeout = next_wake_timeout(
            now,
            now + CONTROL_REFRESH_INTERVAL,
            now + AUTO_ANALYSIS_POLL_INTERVAL,
            &HashMap::new(),
            &baseline,
        );
        assert_eq!(timeout, RECONCILIATION_POLL_INTERVAL);
        assert_eq!(
            take_due_reconciliation(&mut baseline, &HashMap::new(), now, false),
            None
        );
    }

    #[test]
    fn deferred_reconciliation_takes_only_one_root_and_prioritizes_recursive_roots() {
        let started = Instant::now();
        let mut roots = reconciliation_test_roots();
        roots.insert(
            "other".to_owned(),
            WatchedRoot {
                id: "other".to_owned(),
                path: PathBuf::from("other"),
                recursive: false,
            },
        );
        let mut baseline =
            HashMap::from([("root".to_owned(), started), ("other".to_owned(), started)]);
        assert_eq!(
            take_due_reconciliation(
                &mut baseline,
                &roots,
                started + RECONCILIATION_START_DELAY,
                false
            ),
            Some("root".to_owned())
        );
        assert_eq!(baseline.len(), 1);
    }

    #[test]
    fn rescan_notification_uses_catalog_ids_not_visited_subscription_keys() {
        let roots = HashMap::from([
            (
                "root".to_owned(),
                WatchedRoot {
                    id: "root".to_owned(),
                    path: PathBuf::from("fixture"),
                    recursive: false,
                },
            ),
            (
                "folder.visited.root.child".to_owned(),
                WatchedRoot {
                    id: "root".to_owned(),
                    path: PathBuf::from("fixture/child"),
                    recursive: false,
                },
            ),
        ]);
        let event = Event::new(EventKind::Other).set_flag(notify::event::Flag::Rescan);
        assert_eq!(
            roots_for_event(&event, &roots),
            HashSet::from(["root".to_owned()])
        );
    }

    #[test]
    fn directory_timestamp_updates_do_not_trigger_recursive_scans() {
        let directory = tempfile::tempdir().unwrap();
        let event = Event::new(EventKind::Modify(ModifyKind::Metadata(
            notify::event::MetadataKind::Any,
        )))
        .add_path(directory.path().to_owned());
        assert!(!event_is_relevant(&event));
    }

    #[test]
    fn real_filesystem_notifications_reconcile_create_modify_and_delete() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::in_memory().unwrap();
        let root = catalog::add_library_root(&state, dir.path().to_str().unwrap()).unwrap();
        let (sender, receiver) = mpsc::channel();
        let mut watcher = notify::recommended_watcher(move |event| {
            let _ = sender.send(event);
        })
        .unwrap();
        watcher.watch(dir.path(), RecursiveMode::Recursive).unwrap();
        let file = dir.path().join("live.jpg");
        let await_count = |count: usize, bytes: u64| {
            let deadline = Instant::now() + Duration::from_secs(5);
            while Instant::now() < deadline {
                if let Ok(Ok(event)) = receiver.recv_timeout(Duration::from_millis(100)) {
                    if event_is_relevant(&event) {
                        catalog::reconcile_changed_paths(&state, &root.id, &event.paths).unwrap();
                    }
                }
                let items = catalog::list_media_items(&state, None).unwrap();
                if items.len() == count && (count == 0 || items[0].byte_size == bytes) {
                    return;
                }
            }
            panic!("filesystem notification did not update the catalog in time");
        };
        std::fs::write(&file, b"one").unwrap();
        await_count(1, 3);
        std::fs::write(&file, b"updated").unwrap();
        await_count(1, 7);
        std::fs::remove_file(&file).unwrap();
        await_count(0, 0);
    }

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
                    recursive: true,
                },
            ),
            (
                "nested".to_owned(),
                WatchedRoot {
                    id: "nested".to_owned(),
                    path: nested.clone(),
                    recursive: true,
                },
            ),
            (
                "other".to_owned(),
                WatchedRoot {
                    id: "other".to_owned(),
                    path: PathBuf::from("library-other"),
                    recursive: true,
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
    fn debounce_has_a_bounded_latency_during_continuous_events() {
        let started_at = Instant::now();
        let watched_roots = [(
            "root".to_owned(),
            WatchedRoot {
                id: "root".to_owned(),
                path: PathBuf::from(r"C:\Library"),
                recursive: true,
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
            started_at + Duration::from_millis(100),
            false,
        );
        assert!(
            take_stable_root_changes(
                &mut pending,
                &watched_roots,
                started_at + Duration::from_millis(100)
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
        assert_eq!(change.changed_at, started_at);
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
                    recursive: true,
                },
            ),
            (
                "two".to_owned(),
                WatchedRoot {
                    id: "two".to_owned(),
                    path: PathBuf::from("two"),
                    recursive: true,
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
