use std::path::PathBuf;

use clap::Parser;

mod patch;
mod types;
mod encoding;
mod serialize;

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
async fn main() {
    // Run the webserver
}
