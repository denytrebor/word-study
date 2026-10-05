// Runs tests.js against a LOCAL Firestore emulator. Usage: cd tools/rules-tests && npm test
// Needs Java: uses the portable JRE in tools/.jre (git-ignored) or the system one.
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..", "..");
const jreDir = path.join(root, "tools", ".jre");
let javaBin = "";
if (fs.existsSync(jreDir)) {
  const d = fs.readdirSync(jreDir).find((n) => n.startsWith("jdk-"));
  if (d) javaBin = path.join(jreDir, d, "bin");
}
const env = Object.assign({}, process.env);
const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path") || "PATH"; // Windows spells it "Path"
if (javaBin) env[pathKey] = javaBin + path.delimiter + (env[pathKey] || "");

const fb = path.join(__dirname, "node_modules", ".bin", process.platform === "win32" ? "firebase.cmd" : "firebase");
const r = spawnSync(
  fb,
  ["emulators:exec", "--config", path.join(root, "firebase.json"), "--project", "demo-wordstudy", "--only", "firestore", "node " + (process.argv[2] || "tests.js")],
  { cwd: __dirname, env, stdio: "inherit", shell: true }
);
process.exit(r.status === null ? 1 : r.status);
