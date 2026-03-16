const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const projectRoot = path.join(__dirname, "..");
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "opensearch-tests-"));
const dataRoot = path.join(testRoot, "data");

const child = spawn(process.execPath, ["--test"], {
  cwd: projectRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    OPENSEARCH_DATA_DIR: dataRoot,
    OPENSEARCH_DATA_DIR_STRATEGY: "per-process"
  }
});

function cleanup() {
  fs.rmSync(testRoot, { recursive: true, force: true });
}

child.on("exit", (code, signal) => {
  cleanup();
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  cleanup();
  console.error(error);
  process.exit(1);
});
