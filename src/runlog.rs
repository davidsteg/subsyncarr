//! Per-run processing logs, one file per run under `<db dir>/logs/<id>.log`.
//! Lines are buffered and flushed by a background task (or every 100 lines)
//! so a busy run doesn't issue one write syscall per log line.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

/// Run id plus its buffered, not yet flushed lines.
type Pending = Option<(String, Vec<String>)>;

#[derive(Clone)]
pub struct RunLogs {
    dir: PathBuf,
    current: Arc<Mutex<Pending>>,
}

impl RunLogs {
    pub fn new(dir: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&dir);
        let logs = RunLogs { dir, current: Arc::new(Mutex::new(None)) };
        let flusher = logs.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(2));
            loop {
                tick.tick().await;
                flusher.flush();
            }
        });
        logs
    }

    pub fn path(&self, run_id: &str) -> PathBuf {
        // Run ids are UUIDs; reject anything that could escape the directory.
        let safe: String = run_id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
        self.dir.join(format!("{safe}.log"))
    }

    pub fn start(&self, run_id: &str) {
        self.flush();
        *self.current.lock().unwrap() = Some((run_id.to_string(), Vec::new()));
    }

    pub fn append(&self, line: String) {
        let full = {
            let mut g = self.current.lock().unwrap();
            match g.as_mut() {
                Some((_, buf)) => {
                    buf.push(line);
                    buf.len() >= 100
                }
                None => false,
            }
        };
        if full {
            self.flush();
        }
    }

    pub fn flush(&self) {
        let (id, lines) = {
            let mut g = self.current.lock().unwrap();
            match g.as_mut() {
                Some((id, buf)) if !buf.is_empty() => (id.clone(), std::mem::take(buf)),
                _ => return,
            }
        };
        let path = self.path(&id);
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            let mut out = lines.join("\n");
            out.push('\n');
            if let Err(e) = f.write_all(out.as_bytes()) {
                tracing::error!("Error writing run log {}: {e}", path.display());
            }
        }
    }

    pub fn end(&self) {
        self.flush();
        *self.current.lock().unwrap() = None;
    }

    pub fn read(&self, run_id: &str) -> String {
        if self.current.lock().unwrap().as_ref().is_some_and(|(id, _)| id == run_id) {
            self.flush();
        }
        std::fs::read_to_string(self.path(run_id)).unwrap_or_default()
    }

    pub fn delete_older_than(&self, days: i64) -> usize {
        delete_old_logs(&self.dir, days)
    }
}

fn delete_old_logs(dir: &Path, days: i64) -> usize {
    let max_age = Duration::from_secs((days.max(0) as u64) * 86_400);
    let now = SystemTime::now();
    let mut n = 0;
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().is_some_and(|x| x == "log") {
                let old = e
                    .metadata()
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|m| now.duration_since(m).ok())
                    .is_some_and(|age| age > max_age);
                if old && std::fs::remove_file(&p).is_ok() {
                    n += 1;
                }
            }
        }
    }
    n
}
