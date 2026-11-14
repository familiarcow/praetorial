"""Full cryptographic verification of a NEAR AI Cloud attestation receipt.

Builds on verify_attest.py (sig/quote-binding checks already done there) and adds:
  1. Intel DCAP quote verification against Intel PCS collateral (via `dcap_qvl` pip pkg,
     Phala's Rust bindings) -> chains Attestation Key -> PCK cert -> Intel Root CA.
  2. MRTD / RTMR0-3 extraction from the TDX quote + exact byte-level replay of the
     dstack event_log against them (RTMR0-2: firmware/kernel chain; RTMR3: runtime
     events, digest = sha384(event_type_LE32 || ":" || event_name || ":" || payload),
     per github.com/near/mpc crates/attestation and github.com/Dstack-TEE/private-ai-gateway).
  3. Tinfoil SEV-SNP guest report (gunzipped from model_attestations[0].router.report_b64):
     manual ATTESTATION_REPORT struct parse (AMD SEV-SNP ABI) + VCEK chain verification
     (VCEK -> ASK -> ARK, ARK self-signed) against AMD's public KDS collateral, then
     ECDSA P-384/SHA-384 verification of the report signature with the VCEK public key.
  4. model_entry.registers cross-check (expected to NOT match SEV-SNP measurement -- see
     note in PASS/FAIL output; registers are TDX RTMR-shaped values from a *different*
     tdx-guest replica, not comparable to this SEV-SNP replica's measurement).

Run: python3 verify_full.py   (needs: pip install dcap-qvl cryptography; needs network
for Intel PCS + AMD KDS collateral fetch, both public/anonymous endpoints, no NEAR AI calls.)
"""
import json, hashlib, base64, gzip, struct, asyncio, warnings, os
warnings.filterwarnings("ignore")

HERE = os.path.dirname(os.path.abspath(__file__))

def load(name):
    with open(os.path.join(HERE, name)) as f:
        return json.load(f)

results = []
def check(label, ok, detail=""):
    results.append((label, ok, detail))
    print(f"[{'PASS' if ok else 'FAIL'}] {label}" + (f" -- {detail}" if detail else ""))


def part_1_dcap():
    import dcap_qvl, time
    att = load("att.json")
    quote = bytes.fromhex(att["gateway_attestation"]["intel_quote"])

    async def run():
        coll = await dcap_qvl.get_collateral_from_pcs(quote)
        res = dcap_qvl.verify(quote, coll, int(time.time()))
        return res

    try:
        res = asyncio.run(run())
        check("1. DCAP quote verified against Intel PCS collateral (Intel Root CA chain)",
              True, f"status={res.status}, advisories={res.advisory_ids}")
    except Exception as e:
        check("1. DCAP quote verified against Intel PCS collateral (Intel Root CA chain)",
              False, repr(e))
        return None
    return quote


def part_2_rtmr(quote):
    import dcap_qvl
    att = load("att.json")
    g = att["gateway_attestation"]
    ev = json.loads(g["event_log"]) if isinstance(g["event_log"], str) else g["event_log"]

    q = dcap_qvl.parse_quote(quote)
    rep = q.report
    mrtd = rep.mr_td.hex()
    quote_rtmrs = {0: rep.rt_mr0.hex(), 1: rep.rt_mr1.hex(), 2: rep.rt_mr2.hex(), 3: rep.rt_mr3.hex()}
    check("2a. MRTD / RTMR0-3 extracted from TDX quote", True, f"MRTD={mrtd[:16]}...")

    def dstack_event_digest(event_type, event, payload):
        h = hashlib.sha384()
        h.update(event_type.to_bytes(4, "little"))
        h.update(b":")
        h.update(event.encode())
        h.update(b":")
        h.update(payload)
        return h.digest()

    DSTACK_RUNTIME_EVENT_TYPE = 134217729  # 0x08000001

    for imr in range(4):
        mr = b"\x00" * 48
        for e in ev:
            if e["imr"] != imr:
                continue
            if e["event_type"] == DSTACK_RUNTIME_EVENT_TYPE:
                payload = bytes.fromhex(e["event_payload"]) if e["event_payload"] else b""
                d = dstack_event_digest(e["event_type"], e["event"], payload)
            else:
                d = bytes.fromhex(e["digest"]) if e["digest"] else b"\x00" * 48
            mr = hashlib.sha384(mr + d).digest()
        match = mr.hex() == quote_rtmrs[imr]
        check(f"2b. RTMR{imr} event_log replay matches quote RTMR{imr}", match,
              f"replayed={mr.hex()[:16]}... quote={quote_rtmrs[imr][:16]}...")

    # cross-link: compose-hash event -> mr_config_id, app-id/instance-id -> info.*
    rtmr3 = [e for e in ev if e["imr"] == 3]
    ch = next((e["event_payload"] for e in rtmr3 if e["event"] == "compose-hash"), None)
    mrcfg = rep.mr_config_id.hex()
    check("2c. compose-hash event payload is the preimage bound into mr_config_id",
          ch is not None and ch in mrcfg, f"compose-hash={ch}")
    app_id_evt = next((e["event_payload"] for e in rtmr3 if e["event"] == "app-id"), None)
    check("2d. app-id event matches gateway_attestation.info.app_id",
          app_id_evt == g["info"]["app_id"], f"{app_id_evt} vs {g['info']['app_id']}")


def amd_verify_rsa(child, issuer_pubkey):
    from cryptography.hazmat.primitives.asymmetric import padding
    from cryptography.exceptions import InvalidSignature
    try:
        issuer_pubkey.verify(
            child.signature, child.tbs_certificate_bytes,
            padding.PSS(mgf=padding.MGF1(child.signature_hash_algorithm),
                        salt_length=child.signature_hash_algorithm.digest_size),
            child.signature_hash_algorithm,
        )
        return True
    except InvalidSignature:
        return False


def part_3_snp():
    from cryptography import x509
    from cryptography.hazmat.backends import default_backend
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
    from cryptography.exceptions import InvalidSignature

    att = load("att.json")
    router = att["model_attestations"][0]["router"]
    dec = gzip.decompress(base64.b64decode(router["report_b64"]))
    check("3a. SEV-SNP report gunzip + size == ATTESTATION_REPORT struct (1184B)", len(dec) == 1184)

    measurement = dec[144:144 + 48].hex()
    report_data = dec[80:80 + 64].hex()
    check("3b. report.measurement matches router.measurement field", measurement == router["measurement"])

    vcek = x509.load_der_x509_certificate(base64.b64decode(router["vcek_b64"]), default_backend())
    with open(os.path.join(HERE, "genoa_chain.pem"), "rb") as f:
        chain_pem = f.read()
    if b"BEGIN CERTIFICATE" not in chain_pem:
        import subprocess
        subprocess.run(["curl", "-s", "https://kdsintf.amd.com/vcek/v1/Genoa/cert_chain",
                         "-o", os.path.join(HERE, "genoa_chain.pem")], check=True)
        with open(os.path.join(HERE, "genoa_chain.pem"), "rb") as f:
            chain_pem = f.read()
    parts = [c + b"-----END CERTIFICATE-----" for c in chain_pem.split(b"-----END CERTIFICATE-----") if b"BEGIN CERTIFICATE" in c]
    ask = x509.load_pem_x509_certificate(parts[0], default_backend())
    ark = x509.load_pem_x509_certificate(parts[1], default_backend())

    check("3c. ARK (AMD root, Genoa) is self-signed -- trust anchor", amd_verify_rsa(ark, ark.public_key()))
    check("3d. ASK signed by ARK", amd_verify_rsa(ask, ark.public_key()))
    check("3e. VCEK (leaf, bound to this chip+TCB) signed by ASK", amd_verify_rsa(vcek, ask.public_key()))

    msg = dec[0:672]
    sig = dec[672:672 + 512]
    r = int.from_bytes(sig[0:72][::-1].lstrip(b"\x00"), "big")
    s = int.from_bytes(sig[72:144][::-1].lstrip(b"\x00"), "big")
    der_sig = encode_dss_signature(r, s)
    try:
        vcek.public_key().verify(der_sig, msg, ec.ECDSA(hashes.SHA384()))
        check("3f. SEV-SNP report signature (ECDSA P-384) valid under VCEK pubkey", True)
    except InvalidSignature:
        check("3f. SEV-SNP report signature (ECDSA P-384) valid under VCEK pubkey", False)

    model_entry = att["model_attestations"][0]["model_entry"]
    regs = model_entry.get("registers", [])
    reg_match = measurement in regs
    check("3g. (informational) SEV-SNP measurement appears in model_entry.registers",
          reg_match,
          "expected False: registers[] are measurements of the tdx-guest replicas listed "
          "in model_entry.replicas, a *different* attestation format than this pinned "
          "sev-snp-guest replica -- not directly comparable, not a failure of this receipt")


def main():
    print("=== Part A verification: NEAR AI Cloud attestation receipt ===\n")
    quote = part_1_dcap()
    if quote:
        part_2_rtmr(quote)
    part_3_snp()
    print("\n=== Summary ===")
    n_pass = sum(1 for _, ok, _ in results if ok)
    for label, ok, _ in results:
        print(f"{'PASS' if ok else 'FAIL'}  {label}")
    print(f"\n{n_pass}/{len(results)} checks passed (3g intentionally expected False, see detail above)")


if __name__ == "__main__":
    main()
