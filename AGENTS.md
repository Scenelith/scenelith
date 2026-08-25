# Scenelith development rules

Read `docs/DEVELOPMENT_MODEL.md` and `docs/DISTRIBUTION_ARCHITECTURE.md` before changing product code, database schema, dependencies, deployment files, or release automation.

## Repository role

This public repository is the canonical source for all behavior shared by Scenelith Cloud and self-hosted Scenelith. It is also the complete self-hosted product. The private Cloud repository consumes a reviewed, immutable commit from this repository and adds private edition modules.

Never implement the same shared feature independently in both repositories. Shared work lands here first and reaches Cloud through the private `Update public core` workflow.

## Decide ownership before editing

- Canvas, nodes, projects, identities, media processing, providers, portable documents, workers, storage, collaboration and shared observability belong here.
- Self-host deployment, local accounts, owner workspaces, bring-your-own-provider behavior, backups, restores and public releases belong here.
- Billing, credits, checkout, managed provider credentials, email delivery, password recovery, teams, invitations, support, feature requests, notifications, affiliates, Cloud marketing and private operations belong only in `Scenelith/scenelith-cloud`.
- When behavior varies by edition, put the shared contract in `src/editions/contracts/`, the complete public implementation in `src/editions/selfhost/`, and keep `src/editions/current/` as thin selectors. Cloud supplies its implementation privately.

Shared modules may import edition contracts or `src/editions/current/*`. They must not import a self-host or Cloud implementation directly. Do not add environment-condition branches throughout shared product code as a substitute for an edition boundary.

## Database and release rules

- Never edit an applied migration, legacy migration, or released baseline.
- Shared expand-only migrations go in `database/migrations/core/`. Cloud-only schema changes go in the private Cloud migration stream.
- A green `main` commit is not a self-hosted release. Users receive a change only after the version, example environment, signed tag, release image and release notes agree.
- Do not add credentials, real provider payloads, user data, private URLs, dumps, media or runtime `.env` files.

## Required verification

For public changes, run the checks appropriate to the change, with the full gate being:

```bash
npm ci
npm run selfhost:audit
npm test
npm run build
```

Changes to Compose, persistence, collaboration, authentication, migrations or releases must also preserve the complete self-hosted distribution gate in `.github/workflows/runtime.yml`.

After a shared commit merges and public CI is green, a maintainer explicitly runs the private `Update public core` workflow with the full public commit SHA. Review and merge the generated Cloud PR; never copy shared files manually.
