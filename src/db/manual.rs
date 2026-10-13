//! Sync quality per subtitle, and the undo stack behind manual re-sync and
//! offset changes from the library browser.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::Row;

use super::{prefix_upper, Db};
use crate::now_ms;
use crate::quality::{Quality, WEAK_BELOW};

/// Undo steps kept per file.
pub const BACKUPS_PER_FILE: i64 = 10;

/// One `sync_quality` row. Also stored as JSON inside a backup, so undo can
/// put the quality back exactly as it was.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, sqlx::FromRow)]
pub struct QualityRecord {
    pub score: Option<i64>,
    pub level: Option<String>,
    pub details: Option<String>,
    /// `run`, `resync` or `offset`: what produced the current file.
    pub source: String,
    pub manual_offset_ms: i64,
    pub reviewed: bool,
    pub updated_at: i64,
}

impl QualityRecord {
    pub fn needs_review(&self) -> bool {
        !self.reviewed && self.score.is_some_and(|s| s < WEAK_BELOW)
    }

    pub fn to_json(&self) -> Value {
        let details: Value = self.details.as_deref().and_then(|d| serde_json::from_str(d).ok()).unwrap_or(Value::Null);
        json!({
            "score": self.score,
            "level": self.level,
            "details": details,
            "source": self.source,
            "manualOffsetMs": self.manual_offset_ms,
            "reviewed": self.reviewed,
            "needsReview": self.needs_review(),
            "updatedAt": self.updated_at,
        })
    }
}

#[derive(Debug, Clone)]
pub struct Backup {
    pub id: i64,
    pub content: Vec<u8>,
    pub action: String,
    pub offset_ms: Option<i64>,
    pub quality: Option<QualityRecord>,
    /// Hash of the file as the action left it; undo refuses when the file
    /// has changed since.
    pub after_hash: Option<String>,
}

/// What the database knows about one subtitle in a library folder.
#[derive(Debug, Clone, Default)]
pub struct LibraryEntry {
    pub cached: Option<(f64, i64)>,
    pub quality: Option<QualityRecord>,
    pub backups: i64,
}

const QUALITY_COLS: &str = "score, level, details, source, manual_offset_ms, reviewed, updated_at";

impl Db {
    pub async fn upsert_quality(&self, path: &str, q: &Quality, source: &str) -> sqlx::Result<()> {
        sqlx::query(
            "INSERT INTO sync_quality (file_path, score, level, details, source, manual_offset_ms, reviewed, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 0, 0, ?6)
             ON CONFLICT(file_path) DO UPDATE SET score = ?2, level = ?3, details = ?4, source = ?5,
                 manual_offset_ms = 0, reviewed = 0, updated_at = ?6",
        )
        .bind(path)
        .bind(q.score)
        .bind(q.level.as_str())
        .bind(serde_json::to_string(q).unwrap_or_default())
        .bind(source)
        .bind(now_ms())
        .execute(self.pool())
        .await?;
        Ok(())
    }

    pub async fn quality(&self, path: &str) -> sqlx::Result<Option<QualityRecord>> {
        sqlx::query_as(&format!("SELECT {QUALITY_COLS} FROM sync_quality WHERE file_path = ?"))
            .bind(path)
            .fetch_optional(self.pool())
            .await
    }

    /// Put a quality row back as it was (None = there was none).
    pub async fn restore_quality(&self, path: &str, q: Option<&QualityRecord>) -> sqlx::Result<()> {
        let Some(q) = q else {
            sqlx::query("DELETE FROM sync_quality WHERE file_path = ?").bind(path).execute(self.pool()).await?;
            return Ok(());
        };
        sqlx::query(
            "INSERT OR REPLACE INTO sync_quality
                 (file_path, score, level, details, source, manual_offset_ms, reviewed, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(path)
        .bind(q.score)
        .bind(&q.level)
        .bind(&q.details)
        .bind(&q.source)
        .bind(q.manual_offset_ms)
        .bind(q.reviewed)
        .bind(q.updated_at)
        .execute(self.pool())
        .await?;
        Ok(())
    }

    /// A manual offset counts as a review: someone looked and adjusted it.
    pub async fn add_manual_offset(&self, path: &str, offset_ms: i64) -> sqlx::Result<()> {
        sqlx::query(
            "INSERT INTO sync_quality (file_path, source, manual_offset_ms, reviewed, updated_at)
             VALUES (?1, 'offset', ?2, 1, ?3)
             ON CONFLICT(file_path) DO UPDATE SET source = 'offset', manual_offset_ms = manual_offset_ms + ?2,
                 reviewed = 1, updated_at = ?3",
        )
        .bind(path)
        .bind(offset_ms)
        .bind(now_ms())
        .execute(self.pool())
        .await?;
        Ok(())
    }

    /// Returns false when the file has no quality row.
    pub async fn set_reviewed(&self, path: &str, reviewed: bool) -> sqlx::Result<bool> {
        let r = sqlx::query("UPDATE sync_quality SET reviewed = ? WHERE file_path = ?")
            .bind(reviewed)
            .bind(path)
            .execute(self.pool())
            .await?;
        Ok(r.rows_affected() > 0)
    }

    /// Weak syncs nobody has reviewed yet, weakest first.
    pub async fn review_queue(&self, limit: i64) -> sqlx::Result<(i64, Vec<Value>)> {
        let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_quality WHERE reviewed = 0 AND score < ?")
            .bind(WEAK_BELOW)
            .fetch_one(self.pool())
            .await?;
        let rows = sqlx::query(&format!(
            "SELECT file_path, {QUALITY_COLS} FROM sync_quality WHERE reviewed = 0 AND score < ?
             ORDER BY score ASC, updated_at DESC LIMIT ?"
        ))
        .bind(WEAK_BELOW)
        .bind(limit)
        .fetch_all(self.pool())
        .await?;
        let mut out = Vec::with_capacity(rows.len());
        for r in rows {
            let path: String = r.get("file_path");
            let q = <QualityRecord as sqlx::FromRow<_>>::from_row(&r)?;
            out.push(json!({ "filePath": path, "quality": q.to_json() }));
        }
        Ok((total, out))
    }

    pub async fn push_backup(
        &self,
        path: &str,
        content: &[u8],
        action: &str,
        offset_ms: Option<i64>,
        quality: Option<&QualityRecord>,
        after_hash: Option<&str>,
    ) -> sqlx::Result<i64> {
        let mut tx = self.pool().begin().await?;
        let id: i64 = sqlx::query_scalar(
            "INSERT INTO subtitle_backups (file_path, content, action, offset_ms, quality, after_hash, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
        )
        .bind(path)
        .bind(content)
        .bind(action)
        .bind(offset_ms)
        .bind(quality.map(|q| serde_json::to_string(q).unwrap_or_default()))
        .bind(after_hash)
        .bind(now_ms())
        .fetch_one(&mut *tx)
        .await?;
        sqlx::query(
            "DELETE FROM subtitle_backups WHERE file_path = ?1 AND id NOT IN
                 (SELECT id FROM subtitle_backups WHERE file_path = ?1 ORDER BY id DESC LIMIT ?2)",
        )
        .bind(path)
        .bind(BACKUPS_PER_FILE)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(id)
    }

    pub async fn set_backup_after_hash(&self, id: i64, hash: &str) -> sqlx::Result<()> {
        sqlx::query("UPDATE subtitle_backups SET after_hash = ? WHERE id = ?")
            .bind(hash)
            .bind(id)
            .execute(self.pool())
            .await?;
        Ok(())
    }

    pub async fn delete_backup(&self, id: i64) -> sqlx::Result<()> {
        sqlx::query("DELETE FROM subtitle_backups WHERE id = ?").bind(id).execute(self.pool()).await?;
        Ok(())
    }

    pub async fn latest_backup(&self, path: &str) -> sqlx::Result<Option<Backup>> {
        let row = sqlx::query(
            "SELECT id, content, action, offset_ms, quality, after_hash FROM subtitle_backups
             WHERE file_path = ? ORDER BY id DESC LIMIT 1",
        )
        .bind(path)
        .fetch_optional(self.pool())
        .await?;
        Ok(row.map(|r| Backup {
            id: r.get("id"),
            content: r.get("content"),
            action: r.get("action"),
            offset_ms: r.get("offset_ms"),
            quality: r.get::<Option<String>, _>("quality").and_then(|q| serde_json::from_str(&q).ok()),
            after_hash: r.get("after_hash"),
        }))
    }

    /// Undo steps for the media drawer, newest first (no content).
    pub async fn backup_list(&self, path: &str) -> sqlx::Result<Vec<Value>> {
        let rows = sqlx::query(
            "SELECT action, offset_ms, created_at FROM subtitle_backups WHERE file_path = ? ORDER BY id DESC",
        )
        .bind(path)
        .fetch_all(self.pool())
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| {
                json!({
                    "action": r.get::<String, _>("action"),
                    "offsetMs": r.get::<Option<i64>, _>("offset_ms"),
                    "createdAt": r.get::<i64, _>("created_at"),
                })
            })
            .collect())
    }

    /// Mark the current content as known, without the reset that
    /// `refresh_fingerprint` does for a replaced file.
    pub async fn set_fingerprint(&self, path: &str, hash: &str) -> sqlx::Result<()> {
        sqlx::query(
            "INSERT INTO file_fingerprints (file_path, content_hash, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(file_path) DO UPDATE SET content_hash = ?2, updated_at = ?3",
        )
        .bind(path)
        .bind(hash)
        .bind(now_ms())
        .execute(self.pool())
        .await?;
        Ok(())
    }

    /// The subtitle is gone: its quality and undo history go with it.
    pub async fn forget_file(&self, path: &str) -> sqlx::Result<()> {
        let mut tx = self.pool().begin().await?;
        sqlx::query("DELETE FROM sync_quality WHERE file_path = ?").bind(path).execute(&mut *tx).await?;
        sqlx::query("DELETE FROM subtitle_backups WHERE file_path = ?").bind(path).execute(&mut *tx).await?;
        tx.commit().await
    }

    /// Sync cache, quality and undo depth for the subtitles directly in `dir`.
    pub async fn library_dir(&self, dir: &str) -> sqlx::Result<HashMap<String, LibraryEntry>> {
        let lo = format!("{}/", dir.trim_end_matches('/'));
        let hi = prefix_upper(&lo);
        let direct = |p: &str| p.strip_prefix(&lo).is_some_and(|rest| !rest.contains('/'));
        let mut out: HashMap<String, LibraryEntry> = HashMap::new();

        let rows = sqlx::query(
            "SELECT file_path, mtime_ms, size_bytes FROM synced_files WHERE file_path >= ? AND file_path < ?",
        )
        .bind(&lo)
        .bind(&hi)
        .fetch_all(self.pool())
        .await?;
        for r in rows {
            let p: String = r.get("file_path");
            if let (true, Some(m), Some(s)) = (direct(&p), r.get::<Option<f64>, _>("mtime_ms"), r.get("size_bytes")) {
                out.entry(p).or_default().cached = Some((m, s));
            }
        }
        let rows = sqlx::query(&format!(
            "SELECT file_path, {QUALITY_COLS} FROM sync_quality WHERE file_path >= ? AND file_path < ?"
        ))
        .bind(&lo)
        .bind(&hi)
        .fetch_all(self.pool())
        .await?;
        for r in rows {
            let p: String = r.get("file_path");
            if direct(&p) {
                out.entry(p).or_default().quality = Some(<QualityRecord as sqlx::FromRow<_>>::from_row(&r)?);
            }
        }
        let rows = sqlx::query(
            "SELECT file_path, COUNT(*) AS n FROM subtitle_backups WHERE file_path >= ? AND file_path < ? GROUP BY file_path",
        )
        .bind(&lo)
        .bind(&hi)
        .fetch_all(self.pool())
        .await?;
        for r in rows {
            let p: String = r.get("file_path");
            if direct(&p) {
                out.entry(p).or_default().backups = r.get("n");
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quality::{self, Input};

    fn q(score_alignments: &[(String, i64)]) -> Quality {
        quality::score(&Input {
            alignments: score_alignments,
            agreement_threshold_ms: 5000,
            mismatch_reports: 0,
            cue_offsets: &[0; 30],
            cues: 30,
            max_shift_ms: 60_000,
            framerate_scaled: false,
        })
    }

    #[tokio::test]
    async fn quality_and_review_queue() {
        let db = Db::open_memory().await.unwrap();
        let weak = q(&[("alass".into(), 0), ("ffsubsync".into(), 5000)]);
        assert!(weak.score >= WEAK_BELOW);
        db.upsert_quality("/m/a.srt", &weak, "run").await.unwrap();
        let mut w = weak.clone();
        w.score = 20;
        db.upsert_quality("/m/b.srt", &w, "run").await.unwrap();
        let (total, list) = db.review_queue(10).await.unwrap();
        assert_eq!(total, 1);
        assert_eq!(list[0]["filePath"], "/m/b.srt");
        assert_eq!(list[0]["quality"]["needsReview"], true);

        assert!(db.set_reviewed("/m/b.srt", true).await.unwrap());
        assert_eq!(db.review_queue(10).await.unwrap().0, 0);
        assert!(!db.set_reviewed("/m/none.srt", true).await.unwrap());

        db.add_manual_offset("/m/a.srt", 250).await.unwrap();
        db.add_manual_offset("/m/a.srt", -100).await.unwrap();
        let rec = db.quality("/m/a.srt").await.unwrap().unwrap();
        assert_eq!(rec.manual_offset_ms, 150);
        assert_eq!(rec.score, Some(weak.score));
        assert!(rec.reviewed);
        assert_eq!(rec.source, "offset");
    }

    #[tokio::test]
    async fn backups_stack_and_prune() {
        let db = Db::open_memory().await.unwrap();
        db.add_manual_offset("/m/a.srt", 100).await.unwrap();
        let snap = db.quality("/m/a.srt").await.unwrap();
        for i in 0..12 {
            db.push_backup("/m/a.srt", format!("v{i}").as_bytes(), "offset", Some(100), snap.as_ref(), None)
                .await
                .unwrap();
        }
        assert_eq!(db.backup_list("/m/a.srt").await.unwrap().len(), BACKUPS_PER_FILE as usize);
        let top = db.latest_backup("/m/a.srt").await.unwrap().unwrap();
        assert_eq!(top.content, b"v11");
        assert_eq!(top.quality, snap);
        db.delete_backup(top.id).await.unwrap();
        assert_eq!(db.latest_backup("/m/a.srt").await.unwrap().unwrap().content, b"v10");

        db.restore_quality("/m/a.srt", None).await.unwrap();
        assert!(db.quality("/m/a.srt").await.unwrap().is_none());
        db.restore_quality("/m/a.srt", snap.as_ref()).await.unwrap();
        assert_eq!(db.quality("/m/a.srt").await.unwrap(), snap);

        let dir = db.library_dir("/m").await.unwrap();
        assert_eq!(dir["/m/a.srt"].backups, 9);
        assert!(db.library_dir("/").await.unwrap().is_empty());

        db.forget_file("/m/a.srt").await.unwrap();
        assert!(db.latest_backup("/m/a.srt").await.unwrap().is_none());
        assert!(db.quality("/m/a.srt").await.unwrap().is_none());
    }
}
