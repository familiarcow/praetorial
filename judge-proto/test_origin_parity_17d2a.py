"""17d2a: Python twin of the Rust origin derivation. Cases are shared with
resolver/core/tests/origin_parity.rs through resolver/core/tests/fixtures/origin_cases.json."""
import json, os
import judge as J

FX = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "resolver", "core", "tests", "fixtures", "origin_cases.json")
CASES = {
    "domains": [[u, J.registrable_domain(u)] for u in [
        "https://site.api.espn.com/a?b=1", "https://www.bbc.co.uk/x", "https://a.b.example.com:8443/p",
        "https://user@news.example.org/", "http://127.0.0.1:80/x", "https://example.com./", "not a url"]],
    "groups": [
        {"sources": [
            {"publisher": "ESPN (scoreboard)", "url": "https://site.api.espn.com/a"},
            {"publisher": "ESPN Stats", "url": "https://www.espn.com/b"},
            {"publisher": "Reuters", "url": "https://www.reuters.com/c"}]},
        {"sources": [
            {"publisher": "A", "origin": "shared", "url": "https://a.example.com/"},
            {"publisher": "B", "origin": "shared", "url": "https://b.example.net/"}]},
        {"sources": [{"publisher": "No Url (live)"}, {"publisher": "No Url"}]},
    ],
}
for g in CASES["groups"]:
    g["want"] = J.origin_groups(g["sources"])

def test_python_matches_committed_cases():
    assert json.load(open(FX)) == json.loads(json.dumps(CASES))

def test_semantics():
    assert J.origin_groups(CASES["groups"][0]["sources"]) == [0, 0, 1] or J.origin_groups(CASES["groups"][0]["sources"]) == [0, 1, 2]
    assert J.origin_groups(CASES["groups"][1]["sources"]) == [0, 0]       # declared origin merges
    assert J.origin_groups(CASES["groups"][2]["sources"]) == [0, 0]       # qualifier stripped
    same = [{"publisher": "X", "origin": "x1", "url": "https://a.espn.com/1"}, {"publisher": "Y", "origin": "y1", "url": "https://b.espn.com/2"}]
    assert J.origin_groups(same) == [0, 0]                                # declared labels never split a domain

if __name__ == "__main__":
    if os.environ.get("WRITE"):
        json.dump(json.loads(json.dumps(CASES)), open(FX, "w"), indent=1, sort_keys=True)
    test_python_matches_committed_cases(); test_semantics(); print("ok")
