import { mk } from "./lib.mjs";
const { recordTx } = mk("./results.json");
const h = { upload_chunk1: "12MihhpZ63nEwRdxerGwXzu3553iKHBDXzpLbyCpS3Bu", upload_chunk2: "J5nvW2wFbmvSfx7jT1DsFiANgv9q6BgujjGi43SEnVog", upload_chunk3: "7wVrucazhv1ei8obY7wx9vVAoVDxA6DVfKPvyyCHP5ik" };
for (const [k, v] of Object.entries(h)) recordTx(k, v, { status: "Success", resolver_wasm_sha256: "3dd936d8deee90bb452d8e4f242062d8ef6a1f05e4cd62a548941e380fe4ad49" });
