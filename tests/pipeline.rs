//! End-to-end: scan a temp library, run the real pipeline against a fake
//! engine, and check files on disk plus what the database recorded.

use std::path::{Path, PathBuf};
use std::time::Duration;

use subsyncarr::{config::Config, logbuf::LogBuffer};

fn srt(cues: usize) -> String {
    (0..cues)
        .map(|i| {
            let s = 10 + i * 4;
            format!("{}\n00:00:{:02},000 --> 00:00:{:02},500\nLine {i}\n\n", i + 1, s % 60, (s + 2) % 60)
        })
        .collect()
}

fn write_case(root: &Path, dir: &str, video: &str, subs: &[&str]) -> Vec<PathBuf> {
    let d = root.join(dir);
    std::fs::create_dir_all(&d).unwrap();
    std::fs::write(d.join(video), b"not really a video").unwrap();
    subs.iter()
        .map(|s| {
            let p = d.join(s);
            std::fs::write(&p, srt(10)).unwrap();
            p
        })
        .collect()
}

fn script(dir: &Path, engine: &str) -> String {
    let fake = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake_engine.py");
    let p = dir.join(engine);
    std::fs::write(&p, format!("#!/bin/sh\nexec python3 '{}' {engine} \"$@\"\n", fake.display())).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    p.display().to_string()
}

async fn wait_idle(p: &subsyncarr::processor::Processor) {
    for _ in 0..600 {
        if !p.is_running() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("run did not finish");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn full_pipeline() {
    let tmp = tempfile::tempdir().unwrap();
    let media = tmp.path().join("media");
    let bin = tmp.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let log = tmp.path().join("engine.log");

    let good = write_case(&media, "Good (2020)", "Good.mkv", &["Good.en.srt"]);
    let mismatch = write_case(&media, "Mismatch", "Mismatch.mkv", &["Mismatch.mismatch.en.srt"]);
    let broken = write_case(&media, "Broken", "Broken.mkv", &["Broken.broken.en.srt"]);
    let wrong = write_case(&media, "Wrong", "Wrong.mkv", &["Wrong.wrong.en.srt"]);
    let forced = write_case(&media, "Forced", "Forced.mkv", &["Forced.wrong.en.forced.srt"]);
    // Names with shell metacharacters must reach the engine untouched.
    let quoted = write_case(&media, "It's $HOME `x`", "It's $HOME `x`.mp4", &["It's $HOME `x`.en.srt"]);

    // SAFETY: set before any other thread in this test binary reads the env.
    unsafe {
        std::env::set_var("SCAN_PATHS", media.display().to_string());
        std::env::set_var("DB_PATH", tmp.path().join("data/test.db").display().to_string());
        std::env::set_var("ALASS_BIN", script(&bin, "alass"));
        std::env::set_var("FFSUBSYNC_BIN", script(&bin, "ffsubsync"));
        std::env::set_var("INCLUDE_ENGINES", "alass,ffsubsync");
        std::env::set_var("NOT_FITTING_DELETE_THRESHOLD", "1");
        std::env::set_var("MAX_CONCURRENT_SYNC_TASKS", "3");
        std::env::set_var("FAKE_ENGINE_LOG", log.display().to_string());
    }
    let cfg = Config::from_env();
    let app = subsyncarr::build(cfg, LogBuffer::new(100)).await.unwrap();
    let st = app.state.clone();

    let run_id = st.processor.start_run(None, None).await.unwrap();
    wait_idle(&st.processor).await;

    let run = st.db.get_run(&run_id).await.unwrap().unwrap();
    assert_eq!(run.status, "completed");
    assert_eq!(run.total_files, 6);
    let (files, _) = st.db.files_paginated(&run_id, 100, 0, None).await.unwrap();
    let status_of =
        |p: &PathBuf| files.iter().find(|f| Path::new(&f.file_path) == p).map(|f| f.status.clone()).unwrap_or_default();

    // Agreeing engines: synced in place, shifted by the fake's 1.5 s.
    assert_eq!(status_of(&good[0]), "completed");
    assert!(std::fs::read_to_string(&good[0]).unwrap().contains("00:00:11,500 -->"));
    assert_eq!(status_of(&quoted[0]), "completed");

    // Engines disagree: original restored, one strike, threshold 1 → deleted.
    assert_eq!(status_of(&mismatch[0]), "not_fitting");
    assert!(!mismatch[0].exists());

    // Both engines crash: a failure, not a strike — the file stays untouched.
    assert_eq!(status_of(&broken[0]), "error");
    assert_eq!(std::fs::read_to_string(&broken[0]).unwrap(), srt(10));

    // Shift beyond the limit on a normal subtitle: deleted at the threshold.
    assert_eq!(status_of(&wrong[0]), "not_fitting");
    assert!(!wrong[0].exists());

    // Forced subtitle: never deleted, restored byte for byte, and alass ran
    // with --no-split.
    assert_eq!(status_of(&forced[0]), "not_fitting");
    assert_eq!(std::fs::read_to_string(&forced[0]).unwrap(), srt(10));
    let calls = std::fs::read_to_string(&log).unwrap();
    assert!(calls.lines().any(|l| l.starts_with("alass --no-split") && l.contains("Forced.wrong.en.forced.srt")));

    // No backups or temp files left behind.
    for entry in walk(&media) {
        let n = entry.file_name().unwrap().to_string_lossy().to_string();
        assert!(!n.ends_with(".bak") && !n.contains("-tmp."), "leftover {n}");
    }

    // Second run: the synced files are cached, the forced file is parked, so
    // only the broken one is retried.
    let before = calls.lines().count();
    let run2 = st.processor.start_run(None, None).await.unwrap();
    wait_idle(&st.processor).await;
    let run2 = st.db.get_run(&run2).await.unwrap().unwrap();
    assert_eq!(run2.total_files, 1);
    let after = std::fs::read_to_string(&log).unwrap().lines().count();
    assert_eq!(after - before, 2, "only the broken file should hit the engines");

    // A cached file that changes on disk is picked up again.
    std::fs::write(&good[0], srt(12)).unwrap();
    let run3 = st.processor.start_run(None, None).await.unwrap();
    wait_idle(&st.processor).await;
    let run3 = st.db.get_run(&run3).await.unwrap().unwrap();
    assert_eq!(run3.total_files, 2);

    // The HTTP API on top of the same state.
    let api = |method: &str, uri: &str, body: Option<serde_json::Value>| {
        let router = subsyncarr::server::router(st.clone());
        let req = axum::http::Request::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json")
            .body(axum::body::Body::from(body.map(|b| b.to_string()).unwrap_or_default()))
            .unwrap();
        async move {
            use http_body_util::BodyExt;
            use tower::ServiceExt;
            let res = router.oneshot(req).await.unwrap();
            let status = res.status();
            let bytes = res.into_body().collect().await.unwrap().to_bytes();
            (status, serde_json::from_slice::<serde_json::Value>(&bytes).unwrap_or_default())
        }
    };
    let (code, _) = api("GET", "/api/health", None).await;
    assert_eq!(code, 200);
    let (_, history) = api("GET", "/api/history?limit=10", None).await;
    assert_eq!(history.as_array().map(|a| a.len()), Some(3), "{history}");
    let (code, _) =
        api("POST", "/api/settings", Some(serde_json::json!({ "default_engine": "ffsubsync", "theme": "dark" }))).await;
    assert_eq!(code, 200);
    let (_, settings) = api("GET", "/api/settings", None).await;
    assert_eq!(settings["defaultEngine"], "ffsubsync");
    assert_eq!(settings["theme"], "dark");
    let (_, stats) = api("GET", "/api/stats", None).await;
    assert!(stats.is_object(), "{stats}");
    let (code, _) = api("GET", "/api/nope", None).await;
    assert_eq!(code, 404);
}

fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for e in std::fs::read_dir(dir).unwrap().flatten() {
        let p = e.path();
        if p.is_dir() {
            out.extend(walk(&p));
        } else {
            out.push(p);
        }
    }
    out
}
