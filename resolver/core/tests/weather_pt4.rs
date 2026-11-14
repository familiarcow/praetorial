//! PT4 (D-WX1): parse_cli_max on REAL recorded CLI text (wasm-bin/fixtures/pt4). Record flags, MM, another day.
use praetorial_core::weather::*;
use serde_json::Value;

fn text(f: &str) -> String {
    let p = format!("{}/../wasm-bin/fixtures/pt4/{}", env!("CARGO_MANIFEST_DIR"), f);
    let v: Value = serde_json::from_slice(&std::fs::read(&p).unwrap()).unwrap();
    v["productText"].as_str().unwrap().to_string()
}
#[test]
fn minimum_record_flag_line_leaves_max_untouched() {
    let t = text("synth_nws_prod_DTW_20251205_minrecord.json");
    assert!(t.contains("MINIMUM          5R"));
    assert_eq!(parse_cli_max(&t, "2025-12-05"), Copy::Val(27));
    // 'MINIMUM 12R' with the minimum row placed BEFORE the maximum row must still not be read as the max
    let swapped = t.replace("  MAXIMUM         27   1100 PM  67    2001  40    -13       31       \n  MINIMUM          5R   700 AM   6    1974  28    -23       19       \n", "  MINIMUM         12R   700 AM  12    1974  28    -23       19       \n  MAXIMUM         27   1100 PM  67    2001  40    -13       31       \n");
    assert_ne!(swapped, t);
    assert_eq!(parse_cli_max(&swapped, "2025-12-05"), Copy::Val(27));
}
#[test]
fn mm_max_is_mm() {
    assert_eq!(parse_cli_max(&text("synth_nws_prod_DCA_20260205_mm.json"), "2026-02-05"), Copy::Mm);
    assert_eq!(decide(">=", 40, &Copy::Mm, &Copy::Mm).word(), "VOID");
}
#[test]
fn another_days_product_is_absent_never_the_right_day() {
    let t = text("nws_prod_NYC_20261102_prelim.json");
    assert_eq!(parse_cli_max(&t, "2026-11-02"), Copy::Val(66));
    assert_eq!(parse_cli_max(&t, "2026-11-01"), Copy::Absent);
    assert_eq!(parse_cli_max(&t, "2026-11-03"), Copy::Absent);
}
#[test]
fn dst_day_product_reads_59() {
    assert_eq!(parse_cli_max(&text("nws_prod_NYC_20261101_dst.json"), "2026-11-01"), Copy::Val(59));
}
