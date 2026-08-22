# Distribution architecture

`Scenelith/scenelith` is the canonical product repository. The public source is not an exported artifact: product fixes, provider adapters, schema changes, recipes, and community pull requests land here first.

## Repository direction

```text
Scenelith/scenelith (public canonical core)
                 │
                 │ pinned commit + verified one-way sync
                 ▼
Scenelith/scenelith-cloud (private hosted extension)
```

The hosted repository may add deployment, account, support-tier, usage-policy, and payment integrations through declared extension paths. It must not become a second implementation of the canvas or media pipeline. A lock file records the exact public commit consumed by each hosted build, and CI rejects undeclared drift in public-owned paths.

Nothing flows automatically from the private repository into public source. This prevents private files, credentials, infrastructure addresses, commercial policy, or hosted-only dependencies from crossing the boundary.

## Public ownership

The public repository owns:

- canvas, nodes, identities, project library, and portable documents;
- image/video generation orchestration and provider registry;
- TikTok import and automation;
- authentication, workspaces, teams, and community features;
- PostgreSQL, Redis, storage, workers, and realtime collaboration;
- self-host deployment, backup, restore, upgrade, and release tooling;
- `.scenelith.json` schema, migrations, and recipes.

Provider-specific network calls are reachable only through `src/platform/providers/registry.ts`. Runtime variation is exposed through narrow contracts in `src/distribution/` and `src/modules/usage/`; public defaults are complete self-host implementations, not placeholders that require the hosted product.

## Private extension ownership

The private hosted repository owns only hosted-product concerns, including payment providers, hosted account policy, private operations integrations, internal deployment configuration, and commercial usage rules. Those files can implement public extension contracts, but public components never import them directly.

Public changes are pulled into the hosted repository at a reviewed commit. Hosted changes never rewrite public-owned files unless the change is first contributed to the public repository. This gives the company one implementation to maintain while keeping private business and infrastructure data outside public history.

## Runtime and release boundary

The self-hosted runtime calls only operator-configured providers and infrastructure. It contains no hosted payment routes, private credentials, or license server. PostgreSQL is authoritative for accounts, workspaces, projects, jobs, audit events, and collaboration projections. Redis carries ephemeral coordination. Media stays in a local volume or operator-owned S3-compatible storage.

Every release reruns the direct repository boundary audit, tests, production build, and full Compose exercise. A version tag publishes one multi-architecture application image with SBOM and provenance attestations; web, workers, migrations, and collaboration run that same image with role-specific commands.
