// scripts/check-core-isolation.mjs
// Verifies that src/core does NOT import any network, process, or storage Node.js APIs.

import fs from "node:fs";
import path from "node:path";

const CORE_DIR = path.resolve("src/core");
const FORBIDDEN_MODULES = [
  "fs", "node:fs", "fs/promises", "node:fs/promises",
  "http", "node:http", "https", "node:https", "http2", "node:http2",
  "net", "node:net", "dgram", "node:dgram",
  "child_process", "node:child_process",
  "cluster", "node:cluster",
  "process", "node:process"
];

function checkFile(filePath) {
  const content = fs.readFileSync(filePath, "utf-8");
  const importRegex = /(?:import|from|require)\s*['"]([^'"]+)['"]/g;
  let match;
  const violations = [];
  while ((match = importRegex.exec(content)) !== null) {
    const mod = match[1];
    if (FORBIDDEN_MODULES.includes(mod)) {
      violations.push(mod);
    }
  }
  return violations;
}

function walkDir(dir) {
  let files = [];
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files = files.concat(walkDir(full));
    } else if (/\.(ts|js|mjs)$/.test(entry.name) && !entry.name.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

const files = walkDir(CORE_DIR);
let failed = false;

for (const file of files) {
  const rel = path.relative(process.cwd(), file);
  const violations = checkFile(file);
  if (violations.length > 0) {
    console.error(`FAIL: Core isolation violation in ${rel}: imports forbidden [${violations.join(", ")}]`);
    failed = true;
  }
}

if (failed) {
  console.error("\nCore isolation check failed: src/core must be pure domain logic with NO process/network/storage imports.");
  process.exit(1);
} else {
  console.log(`PASS: Core isolation verified across ${files.length} core files.`);
}
