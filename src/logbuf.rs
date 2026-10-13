//! In-memory ring buffer of everything the server logs (startup, requests,
//! cleanup, errors), exposed at `GET /api/logs` for remote debugging without
//! pulling container stdout. Implemented as a `tracing` layer.

use std::collections::VecDeque;
use std::fmt::Write as _;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tracing::field::{Field, Visit};
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::layer::Context;
use tracing_subscriber::Layer;

#[derive(Debug, Clone, Serialize)]
pub struct LogEntry {
    pub seq: u64,
    pub timestamp: i64,
    pub level: &'static str,
    pub message: String,
}

struct Inner {
    entries: VecDeque<LogEntry>,
    seq: u64,
    max: usize,
}

#[derive(Clone)]
pub struct LogBuffer {
    inner: Arc<Mutex<Inner>>,
}

pub struct Query<'a> {
    pub limit: usize,
    pub level: Option<&'a str>,
    pub search: Option<&'a str>,
    pub since: Option<u64>,
}

impl LogBuffer {
    pub fn new(max: usize) -> Self {
        LogBuffer {
            inner: Arc::new(Mutex::new(Inner { entries: VecDeque::with_capacity(max.min(8192)), seq: 0, max })),
        }
    }

    pub fn push(&self, level: &'static str, message: String) {
        let mut g = self.inner.lock().unwrap();
        g.seq += 1;
        let seq = g.seq;
        g.entries.push_back(LogEntry { seq, timestamp: crate::now_ms(), level, message });
        while g.entries.len() > g.max {
            g.entries.pop_front();
        }
    }

    pub fn query(&self, q: &Query) -> Vec<LogEntry> {
        let g = self.inner.lock().unwrap();
        let search = q.search.map(str::to_lowercase);
        let mut out: Vec<LogEntry> = g
            .entries
            .iter()
            .filter(|e| q.since.map_or(true, |s| e.seq > s))
            .filter(|e| q.level.map_or(true, |l| l == "all" || e.level == l))
            .filter(|e| search.as_ref().map_or(true, |s| e.message.to_lowercase().contains(s)))
            .cloned()
            .collect();
        if out.len() > q.limit {
            out.drain(..out.len() - q.limit);
        }
        out
    }

    pub fn info(&self) -> (usize, usize, u64) {
        let g = self.inner.lock().unwrap();
        (g.entries.len(), g.max, g.seq)
    }
}

struct MessageVisitor(String);

impl Visit for MessageVisitor {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            let _ = write!(self.0, "{value:?}");
        } else {
            let _ = write!(self.0, " {}={value:?}", field.name());
        }
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.0.push_str(value);
        } else {
            let _ = write!(self.0, " {}={value}", field.name());
        }
    }
}

impl<S: Subscriber> Layer<S> for LogBuffer {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let level = match *event.metadata().level() {
            Level::ERROR => "error",
            Level::WARN => "warn",
            Level::INFO => "log",
            _ => return,
        };
        if !event.metadata().target().starts_with("subsyncarr") {
            return;
        }
        let mut v = MessageVisitor(String::new());
        event.record(&mut v);
        self.push(level, v.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_and_filters() {
        let b = LogBuffer::new(3);
        for i in 0..5 {
            b.push(if i % 2 == 0 { "log" } else { "warn" }, format!("msg {i}"));
        }
        let all = b.query(&Query { limit: 10, level: None, search: None, since: None });
        assert_eq!(all.iter().map(|e| e.seq).collect::<Vec<_>>(), vec![3, 4, 5]);
        let warns = b.query(&Query { limit: 10, level: Some("warn"), search: None, since: None });
        assert_eq!(warns.len(), 1);
        let since = b.query(&Query { limit: 10, level: Some("all"), search: Some("MSG 4"), since: Some(3) });
        assert_eq!(since[0].message, "msg 4");
        assert_eq!(b.info(), (3, 3, 5));
    }
}
