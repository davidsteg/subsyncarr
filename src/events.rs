//! Live-update fan-out. Producers send small events; one batcher task
//! coalesces them every 100 ms (collapsing repeated `file:updated` /
//! `scan:progress` to the latest), serializes the batch once, and broadcasts
//! the same `Arc<str>` to every WebSocket client.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::{broadcast, mpsc};

use crate::db::Db;
use crate::models::{Run, ScanProgress};

#[derive(Debug, Clone)]
pub enum Event {
    RunStarted(Run),
    RunCompleted(Run),
    RunCancelled(Run),
    FileUpdated { run_id: String, file_path: String },
    ScanProgress(Option<ScanProgress>),
}

#[derive(Clone)]
pub struct EventBus {
    tx: mpsc::UnboundedSender<Event>,
    out: broadcast::Sender<Arc<str>>,
    /// Completed runs, for in-process listeners (notifications, media refresh).
    runs: broadcast::Sender<Run>,
    /// Bumped whenever a run finishes, so caches of aggregate stats know to refresh.
    generation: Arc<AtomicU64>,
}

impl EventBus {
    pub fn new(db: Db) -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        let (out, _) = broadcast::channel(256);
        let (runs, _) = broadcast::channel(16);
        tokio::spawn(batcher(rx, out.clone(), db));
        EventBus { tx, out, runs, generation: Arc::new(AtomicU64::new(0)) }
    }

    pub fn send(&self, e: Event) {
        if matches!(e, Event::RunCompleted(_) | Event::RunCancelled(_)) {
            self.generation.fetch_add(1, Ordering::Relaxed);
        }
        if let Event::RunCompleted(r) = &e {
            let _ = self.runs.send(r.clone());
        }
        let _ = self.tx.send(e);
    }

    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::Relaxed)
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Arc<str>> {
        self.out.subscribe()
    }

    pub fn subscribe_runs(&self) -> broadcast::Receiver<Run> {
        self.runs.subscribe()
    }

    pub fn client_count(&self) -> usize {
        self.out.receiver_count()
    }
}

async fn batcher(mut rx: mpsc::UnboundedReceiver<Event>, out: broadcast::Sender<Arc<str>>, db: Db) {
    while let Some(first) = rx.recv().await {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let mut events = vec![first];
        while let Ok(e) = rx.try_recv() {
            events.push(e);
        }
        if out.receiver_count() == 0 {
            continue;
        }
        let mut messages: Vec<Value> = Vec::new();
        let mut last_file: Option<(String, String)> = None;
        let mut last_scan: Option<Option<ScanProgress>> = None;
        for e in events {
            match e {
                Event::RunStarted(r) => messages.push(json!({"type": "run:started", "data": r})),
                Event::RunCompleted(r) => messages.push(json!({"type": "run:completed", "data": r})),
                Event::RunCancelled(r) => messages.push(json!({"type": "run:cancelled", "data": r})),
                Event::FileUpdated { run_id, file_path } => last_file = Some((run_id, file_path)),
                Event::ScanProgress(p) => last_scan = Some(p),
            }
        }
        if let Some(p) = last_scan {
            messages.push(json!({"type": "scan:progress", "data": p}));
        }
        if let Some((run_id, file_path)) = last_file {
            // One run snapshot per flush instead of one DB read per event.
            if let Ok(Some(run)) = db.get_run(&run_id).await {
                messages.push(
                    json!({"type": "file:updated", "data": {"runId": run_id, "filePath": file_path, "run": run}}),
                );
            }
        }
        if messages.is_empty() {
            continue;
        }
        let payload: Arc<str> = json!({"type": "batch", "messages": messages}).to_string().into();
        let _ = out.send(payload);
    }
}
