import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { argument, composeArgs, requireEnvironment, root, runDocker, sha256 } from "./selfhost-operations.mjs";

const environment = requireEnvironment();
const timestamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
const backupRoot = resolve(root, argument("--output") || "backups");
const destination = resolve(backupRoot, `scenelith-${timestamp}`);
mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
mkdirSync(destination, { recursive: false, mode: 0o700 });

const database = environment.get("POSTGRES_DB") || "scenelith";
const user = environment.get("POSTGRES_USER") || "scenelith";
const databaseDump = resolve(destination, "postgres.dump");
let media = null;
let completed = false;
try {
  // Database rows and local media form one logical snapshot. Quiesce every
  // writer so a lifecycle worker cannot remove an object between pg_dump and
  // the media archive.
  runDocker(composeArgs("stop", "gateway", "frameflow", "generation-worker", "automation-worker", "storage-worker", "collaboration"));
  runDocker(composeArgs("up", "-d", "--wait", "postgres"));
  const databaseFd = openSync(databaseDump, "wx", 0o600);
  try {
    runDocker(composeArgs("exec", "-T", "postgres", "pg_dump", "-U", user, "-d", database, "--format=custom", "--compress=6", "--no-owner", "--no-acl"), {
      stdio: ["ignore", databaseFd, "inherit"],
    });
  } finally {
    closeSync(databaseFd);
  }

  const storageProvider = (environment.get("STORAGE_PROVIDER") || "local").toLowerCase();
  if (storageProvider === "local") {
    const mediaArchive = resolve(destination, "media.tar.gz");
    runDocker(composeArgs("run", "--rm", "--no-deps", "-v", `${destination}:/backup`, "storage-worker", "tar", "-czf", "/backup/media.tar.gz", "-C", "/app/data", "."));
    media = { file: basename(mediaArchive), sha256: sha256(mediaArchive) };
  }

  let release = null;
  try {
    const packageMetadata = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    release = { version: packageMetadata.version };
  } catch {}
  const manifest = {
    schemaVersion: 1,
    distribution: "scenelith-selfhost-backup",
    createdAt: new Date().toISOString(),
    release,
    database: { file: basename(databaseDump), sha256: sha256(databaseDump), name: database },
    storage: { provider: storageProvider, media },
  };
  writeFileSync(resolve(destination, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  completed = true;
} finally {
  runDocker(composeArgs("up", "-d"));
}

if (!completed) throw new Error("Backup did not complete");
console.log(`Backup complete: ${destination}`);
if ((environment.get("STORAGE_PROVIDER") || "local").toLowerCase() !== "local") console.log("Media is stored externally and was not copied; retain the object-storage version/snapshot covering this timestamp.");
