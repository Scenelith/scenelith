import {
  GetBucketCorsCommand,
  PutBucketCorsCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const supportedArguments = new Set(["--check", "--dry-run"]);
const argumentsList = process.argv.slice(2);
for (const argument of argumentsList) {
  if (!supportedArguments.has(argument)) throw new Error(`Unknown option: ${argument}`);
}
const checkOnly = argumentsList.includes("--check");
const dryRun = argumentsList.includes("--dry-run");
if (checkOnly && dryRun) throw new Error("--check and --dry-run cannot be used together");

const environment = { ...process.env };
const selfhostEnvironmentPath = resolve(import.meta.dirname, "../deploy/selfhost/.env");
if (existsSync(selfhostEnvironmentPath)) {
  for (const rawLine of readFileSync(selfhostEnvironmentPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator > 0 && environment[line.slice(0, separator)] === undefined) {
      environment[line.slice(0, separator)] = line.slice(separator + 1);
    }
  }
}

function secret(name) {
  const file = environment[`${name}_FILE`];
  return file ? readFileSync(file, "utf8").trim() : environment[name];
}

const s3 = String(environment.STORAGE_PROVIDER || "").toLowerCase() === "s3";
const accountId = environment.R2_ACCOUNT_ID;
const accessKeyId = secret(s3 ? "S3_ACCESS_KEY_ID" : "R2_ACCESS_KEY_ID");
const secretAccessKey = secret(s3 ? "S3_SECRET_ACCESS_KEY" : "R2_SECRET_ACCESS_KEY");
const buckets = [...new Set([
  environment[s3 ? "S3_PRIVATE_BUCKET" : "R2_PRIVATE_BUCKET"],
  environment[s3 ? "S3_PUBLIC_BUCKET" : "R2_PUBLIC_BUCKET"],
].filter(Boolean))];

if ((!s3 && !accountId) || !accessKeyId || !secretAccessKey) {
  throw new Error(s3
    ? "S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required"
    : "R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are required");
}
if (!buckets.length) throw new Error(`At least one ${s3 ? "S3" : "R2"} bucket is required`);

const configuredOrigins = String(environment.STORAGE_CORS_ORIGINS || environment.R2_CORS_ORIGINS || environment.PUBLIC_URL || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean)
  .map((value) => {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
      throw new Error(`Storage CORS origin must be scheme://host[:port] without a path: ${value}`);
    }
    return url.origin;
  });

if (!configuredOrigins.length) throw new Error("PUBLIC_URL or STORAGE_CORS_ORIGINS is required");

const client = new S3Client({
  region: s3 ? environment.S3_REGION || "us-east-1" : "auto",
  endpoint: s3 ? environment.S3_ENDPOINT : `https://${accountId}.r2.cloudflarestorage.com`,
  forcePathStyle: s3 ? String(environment.S3_FORCE_PATH_STYLE || "false").toLowerCase() === "true" : false,
  credentials: { accessKeyId, secretAccessKey },
});

const managedRuleId = "scenelith-browser-media-v1";
const managedRule = {
  ID: managedRuleId,
  AllowedOrigins: configuredOrigins,
  AllowedMethods: ["GET", "HEAD", "PUT"],
  AllowedHeaders: ["content-type", "range"],
  ExposeHeaders: ["etag", "content-length", "content-range"],
  MaxAgeSeconds: 3600,
};

function sameValues(actual = [], expected = []) {
  return [...actual].map(String).sort().join("\n") === [...expected].map(String).sort().join("\n");
}

function matchesManagedRule(rule) {
  return rule?.ID === managedRule.ID
    && sameValues(rule.AllowedOrigins, managedRule.AllowedOrigins)
    && sameValues(rule.AllowedMethods, managedRule.AllowedMethods)
    && sameValues(rule.AllowedHeaders, managedRule.AllowedHeaders)
    && sameValues(rule.ExposeHeaders, managedRule.ExposeHeaders)
    && Number(rule.MaxAgeSeconds) === managedRule.MaxAgeSeconds;
}

for (const bucket of buckets) {
  if (dryRun || environment.STORAGE_CORS_DRY_RUN === "1" || environment.R2_CORS_DRY_RUN === "1") {
    console.log(JSON.stringify({ bucket, managedRule }, null, 2));
    continue;
  }
  let existing = [];
  try {
    existing = (await client.send(new GetBucketCorsCommand({ Bucket: bucket }))).CORSRules || [];
  } catch (error) {
    const status = error?.$metadata?.httpStatusCode;
    if (status !== 404 && error?.name !== "NoSuchCORSConfiguration") throw error;
  }
  const currentManagedRule = existing.find((rule) => rule.ID === managedRuleId);
  if (checkOnly) {
    if (!matchesManagedRule(currentManagedRule)) {
      throw new Error(`${s3 ? "S3-compatible" : "R2"} CORS is missing or stale for ${bucket}. Run ./scenelith storage configure-cors.`);
    }
    console.log(`${s3 ? "S3-compatible" : "R2"} CORS verified for ${bucket}`);
    continue;
  }
  if (matchesManagedRule(currentManagedRule)) {
    console.log(`${s3 ? "S3-compatible" : "R2"} CORS already configured for ${bucket}`);
    continue;
  }
  const preserved = existing.filter((rule) => rule.ID !== managedRuleId);
  const rules = [...preserved, managedRule];
  await client.send(new PutBucketCorsCommand({
    Bucket: bucket,
    CORSConfiguration: { CORSRules: rules },
  }));
  const verified = (await client.send(new GetBucketCorsCommand({ Bucket: bucket }))).CORSRules || [];
  if (!verified.some(matchesManagedRule)) throw new Error(`CORS verification failed for ${bucket}`);
  console.log(`${s3 ? "S3-compatible" : "R2"} CORS configured and verified for ${bucket}; ${preserved.length} unrelated rule(s) preserved`);
}
