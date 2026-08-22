import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { argument, composeArgs, requireEnvironment, root, runDocker, sha256 } from "./selfhost-operations.mjs";

const sourceArgument = argument("--from");
if (!sourceArgument) throw new Error("Usage: npm run selfhost:restore -- --from /absolute/backup/path --confirm");
if (!process.argv.includes("--confirm")) throw new Error("Restore replaces the current database and local media. Re-run with --confirm after verifying the backup path.");

const source = resolve(root, sourceArgument);
const manifestPath = resolve(source, "manifest.json");
if (!existsSync(manifestPath)) throw new Error(`Backup manifest is missing: ${manifestPath}`);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest.schemaVersion !== 1 || manifest.distribution !== "scenelith-selfhost-backup") throw new Error("Unsupported backup manifest");
function safeManifestFile(value, label) {
  if (typeof value !== "string" || value !== basename(value) || !/^[a-zA-Z0-9._-]+$/.test(value)) {
    throw new Error(`Unsafe ${label} filename in backup manifest`);
  }
  return value;
}

const databaseDump = resolve(source, safeManifestFile(manifest.database?.file, "database"));
if (!existsSync(databaseDump) || sha256(databaseDump) !== manifest.database.sha256) throw new Error("Database backup checksum mismatch");
const mediaArchive = manifest.storage?.media ? resolve(source, safeManifestFile(manifest.storage.media.file, "media")) : null;
if (mediaArchive && (!existsSync(mediaArchive) || sha256(mediaArchive) !== manifest.storage.media.sha256)) throw new Error("Media backup checksum mismatch");

const environment = requireEnvironment();
const database = environment.get("POSTGRES_DB") || "scenelith";
const user = environment.get("POSTGRES_USER") || "scenelith";
const currentStorageProvider = (environment.get("STORAGE_PROVIDER") || "local").toLowerCase();
if (String(manifest.storage?.provider || "local").toLowerCase() !== currentStorageProvider) {
  throw new Error(`Backup storage provider ${manifest.storage?.provider || "local"} does not match current provider ${currentStorageProvider}`);
}

runDocker(composeArgs("stop", "gateway", "frameflow", "generation-worker", "automation-worker", "storage-worker", "collaboration"));
runDocker(composeArgs("up", "-d", "--wait", "postgres"));
runDocker(composeArgs("exec", "-T", "postgres", "psql", "-U", user, "-d", database, "-v", "ON_ERROR_STOP=1", "-c", "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"));

const databaseFd = openSync(databaseDump, "r");
try {
  runDocker(composeArgs("exec", "-T", "postgres", "pg_restore", "-U", user, "-d", database, "--no-owner", "--no-acl", "--exit-on-error"), {
    stdio: [databaseFd, "inherit", "inherit"],
  });
} finally {
  closeSync(databaseFd);
}

if (mediaArchive) {
  runDocker(composeArgs("run", "--rm", "--no-deps", "-v", `${source}:/backup:ro`, "storage-worker", "sh", "-c", `find /app/data -mindepth 1 -delete && tar -xzf /backup/${manifest.storage.media.file} -C /app/data`));
}

runDocker(composeArgs("up", "-d"));
console.log(`Restore complete from ${source}`);
