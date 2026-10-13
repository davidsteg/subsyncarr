//! Runtime settings: one resolver for every value the Settings page can
//! change. Precedence is always DB (UI) → environment → built-in default, so
//! a saved setting can never be silently shadowed by a stale env var.

use std::collections::{BTreeMap, HashMap};

use serde::Serialize;
use serde_json::Value;

use crate::config::{Config, KNOWN_ENGINES};

pub const ALLOWED_KEYS: [&str; 13] = [
    "max_subtitle_shift_ms",
    "engine_agreement_threshold_ms",
    "not_fitting_delete_threshold",
    "engine_timeout_alass",
    "engine_timeout_ffsubsync",
    "engine_timeout_autosubsync",
    "max_concurrent_tasks",
    "default_engine",
    "fallback_engine",
    "dry_run",
    "anchor_alignment",
    "embedded_subtitle_reference",
    "theme",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub max_subtitle_shift_ms: i64,
    pub engine_agreement_threshold_ms: i64,
    pub not_fitting_delete_threshold: i64,
    pub engine_timeouts: BTreeMap<String, u64>,
    pub max_concurrent_tasks: usize,
    pub default_engine: String,
    pub fallback_engine: String,
    pub dry_run: bool,
    pub anchor_alignment: bool,
    pub embedded_subtitle_reference: bool,
    pub theme: String,
}

fn pos<T: std::str::FromStr + PartialOrd + Default>(db: &HashMap<String, String>, key: &str) -> Option<T> {
    db.get(key).and_then(|v| v.trim().parse::<T>().ok()).filter(|v| *v > T::default())
}

fn boolean(db: &HashMap<String, String>, key: &str) -> Option<bool> {
    match db.get(key).map(|s| s.trim()) {
        Some("true") => Some(true),
        Some("false") => Some(false),
        _ => None,
    }
}

fn engine(db: &HashMap<String, String>, key: &str) -> Option<String> {
    db.get(key).filter(|v| KNOWN_ENGINES.contains(&v.as_str())).cloned()
}

impl Settings {
    pub fn resolve(cfg: &Config, db: &HashMap<String, String>) -> Self {
        let d = &cfg.defaults;
        let engine_timeouts = d
            .engine_timeouts_ms
            .iter()
            .map(|(name, env_ms)| (name.clone(), pos(db, &format!("engine_timeout_{name}")).unwrap_or(*env_ms)))
            .collect();
        Settings {
            max_subtitle_shift_ms: pos(db, "max_subtitle_shift_ms").unwrap_or(d.max_subtitle_shift_ms),
            engine_agreement_threshold_ms: pos(db, "engine_agreement_threshold_ms")
                .unwrap_or(d.engine_agreement_threshold_ms),
            not_fitting_delete_threshold: pos(db, "not_fitting_delete_threshold")
                .unwrap_or(d.not_fitting_delete_threshold),
            engine_timeouts,
            max_concurrent_tasks: pos(db, "max_concurrent_tasks").unwrap_or(d.max_concurrent_tasks).min(64),
            default_engine: engine(db, "default_engine").unwrap_or_else(|| d.default_engine.clone()),
            fallback_engine: engine(db, "fallback_engine").unwrap_or_else(|| d.fallback_engine.clone()),
            dry_run: boolean(db, "dry_run").unwrap_or(d.dry_run),
            anchor_alignment: boolean(db, "anchor_alignment").unwrap_or(d.anchor_alignment),
            embedded_subtitle_reference: boolean(db, "embedded_subtitle_reference")
                .unwrap_or(d.embedded_subtitle_reference),
            theme: db.get("theme").cloned().unwrap_or_else(|| "system".into()),
        }
    }

    pub fn timeout_ms(&self, engine: &str) -> u64 {
        self.engine_timeouts.get(engine).copied().unwrap_or(300_000)
    }
}

/// Normalize a POST /api/settings body to `(key, value-string)` pairs,
/// dropping unknown keys and values that would not resolve.
pub fn normalize_updates(body: &serde_json::Map<String, Value>) -> Vec<(String, String)> {
    body.iter()
        .filter(|(k, _)| ALLOWED_KEYS.contains(&k.as_str()))
        .filter_map(|(k, v)| {
            let s = match v {
                Value::String(s) => s.trim().to_string(),
                Value::Number(n) => n.to_string(),
                Value::Bool(b) => b.to_string(),
                _ => return None,
            };
            let ok = match k.as_str() {
                "dry_run" | "anchor_alignment" | "embedded_subtitle_reference" => s == "true" || s == "false",
                "default_engine" | "fallback_engine" => KNOWN_ENGINES.contains(&s.as_str()),
                "theme" => matches!(s.as_str(), "light" | "dark" | "system"),
                _ => s.parse::<f64>().map(|n| n > 0.0).unwrap_or(false),
            };
            ok.then(|| {
                let s = if let Ok(f) = s.parse::<f64>() {
                    if k.starts_with("engine_") || k.starts_with("max_") || k.starts_with("not_") {
                        (f.round() as i64).to_string()
                    } else {
                        s
                    }
                } else {
                    s
                };
                (k.clone(), s)
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalize_filters_and_coerces() {
        let body = json!({
            "max_concurrent_tasks": "4",
            "engine_timeout_alass": 120000,
            "dry_run": true,
            "theme": "dark",
            "default_engine": "nope",
            "evil": "x",
            "max_subtitle_shift_ms": "-5",
        });
        let mut out = normalize_updates(body.as_object().unwrap());
        out.sort();
        assert_eq!(
            out,
            vec![
                ("dry_run".to_string(), "true".to_string()),
                ("engine_timeout_alass".to_string(), "120000".to_string()),
                ("max_concurrent_tasks".to_string(), "4".to_string()),
                ("theme".to_string(), "dark".to_string()),
            ]
        );
    }
}
