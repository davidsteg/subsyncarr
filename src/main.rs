#[tokio::main]
async fn main() {
    if let Err(e) = subsyncarr::run().await {
        eprintln!("Failed to start server: {e:#}");
        std::process::exit(1);
    }
}
