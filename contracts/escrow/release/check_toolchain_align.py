#!/usr/bin/env python3
"""TC1 guard: the rust-toolchain.toml channels must equal the rust version of the
reproducible-build image pinned in contracts/escrow/Cargo.toml (tested compiler == shipping compiler).
Run: python3 contracts/escrow/release/check_toolchain_align.py  (exit 1 on mismatch)"""
import os, re, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))
TOOLCHAINS = ["contracts/rust-toolchain.toml", "tests/conformance/escrow_conformance/rust-toolchain.toml"]


def read(rel):
    with open(os.path.join(ROOT, rel), encoding="utf-8") as f:
        return f.read()


def image_rust():
    m = re.search(r'^image\s*=\s*"[^"]*-rust-(\d+\.\d+\.\d+)"', read("contracts/escrow/Cargo.toml"), re.M)
    if not m:
        sys.exit("FAIL: no `image = \"...-rust-X.Y.Z\"` in contracts/escrow/Cargo.toml")
    return m.group(1)


def channel(rel):
    m = re.search(r'^channel\s*=\s*"([^"]+)"', read(rel), re.M)
    if not m:
        sys.exit(f"FAIL: no channel in {rel}")
    return m.group(1)


def main():
    img = image_rust()
    bad = [f"{rel}: channel {channel(rel)} != reproducible image rust {img}" for rel in TOOLCHAINS if channel(rel) != img]
    if bad:
        print("FAIL: toolchain mismatch (tested compiler != shipping compiler)\n  " + "\n  ".join(bad))
        return 1
    print(f"ok: toolchain channels == reproducible image rust {img}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
