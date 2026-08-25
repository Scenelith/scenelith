# Contributing to Scenelith

Thank you for improving Scenelith. This public repository is the canonical source for the canvas, media pipeline, providers, collaboration, storage, workers, local self-hosted authentication, and portable recipe format. Accepted changes merge here directly; there is no generated public mirror or private import bridge. Teams, invitations, transactional email, billing, support and other hosted account services belong only to the private Cloud edition.

## Start with the right channel

- Use **Discussions** for setup questions, recipe ideas, and concepts that still need shaping.
- Open a **feature request** for a focused product outcome.
- Open a **bug report** for reproducible behavior in the latest release.
- Use a **private security advisory** for suspected vulnerabilities.

## Pull requests

Before opening a pull request:

1. read `docs/DEVELOPMENT_MODEL.md` and decide whether the change is shared, self-host-only or Cloud-only;
2. read `CLA.md` and add the versioned signature record described in `.github/cla-signatures/README.md`;
3. explain the user or operator problem and keep the change focused;
4. add or update tests for behavior changes;
5. run `npm ci`, `npm run selfhost:audit`, `npm test`, and `npm run build`;
6. do not include provider keys, environment files, user media, database dumps, private URLs, or instance data;
7. do not rewrite an applied database migration;
8. document new provider connections and every outbound network destination.

Product, runtime, provider, documentation, recipe, and deployment improvements are all welcome. Changes to security boundaries, workflows, licensing, migrations, or portable document compatibility receive additional maintainer review.

Every human contributor must have the current Scenelith Individual Contributor License Agreement on file before a pull request can merge. The required status check validates the signed GitHub record for every pull request; there is no size-based exemption. Contributors acting for an employer or another rights holder must arrange the appropriate entity authorization with the maintainers first.

## Architecture rules

- Keep provider transports behind `src/platform/providers/registry.ts`.
- Keep payment, hosted-account, and private infrastructure code outside this repository.
- Define optional edition behavior through `src/editions/contracts/`, implement the public policy in `src/editions/selfhost/`, and keep `src/editions/current/` as thin selectors. Shared components must not import a concrete self-hosted or private implementation.
- Keep `.scenelith.json` backward compatible. Add a new format version and migration path before changing an existing document contract.
- Keep recipes credential-free, media-free, portable, and valid against the current document schema.
- Never add an automatic connection to a Scenelith-operated service to the self-hosted runtime.

## Review and release flow

1. A pull request is reviewed in this repository.
2. CLA, boundary, test, build, and self-host runtime checks must pass.
3. The change merges into `main`, which remains the single source of shared product behavior.
4. A signed version tag builds the multi-architecture container with an SBOM and provenance attestation.
5. The private hosted-product repository updates its pinned public-core commit and adds only its declared extension modules.

Maintainers never copy the same shared feature into two independent implementations.
