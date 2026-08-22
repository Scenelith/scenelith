import { createServer } from "node:net";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

function commandPath(name) {
  const direct = spawnSync("sh", ["-lc", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
  if (direct) return direct;
  const pgConfig = spawnSync("sh", ["-lc", "command -v pg_config"], { encoding: "utf8" }).stdout.trim();
  if (pgConfig) {
    const bindir = spawnSync(pgConfig, ["--bindir"], { encoding: "utf8" }).stdout.trim();
    const candidate = join(bindir, name);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`${name} is required for PostgreSQL integration tests (or set TEST_DATABASE_URL)`);
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}

const temporaryRoot = mkdtempSync(join(tmpdir(), "scenelith-tests-"));
let pgCtl;
let pgData;
let databaseUrl = process.env.TEST_DATABASE_URL || "";
try {
  if (!databaseUrl) {
    const initdb = commandPath("initdb");
    pgCtl = commandPath("pg_ctl");
    const createdb = commandPath("createdb");
    pgData = join(temporaryRoot, "postgres");
    const port = await freePort();
    run(initdb, ["-D", pgData, "-A", "trust", "-U", "postgres", "--no-locale"]);
    // Linux packages default Unix sockets to /var/run/postgresql, which is not
    // writable by an unprivileged CI user. Keep the disposable socket beside
    // the disposable data directory on every platform.
    run(pgCtl, ["-D", pgData, "-o", `-F -p ${port} -h 127.0.0.1 -k ${temporaryRoot}`, "-w", "start"]);
    run(createdb, ["-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "scenelith_test"]);
    databaseUrl = `postgresql://postgres@127.0.0.1:${port}/scenelith_test`;
  }

  const env = {
    ...process.env,
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    COLLABORATION_DATABASE_URL: databaseUrl,
    TEST_DATABASE_URL: databaseUrl,
    COLLABORATION_INTERNAL_SECRET: "",
    COLLABORATION_INTERNAL_URL: "",
    STORAGE_PROVIDER: "local",
    STORAGE_PATH: join(temporaryRoot, "storage"),
    PATH: process.env.PATH?.split(delimiter).join(delimiter),
  };
  run(process.execPath, ["database/migrate.mjs"], { env });
  run(process.execPath, ["collaboration/migrate.mjs"], { env });
  const excludedTests = new Set(process.argv.flatMap((value, index, values) => value === "--exclude" ? [values[index + 1]] : []).filter(Boolean));
  const tests = readdirSync("tests")
    .filter((name) => name.endsWith(".test.ts") && !excludedTests.has(name))
    .sort()
    .map((name) => join("tests", name));
  const testProcess = spawn(join("node_modules", ".bin", "tsx"), ["--test", "--test-concurrency=1", ...tests], {
    env,
    stdio: "inherit",
  });
  const exitCode = await new Promise((resolve) => testProcess.once("exit", (code) => resolve(code ?? 1)));
  process.exitCode = exitCode;
} finally {
  if (pgCtl && pgData) spawnSync(pgCtl, ["-D", pgData, "-m", "fast", "-w", "stop"], { stdio: "inherit" });
  rmSync(temporaryRoot, { recursive: true, force: true });
}
