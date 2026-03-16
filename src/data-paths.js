const fs = require("fs");
const path = require("path");

const projectRoot = path.join(__dirname, "..");
const defaultDataDir = path.join(projectRoot, "data");

function ensureDirectoryExists(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function resolveBaseDataDir() {
  return path.resolve(process.env.OPENSEARCH_DATA_DIR || defaultDataDir);
}

function resolveDataDir() {
  const baseDir = resolveBaseDataDir();
  const strategy = process.env.OPENSEARCH_DATA_DIR_STRATEGY || "";

  if (strategy === "per-process") {
    return ensureDirectoryExists(path.join(baseDir, `pid-${process.pid}`));
  }

  return ensureDirectoryExists(baseDir);
}

function resolveDataFile(filename, envVarName) {
  const explicitPath = envVarName ? process.env[envVarName] : "";
  const filePath = explicitPath
    ? path.resolve(explicitPath)
    : path.join(resolveDataDir(), filename);

  ensureDirectoryExists(path.dirname(filePath));
  return filePath;
}

function resolveStateDir() {
  const explicitPath = process.env.OPENSEARCH_STATE_DIR || "";
  const stateDir = explicitPath ? path.resolve(explicitPath) : resolveDataDir();
  return ensureDirectoryExists(stateDir);
}

module.exports = {
  ensureDirectoryExists,
  resolveDataDir,
  resolveDataFile,
  resolveStateDir
};
