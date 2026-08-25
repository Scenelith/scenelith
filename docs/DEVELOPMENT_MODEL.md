# Development model

This document is the operational source of truth for deciding where a Scenelith change belongs and how it moves between the public self-hosted product and the private Cloud product.

## One product core, two distributions

Scenelith does not maintain two independent copies of the product.

```text
public Scenelith core + self-host edition
                    │
                    │ reviewed immutable commit
                    ▼
public Scenelith core + private Cloud edition
```

`Scenelith/scenelith` is canonical for shared product behavior. `Scenelith/scenelith-cloud` vendors an exact reviewed public commit and adds private modules. The copy in Cloud is an integration artifact, not a second place where shared features are authored.

## Ownership decision table

| Change | Authoritative location | How Cloud receives it |
| --- | --- | --- |
| Canvas, nodes, projects, identities, media, providers, workers, storage, collaboration or portable documents | Public shared core | Verified public-core sync PR |
| Self-host setup, local accounts, operator keys, backups, restore or public release tooling | Public self-host edition | It normally does not; only shared contracts are synchronized |
| Billing, credits, checkout, managed provider keys or commercial policy | Private Cloud edition | Direct private change |
| Email verification, password recovery, teams, invitations, support, feature requests or notifications | Private Cloud edition | Direct private change |
| Cloud landing pages, affiliates, administration, production deployment or private observability | Private Cloud edition | Direct private change |
| A capability with different behavior in each distribution | Public contract plus edition implementations | Public contract is synchronized; Cloud implementation stays private |

If ownership is unclear, design the narrow public contract first. Do not solve uncertainty by adding Cloud imports to shared code or spreading `SCENELITH_DEPLOYMENT_TYPE` checks across unrelated modules.

## Shared change flow

1. Make and review the change in `Scenelith/scenelith`.
2. Public CI verifies the repository boundary, tests, production build and complete self-hosted Compose distribution.
3. Merge the public pull request.
4. In `Scenelith/scenelith-cloud`, explicitly run `Update public core` with the full reviewed public commit SHA.
5. The workflow copies the allowed public files, records commit/tree hashes, composes Cloud-owned package metadata, runs tests and opens a Cloud integration pull request.
6. Review and merge that generated pull request. Cloud then follows its independent release and deployment process.

No shared source file should be edited manually in the Cloud integration pull request. If integration exposes a shared defect, fix it publicly and synchronize a new commit.

The sync is intentionally explicit rather than hourly. Public merges do not silently rebuild or deploy Cloud, and Cloud can remain pinned while a public change is reviewed for hosted compatibility.

## Edition implementation pattern

The public repository defines stable boundaries:

```text
src/editions/contracts/   shared types and narrow interfaces
src/editions/selfhost/    complete public implementation
src/editions/current/     thin selectors for the active distribution
```

The private repository adds:

```text
src/cloud/                private services, policies and UI
src/app/(cloud)/          framework route entries for Cloud-only URLs
src/editions/current/     thin selectors pointing at private implementations
```

Shared code imports contracts or `src/editions/current/*`. Public self-host code never imports private modules. Private modules may depend on public contracts and core services.

An edition-specific implementation is not duplicated business logic. Shared algorithms remain public; adapters contain only the policy or integration that genuinely differs.

## Database changes

Fresh installations use edition-specific baselines. Existing installations retain immutable, checksummed compatibility history.

- Never modify a released baseline or applied migration.
- Put future shared, expand-only schema changes in `database/migrations/core/`.
- Put Cloud-only schema changes in the private `database/migrations/cloud/` stream.
- Do not add Cloud tables to the self-hosted baseline or core stream.
- Destructive cleanup requires an explicit compatibility and rollback plan; it is not hidden inside an ordinary feature pull request.

Files under `database/legacy/` exist only to verify and upgrade installations created before the edition split. A fresh self-hosted instance does not replay the mixed legacy chain.

## Releases are independent

Merging a shared change makes it available to both distributions' source, but does not release either distribution automatically.

- Public users receive it after a new signed version tag builds the public multi-architecture image.
- Cloud receives it after the pinned-core integration PR is reviewed, merged and promoted through private deployment.
- Package version, `deploy/selfhost/.env.example`, Git tag, container image and release notes must identify the same public release.

This separation permits urgent Cloud fixes without publishing private code and permits public self-host releases without silently changing production Cloud.

## Boundary and security rules

- Never commit real secrets or production data to either repository.
- Public code must not require a Scenelith-operated endpoint. Operators provide their own infrastructure and provider accounts.
- Every public outbound service must be named and documented.
- Client and edge selectors must not import server-only dependencies or secrets.
- Public history is permanent in practice. Removing a file later does not make previously published source confidential.
- The public boundary audit and full-history secret scan are mandatory release controls, not substitutes for reviewing the actual diff.

## Pull-request checklist

Before implementation and again before merge, answer:

1. Is this shared, self-host-only or Cloud-only?
2. Is the chosen file owned by that distribution?
3. Does shared code depend only on an edition contract or current selector?
4. Does the change introduce a provider, outbound endpoint, secret or schema object?
5. Does it require a public release, a Cloud core-sync PR, or both?
6. Were the relevant boundary, test, build and distribution checks run?

If a proposed workflow requires engineers to make the same functional edit in both repositories, the design is wrong and should be moved behind a shared contract before merging.
