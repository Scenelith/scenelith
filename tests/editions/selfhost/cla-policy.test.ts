import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();
const publicRoot = existsSync(join(root, ".github/workflows/cla.yml")) ? root : join(root, "deploy/selfhost/repository");
const source = (path: string) => readFileSync(join(publicRoot, path), "utf8");

test("external human pull requests are gated by the versioned CLA record", () => {
  const workflow = source(".github/workflows/cla.yml");
  assert.match(workflow, /pull_request_target:/);
  assert.match(workflow, /pull_request\.author_association/);
  assert.match(workflow, /OWNER\|MEMBER\|COLLABORATOR\) exit 0/);
  assert.match(workflow, /signature_path="\.github\/cla-signatures\/v1\/\$\{PR_AUTHOR\}\.json"/);
  assert.match(workflow, /\.github\/cla-signature-template\.json/);
  assert.match(workflow, /\.version == "1\.0"/);
  assert.match(workflow, /\.githubLogin == \$login/);
  assert.match(workflow, /\.signature == \.legalName/);
  assert.match(workflow, /may not change another contributor's CLA signature/);
  assert.doesNotMatch(workflow, /actions\/checkout|pull_request\.head\.ref/);
  assert.doesNotMatch(workflow, /permissions:\s*[\s\S]*contents:\s*write/);
});

test("the CLA preserves contributor ownership while covering Cloud and relicensing", () => {
  const agreement = readFileSync(join(root, "CLA.md"), "utf8");
  assert.match(agreement, /retain all ownership rights/i);
  assert.match(agreement, /hosted Cloud editions/i);
  assert.match(agreement, /relicense/i);
  assert.match(agreement, /patent license/i);
  assert.match(agreement, /employer or another entity/i);
});

test("public contribution instructions make the CLA mandatory for external contributors without a size exemption", () => {
  const contributionGuide = readFileSync(join(root, "CONTRIBUTING.md"), "utf8");
  const pullRequestTemplate = source(".github/PULL_REQUEST_TEMPLATE.md");
  assert.match(contributionGuide, /Every external human contributor must have the current Scenelith Individual Contributor License Agreement/);
  assert.match(contributionGuide, /there is no size-based exemption/);
  assert.match(pullRequestTemplate, /\.github\/cla-signatures\/v1\/MY-GITHUB-LOGIN\.json/);
});
