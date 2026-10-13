//! Manual changes from the library browser: shift a subtitle by a fixed
//! offset, undo the last manual change, and list a folder's subtitles with
//! their sync state. Every change is pushed onto the undo stack first and the
//! sync cache is updated afterwards, so the next scan keeps the file as the
//! user left it instead of re-syncing it.

use std::path::{Component, Path, PathBuf};

use serde_json::{json, Value};

use crate::db::Db;
use crate::processor::{content_hash, Processor};
use crate::scanner::mtime_ms;
use crate::srt;

/// Largest manual shift accepted in one step.
pub const MAX_MANUAL_OFFSET_MS: i64 = 10 * 60 * 1000;

#[derive(Debug)]
pub enum ManualError {
    /// An engine is working on this file right now.
    Busy,
    Invalid(String),
    /// The file changed on disk since the change being undone.
    Changed,
    NothingToUndo,
    Io(std::io::Error),
    Db(sqlx::Error),
}

impl std::fmt::Display for ManualError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ManualError::Busy => write!(f, "This subtitle is being synced right now"),
            ManualError::Invalid(m) => write!(f, "{m}"),
            ManualError::Changed => {
                write!(f, "The subtitle changed on disk since that change, so it can't be undone safely")
            }
            ManualError::NothingToUndo => write!(f, "Nothing to undo for this subtitle"),
            ManualError::Io(e) => write!(f, "file error: {e}"),
            ManualError::Db(e) => write!(f, "database error: {e}"),
        }
    }
}

impl From<std::io::Error> for ManualError {
    fn from(e: std::io::Error) -> Self {
        ManualError::Io(e)
    }
}

impl From<sqlx::Error> for ManualError {
    fn from(e: sqlx::Error) -> Self {
        ManualError::Db(e)
    }
}

fn key(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// True when `p` is an absolute path inside one of `roots`, without `..`.
pub fn within_roots(p: &Path, roots: &[PathBuf]) -> bool {
    p.is_absolute()
        && !p.components().any(|c| matches!(c, Component::ParentDir))
        && roots.iter().any(|r| p.starts_with(r))
}

fn is_srt(p: &Path) -> bool {
    p.extension().is_some_and(|e| e.eq_ignore_ascii_case("srt"))
}

/// Record the file as written so the scan trusts it and leaves it alone.
async fn recache(db: &Db, path: &Path) -> Result<(), ManualError> {
    let m = std::fs::metadata(path)?;
    db.upsert_sync_cache(&[(key(path), mtime_ms(&m), m.len() as i64)]).await?;
    Ok(())
}

pub async fn apply_offset(p: &Processor, path: &Path, offset_ms: i64) -> Result<(), ManualError> {
    if offset_ms == 0 || offset_ms.abs() > MAX_MANUAL_OFFSET_MS {
        return Err(ManualError::Invalid(format!("offsetMs must be non-zero and within ±{MAX_MANUAL_OFFSET_MS}")));
    }
    if !p.claim_file(path) {
        return Err(ManualError::Busy);
    }
    let db = p.db();
    let before = std::fs::read(path)?;
    if !srt::has_cues(&before) {
        return Err(ManualError::Invalid("The subtitle has no parseable cues".into()));
    }
    let after = srt::shift_timestamps(&before, offset_ms);
    let k = key(path);
    let snapshot = db.quality(&k).await?;
    let id =
        db.push_backup(&k, &before, "offset", Some(offset_ms), snapshot.as_ref(), Some(&content_hash(&after))).await?;
    if let Err(e) = std::fs::write(path, &after) {
        db.delete_backup(id).await?;
        return Err(e.into());
    }
    db.add_manual_offset(&k, offset_ms).await?;
    recache(db, path).await?;
    tracing::info!("Manual offset {offset_ms:+}ms applied: {k}");
    Ok(())
}

/// Revert the most recent manual change. Returns the action undone.
pub async fn undo(p: &Processor, path: &Path) -> Result<String, ManualError> {
    if !p.claim_file(path) {
        return Err(ManualError::Busy);
    }
    let db = p.db();
    let k = key(path);
    let backup = db.latest_backup(&k).await?.ok_or(ManualError::NothingToUndo)?;
    if let Some(expected) = &backup.after_hash {
        let current = std::fs::read(path).ok().map(|c| content_hash(&c));
        if current.as_ref() != Some(expected) {
            return Err(ManualError::Changed);
        }
    }
    std::fs::write(path, &backup.content)?;
    db.restore_quality(&k, backup.quality.as_ref()).await?;
    db.delete_backup(backup.id).await?;
    recache(db, path).await?;
    tracing::info!("Undid manual {}: {k}", backup.action);
    Ok(backup.action)
}

/// Subtitles directly in `dir` (dotfiles skipped), with what the database
/// knows about each: synced (cache matches the file), quality, undo depth.
pub async fn list_dir(db: &Db, dir: &Path) -> Result<Vec<Value>, ManualError> {
    let d = dir.to_path_buf();
    let files = tokio::task::spawn_blocking(move || -> std::io::Result<Vec<(String, String, std::fs::Metadata)>> {
        let mut out = Vec::new();
        for e in std::fs::read_dir(&d)?.flatten() {
            let path = e.path();
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || !is_srt(&path) {
                continue;
            }
            if let Ok(m) = std::fs::metadata(&path) {
                if m.is_file() {
                    out.push((key(&path), name, m));
                }
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| ManualError::Io(std::io::Error::other(e)))??;

    let known = db.library_dir(&key(dir)).await?;
    let mut out: Vec<(String, Value)> = files
        .into_iter()
        .map(|(path, name, m)| {
            let entry = known.get(&path).cloned().unwrap_or_default();
            let synced =
                entry.cached.is_some_and(|(mt, size)| (mt - mtime_ms(&m)).abs() < 0.001 && size == m.len() as i64);
            let v = json!({
                "name": name,
                "filePath": path,
                "sizeBytes": m.len(),
                "synced": synced,
                "quality": entry.quality.map(|q| q.to_json()),
                "undoSteps": entry.backups,
            });
            (name, v)
        })
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out.into_iter().map(|(_, v)| v).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roots() {
        let roots = vec![PathBuf::from("/media/tv"), PathBuf::from("/movies")];
        assert!(within_roots(Path::new("/media/tv/Show/a.srt"), &roots));
        assert!(within_roots(Path::new("/movies"), &roots));
        assert!(!within_roots(Path::new("/media/tvx/a.srt"), &roots));
        assert!(!within_roots(Path::new("/media/tv/../etc/passwd"), &roots));
        assert!(!within_roots(Path::new("media/tv/a.srt"), &roots));
    }
}
