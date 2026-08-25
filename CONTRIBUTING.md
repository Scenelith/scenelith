# Contributing to Scenelith

Thank you for improving Scenelith. This public repository is the canonical source for the canvas, media pipeline, providers, collaboration, storage, workers, authentication, teams, and portable recipe format. Accepted changes merge here directly; there is no generated public mirror or private import bridge.

## Start with the right channel

- Use **Discussions** for setup questions, recipe ideas, and concepts that still need shaping.
- Open a **feature request** for a focused product outcome.
- Open a **bug report** for reproducible behavior in the latest release.
- Use a **private security advisory** for suspected vulnerabilities.

## Pull requests

Before opening a pull request:

1. if You are contributing from outside the Scenelith GitHub organization, read `CLA.md` and add the versioned signature record described in `.github/cla-signatures/README.md`;
2. explain the user or operator problem and keep the change focused;
3. add or update tests for behavior changes;
4. run `npm ci`, `npm run selfhost:audit`, `npm test`, and `npm run build`;
5. do not include provider keys, environment files, user media, database dumps, private URLs, or instance data;
6. do not rewrite an applied database migration;
7. document new provider connections and every outbound network destination.

Product, runtime, provider, documentation, recipe, and deployment improvements are all welcome. Changes to security boundaries, workflows, licensing, migrations, or portable document compatibility receive additional maintainer review.

Every external human contributor must have the current Scenelith Individual Contributor License Agreement on file before a pull request can merge. Repository owners and members of the Scenelith GitHub organization are maintainers of the product and are exempt. For external contributions, the required status check validates the signed GitHub record for every pull request and there is no size-based exemption. Contributors acting for an employer or another rights holder must arrange the appropriate entity authorization with the maintainers first.

## Architecture rules

- Keep provider transports behind `src/platform/providers/registry.ts`.
- Keep payment, hosted-account, and private infrastructure code outside this repository.
- Add optional distribution behavior through narrow files in `src/distribution/`; shared components must not import a private implementation.
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
