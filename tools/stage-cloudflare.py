"""Copy just the shippable site into .cf-dist/ for `wrangler deploy`.

Whitelist, not blacklist: anything not named here (experiments/, docs/, Temp/,
tools/, the master zip...) is never uploaded.
"""
import os, shutil

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir)
OUT = os.path.join(ROOT, ".cf-dist")
FILES = ["index.html", "manifest.webmanifest", "service-worker.js"]
DIRS = ["css", "js", "assets", "icons", "data"]

if os.path.isdir(OUT):
    shutil.rmtree(OUT)
os.makedirs(OUT)
for f in FILES:
    shutil.copy2(os.path.join(ROOT, f), os.path.join(OUT, f))
for d in DIRS:
    shutil.copytree(os.path.join(ROOT, d), os.path.join(OUT, d))
count = sum(len(fs) for _, _, fs in os.walk(OUT))
print(f"staged {count} files into {os.path.abspath(OUT)}")
