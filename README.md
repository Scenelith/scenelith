<div align="center">
  <img src="public/scenelith-mark-email.png" width="72" alt="Scenelith logo" />
  <h1>Scenelith</h1>
  <p>An open visual canvas for creating, editing, and automating AI image and video work.</p>
  <p>
    <a href="https://github.com/Scenelith/scenelith/actions/workflows/runtime.yml"><img src="https://github.com/Scenelith/scenelith/actions/workflows/runtime.yml/badge.svg" alt="Runtime checks" /></a>
    <a href="https://github.com/Scenelith/scenelith/releases"><img src="https://img.shields.io/github/v/release/Scenelith/scenelith" alt="Latest release" /></a>
    <a href="LICENSE.md"><img src="https://img.shields.io/badge/license-Sustainable%20Use-6ad7b0" alt="Sustainable Use License" /></a>
  </p>
</div>

Scenelith combines a node canvas, image and video generation, editing, reusable identities, TikTok imports and automation, background workers, and realtime collaboration. This repository is the canonical product source: fixes and features land here first, public pull requests are normal product contributions, and every release can run entirely on infrastructure and provider accounts you control.

![Scenelith architecture](docs/assets/architecture.svg)

## Quick start

You need Docker Engine, Docker Compose 2.20.3 or newer, Node.js 24, 4 CPU cores, 8 GB RAM, and at least 10 GB of free disk space.

```bash
git clone https://github.com/Scenelith/scenelith.git
cd scenelith
npm run selfhost:init
```

Add the provider keys you intend to use to `deploy/selfhost/.env`:

```dotenv
KIE_API_KEY=
OPENROUTER_API_KEY=
```

Then validate and start the complete instance:

```bash
npm run selfhost:doctor
npm run selfhost:up
```

Open <http://localhost>. The first account becomes the instance owner, and public registration closes by default. Operators can choose open registration explicitly when several independent local accounts are required.

The normal installation pulls one signed, versioned, multi-architecture application image. Web, workers, migrations, and realtime collaboration run that exact image with different commands. Contributors can build the checked-out source with `npm run selfhost:up:source`.

For domains, automatic HTTPS, S3-compatible storage, SMTP, backups, upgrades, rollback, and the complete service topology, read the [self-hosting guide](docs/SELF_HOSTING.md).

## Providers and outbound connections

Provider keys stay in the server environment. They are sent only to the provider they authenticate against and are never returned to the browser or sent to Scenelith.

| Provider | Used for | Data sent |
| --- | --- | --- |
| **Kie** | Image and video generation and editing | Kie key, prompts, settings, and request reference media |
| **OpenRouter** | Assistant, automation planning, and visual text analysis | OpenRouter key and the prompt or media required by the selected model |
| **Tikwm** | Resolving public TikTok posts during import | TikTok URL; Tikwm returns post metadata and direct media URLs |
| **S3-compatible storage** | Optional operator-owned media storage | Media and object metadata configured by the operator |
| **SMTP or Resend** | Optional account verification and password recovery | Recipient and message data |
| **Google OAuth** | Optional sign-in | Standard OAuth identity data |

TikTok import does not use a logged-in TikTok account or TikTok cookies. Video scene detection, thumbnails, and timeline sprites are processed locally with FFmpeg after download. The default interface makes no automatic request to a Scenelith media server.

## What runs on your server

- Scenelith web application and API;
- generation, automation, and storage workers;
- realtime collaboration service;
- PostgreSQL and Redis;
- local persistent media storage, with optional S3-compatible storage;
- Caddy gateway with automatic HTTPS for public domains;
- database migrations, backup/restore tools, and an installation doctor.

The public runtime uses your own provider credentials and has no payment service, hosted-account dependency, or license server.

## Portable projects and recipes

Canvas projects can be exported as a versioned `.scenelith.json` document and imported into another instance. Portable documents contain graph structure and safe settings, but never instance IDs, stored media URLs, generated outputs, or credentials.

The [`recipes/`](recipes) directory contains small, reviewable workflow examples. A recipe is an ordinary portable Scenelith document: fork it, improve it, or contribute a new one with the media and provider requirements documented in its pull request.

## Updates and data safety

Create a checksummed backup before every upgrade:

```bash
npm run selfhost:backup
```

Restore only from a verified backup and only with explicit confirmation:

```bash
npm run selfhost:restore -- --from /absolute/path/to/backup --confirm
```

Select an exact release in `SCENELITH_VERSION`, check out the matching source tag, and run `npm run selfhost:up`. Ordered migrations complete before application services start. Never edit an applied migration or run `docker compose down -v` unless permanent data deletion is intentional.

## Community and contributions

- Ask setup and workflow questions in [Discussions](https://github.com/Scenelith/scenelith/discussions).
- Report defects or request features through the [issue forms](https://github.com/Scenelith/scenelith/issues/new/choose).
- Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.
- Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

Community changes merge directly into this canonical repository after review, CLA verification, tests, build, and the public-boundary audit. The hosted Scenelith product consumes this public core as an extension; maintainers do not maintain a second copy of shared product code.

## License

Scenelith is **source-available**, not OSI open source. The [Sustainable Use License](LICENSE.md) allows internal business, non-commercial, and personal use and modification. It does not allow selling Scenelith or offering it as a competing hosted service. Brand use is covered by [TRADEMARKS.md](TRADEMARKS.md).

The repository boundary and hosted-extension model are documented in [Distribution architecture](docs/DISTRIBUTION_ARCHITECTURE.md).
