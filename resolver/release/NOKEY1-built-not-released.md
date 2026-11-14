# NOKEY1 resolver wasm: built, not yet released

- Source commit: `f9c61ecb1407aa372796ed0834220cef9e5d5108` (resolver/ identical to the NOKEY1 GREEN(1) commit ce96a247)
- wasm sha256: `8791413ff7943f5e5b99df4c5cafc50cb9baf5696cf32837e1a8afd31baa2473` (features `real-http,outlayer-sign`)
- Route: `build_reproducible.sh f9c61ecb run|cp <out>` in the pinned `outlayer/wasmedge-compiler@sha256:d9eb7bd9...` amd64 image (colima rosetta):
  docker run x2 and a fresh-container cp build all gave the hash above (a first cp attempt hit a linker SIGSEGV under emulation and was re-run).
- NOT uploaded, NOT deployed, NOT bound. The release record file is deliberately not in this directory (NOKEY1b adds `record-f9c61ec.json`
  with the same fields as record-b67b3d7.json): `apps/web/tests/releasePins.unit.test.ts` requires `apps/web/lib/release.json` to pin the newest record,
  and the web pin must not move before the escrow/resolver is redeployed.
- NOKEY1b needs: the record + web pin + redeploy + D-KEY2 key re-bind for (escrow, new hash) (frz2: `bind_secret.sh <frz2 escrow> 8791413f...`, as FRZ2SEC1 77bd57ef),
  then `check_key_bound.py` must exit 0.
- Known coupling: `check_record_covers_source.py` (RR6) reports STALE until the record lands, because resolver/wasm-bin/src/main.rs changed after record-b67b3d7.
