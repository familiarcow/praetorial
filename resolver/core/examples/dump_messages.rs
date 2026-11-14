//! RTE1: print the EXACT judge messages the resolver builds (core `build_messages_at`) for a case.
//! stdin: {"ts":..,"element":..,"sources":[..],"as_of":<unix|null>}  stdout: [["system",..],["user",..]]
use std::io::Read;
fn main() {
    let mut s = String::new();
    std::io::stdin().read_to_string(&mut s).unwrap();
    let v: serde_json::Value = serde_json::from_str(&s).unwrap();
    let srcs = v["sources"].as_array().cloned().unwrap_or_default();
    let m = praetorial_core::build_messages_at(&v["ts"], &v["element"], &srcs, v["as_of"].as_i64());
    println!("{}", serde_json::to_string(&m).unwrap());
}
