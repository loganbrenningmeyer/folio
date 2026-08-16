import { access, cp, mkdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const source = join(
  projectRoot,
  "src-tauri",
  "target",
  "release",
  "bundle",
  "macos",
  "Folio.app",
);
const installRoot = resolve(
  process.env.FOLIO_INSTALL_DIR || join(homedir(), "Applications"),
);
const target = join(installRoot, "Folio.app");
const staging = join(installRoot, `.Folio.app.installing-${process.pid}`);
const backup = join(installRoot, `.Folio.app.previous-${process.pid}`);

try {
  await access(source);
} catch {
  throw new Error(`The built app was not found at ${source}. Run npm run desktop:build first.`);
}

await mkdir(installRoot, { recursive: true });
await rm(staging, { recursive: true, force: true });
await cp(source, staging, { recursive: true, preserveTimestamps: true });

let replacedExistingApp = false;
try {
  await rename(target, backup);
  replacedExistingApp = true;
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

try {
  await rename(staging, target);
  if (replacedExistingApp) {
    await rm(backup, { recursive: true, force: true });
  }
} catch (error) {
  await rm(staging, { recursive: true, force: true });
  if (replacedExistingApp) await rename(backup, target);
  throw error;
}

console.log(`Installed Folio at ${target}`);
console.log("Open it from Finder, Spotlight, or Launchpad.");
