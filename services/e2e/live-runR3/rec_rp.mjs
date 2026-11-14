import { mk } from "./lib.mjs";
const { recordTx } = mk("./results.json");
const H="4a69b059fb530b383af9c8ad711f9facf1f8bae3b20398a5ccdd05c330808338";
recordTx("upload_chunk1","CLaedbc6YfCfj9nTyuiE8xwsDMvAgatZDxYF4ZUvFQSY",{status:"Success",resolver_wasm_sha256:H});
recordTx("upload_chunk2","DydCzo5D79FfB1bPBhkRghN646jVHDF2esFY8DbaL6oA",{status:"Success",resolver_wasm_sha256:H});
recordTx("upload_chunk3","2f83vo5iq6s1tLYsuT35ByJzqhfmoq3sAj7wYdkYT2JN",{status:"Success",resolver_wasm_sha256:H});
recordTx("report_pubkey_outcome","CuFSR8g2uG2sktQxrzxv2yjNYTLYGzKgPUCMWtgHyqiv",{status:"Success",outcome_pubkey:"4a32e605ca20d6aff23c7a3a278bb6727ebad0f4f58fb91a116fd6e89926b85c"});
recordTx("report_pubkey_attest1","65E5M6A3J79zbWpzTk4nDkkmVxXQYfAemFCK3v5quiQE",{status:"Success",attest_pubkey:"4338312f945867b7734f46cf8f6e8d6a50ecd8a524e1b3ef4f55d4c4d153a063"});
