import { randomBytes } from "node:crypto";
import { chmod, copyFile, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const examplePath = resolve(root, "deploy/selfhost/.env.example");
const targetPath = resolve(root, "deploy/selfhost/.env");

try {
  await copyFile(examplePath, targetPath, constants.COPYFILE_EXCL);
} catch (error) {
  if (error?.code === "EEXIST") {
    console.error("deploy/selfhost/.env already exists; refusing to overwrite its secrets");
    process.exit(1);
  }
  throw error;
}

let contents = await readFile(targetPath, "utf8");
for (const key of ["POSTGRES_PASSWORD", "SESSION_SECRET", "COLLABORATION_JWT_SECRET", "COLLABORATION_INTERNAL_SECRET"]) {
  contents = contents.replace(new RegExp(`^${key}=$`, "m"), `${key}=${randomBytes(32).toString("base64url")}`);
}
await writeFile(targetPath, contents, { mode: 0o600 });
await chmod(targetPath, 0o600);
console.log("Created deploy/selfhost/.env with unique secrets.");
console.log("Add KIE_API_KEY and OPENROUTER_API_KEY, then run: npm run selfhost:up");
