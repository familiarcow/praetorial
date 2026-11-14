// Launches a near-sandbox node (nearcore 2.13.x, via the `near-sandbox`
// Rust crate) compatible with near-sdk 5.30's wasm output -- the bundled
// JS `near-sandbox` npm package hardcodes nearcore 2.6.2, which cannot
// deserialize wasm built with current near-sdk/rustc (PrepareError
// ::Deserialization on deploy). This launcher starts a compatible node and
// prints its RPC address + the default genesis account's keys so the JS
// harness (near-workspaces/near-api-js) can drive it directly over RPC.
// Local-only: chaos/ scope, no testnet/mainnet, no keys printed beyond the
// sandbox's own disposable throwaway genesis keypair (same fixed test key
// the sandbox ships with upstream, not a real credential).
use near_sandbox::config::{
    DEFAULT_GENESIS_ACCOUNT, DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY, DEFAULT_GENESIS_ACCOUNT_PUBLIC_KEY,
    SandboxConfig,
};
use near_sandbox::Sandbox;

// near-sdk-rs's own CI pins its sandbox to 2.14.0-rc.2+ to run contracts
// built with current near-sdk/rustc (near/near-sdk-rs#1630) -- the crate's
// own DEFAULT_NEAR_SANDBOX_VERSION (2.13.4) still link-errors on an
// "unknown or invalid import" for a newer host function our wasm uses.
const SANDBOX_VERSION: &str = "2.14.0-rc.4";

#[tokio::main]
async fn main() {
    let sandbox = Sandbox::start_sandbox_with_config_and_version(SandboxConfig::default(), SANDBOX_VERSION)
        .await
        .expect("failed to start sandbox");
    println!("RPC_ADDR={}", sandbox.rpc_addr);
    println!("ROOT_ACCOUNT_ID={}", DEFAULT_GENESIS_ACCOUNT);
    println!("ROOT_PUBLIC_KEY={}", DEFAULT_GENESIS_ACCOUNT_PUBLIC_KEY);
    println!("ROOT_PRIVATE_KEY={}", DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY);
    println!("READY");
    // Simple stdin protocol so the JS harness can drive sandbox-only
    // features (block production) this launcher's crate exposes but no
    // JSON-RPC method does: "FASTFORWARD <n>\n" advances n blocks.
    let stdin = tokio::io::stdin();
    let mut reader = tokio::io::BufReader::new(stdin);
    use tokio::io::AsyncBufReadExt;
    let mut line = String::new();
    loop {
        line.clear();
        tokio::select! {
            res = reader.read_line(&mut line) => {
                match res {
                    Ok(0) => break, // stdin closed
                    Ok(_) => {
                        let trimmed = line.trim();
                        if let Some(rest) = trimmed.strip_prefix("FASTFORWARD ") {
                            if let Ok(n) = rest.parse::<u64>() {
                                match sandbox.fast_forward(n).await {
                                    Ok(()) => println!("FASTFORWARD_OK"),
                                    Err(e) => println!("FASTFORWARD_ERR {e}"),
                                }
                            } else {
                                println!("FASTFORWARD_ERR bad arg");
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
            _ = tokio::signal::ctrl_c() => break,
        }
    }
}
