import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const root = process.cwd();
const currentVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string;
const nextVersion = currentVersion.replace(/(\d+)$/, (patch) => String(Number(patch) + 1));

function sha256(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function parseEnvironment(contents: string) {
  return new Map(contents
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
}

function createFakeDocker(directory: string) {
  const path = join(directory, "docker");
  writeFileSync(path, `#!/bin/sh
if [ "\${1:-}" = compose ] && [ "\${2:-}" = version ]; then
  printf '2.38.2\\n'
  exit 0
fi
printf '%s\\n' "$*" >> "\${SCENELITH_TEST_DOCKER_LOG}"
exit 0
`, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

function createFakeCurl(directory: string) {
  const path = join(directory, "curl");
  writeFileSync(path, `#!/bin/sh
destination=''
url=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) destination=$2; shift ;;
    http*) url=$1 ;;
  esac
  shift
done
case "$url" in
  *.sha256) cp "\${SCENELITH_TEST_CHECKSUM}" "$destination" ;;
  *) cp "\${SCENELITH_TEST_ARCHIVE}" "$destination" ;;
esac
`, { mode: 0o755 });
  chmodSync(path, 0o755);
}

test("the release bundle installs without Git, npm, or a host Node runtime", () => {
  execFileSync(process.execPath, ["scripts/build-selfhost-bundle.mjs"], { cwd: root, stdio: "pipe" });
  const archive = join(root, "dist/scenelith-selfhost.tar.gz");
  const temporary = mkdtempSync(join(tmpdir(), "scenelith-bundle-test-"));
  execFileSync("tar", ["-xzf", archive, "-C", temporary]);
  const bundle = join(temporary, "scenelith-selfhost");

  assert.equal(readdirSync(bundle).sort().join(","), "LICENSE.md,MANIFEST.sha256,README.md,config,deploy,docs,scenelith");
  assert.equal(statSync(join(bundle, "scenelith")).mode & 0o111, 0o111);
  assert.equal(statSync(join(bundle, "deploy/selfhost/.env.example")).isFile(), true);
  assert.equal(spawnSync("sh", ["-c", "test ! -e package.json && test ! -e .git && test ! -e deploy/selfhost/.env"], { cwd: bundle }).status, 0);

  const initialized = spawnSync("./scenelith", ["init"], { cwd: bundle, encoding: "utf8" });
  assert.equal(initialized.status, 0, initialized.stderr);
  const envPath = join(bundle, "deploy/selfhost/.env");
  const originalEnvironment = readFileSync(envPath, "utf8");
  const environment = parseEnvironment(originalEnvironment);
  const secrets = ["POSTGRES_PASSWORD", "SESSION_SECRET", "COLLABORATION_JWT_SECRET", "COLLABORATION_INTERNAL_SECRET", "SCENELITH_INTERNAL_METRICS_SECRET"]
    .map((key) => environment.get(key));
  assert.equal(new Set(secrets).size, secrets.length);
  for (const secret of secrets) assert.match(secret || "", /^[a-f0-9]{64}$/);
  assert.equal(statSync(envPath).mode & 0o077, 0);

  const secondInitialize = spawnSync("./scenelith", ["init"], { cwd: bundle, encoding: "utf8" });
  assert.notEqual(secondInitialize.status, 0);
  assert.equal(readFileSync(envPath, "utf8"), originalEnvironment);

  const fakeBin = join(temporary, "bin");
  mkdirSync(fakeBin);
  createFakeDocker(fakeBin);
  const dockerLog = join(temporary, "docker.log");
  writeFileSync(dockerLog, "");
  const processEnvironment = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    SCENELITH_TEST_DOCKER_LOG: dockerLog,
  };
  const doctor = spawnSync("./scenelith", ["doctor", "--json"], { cwd: bundle, encoding: "utf8", env: processEnvironment });
  assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
  const report = JSON.parse(doctor.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.errors, 0);
  assert.equal(report.checks.some((check: { id: string }) => check.id === "configuration"), true);
  assert.deepEqual(report.checks.filter((check: { id: string }) => check.id.startsWith("provider:")).map((check: { id: string }) => check.id), ["provider:kie", "provider:openrouter", "provider:tikwm"]);

  const start = spawnSync("./scenelith", ["start"], { cwd: bundle, encoding: "utf8", env: processEnvironment });
  assert.equal(start.status, 0, start.stderr || start.stdout);
  const calls = readFileSync(dockerLog, "utf8");
  assert.match(calls, /compose .* pull/);
  assert.match(calls, /compose .* up -d --no-build --wait --wait-timeout 300/);

  const backupRoot = join(temporary, "backups");
  const backup = spawnSync("./scenelith", ["backup", "--output", backupRoot], { cwd: bundle, encoding: "utf8", env: processEnvironment });
  assert.equal(backup.status, 0, backup.stderr || backup.stdout);
  const backupDirectory = join(backupRoot, readdirSync(backupRoot)[0]);
  const manifest = JSON.parse(readFileSync(join(backupDirectory, "manifest.json"), "utf8"));
  assert.equal(manifest.distribution, "scenelith-selfhost-backup");
  assert.equal(manifest.storage.provider, "local");
  assert.equal(statSync(join(backupDirectory, "media.tar.gz")).isFile(), true);
  const restore = spawnSync("./scenelith", ["restore", "--from", backupDirectory, "--confirm"], { cwd: bundle, encoding: "utf8", env: processEnvironment });
  assert.equal(restore.status, 0, restore.stderr || restore.stdout);
});

test("source checkouts cannot overwrite themselves through the bundle updater", () => {
  const result = spawnSync("./scenelith", ["update"], { cwd: root, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Source checkouts update through Git/);
});

test("the public installer verifies and starts a release in a new directory", () => {
  execFileSync(process.execPath, ["scripts/build-selfhost-bundle.mjs"], { cwd: root, stdio: "pipe" });
  const temporary = mkdtempSync(join(tmpdir(), "scenelith-installer-test-"));
  const fakeBin = join(temporary, "bin");
  mkdirSync(fakeBin);
  createFakeCurl(fakeBin);
  createFakeDocker(fakeBin);
  const dockerLog = join(temporary, "docker.log");
  writeFileSync(dockerLog, "");
  const result = spawnSync(join(root, "install.sh"), [], {
    cwd: temporary,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      SCENELITH_TEST_ARCHIVE: join(root, "dist/scenelith-selfhost.tar.gz"),
      SCENELITH_TEST_CHECKSUM: join(root, "dist/scenelith-selfhost.tar.gz.sha256"),
      SCENELITH_TEST_DOCKER_LOG: dockerLog,
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(statSync(join(temporary, "scenelith/deploy/selfhost/.env")).mode & 0o077, 0);
  assert.match(readFileSync(dockerLog, "utf8"), /compose .* up -d --no-build --wait --wait-timeout 300/);
});

test("bundle updates preserve secrets, back up data, and move to one exact image version", () => {
  execFileSync(process.execPath, ["scripts/build-selfhost-bundle.mjs"], { cwd: root, stdio: "pipe" });
  const temporary = mkdtempSync(join(tmpdir(), "scenelith-update-test-"));
  execFileSync("tar", ["-xzf", join(root, "dist/scenelith-selfhost.tar.gz"), "-C", temporary]);
  const installation = join(temporary, "installation");
  execFileSync("cp", ["-R", join(temporary, "scenelith-selfhost"), installation]);
  assert.equal(spawnSync("./scenelith", ["init"], { cwd: installation }).status, 0);
  const envPath = join(installation, "deploy/selfhost/.env");
  const originalSecret = parseEnvironment(readFileSync(envPath, "utf8")).get("SESSION_SECRET");
  writeFileSync(envPath, readFileSync(envPath, "utf8")
    .replace(/^STORAGE_PROVIDER=.*$/m, "STORAGE_PROVIDER=s3")
    .replace(/^S3_ACCESS_KEY_ID=.*$/m, "S3_ACCESS_KEY_ID=test-access")
    .replace(/^S3_SECRET_ACCESS_KEY=.*$/m, "S3_SECRET_ACCESS_KEY=test-secret")
    .replace(/^S3_PRIVATE_BUCKET=.*$/m, "S3_PRIVATE_BUCKET=test-private")
    .replace(/^S3_PUBLIC_BUCKET=.*$/m, "S3_PUBLIC_BUCKET=test-public"), { mode: 0o600 });

  const incoming = join(temporary, "scenelith-selfhost");
  const incomingExample = join(incoming, "deploy/selfhost/.env.example");
  writeFileSync(incomingExample, readFileSync(incomingExample, "utf8").replace(/^SCENELITH_VERSION=.*$/m, `SCENELITH_VERSION=${nextVersion}`));
  const manifestPath = join(incoming, "MANIFEST.sha256");
  const manifest = readFileSync(manifestPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => {
    const path = line.slice(line.indexOf("  ") + 2);
    return `${sha256(join(incoming, path))}  ${path}`;
  }).join("\n");
  writeFileSync(manifestPath, `${manifest}\n`);
  const archive = join(temporary, "scenelith-selfhost.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", temporary, "scenelith-selfhost"]);
  const checksum = join(temporary, "scenelith-selfhost.tar.gz.sha256");
  writeFileSync(checksum, `${sha256(archive)}  scenelith-selfhost.tar.gz\n`);

  const fakeBin = join(temporary, "bin");
  mkdirSync(fakeBin);
  createFakeCurl(fakeBin);
  createFakeDocker(fakeBin);
  const dockerLog = join(temporary, "docker.log");
  writeFileSync(dockerLog, "");
  const updated = spawnSync("./scenelith", ["update"], {
    cwd: installation,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      SCENELITH_TEST_ARCHIVE: archive,
      SCENELITH_TEST_CHECKSUM: checksum,
      SCENELITH_TEST_DOCKER_LOG: dockerLog,
    },
  });
  assert.equal(updated.status, 0, updated.stderr || updated.stdout);
  const updatedEnvironment = parseEnvironment(readFileSync(envPath, "utf8"));
  assert.equal(updatedEnvironment.get("SCENELITH_VERSION"), nextVersion);
  assert.equal(updatedEnvironment.get("SESSION_SECRET"), originalSecret);
  assert.equal(readdirSync(join(installation, "backups")).length, 1);
  assert.match(readFileSync(dockerLog, "utf8"), /compose .* pull/);
});
