// The UI is embedded from web/dist. Make sure the folder exists so a plain
// `cargo build` works before the frontend has been built.
fn main() {
    let dist = std::path::Path::new("web/dist");
    if !dist.join("index.html").exists() {
        std::fs::create_dir_all(dist).unwrap();
        std::fs::write(
            dist.join("index.html"),
            "<!doctype html><title>Subsyncarr</title><p>UI not built — run <code>npm run build</code> in <code>web/</code>.</p>",
        )
        .unwrap();
    }
    println!("cargo:rerun-if-changed=web/dist");
    println!("cargo:rerun-if-changed=CHANGELOG.md");
}
