"""Copy just the shippable site into .cf-dist/ for `wrangler deploy`.

Whitelist, not blacklist: anything not named here (experiments/, docs/, Temp/,
tools/, the master zip...) is never uploaded.
"""
import os, shutil

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir)
OUT = os.path.join(ROOT, ".cf-dist")
FILES = ["index.html", "manifest.webmanifest", "service-worker.js"]
DIRS = ["css", "js", "assets", "icons", "data"]

# OneDrive can hold a lock on folders it is syncing, so clear files one by one
# and tolerate directories that refuse to be removed.
if os.path.isdir(OUT):
    for dirpath, _dirs, files in os.walk(OUT):
        for f in files:
            try:
                os.remove(os.path.join(dirpath, f))
            except OSError:
                pass
os.makedirs(OUT, exist_ok=True)
for f in FILES:
    shutil.copy2(os.path.join(ROOT, f), os.path.join(OUT, f))
for d in DIRS:
    shutil.copytree(os.path.join(ROOT, d), os.path.join(OUT, d), dirs_exist_ok=True)
count = sum(len(fs) for _, _, fs in os.walk(OUT))
print(f"staged {count} files into {os.path.abspath(OUT)}")
