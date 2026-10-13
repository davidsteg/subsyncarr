//! End-to-end for the integrations: a Sonarr webhook syncs just the
//! subtitles of one episode, then the run is announced to a notification
//! endpoint and a (fake) Jellyfin server.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::http::HeaderMap;
use serde_json::{json, Value};
use subsyncarr::{config::Config, logbuf::LogBuffer};

fn srt(cues: usize) -> String {
    (0..cues)
        .map(|i| {
            let s = 10 + i * 4;
            format!("{}\n00:00:{:02},000 --> 00:00:{:02},500\nLine {i}\n\n", i + 1, s % 60, (s + 2) % 60)
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

type Seen = Arc<Mutex<Vec<(String, Option<String>, Value)>>>;

/// Records every request: (path, X-Emby-Token header, JSON body).
async fn mock_server() -> (String, Seen) {
    let seen: Seen = Arc::default();
    let s = seen.clone();
    let app = axum::Router::new().fallback(move |uri: axum::http::Uri, headers: HeaderMap, body: String| {
        let s = s.clone();
        async move {
            let token = headers.get("x-emby-token").and_then(|v| v.to_str().ok()).map(str::to_string);
            s.lock().unwrap().push((uri.path().to_string(), token, serde_json::from_str(&body).unwrap_or_default()));
            "ok"
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{addr}"), seen)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn webhook_sync_notify_and_refresh() {
    let tmp = tempfile::tempdir().unwrap();
    let media = tmp.path().join("media");
    let bin = tmp.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let show = media.join("Show");
    std::fs::create_dir_all(&show).unwrap();
    for f in ["e1.mkv", "e2.mkv"] {
        std::fs::write(show.join(f), b"not really a video").unwrap();
    }
    std::fs::write(show.join("e1.en.srt"), srt(10)).unwrap();
    std::fs::write(show.join("e2.en.srt"), srt(10)).unwrap();

    // SAFETY: set before any other thread in this test binary reads the env.
    unsafe {
        std::env::set_var("SCAN_PATHS", media.display().to_string());
        std::env::set_var("DB_PATH", tmp.path().join("data/test.db").display().to_string());
        std::env::set_var("ALASS_BIN", script(&bin, "alass"));
        std::env::set_var("FFSUBSYNC_BIN", script(&bin, "ffsubsync"));
        std::env::set_var("INCLUDE_ENGINES", "alass,ffsubsync");
        std::env::set_var("STARTUP_SCAN", "false");
        std::env::set_var("FAKE_ENGINE_LOG", tmp.path().join("engine.log").display().to_string());
    }
    let (mock, seen) = mock_server().await;
    let app = subsyncarr::build(Config::from_env(), LogBuffer::new(100)).await.unwrap();
    let st = app.state.clone();

    let api = |method: &str, uri: &str, body: Option<Value>| {
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
            (status.as_u16(), serde_json::from_slice::<Value>(&bytes).unwrap_or_default())
        }
    };

    // Off by default.
    let (code, _) = api("POST", "/api/webhook/sonarr", Some(json!({"eventType": "Test"}))).await;
    assert_eq!(code, 403);

    let (code, _) = api(
        "POST",
        "/api/settings",
        Some(json!({
            "webhook_enabled": true,
            "webhook_token": "s3cret",
            "webhook_path_map": format!("/tv={}", media.display()),
            "notify_url": format!("{mock}/notify"),
            "notify_kind": "json",
            "notify_on": "always",
            "media_server": "jellyfin",
            "media_server_url": mock,
            "media_server_token": "jf-token",
            "media_path_map": format!("{}=/data", media.display()),
        })),
    )
    .await;
    assert_eq!(code, 200);
    let (_, settings) = api("GET", "/api/settings", None).await;
    assert_eq!(settings["integrations"]["mediaServer"], "jellyfin");

    let (code, _) = api("POST", "/api/webhook/sonarr", Some(json!({"eventType": "Test"}))).await;
    assert_eq!(code, 401);
    let (code, body) = api("POST", "/api/webhook/sonarr?token=s3cret", Some(json!({"eventType": "Test"}))).await;
    assert_eq!((code, body["ok"].clone()), (200, json!(true)));
    let (code, _) = api("POST", "/api/webhook/lidarr?token=s3cret", Some(json!({}))).await;
    assert_eq!(code, 404);
    let (code, _) = api("POST", "/api/webhook?token=s3cret", Some(json!({"path": "/etc/passwd"}))).await;
    assert_eq!(code, 422);

    let (code, body) = api(
        "POST",
        "/api/webhook/sonarr?token=s3cret",
        Some(json!({
            "eventType": "Download",
            "series": {"path": "/tv/Show"},
            "episodeFile": {"relativePath": "e1.mkv"},
        })),
    )
    .await;
    assert_eq!(code, 200, "{body}");
    assert_eq!(body["queued"], json!([show.join("e1.en.srt").display().to_string()]));

    // The debounced run starts on its own and covers only that episode.
    let mut run = None;
    for _ in 0..400 {
        if let Some(r) = st.db.run_history(5).await.unwrap().into_iter().find(|r| r.status == "completed") {
            run = Some(r);
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let run = run.expect("webhook run did not complete");
    assert_eq!((run.total_files, run.completed), (1, 1));
    assert!(std::fs::read_to_string(show.join("e1.en.srt")).unwrap().contains("00:00:11,500 -->"));
    assert_eq!(std::fs::read_to_string(show.join("e2.en.srt")).unwrap(), srt(10));

    // Notification and Jellyfin refresh follow the finished run.
    for _ in 0..200 {
        if seen.lock().unwrap().len() >= 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let seen = seen.lock().unwrap().clone();
    let notify = seen.iter().find(|(p, ..)| p == "/notify").expect("notification sent");
    assert_eq!(notify.2["event"], "run.completed");
    assert_eq!(notify.2["run"]["completed"], 1);
    let jf = seen.iter().find(|(p, ..)| p == "/Library/Media/Updated").expect("jellyfin refresh sent");
    assert_eq!(jf.1.as_deref(), Some("jf-token"));
    assert_eq!(jf.2["Updates"], json!([{"Path": "/data/Show", "UpdateType": "Modified"}]));

    let (code, body) = api("POST", "/api/integrations/test", Some(json!({"target": "notify"}))).await;
    assert_eq!(code, 200, "{body}");
}
