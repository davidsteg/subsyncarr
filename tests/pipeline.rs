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
    let insync = write_case(&media, "InSync", "InSync.mkv", &["InSync.insync.en.srt"]);
    let onesided = write_case(&media, "OneSided", "OneSided.mkv", &["OneSided.onesided.en.srt"]);
    let broken = write_case(&media, "Broken", "Broken.mkv", &["Broken.broken.en.srt"]);
    let wrong = write_case(&media, "Wrong", "Wrong.mkv", &["Wrong.wrong.en.srt"]);
    let forced = write_case(&media, "Forced", "Forced.mkv", &["Forced.wrong.en.forced.srt"]);
    // Names with shell metacharacters must reach the engine untouched.
    // alass moving one intro cue by a minute is not a mismatch: the 30 s limit
    // applies to the median shift.
    let intro = write_case(&media, "Intro", "Intro.mkv", &["Intro.intro.en.srt"]);
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
    assert_eq!(run.total_files, 9);
    let (files, _) = st.db.files_paginated(&run_id, 100, 0, None).await.unwrap();
    let status_of =
        |p: &PathBuf| files.iter().find(|f| Path::new(&f.file_path) == p).map(|f| f.status.clone()).unwrap_or_default();

    // Agreeing engines: synced in place, shifted by the fake's 1.5 s.
    assert_eq!(status_of(&good[0]), "completed");
    assert!(std::fs::read_to_string(&good[0]).unwrap().contains("00:00:11,500 -->"));
    assert_eq!(status_of(&quoted[0]), "completed");
    assert_eq!(status_of(&intro[0]), "completed");

    // One verdict line per file plus the closing summary in the run log.
    let log_text = st.runlogs.read(&run_id);
    for line in [
        "Effective config: engines=alass+ffsubsync",
        "▶ synced: Good.en.srt | alass ✓ +1500ms, ffsubsync ✓ +1500ms | kept alass",
        "▶ failed_error: Broken.broken.en.srt | alass ✗ error (could not decode audio), ffsubsync ✗ error (could not decode audio)",
        "▶ deleted: Mismatch.mismatch.en.srt | alass ✓ +5000ms, ffsubsync ✓ +20000ms | strike 1/1, deleted",
        "▶ already_in_sync: InSync.insync.en.srt | alass ✓ +20000ms, ffsubsync ✓ +300ms | left unchanged",
        "▶ not_fitting_unconfirmed: OneSided.onesided.en.srt | alass ✓ +0ms, ffsubsync ✓ +20000ms | no strike",
        "▶ deleted: Wrong.wrong.en.srt",
        "▶ forced_parked: Forced.wrong.en.forced.srt",
        "===== Run summary =====",
        "Scan: 9 subtitle(s) found, 9 needed sync, 0 already synced",
        "-- failed: engine error (no strike) (1):",
    ] {
        assert!(log_text.contains(line), "missing {line:?} in run log:\n{log_text}");
    }

    // Engines disagree: original restored, one strike, threshold 1 → deleted.
    assert_eq!(status_of(&mismatch[0]), "not_fitting");
    assert!(!mismatch[0].exists());

    // ffsubsync sees no shift: already in sync, untouched, cached, no strike.
    assert_eq!(status_of(&insync[0]), "completed");
    assert_eq!(std::fs::read_to_string(&insync[0]).unwrap(), srt(10));
    assert_eq!(st.db.not_fitting_strikes(&insync[0].display().to_string()).await.unwrap(), 0);

    // Only one engine wants a large shift: kept untouched, no strike.
    assert_eq!(status_of(&onesided[0]), "not_fitting");
    assert_eq!(std::fs::read_to_string(&onesided[0]).unwrap(), srt(10));
    assert_eq!(st.db.not_fitting_strikes(&onesided[0].display().to_string()).await.unwrap(), 0);

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

    // Second run: the synced and in-sync files are cached, the forced file is
    // parked, so only the broken and the one-sided ones are retried.
    let before = calls.lines().count();
    let run2 = st.processor.start_run(None, None).await.unwrap();
    wait_idle(&st.processor).await;
    let run2 = st.db.get_run(&run2).await.unwrap().unwrap();
    assert_eq!(run2.total_files, 2);
    let after = std::fs::read_to_string(&log).unwrap().lines().count();
    assert_eq!(after - before, 4, "only the broken and one-sided files should hit the engines");

    // A cached file that changes on disk is picked up again.
    std::fs::write(&good[0], srt(12)).unwrap();
    let run3 = st.processor.start_run(None, None).await.unwrap();
    wait_idle(&st.processor).await;
    let run3 = st.db.get_run(&run3).await.unwrap().unwrap();
    assert_eq!(run3.total_files, 3);

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
    let (_, diag) = api("GET", "/api/diagnostics", None).await;
    assert_eq!(diag["totals"]["parked"], 1, "{diag}");
    assert_eq!(diag["parked"][0]["reason"], "forced_not_fitting");
    assert_eq!(diag["lastRunSummary"]["runId"], run3.id);
    assert_eq!(diag["lastRunSummary"]["scan"]["needSync"], 3);
    let (code, _) = api("GET", "/api/nope", None).await;
    assert_eq!(code, 404);

    // Sync quality: engines agree exactly, but 12 cues are sparse.
    let good_path = good[0].display().to_string();
    let enc = |s: &str| s.replace('%', "%25").replace(' ', "%20").replace('(', "%28").replace(')', "%29");
    let (_, media) = api("GET", &format!("/api/media?path={}", enc(&good_path)), None).await;
    assert_eq!(media["quality"]["score"], 90, "{media}");
    assert_eq!(media["quality"]["level"], "good");
    assert_eq!(media["quality"]["needsReview"], false);
    let (files3, _) = st.db.files_paginated(&run3.id, 10, 0, Some("completed")).await.unwrap();
    assert_eq!(files3[0].quality_score, Some(90));

    // Manual offset: shifted in place, recorded, undoable.
    let synced = std::fs::read_to_string(&good[0]).unwrap();
    let body = |extra: serde_json::Value| {
        let mut v = serde_json::json!({ "filePath": good_path });
        v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        Some(v)
    };
    let (code, res) = api("POST", "/api/file/offset", body(serde_json::json!({ "offsetMs": 500 }))).await;
    assert_eq!(code, 200, "{res}");
    assert!(std::fs::read_to_string(&good[0]).unwrap().starts_with("1\n00:00:12,000 -->"));
    let (_, media) = api("GET", &format!("/api/media?path={}", enc(&good_path)), None).await;
    assert_eq!(media["quality"]["manualOffsetMs"], 500);
    assert_eq!(media["quality"]["reviewed"], true);
    assert_eq!(media["undo"][0]["action"], "offset");

    let dir = good[0].parent().unwrap().display().to_string();
    let (_, listing) = api("GET", &format!("/api/library/files?dir={}", enc(&dir)), None).await;
    assert_eq!(listing[0]["name"], "Good.en.srt", "{listing}");
    assert_eq!(listing[0]["synced"], true, "a manual change must stay cached");
    assert_eq!(listing[0]["undoSteps"], 1);

    let (code, res) = api("POST", "/api/file/undo", body(serde_json::json!({}))).await;
    assert_eq!((code.as_u16(), res["undone"].as_str()), (200, Some("offset")));
    assert_eq!(std::fs::read_to_string(&good[0]).unwrap(), synced);
    let (code, _) = api("POST", "/api/file/undo", body(serde_json::json!({}))).await;
    assert_eq!(code, 404);

    // Undo refuses once the file has changed underneath it.
    api("POST", "/api/file/offset", body(serde_json::json!({ "offsetMs": -200 }))).await;
    std::fs::write(&good[0], &synced).unwrap();
    let (code, _) = api("POST", "/api/file/undo", body(serde_json::json!({}))).await;
    assert_eq!(code, 409);

    // Manual re-sync: a one-file run straight past the sync cache.
    let (code, res) = api("POST", "/api/file/resync", body(serde_json::json!({}))).await;
    assert_eq!(code, 200, "{res}");
    wait_idle(&st.processor).await;
    let run4 = st.db.get_run(res["runId"].as_str().unwrap()).await.unwrap().unwrap();
    assert_eq!((run4.total_files, run4.completed), (1, 1));
    assert!(std::fs::read_to_string(&good[0]).unwrap().starts_with("1\n00:00:13,000 -->"));
    let (code, _) = api("POST", "/api/file/undo", body(serde_json::json!({}))).await;
    assert_eq!(code, 200);
    assert_eq!(std::fs::read_to_string(&good[0]).unwrap(), synced);

    // Only subtitles inside SCAN_PATHS.
    let (code, _) =
        api("POST", "/api/file/offset", Some(serde_json::json!({ "filePath": "/etc/passwd", "offsetMs": 1 }))).await;
    assert_eq!(code, 400);
    let (_, queue) = api("GET", "/api/quality/review", None).await;
    assert_eq!(queue["total"], 0, "{queue}");

    // Fresh scan: synced files are reprocessed, the parked forced sub stays parked.
    let (code, res) = api("POST", "/api/run/start", Some(serde_json::json!({ "fresh": true }))).await;
    assert_eq!(code, 200, "{res}");
    wait_idle(&st.processor).await;
    let fresh = st.db.get_run(res["runId"].as_str().unwrap()).await.unwrap().unwrap();
    assert_eq!(fresh.total_files, 6, "good, in-sync, intro, quoted, one-sided and broken");

    // With resetFailures the park is lifted as well.
    let (code, res) =
        api("POST", "/api/run/start", Some(serde_json::json!({ "fresh": true, "resetFailures": true }))).await;
    assert_eq!(code, 200, "{res}");
    wait_idle(&st.processor).await;
    let reset = st.db.get_run(res["runId"].as_str().unwrap()).await.unwrap().unwrap();
    assert_eq!(reset.total_files, 7, "the forced sub is back in");
    assert!(st.runlogs.read(&reset.id).contains("cleared 1 strike(s)"), "{}", st.runlogs.read(&reset.id));

    // Statistics history: a subtitle with no video next to it is an orphan.
    let orphan = tmp.path().join("media/Loose/Lost.en.srt");
    std::fs::create_dir_all(orphan.parent().unwrap()).unwrap();
    std::fs::write(&orphan, srt(10)).unwrap();
    st.processor.start_run(None, None).await.unwrap();
    wait_idle(&st.processor).await;
    let (code, deep) = api("GET", "/api/stats/deep?days=7&tzOffset=120", None).await;
    assert_eq!(code, 200, "{deep}");
    let t = &deep["totals"];
    assert_eq!(t["deleted"], 2, "mismatch and wrong: {t}");
    assert!(t["parked"].as_i64().unwrap() >= 1, "{t}");
    assert!(t["categories"]["failed_error"].as_i64().unwrap() >= 1, "{t}");
    assert_eq!(t["noVideo"], 1, "{t}");
    assert_eq!(deep["orphans"]["count"], 1, "{}", deep["orphans"]);
    assert_eq!(deep["orphans"]["items"][0]["filePath"], orphan.display().to_string());
    // Engines in a fixed order on the axes; a 20 s disagreement tops the list.
    // The chain changed to ffsubsync twice above: one block per engine pair.
    let ag = deep["agreement"]["pairs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|b| b["engines"] == serde_json::json!(["alass", "ffsubsync"]))
        .unwrap_or_else(|| panic!("{}", deep["agreement"]));
    let m = ag["worst"].as_array().unwrap().iter().find(|w| w["filePath"] == mismatch[0].display().to_string());
    let m = m.unwrap_or_else(|| panic!("{ag}"));
    assert_eq!((m["a"].as_i64(), m["b"].as_i64(), m["category"].as_str()), (Some(5000), Some(20000), Some("deleted")));
    assert_eq!(ag["worst"][0]["a"].as_i64().unwrap().abs_diff(ag["worst"][0]["b"].as_i64().unwrap()), 20000);
    let engines = deep["engines"].as_array().unwrap();
    let alass = engines.iter().find(|e| e["engine"] == "alass").unwrap();
    assert!(alass["results"]["ok"].as_i64().unwrap() > 0 && alass["results"]["error"].as_i64().unwrap() > 0);
    assert_eq!(alass["results"]["shift"], 2, "wrong, and the forced sub: {alass}");
    let langs = deep["breakdowns"]["language"].as_array().unwrap();
    assert_eq!(langs[0]["key"], "English", "{langs:?}");
    let forced = deep["breakdowns"]["forced"].as_array().unwrap();
    assert!(forced.iter().any(|r| r["key"] == "forced"), "{forced:?}");
    let titles = deep["breakdowns"]["titles"].as_array().unwrap();
    assert!(titles.iter().any(|r| r["key"] == "Mismatch" && r["deleted"] == 1), "{titles:?}");
    assert!(deep["runs"].as_array().unwrap().len() >= 6, "{}", deep["runs"]);
    assert!(!deep["timeline"].as_array().unwrap().is_empty());
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
