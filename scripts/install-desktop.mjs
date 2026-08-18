import { access, cp, mkdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Installing in place is a macOS idea: the build is a self-contained bundle
// that only has to be moved into an Applications folder. Windows installs
// through the generated setup program instead, so say that rather than failing
// later on a path that was never going to exist.
if (process.platform !== "darwin") {
  console.error(
    "npm run desktop:install installs the macOS app bundle and only runs on macOS.",
  );
  console.error(
    process.platform === "win32"
      ? "On Windows run npm run desktop:exe, then run the installer it writes to src-tauri/target/release/bundle/nsis/."
      : "See DESKTOP.md for the platforms Folio builds for.",
  );
  process.exit(1);
}

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
