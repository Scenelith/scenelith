# Distribution architecture

`Scenelith/scenelith` is the canonical source for every feature shared by the self-hosted and Cloud products. It is not generated from the private repository.

## Repository direction

```text
Scenelith/scenelith (public, canonical)
                 │
                 │ immutable commit, tree and file hashes
                 ▼
Scenelith/scenelith-cloud (private Cloud edition)
```

Shared fixes land in public first. The private repository consumes a reviewed public commit and adds Cloud-owned modules. No exporter or reverse sync copies private source into public history.

## Edition boundary

Shared runtime code imports only stable contracts or `src/editions/current/*`.

```text
src/editions/
├── contracts/       stable server, client, access, worker and runtime types
├── selfhost/        complete public policies and implementations
└── current/         thin edition selectors
```

The Cloud repository supplies private implementations under `src/cloud/` and overrides only the thin selectors in `src/editions/current/`. Shared modules never import `src/cloud/` or `src/editions/selfhost/` directly. CI enforces this dependency direction.

Server, client, worker and request-edge selectors are separate so Node-only dependencies and secrets cannot enter browser or edge bundles. Edition UI is a registry of optional components; absent self-hosted surfaces are not dummy feature implementations.

## Public ownership

The public repository owns:

- canvas, nodes, identities, library and portable documents;
- image and video generation, editing and provider adapters;
- TikTok import and automation;
- local account sessions and owner workspaces;
- storage, workers, observability and realtime collaboration;
- self-host deployment, backup, restore, upgrade and release tooling;
- public recipes and document formats.

Self-hosted supports owner-only or explicitly open local registration. It has no team invitations, transactional email, password recovery email, product support inbox, feature-request board, notifications, billing, affiliate program or Cloud marketing site. It calls only infrastructure and providers configured by the operator.

## Private Cloud ownership

The private repository owns:

- subscriptions, credit accounting, checkout and payment webhooks;
- managed provider credentials and commercial pricing policy;
- email verification, password recovery and transactional delivery;
- teams, invitations, grants and managed member accounts;
- support, feature requests, notifications and administration;
- affiliate attribution, Cloud landing pages and internal deployment.

These modules may depend on public contracts and core services. Public code cannot depend on them.

## Database ownership

New installations do not replay the historical mixed migration chain.

```text
database/
├── legacy/                 immutable compatibility history
├── baselines/core-v1.sql   clean self-hosted schema
└── migrations/core/        future shared expand-only migrations
```

The private edition adds its own Cloud baseline and `migrations/cloud/` stream. Fresh self-hosted databases install only the core baseline. Fresh Cloud databases install the Cloud baseline. Existing databases keep their original checksummed legacy migrations and then join the namespaced stream ledger. Applied legacy files and baselines are immutable.

The self-hosted baseline contains no billing, team, invitation, recovery-token, support, feature-request or notification tables.

## Promotion and release

1. A shared change is reviewed and merged in public.
2. Public CI validates boundaries, schema, tests, production build and self-hosted Compose.
3. A Cloud integration pull request pins the exact public commit.
4. Cloud CI composes private adapters, dependencies, schema and tests without modifying shared files.
5. Cloud deployment and public self-hosted releases remain separate promotion decisions.

Every application role in one distribution runs the same versioned image. PostgreSQL, Redis and the gateway remain independently pinned infrastructure images.
