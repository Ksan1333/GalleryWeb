//! Bounded caches containing only derived archive images, never source books.
use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs::{self, File, FileTimes},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant, SystemTime},
};

pub const PAGE_CACHE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub const COVER_CACHE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_AGE: Duration = Duration::from_secs(30 * 24 * 60 * 60);
const MAX_PAGE_FILES: usize = 20_000;
const MAX_COVER_FILES: usize = 4_000;

#[derive(Clone, Copy)]
pub enum Kind {
    Pages,
    Covers,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Self::Pages => "book-pages",
            Self::Covers => "book-covers",
        }
    }
    fn limits(self) -> (u64, usize, usize) {
        match self {
            Self::Pages => (PAGE_CACHE_BYTES, MAX_PAGE_FILES, 32),
            Self::Covers => (COVER_CACHE_BYTES, MAX_COVER_FILES, 8),
        }
    }
}

#[derive(Clone)]
struct Entry {
    bytes: u64,
    accessed: SystemTime,
}

#[derive(Default)]
struct Cache {
    root: PathBuf,
    entries: HashMap<PathBuf, Entry>,
    recent: VecDeque<PathBuf>,
    total_bytes: u64,
    generations: HashMap<String, String>,
    last_sweep: Option<Instant>,
}

static PAGES: OnceLock<Mutex<Cache>> = OnceLock::new();
static COVERS: OnceLock<Mutex<Cache>> = OnceLock::new();

fn safe_component(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn managed_file(root: &Path, path: &Path) -> bool {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    if !metadata.is_file() || metadata.is_symlink() {
        return false;
    }
    // Canonical containment also rejects Windows junctions/reparse directories.
    path.canonicalize()
        .is_ok_and(|resolved| resolved.starts_with(root))
}

impl Cache {
    fn open(root: &Path) -> Result<Self, String> {
        fs::create_dir_all(root).map_err(|error| format!("Cannot create book cache: {error}"))?;
        if fs::symlink_metadata(root)
            .map_err(|error| error.to_string())?
            .is_symlink()
        {
            return Err("Book cache directory must not be a symbolic link".to_owned());
        }
        let root = root.canonicalize().map_err(|error| error.to_string())?;
        let mut cache = Self {
            root,
            ..Self::default()
        };
        let mut files = Vec::new();
        for entry in fs::read_dir(&cache.root)
            .map_err(|error| error.to_string())?
            .flatten()
        {
            let path = entry.path();
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_symlink() {
                continue;
            }
            if kind.is_file() {
                files.push(path);
            } else if kind.is_dir()
                && path
                    .canonicalize()
                    .is_ok_and(|resolved| resolved.starts_with(&cache.root))
            {
                if let Ok(children) = fs::read_dir(path) {
                    files.extend(children.flatten().map(|child| child.path()));
                }
            }
        }
        for path in files {
            if managed_file(&cache.root, &path) {
                if let Ok(metadata) = path.metadata() {
                    cache.entries.insert(
                        path,
                        Entry {
                            bytes: metadata.len(),
                            accessed: metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                        },
                    );
                    cache.total_bytes += metadata.len();
                }
            }
        }
        Ok(cache)
    }

    fn bytes(&self) -> u64 {
        self.total_bytes
    }

    fn touch(&mut self, paths: &[PathBuf], recent_limit: usize) {
        let now = SystemTime::now();
        for path in paths {
            if !managed_file(&self.root, path) {
                continue;
            }
            let Ok(metadata) = path.metadata() else {
                continue;
            };
            let previous = self.entries.insert(
                path.clone(),
                Entry {
                    bytes: metadata.len(),
                    accessed: now,
                },
            );
            self.total_bytes = self
                .total_bytes
                .saturating_sub(previous.map_or(0, |entry| entry.bytes))
                + metadata.len();
            self.recent.retain(|candidate| candidate != path);
            self.recent.push_back(path.clone());
            // Persist recency for the next launch; no payload rewriting.
            if let Ok(file) = File::options().write(true).open(path) {
                let _ = file.set_times(FileTimes::new().set_modified(now));
            }
        }
        while self.recent.len() > recent_limit {
            self.recent.pop_front();
        }
    }

    fn remove(&mut self, path: &Path) -> bool {
        // Never recursively delete: only indexed regular derived files inside
        // the canonical cache root, followed by their now-empty directory.
        if fs::symlink_metadata(path)
            .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
        {
            if let Some(entry) = self.entries.remove(path) {
                self.total_bytes = self.total_bytes.saturating_sub(entry.bytes);
            }
            self.recent.retain(|candidate| candidate != path);
            return true;
        }
        if !managed_file(&self.root, path) {
            return false;
        }
        if fs::remove_file(path).is_err() {
            return false;
        }
        if let Some(entry) = self.entries.remove(path) {
            self.total_bytes = self.total_bytes.saturating_sub(entry.bytes);
        }
        self.recent.retain(|candidate| candidate != path);
        if let Some(parent) = path.parent().filter(|parent| *parent != self.root) {
            let _ = fs::remove_dir(parent);
        }
        true
    }

    fn prune(&mut self, max_bytes: u64, max_files: usize, stale_prefix: Option<(&str, &Path)>) {
        self.last_sweep = Some(Instant::now());
        let protected: HashSet<PathBuf> = self.recent.iter().cloned().collect();
        let now = SystemTime::now();
        let mut ordered: Vec<_> = self
            .entries
            .iter()
            .map(|(path, entry)| (path.clone(), entry.clone()))
            .collect();
        ordered.sort_by_key(|(_, entry)| entry.accessed);
        let mut bytes = self.bytes();
        for (path, entry) in ordered {
            if protected.contains(&path) {
                continue;
            }
            let stale = stale_prefix.is_some_and(|(prefix, current)| {
                let relative = path.strip_prefix(&self.root).unwrap_or(&path);
                let first = relative
                    .components()
                    .next()
                    .map(|part| part.as_os_str().to_string_lossy());
                first.is_some_and(|name| name.starts_with(prefix)) && !path.starts_with(current)
            });
            let expired = now
                .duration_since(entry.accessed)
                .is_ok_and(|age| age > MAX_AGE);
            if (stale || expired || bytes > max_bytes || self.entries.len() > max_files)
                && self.remove(&path)
            {
                bytes = bytes.saturating_sub(entry.bytes);
            }
        }
    }
}

/// Serialize extraction with eviction. Recent returned pages (32, at most
/// 1.25 GiB) cover the viewer's 17-page window and in-flight asset requests.
/// Callers revalidate paths when revisiting a page; old URLs are not permanent.
pub fn with_directory<T>(
    data_root: &Path,
    kind: Kind,
    media_key: &str,
    generation: &str,
    operation: impl FnOnce(&Path) -> Result<(T, Vec<PathBuf>), String>,
) -> Result<T, String> {
    if !safe_component(media_key) || !safe_component(generation) {
        return Err("Invalid book cache key".to_owned());
    }
    let root = data_root.join(kind.name());
    let mut cache = match kind {
        Kind::Pages => &PAGES,
        Kind::Covers => &COVERS,
    }
    .get_or_init(|| Mutex::new(Cache::default()))
    .lock()
    .map_err(|_| "Book cache lock is poisoned".to_owned())?;
    let canonical = root.canonicalize().ok();
    if canonical.as_ref() != Some(&cache.root) {
        *cache = Cache::open(&root)?;
    }
    let canonical_data_root = data_root
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if cache.root.parent() != Some(canonical_data_root.as_path()) {
        return Err("Book cache root must stay inside application data".to_owned());
    }
    let directory = cache.root.join(generation);
    let prefix = format!("{media_key}-");
    let (max_bytes, max_files, recent_limit) = kind.limits();
    let generation_changed = cache
        .generations
        .get(media_key)
        .is_none_or(|value| value != generation);
    if generation_changed
        || cache
            .last_sweep
            .is_none_or(|sweep| sweep.elapsed() > Duration::from_secs(300))
        || cache.bytes() > max_bytes
        || cache.entries.len() > max_files
    {
        cache.prune(max_bytes, max_files, Some((&prefix, &directory)));
    }
    cache
        .generations
        .insert(media_key.to_owned(), generation.to_owned());
    if cache.bytes() > max_bytes || cache.entries.len() > max_files {
        return Err("Book cache is full and its old files could not be removed".to_owned());
    }
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    if !directory
        .canonicalize()
        .is_ok_and(|path| path.starts_with(&cache.root))
    {
        return Err("Book cache directory is outside its managed root".to_owned());
    }
    let result = operation(&directory);
    // Index partial writes too, so failed extraction cannot bypass the quota.
    let known_paths: Vec<_> = match &result {
        Ok((_, paths)) => paths.clone(),
        Err(_) => fs::read_dir(&directory)
            .map_err(|error| error.to_string())?
            .flatten()
            .map(|entry| entry.path())
            .collect(),
    };
    for path in &known_paths {
        if !cache.entries.contains_key(path) && managed_file(&cache.root, path) {
            if let Ok(metadata) = path.metadata() {
                cache.entries.insert(
                    path.clone(),
                    Entry {
                        bytes: metadata.len(),
                        accessed: SystemTime::now(),
                    },
                );
                cache.total_bytes += metadata.len();
            }
        }
    }
    if let Ok((_, paths)) = &result {
        cache.touch(paths, recent_limit);
    }
    if generation_changed || cache.bytes() > max_bytes || cache.entries.len() > max_files {
        cache.prune(max_bytes, max_files, Some((&prefix, &directory)));
    }
    result.map(|(value, _)| value)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("pixvault-book-cache-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        root
    }
    fn page(root: &Path, name: &str, bytes: usize) -> PathBuf {
        let path = root.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, vec![1; bytes]).unwrap();
        path
    }
    #[test]
    fn quota_evicts_unprotected_lru_and_preserves_sources() {
        let root = fixture();
        let original = page(&root, "original.zip", 100);
        let managed = root.join("book-pages");
        let old = page(&managed, "book-1/000000.png", 40);
        let active = page(&managed, "book-2/000001.png", 40);
        let mut cache = Cache::open(&managed).unwrap();
        let active = active.canonicalize().unwrap();
        cache.touch(&[active.clone()], 32);
        cache.prune(40, 10, None);
        assert!(!old.exists());
        assert!(active.exists());
        assert!(original.exists());
        assert_eq!(cache.bytes(), 40);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn old_generations_retire_after_the_recent_window_moves_on() {
        let root = fixture();
        let old = page(&root, "book-1-10/000000.png", 3);
        let current = page(&root, "book-2-10/000000.png", 3);
        let other = page(&root, "other-1-10/000000.png", 3);
        let mut cache = Cache::open(&root).unwrap();
        let old = old.canonicalize().unwrap();
        let current = current.canonicalize().unwrap();
        let current_dir = current.parent().unwrap();
        cache.touch(&[old.clone()], 1);
        cache.prune(100, 10, Some(("book-", current_dir)));
        assert!(old.exists());
        cache.touch(&[current.clone()], 1);
        cache.prune(100, 10, Some(("book-", current_dir)));
        assert!(!old.exists());
        assert!(current.exists());
        assert!(other.exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn age_and_file_count_apply_independently_of_byte_limit() {
        let root = fixture();
        let ancient = page(&root, "book-1/000000.png", 1).canonicalize().unwrap();
        let active = page(&root, "book-1/000001.png", 1).canonicalize().unwrap();
        let mut cache = Cache::open(&root).unwrap();
        cache.entries.get_mut(&ancient).unwrap().accessed = SystemTime::UNIX_EPOCH;
        cache.touch(&[active.clone()], 1);
        cache.prune(100, 1, None);
        assert!(!ancient.exists());
        assert!(active.exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn rejects_path_components_and_never_indexes_outside_files() {
        assert!(!safe_component("../source"));
        assert!(!safe_component("C:\\source"));
        assert!(safe_component("abc_123-100-200"));
        let root = fixture();
        let outside = page(&root, "source.png", 1);
        let managed = root.join("book-pages");
        fs::create_dir_all(&managed).unwrap();
        let canonical = managed.canonicalize().unwrap();
        assert!(!managed_file(&canonical, &outside));
        fs::remove_dir_all(root).unwrap();
    }
}
