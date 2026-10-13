//! Cron scheduling (local time, honours `TZ`) and a short human description
//! of the expression for the dashboard.

use std::sync::Arc;

use chrono::{DateTime, Local};
use croner::Cron;
use tracing::{error, info};

use crate::processor::{Processor, RunError};

pub fn parse(expr: &str) -> Option<Cron> {
    Cron::new(expr).parse().ok()
}

pub fn next_run(expr: &str) -> Option<DateTime<Local>> {
    parse(expr)?.find_next_occurrence(&Local::now(), false).ok()
}

const DAYS: [&str; 7] = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/// Human description for the common shapes; the raw expression otherwise.
pub fn describe(expr: &str) -> String {
    let f: Vec<&str> = expr.split_whitespace().collect();
    if f.len() != 5 {
        return expr.to_string();
    }
    let num = |s: &str| s.parse::<u32>().ok();
    let step = |s: &str| s.strip_prefix("*/").and_then(|n| n.parse::<u32>().ok());
    let (min, hour, dom, mon, dow) = (f[0], f[1], f[2], f[3], f[4]);
    let rest_any = dom == "*" && mon == "*";
    match (num(min), num(hour)) {
        (Some(m), Some(h)) if rest_any && dow == "*" => format!("Every day at {h:02}:{m:02}"),
        (Some(m), Some(h)) if rest_any && num(dow).is_some_and(|d| d <= 7) => {
            format!("Every {} at {h:02}:{m:02}", DAYS[(num(dow).unwrap() % 7) as usize])
        }
        (Some(m), Some(h)) if mon == "*" && dow == "*" && num(dom).is_some() => {
            format!("Monthly on day {} at {h:02}:{m:02}", dom)
        }
        (Some(0), None) if hour == "*" && rest_any && dow == "*" => "Every hour".into(),
        (Some(m), None) if hour == "*" && rest_any && dow == "*" => {
            format!("Every hour at minute {m}")
        }
        (Some(m), None) if step(hour).is_some() && rest_any && dow == "*" => {
            format!("Every {} hours at minute {m}", step(hour).unwrap())
        }
        (None, None) if step(min).is_some() && hour == "*" && rest_any && dow == "*" => {
            format!("Every {} minutes", step(min).unwrap())
        }
        _ => expr.to_string(),
    }
}

pub fn spawn(expr: String, processor: Arc<Processor>) {
    let Some(cron) = parse(&expr) else {
        error!("Invalid CRON_SCHEDULE '{expr}' — automatic runs disabled");
        return;
    };
    info!("Scheduled runs: {expr} ({})", describe(&expr));
    tokio::spawn(async move {
        loop {
            let now = Local::now();
            let Ok(next) = cron.find_next_occurrence(&now, false) else {
                return;
            };
            let wait = (next - now).to_std().unwrap_or_default();
            tokio::time::sleep(wait).await;
            info!("Starting scheduled run ({expr})");
            match processor.start_run(None, None).await {
                Ok(_) => {}
                Err(RunError::AlreadyRunning) => {
                    info!("Scheduled run skipped: a run is already in progress")
                }
                Err(e) => error!("Scheduled run failed: {e}"),
            }
            // Never fire twice for the same minute.
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn descriptions() {
        assert_eq!(describe("0 0 * * *"), "Every day at 00:00");
        assert_eq!(describe("30 4 * * 1"), "Every Monday at 04:30");
        assert_eq!(describe("0 * * * *"), "Every hour");
        assert_eq!(describe("15 * * * *"), "Every hour at minute 15");
        assert_eq!(describe("0 */6 * * *"), "Every 6 hours at minute 0");
        assert_eq!(describe("*/10 * * * *"), "Every 10 minutes");
        assert_eq!(describe("0 3 1 * *"), "Monthly on day 1 at 03:00");
        assert_eq!(describe("0 3 * 1-6 *"), "0 3 * 1-6 *");
    }

    #[test]
    fn next() {
        assert!(next_run("0 0 * * *").is_some());
        assert!(next_run("not a cron").is_none());
    }
}
