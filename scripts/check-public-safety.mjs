#!/usr/bin/env node
/**
 * check-public-safety.mjs — pre-commit secret + sensitive-path scanner.
 *
 * This repository is public, so before committing we scan exactly the files that
 * *would* be committed (tracked modified/added + untracked non-ignored), plus a
 * `git ls-files` sanity pass over the whole index to catch anything that slipped
 * in earlier.
 *
 * Exit codes: 0 = clean, 1 = [BLOCKER] found, 2 = [WARN]-only.
 *
 * [BLOCKER] means "do not commit": a real-looking secret value, a path that
 * should never be published, or an exact secret-storage location.
 * [WARN] means "review with a human": placeholders, example domains, and long
 * base64-ish blobs that are usually lockfile/integrity noise.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const REPO = process.cwd();
const SELF = "scripts/check-public-safety.mjs";

/** Values that look like real credentials. Never commit these. */
const BLOCKER_RE = [
  [/gh[pousr]_[A-Za-z0-9]{30,}/, "GitHub token"],
  [/sk-[A-Za-z0-9]{20,}/, "OpenAI/DeepSeek-style API key"],
  [/hf_[A-Za-z0-9]{20,}/, "HuggingFace token"],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/, "Slack token"],
  [/AKIA[0-9A-Z]{16}/, "AWS access key id"],
  [/AIza[0-9A-Za-z_-]{30,}/, "Google API key"],
  [/-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/, "PEM private key"],
  [/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./, "JWT"],
];

/** Paths that must never appear in the commit set. */
const BAD_PATH_RE = [
  [/^docs\/safe\//, "docs/safe/ (internal docs — gitignored, never published)"],
  [/(^|\/)logs\//, "logs/ directory"],
  [/(^|\/)safe\//, "safe/ directory (OAuth client secrets)"],
  [/(^|\/)tokens\//, "tokens/ directory (OAuth refresh tokens)"],
  [/(^|\/)node_modules\//, "node_modules"],
  [/(^|\/)dist\//, "build output"],
  [/(^|\/)release\//, "electron-builder output"],
  [/(^|\/)storage\//, "storage/ directory"],
  [/(^|\/)queue\//, "queue/ directory"],
  [/(^|\/)data\/local\//, "local user data"],
  [/\.db(-wal|-shm|-journal)?$/, "SQLite database"],
  [/(^|\/)study\.db/i, "application database"],
  [/(^|\/)ui-state\.json$/, "UI state file"],
  [/(^|\/)config\.json$/, "machine-local config (may hold API keys)"],
  [/(^|\/)config\.defaults\.json$/, "machine-local defaults snapshot"],
  [/\.tsbuildinfo$/, "TypeScript build info"],
];

/** Exact secret-storage locations. Publishing these maps where keys live. */
const SECRET_PATH_RE = [
  [/\/Library\/Application Support\//, "macOS app-data path"],
  [/%APPDATA%/, "Windows app-data path"],
  [/(^|\/)\.config\/[A-Za-z]/, "Linux app-config path"],
  [/Application Support\/Study Aide/, "app config directory"],
];

/** Files that are intentionally committed despite matching a bad-path shape. */
const ALLOWED_PATHS = new Set([".env.example", ".env.template", "config.example.json"]);

/** Placeholders and example values — review, don't block. */
const WARN_RE = [
  [/sk-your-key-here|sk-xxxxx|your-api-key|your_token|REPLACE_ME|xxxxx/i, "placeholder key"],
  [/YOURDOMAIN|yourdomain|chat\.example\.com|example\.com/i, "example domain"],
  [/ghp_[A-Za-z0-9]{6,}\.{3}/, "truncated/placeholder GitHub token"],
  [/[A-Za-z0-9+/]{45,}={0,2}/, "long base64 blob"],
];

let blockers = [];
let warns = [];

function git(cmd) {
  return execSync(cmd, { cwd: REPO, encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function scanFile(file) {
  if (file === SELF) return; // the scanner must not flag its own pattern definitions
  const isLockfile = /package-lock\.json$/.test(file);

  let content;
  try {
    content = fs.readFileSync(path.join(REPO, file), "utf8");
  } catch {
    return; // deleted, or not a regular file
  }

  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const snippet = line.trim().slice(0, 120);
    for (const [re, label] of BLOCKER_RE) {
      if (re.test(line)) blockers.push({ file, line: index + 1, label, snippet });
    }
    // Lockfiles legitimately carry sha512 integrity hashes — skip WARN noise there,
    // but always run the BLOCKER patterns above.
    if (isLockfile) continue;
    for (const [re, label] of WARN_RE) {
      if (re.test(line)) warns.push({ file, line: index + 1, label, snippet });
    }
    for (const [re, label] of SECRET_PATH_RE) {
      if (re.test(line)) blockers.push({ file, line: index + 1, label, snippet });
    }
  }
}

function pathCheck(file) {
  if (ALLOWED_PATHS.has(file)) return;
  for (const [re, label] of BAD_PATH_RE) {
    if (re.test(file)) blockers.push({ file, line: 1, label, snippet: file });
  }
  for (const [re, label] of SECRET_PATH_RE) {
    if (re.test(file)) blockers.push({ file, line: 1, label, snippet: file });
  }
}

const modified = git("git diff --name-only --diff-filter=ACM HEAD");
const untracked = git("git ls-files --others --exclude-standard");
const tracked = git("git ls-files");

const commitSet = new Set([...modified, ...untracked]);
for (const file of commitSet) {
  pathCheck(file);
  scanFile(file);
}
// Sanity pass over already-tracked files, to catch anything committed earlier.
for (const file of tracked) {
  if (!commitSet.has(file)) scanFile(file);
}

const dedupe = (findings) =>
  findings.filter(
    (finding, index) =>
      findings.findIndex(
        (other) =>
          other.file === finding.file && other.line === finding.line && other.label === finding.label,
      ) === index,
  );

blockers = dedupe(blockers);
warns = dedupe(warns);

console.log(
  `\nPublic-safety scan — ${commitSet.size} file(s) in commit set (${tracked.length} tracked total)`,
);

if (!blockers.length && !warns.length) {
  console.log("Clean — no secret values or sensitive paths found.\n");
  process.exit(0);
}

if (blockers.length) {
  console.log(`\n[BLOCKER] ${blockers.length} finding(s) — DO NOT COMMIT:`);
  for (const finding of blockers) {
    console.log(`  ${finding.file}:${finding.line} — ${finding.label}\n      ${finding.snippet}`);
  }
}

if (warns.length) {
  console.log(`\n[WARN] ${warns.length} finding(s) — review before proceeding:`);
  for (const warning of warns) {
    console.log(`  ${warning.file}:${warning.line} — ${warning.label}\n      ${warning.snippet}`);
  }
}

console.log();
process.exit(blockers.length ? 1 : 2);
