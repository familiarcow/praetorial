#!/usr/bin/env python3
"""EXP2: history-independent "the current release record covers the current source" check, shared by
resolver/release/check_record_covers_source.py (RR6) and contracts/escrow/release/check_record_covers_source.py (JC1r).

Which record is current: the committed pointer <release dir>/CURRENT (one line, the record's file name). Git
timestamps are NOT used to pick it, so a squashed tree (every file added in one commit) still selects it.
When history exists the pointer must not be stale: it must name a record added by the most recent commit that
added any record-*.json (adding a record without moving CURRENT fails).

What "covers" means, both must hold:
  1. commit check (today's behaviour, only when the record's `commit` is in the repo): `git diff <commit> <ref>`
     is empty for the covered paths.
  2. content check (always): the per-file sha256 digests of the covered paths now (working tree when ref is HEAD,
     else the tree at ref) equal the record's `source` block. A record without a `source` block fails.
     The content may instead match a rebuild record: a record-*.json with `rebuild_of` = the current record, the
     same `hash`, >=3 identical builds, and its own matching `source` (the public export writes one, because its
     name rewrites change comments in covered files; the wasm hash is unchanged and was rebuilt to prove it).
If the commit is absent (squashed export) only the content check decides; it still fails on any changed byte.

Usage:
  covers_source.py check <resolver|escrow> [--repo DIR] [--ref HEAD]
  covers_source.py source <resolver|escrow> [--repo DIR] [--ref REF]        print the `source` block for REF's tree
  covers_source.py stamp <resolver|escrow> <record.json> [--repo DIR]       add `source` (computed at the record's commit)
  covers_source.py rebuild-record <resolver|escrow> <out.json> --of <record-name> --commit SHA --image-digest D
                   --build ROUTE=SHA256 [--build ...] [--note TEXT] [--repo DIR]   (source computed at --commit)
"""
import argparse, fnmatch, hashlib, json, os, re, stat, subprocess, sys

SCHEME = "praetorial-source-v1: files[path] = '<git mode> <sha256 of bytes>'; digest = sha256 of the sorted lines '<mode> <sha256> <path>\\n'"

# include = path prefixes; exclude = fnmatch patterns (records, the pointer and release tooling: not build inputs)
COMPONENTS = {
    "resolver": {
        "rel": "resolver/release",
        "include": ["resolver/"],
        "exclude": ["resolver/release/*"],
    },
    "escrow": {
        "rel": "contracts/escrow/release",
        "include": ["contracts/escrow/", "contracts/Cargo.toml", "contracts/Cargo.lock", "contracts/rust-toolchain.toml", "contracts/.cargo/"],
        # build_reproducible.sh (the recipe) stays covered; records, CURRENT and the python checks/tests do not.
        "exclude": ["contracts/escrow/release/record-*.json", "contracts/escrow/release/CURRENT", "contracts/escrow/release/*.py"],
    },
}


def git(repo, *a, inp=None):
    return subprocess.run(["git", "-C", repo, *a], capture_output=True, input=inp)


def covered(comp, path):
    c = COMPONENTS[comp]
    if not any(path == p or (p.endswith("/") and path.startswith(p)) for p in c["include"]):
        return False
    return not any(fnmatch.fnmatchcase(path, x) for x in c["exclude"])


def pathspecs(comp):
    c = COMPONENTS[comp]
    return [p.rstrip("/") for p in c["include"]] + [f":(exclude){x}" for x in c["exclude"]]


def manifest(repo, ref, comp, worktree):
    """{path: '<mode> <sha256>'} for the covered files tracked at ref; bytes from the working tree if worktree."""
    r = git(repo, "ls-tree", "-r", "-z", "--full-tree", ref)
    if r.returncode:
        raise RuntimeError(f"git ls-tree {ref} failed: {r.stderr.decode().strip()}")
    entries = []
    for e in r.stdout.decode().split("\0"):
        if not e:
            continue
        meta, path = e.split("\t", 1)
        mode, typ, oid = meta.split()
        if typ == "blob" and covered(comp, path):
            entries.append((path, mode, oid))
    out = {}
    if worktree:
        for path, _, _ in entries:
            p = os.path.join(repo, path)
            if not os.path.lexists(p):
                out[path] = "missing -"
                continue
            st = os.lstat(p)
            if stat.S_ISLNK(st.st_mode):
                mode, data = "120000", os.readlink(p).encode()
            else:
                mode, data = ("100755" if st.st_mode & 0o111 else "100644"), open(p, "rb").read()
            out[path] = f"{mode} {hashlib.sha256(data).hexdigest()}"
        return out
    if entries:
        b = git(repo, "cat-file", "--batch", inp="".join(f"{oid}\n" for _, _, oid in entries).encode())
        buf, i = b.stdout, 0
        for path, mode, _ in entries:
            nl = buf.index(b"\n", i)
            size = int(buf[i:nl].split()[2])
            data = buf[nl + 1:nl + 1 + size]
            i = nl + 1 + size + 1
            out[path] = f"{mode} {hashlib.sha256(data).hexdigest()}"
    return out


def digest(files):
    lines = "".join(f"{files[p]} {p}\n" for p in sorted(files))
    return hashlib.sha256(lines.encode()).hexdigest()


def source_block(files):
    return {"scheme": SCHEME, "digest": digest(files), "files": dict(sorted(files.items()))}


def diff_paths(want, have):
    return sorted(p for p in set(want) | set(have) if want.get(p) != have.get(p))


def show(repo, ref, path):
    r = git(repo, "show", f"{ref}:{path}")
    return r.stdout.decode() if r.returncode == 0 else None


def records_at(repo, ref, rel):
    r = git(repo, "ls-tree", "--name-only", f"{ref}:{rel}")
    return sorted(n for n in r.stdout.decode().split() if re.fullmatch(r"record-.*\.json", n))


def is_rebuild(repo, ref, path):
    b = show(repo, ref, path)
    try:
        return b is not None and "rebuild_of" in json.loads(b)
    except ValueError:
        return False


def last_added_records(repo, ref, rel):
    """Release records (not rebuild records) added by the most recent commit reachable from ref that added any;
    None if there is no such history. In a squashed tree that is every record, so the pointer decides."""
    r = git(repo, "log", ref, "--diff-filter=A", "--format=%x00%H", "--name-only", "--", f"{rel}/record-*.json")
    for grp in (g.split() for g in r.stdout.decode().split("\0") if g.strip()):
        names = {os.path.basename(p) for p in grp[1:] if not is_rebuild(repo, ref, p)}
        if names:
            return names
    return None


def builds_ok(rec):
    bs = rec.get("builds") or []
    return len(bs) >= 3 and {b.get("sha256") for b in bs} == {rec.get("hash")}


def check(repo, comp, ref="HEAD"):
    """-> (errors, current record path or None)."""
    rel = COMPONENTS[comp]["rel"]
    ptr = show(repo, ref, f"{rel}/CURRENT")
    if ptr is None:
        return [f"no {rel}/CURRENT pointer (it names the current {comp} release record)"], None
    name = ptr.strip()
    rec_path = f"{rel}/{name}"
    if not re.fullmatch(r"record-[^/]+\.json", name) or name not in records_at(repo, ref, rel):
        return [f"{rel}/CURRENT names {name!r}, which is not a record in {rel}"], rec_path
    last = last_added_records(repo, ref, rel)
    if last is not None and name not in last:
        return [f"stale pointer: {rel}/CURRENT names {name} but the newest added record is {', '.join(sorted(last))}"], rec_path
    rec = json.loads(show(repo, ref, rec_path))
    errs = []
    commit = str(rec.get("commit", ""))
    if commit and git(repo, "cat-file", "-e", f"{commit}^{{commit}}").returncode == 0:
        d = git(repo, "diff", "--name-only", commit, ref, "--", *pathspecs(comp))
        if d.returncode:
            return [f"git diff failed: {d.stderr.decode().strip()}"], rec_path
        files = d.stdout.decode().split()
        if files:
            errs.append(f"{rec_path} (commit {commit[:7]}) is stale; changed since: " + ", ".join(files[:8]) + (" ..." if len(files) > 8 else ""))
        how = f"commit {commit[:7]} + content"
    else:
        how = f"content (commit {commit[:7] or '?'} not in repo)"
    if "source" not in rec:
        errs.append(f"{rec_path} has no `source` digests (add them: scripts/release/covers_source.py stamp {comp} {rec_path})")
        return errs, rec_path
    have = manifest(repo, ref, comp, worktree=(ref == "HEAD"))
    hd = digest(have)
    if rec["source"].get("digest") == hd and rec["source"].get("files") == have:
        return errs, rec_path
    for other in records_at(repo, ref, rel):
        if other == name:
            continue
        o = json.loads(show(repo, ref, f"{rel}/{other}"))
        if o.get("rebuild_of") == name and o.get("hash") == rec.get("hash") and builds_ok(o) \
                and o.get("source", {}).get("digest") == hd and o["source"].get("files") == have:
            print(f"{comp}: source matches rebuild record {rel}/{other} (rebuild_of {name}, same wasm {rec['hash'][:8]})")
            return errs, rec_path
    changed = diff_paths(rec["source"].get("files", {}), have)
    errs.append(f"{rec_path}: {how}: source differs from the record in {len(changed)} file(s): "
                + ", ".join(changed[:8]) + (" ..." if len(changed) > 8 else ""))
    return errs, rec_path


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["check", "source", "stamp", "rebuild-record"])
    ap.add_argument("comp", choices=sorted(COMPONENTS))
    ap.add_argument("file", nargs="?")
    ap.add_argument("--repo", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
    ap.add_argument("--ref", default="HEAD")
    ap.add_argument("--of"); ap.add_argument("--commit"); ap.add_argument("--image-digest")
    ap.add_argument("--build", action="append", default=[]); ap.add_argument("--note", default="")
    a = ap.parse_args(argv)
    repo = os.path.abspath(a.repo)
    if a.cmd == "check":
        errs, rec = check(repo, a.comp, a.ref)
        for e in errs:
            print("STALE:", e, file=sys.stderr)
        if not errs:
            print(f"{a.comp} record covers current source: {rec}")
        return 1 if errs else 0
    if a.cmd == "source":
        print(json.dumps(source_block(manifest(repo, a.ref, a.comp, worktree=False)), indent=2))
        return 0
    if a.cmd == "stamp":
        rec = json.load(open(a.file))
        rec["source"] = source_block(manifest(repo, rec["commit"], a.comp, worktree=False))
        open(a.file, "w").write(json.dumps(rec, indent=2) + "\n")
        print(f"stamped {a.file}: source digest {rec['source']['digest']} ({len(rec['source']['files'])} files @ {rec['commit'][:7]})")
        return 0
    # rebuild-record
    builds = [dict(zip(("route", "sha256"), b.split("=", 1))) for b in a.build]
    hs = {b["sha256"] for b in builds}
    if len(builds) < 3 or len(hs) != 1:
        print(f"rebuild-record: need >=3 identical builds, got {builds}", file=sys.stderr)
        return 1
    rec = {"repo": "praetorial (public export)", "commit": a.commit, "rebuild_of": a.of,
           "image_digest": a.image_digest, "platform": "linux/amd64", "hash": hs.pop(), "builds": builds,
           "notes": {"item": a.note}, "source": source_block(manifest(repo, a.commit, a.comp, worktree=False))}
    of = show(repo, a.commit, f"{COMPONENTS[a.comp]['rel']}/{a.of}")
    if of is None or "source" not in json.loads(of):
        print(f"rebuild-record: {a.of} has no `source` digests at {a.commit}", file=sys.stderr)
        return 1
    want, have = json.loads(of)["source"]["files"], rec["source"]["files"]
    rec["differs_from"] = {  # exact, computed: what in the covered tree differs from the record this rebuilds
        "record": a.of,
        "changed": sorted(p for p in want if p in have and want[p] != have[p]),
        "absent": sorted(set(want) - set(have)),
        "added": sorted(set(have) - set(want)),
    }
    open(a.file, "w").write(json.dumps(rec, indent=2) + "\n")
    print(f"wrote {a.file}: rebuild_of {a.of}, hash {rec['hash']}, source digest {rec['source']['digest']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
