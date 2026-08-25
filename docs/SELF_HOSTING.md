# Self-hosting Scenelith

Scenelith self-hosted is the complete public product runtime. It uses bring-your-own-provider credentials and runs from a release bundle backed by the canonical public source.

## Quick start

Requirements:

- Docker Engine with Docker Compose 2.20.3 or newer (the distribution uses Compose `include`)
- 4 CPU cores and 8 GB RAM for a small instance
- 10 GB of free disk space, with 20 GB or more recommended for images and media
- optionally, a Kie API key for image/video generation and an OpenRouter API key for Assistant and automation planning

Install the latest stable release without Git, Node.js, npm, or a source checkout:

```bash
curl -fsSL https://github.com/Scenelith/scenelith/releases/latest/download/install.sh | sh
```

The installer downloads the release archive and checksum from GitHub Releases, verifies both the archive and its internal file manifest, creates `./scenelith`, generates unique secrets with mode `0600`, validates the complete Compose model, and starts the pinned images. Set `SCENELITH_INSTALL_DIR=/opt/scenelith` to choose another empty directory or `SCENELITH_VERSION=1.2.3` to install an exact release.

For a review-before-run installation:

```bash
curl -fsSLO https://github.com/Scenelith/scenelith/releases/latest/download/install.sh
less install.sh
sh install.sh
```

Open `scenelith/deploy/selfhost/.env` and add the provider keys you intend to use, then run `./scenelith restart`. The stack can start without provider keys; only the corresponding generation or Assistant features stay unavailable.

`./scenelith doctor` names every configured provider, validates secrets and storage without printing their values, checks the complete Compose model, and stops before pulling images when the host does not have enough free disk space. Add `--strict-providers` when both Kie and OpenRouter must be present. `./scenelith doctor --json` is available for automation.

Open <http://localhost>. The first account becomes the instance owner and administrator. Normal public registration closes after that account. Self-hosted has no team invitations or email delivery; set `SCENELITH_REGISTRATION_MODE=open` only when independent local accounts are intentional. Each local account owns its own workspace.

Provider names and connection status are visible in **Profile → Providers**:

- **Kie** — image and video generation (`KIE_API_KEY`);
- **OpenRouter** — Assistant and automation planning (`OPENROUTER_API_KEY`);
- **Tikwm** — public TikTok media import resolver (no key required).

Keys stay in the server environment and are never returned to the browser. Only the configured/not-configured status is shown. Restart the instance after changing a key.

`./scenelith init` creates unique database, session, collaboration, and internal-service secrets with mode `0600`. It refuses to replace an existing environment file.

## Included services

The default distribution starts:

- the Scenelith web/API runtime;
- generation, automation, and storage workers;
- the collaboration service;
- PostgreSQL 17;
- Redis with append-only persistence;
- Caddy for HTTP/WebSocket routing and automatic TLS on a public domain.

Hosted payment and account-email services are not part of the self-hosted runtime. The instance owner signs in directly after local registration; Google OAuth, email confirmation, and email-based password recovery are intentionally absent.

Uploaded and generated media uses the `scenelith-data` Docker volume by default. PostgreSQL and Redis use separate persistent volumes. Removing containers does not remove these volumes. Do not run `docker compose down -v` unless permanent deletion is intended.

For distributed or off-host media storage, set `STORAGE_PROVIDER=s3` and configure the `S3_*` values in the environment file. Leave `S3_ENDPOINT` blank for AWS S3; set it for S3-compatible services such as MinIO, Backblaze, Cloudflare R2, or DigitalOcean Spaces.

Create the private and public buckets named in the environment file. Source-checkout operators can run `npm run storage:configure-cors`. Release-bundle operators should create one CORS rule on both buckets: allow the origins in `PUBLIC_URL` or `STORAGE_CORS_ORIGINS`, allow `GET`, `HEAD`, and `PUT`, allow the `content-type` and `range` headers, and expose `etag`, `content-length`, and `content-range`.

## Public server

Set the following values in `deploy/selfhost/.env`:

```dotenv
SCENELITH_HOST=scenelith.example.com
PUBLIC_URL=https://scenelith.example.com
COOKIE_SECURE=true
```

Point the domain's DNS records at the server and allow inbound TCP ports 80 and 443. Caddy obtains and renews the certificate automatically.

For a production instance, also establish:

- encrypted off-host retention for the backups created by `./scenelith backup`;
- monitoring for `/api/health/ready` and container health;
- host-level disk capacity alerts for local media;
- image update and rollback procedures;
- provider budget/rate limits at Kie and OpenRouter.

## Updating

Create and verify a backup first:

```bash
./scenelith backup
```

The command briefly quiesces application writers, writes a PostgreSQL custom-format dump, archives local media, records checksums and release metadata, then starts the stack again. It never copies provider keys. S3-compatible media remains in operator-owned object storage and needs its own versioning or snapshot policy.

Run `./scenelith update` for the latest stable release or `./scenelith update 1.2.3` for an exact release. The updater verifies the release archive and internal manifest, creates a backup, preserves the environment and Docker volumes, installs only the allowlisted deployment files, pulls the exact application image, applies ordered migrations, and waits for health checks. If the new services do not become healthy, it restores the previous deployment files and image. Core migrations are expand-only so the prior application image remains a valid operational rollback while the backup remains the data recovery boundary.

To restore a backup, use its absolute directory and explicit confirmation:

```bash
./scenelith restore --from /absolute/path/to/scenelith-backup --confirm
```

Restore verifies every checksum, stops application writers, replaces the database and local media, then starts the complete stack. Test this procedure on a separate host before relying on it for production recovery.

Back up PostgreSQL and the media volume before upgrading. Never edit an already-applied migration.

## Runtime profiles

The public runtime accepts only its self-hosted profile:

```dotenv
SCENELITH_DEPLOYMENT_TYPE=selfhost
SCENELITH_USAGE_MODE=bring_your_own
```

Product code receives an authoritative server-side capability object and a `UsageAuthority`; domain logic does not read hosted deployment flags or payment tables.

## Current provider boundary

The current generation model catalogue is implemented by the Kie adapter and Assistant/automation planning uses the OpenRouter adapter. TikTok imports send the public post URL to Tikwm to resolve post metadata and direct media URLs; they do not use a logged-in TikTok account or TikTok cookies. Direct Google, OpenAI, TikTok, and other provider credentials require their corresponding provider adapters; changing provider transport must not change generation domain logic or saved Canvas documents.
