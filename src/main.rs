use std::path::PathBuf;
use std::sync::Arc;

use clap::Parser;
use tower_http::cors::{Any, CorsLayer};

mod branches;
mod encoding;
mod logtrees;
mod patch;
mod replay;
mod serialize;
mod types;
mod web_api;

use branches::BranchManager;
use logtrees::LogtreeStorage;

#[derive(Parser)]
struct Args {
    /// Directory to store document data
    #[arg(short, long, default_value = "./data")]
    data_dir: PathBuf,

    /// Port to listen on
    #[arg(short, long, default_value_t = 3000)]
    port: u16,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();

    let storage = LogtreeStorage::new(&args.data_dir)?;
    let manager = Arc::new(BranchManager::new(storage));

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = web_api::router(manager).layer(cors);

    let addr = format!("0.0.0.0:{}", args.port);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    println!("branchedit listening on http://{}", addr);
    axum::serve(listener, app).await?;
    Ok(())
}
