//! A stopped run adds no not-fitting strikes, even for files it already
//! judged before the stop.

use std::path::Path;
use std::time::Duration;

use subsyncarr::{config::Config, logbuf::LogBuffer};

fn srt(cues: usize) -> String {
    (0..cues).map(|i| format!("{}\n00:00:{:02},000 --> 00:00:{:02},500\nLine {i}\n\n", i + 1, 10 + i, 11 + i)).collect()
}

fn script(dir: &Path, engine: &str) -> String {
    let fake = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake_engine.py");
    let p = dir.join(engine);
    std::fs::write(&p, format!("#!/bin/sh\nexec python3 '{}' {engine} \"$@\"\n", fake.display())).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    p.display().to_string()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stopped_run_adds_no_strikes() {
    let tmp = tempfile::tempdir().unwrap();
    let media = tmp.path().join("media");
    let bin = tmp.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let mut subs = Vec::new();
    for (dir, sub) in [("Mismatch", "Mismatch.mismatch.en.srt"), ("Slow", "Slow.slow.en.srt")] {
        let d = media.join(dir);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join(format!("{dir}.mkv")), b"not really a video").unwrap();
        std::fs::write(d.join(sub), srt(10)).unwrap();
        subs.push(d.join(sub));
    }

    // SAFETY: set before any other thread in this test binary reads the env.
    unsafe {
        std::env::set_var("SCAN_PATHS", media.display().to_string());
        std::env::set_var("DB_PATH", tmp.path().join("data/test.db").display().to_string());
        std::env::set_var("ALASS_BIN", script(&bin, "alass"));
        std::env::set_var("FFSUBSYNC_BIN", script(&bin, "ffsubsync"));
        std::env::set_var("INCLUDE_ENGINES", "alass,ffsubsync");
        std::env::set_var("NOT_FITTING_DELETE_THRESHOLD", "1");
        std::env::set_var("MAX_CONCURRENT_SYNC_TASKS", "2");
        std::env::set_var("FAKE_ENGINE_LOG", tmp.path().join("engine.log").display().to_string());
    }
    let app = subsyncarr::build(Config::from_env(), LogBuffer::new(100)).await.unwrap();
    let st = app.state.clone();
    let run_id = st.processor.start_run(None, None).await.unwrap();

    // Wait for the mismatch verdict while the slow file is still in an engine.
    let mismatch = subs[0].display().to_string();
    let mut judged = false;
    for _ in 0..400 {
        let (files, _) = st.db.files_paginated(&run_id, 10, 0, Some("not_fitting")).await.unwrap();
        if files.iter().any(|f| f.file_path == mismatch) {
            judged = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(judged, "mismatch file was never judged");
    st.processor.stop_run().await.unwrap();
    for _ in 0..400 {
        if !st.processor.is_running() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(!st.processor.is_running(), "run did not stop");

    // Threshold 1 would have deleted it at the end of a completed run.
    assert_eq!(std::fs::read_to_string(&subs[0]).unwrap(), srt(10));
    assert_eq!(st.db.not_fitting_strikes(&mismatch).await.unwrap(), 0);
    let run = st.db.get_run(&run_id).await.unwrap().unwrap();
    assert_eq!(run.status, "cancelled");
    assert!(run.end_time.unwrap() >= run.start_time);
    assert!(st.runlogs.read(&run_id).contains("run stopped, no strike recorded"));
}
