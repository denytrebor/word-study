"""Read-only check of the LIVE Firestore rules (creates and changes no data).

    python tools/verify-live-rules.py

Signs in anonymously (like the app does) and sends requests whose outcome tells us
which rules are published. Deleting a document that does not exist is a safe probe:
Firestore checks the rules first.
"""
import json, re, sys, urllib.request, urllib.error, os

HERE = os.path.dirname(os.path.abspath(__file__))
cfg = open(os.path.join(HERE, "..", "js", "firebase-config.js"), encoding="utf-8").read()
KEY = re.search(r'apiKey: "([^"]+)"', cfg).group(1)
PROJ = re.search(r'projectId: "([^"]+)"', cfg).group(1)
H = {"Content-Type": "application/json", "Referer": "https://wordstudy.trebor.me/", "Origin": "https://wordstudy.trebor.me"}
BASE = f"https://firestore.googleapis.com/v1/projects/{PROJ}/databases/(default)/documents"


def call(url, method="GET", token=None, body=None):
    h = dict(H)
    if token:
        h["Authorization"] = "Bearer " + token
    req = urllib.request.Request(url, data=(json.dumps(body).encode() if body is not None else None), headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


st, b = call(f"https://identitytoolkit.googleapis.com/v1/accounts:signUp?key={KEY}", "POST", body={"returnSecureToken": True})
tok = json.loads(b)["idToken"]
Z64 = "0" * 64
CID = "zzzzzzzzzzzzzzzzzzzz"

family = [
    ("LIST households denied", "GET", f"{BASE}/households?pageSize=1", 403),
    ("LIST students denied", "GET", f"{BASE}/students?pageSize=1", 403),
    ("LIST catalogs denied", "GET", f"{BASE}/catalogs?pageSize=1", 403),
    ("GET a household by code allowed", "GET", f"{BASE}/households/ZZNOPE9", 404),
    ("DELETE a catalog week allowed", "DELETE", f"{BASE}/catalogs/ZZNOPE9/weeks/w1", 200),
    ("DELETE a profile doc allowed", "DELETE", f"{BASE}/households/ZZNOPE9/profiles/p1", 200),
    ("DELETE progress denied", "DELETE", f"{BASE}/households/ZZNOPE9/profiles/p1/progress/w1", 403),
    ("DELETE activity denied", "DELETE", f"{BASE}/households/ZZNOPE9/profiles/p1/activity/d1", 403),
    ("DELETE a student doc denied", "DELETE", f"{BASE}/students/ZZNOPE9", 403),
    ("DELETE a household denied", "DELETE", f"{BASE}/households/ZZNOPE9", 403),
]
school = [  # these only pass once the NEW rules are published
    ("school: GET an unknown class -> 404 (allowed)", "GET", f"{BASE}/classes/{CID}", 404),
    ("school: GET an unknown card hash -> 404 (allowed)", "GET", f"{BASE}/studentCodes/{Z64}", 404),
    ("school: GET an unknown key hash -> 404 (allowed)", "GET", f"{BASE}/classKeys/{Z64}", 404),
    ("school: LIST classes denied", "GET", f"{BASE}/classes?pageSize=1", 403),
    ("school: LIST studentCodes denied", "GET", f"{BASE}/studentCodes?pageSize=1", 403),
    ("school: LIST classKeys denied", "GET", f"{BASE}/classKeys?pageSize=1", 403),
    ("school: stranger LIST a class roster denied", "GET", f"{BASE}/classes/{CID}/profiles?pageSize=1", 403),
    ("school: stranger READ a class student's progress denied", "GET", f"{BASE}/classes/{CID}/profiles/s1/progress/w1", 403),
    ("school: stranger DELETE a card denied", "DELETE", f"{BASE}/studentCodes/{Z64}", 403),
]
bad = 0
for group, tests in (("FAMILY behaviour (must always pass)", family), ("SCHOOL rules (pass only once published)", school)):
    print("\n" + group)
    for name, m, u, want in tests:
        s, _ = call(u, m, tok)
        ok = s == want
        if not ok:
            bad += 1
        print(("  PASS" if ok else "  DIFF"), s, "expected", want, "-", name)
s, _ = call(f"{BASE}/households/ZZNOPE9", "GET")
print("\n  " + ("PASS" if s in (401, 403) else "DIFF"), s, "no sign-in -> denied")
if s not in (401, 403):
    bad += 1
sys.exit(1 if bad else 0)
