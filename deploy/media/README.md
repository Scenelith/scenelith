# Isolated media worker

Use the exact signed application image digest. This role neither opens a host port nor needs AI, payment, session or collaboration secrets. It does not take over rendering on the web host when unavailable.

Before starting, record existing services, listeners, free RAM/disk and CPU load. Use a dedicated OS account and a container runtime that does not change existing host networking. Do not install a host-wide proxy, restart existing services, or run a second database.

1. Apply compatible core migrations with the application's normal release procedure.
2. Run `database/provision-media-worker.sql` on the database as its owner. Create a dedicated login through the operator's secret manager and grant only `scenelith_media_worker`. Cloud additionally grants read access to its private authorization tables. Verify that the login cannot read provider credentials, payment records or session tokens.
3. Connect through the existing private network or a dedicated encrypted tunnel bound to loopback. Do not publish a PostgreSQL port. Test reconnection with the worker stopped.
4. Create a dedicated filesystem or project quota for `MEDIA_TEMP_DIRECTORY`, owned by UID/GID 1001. The filesystem quota is mandatory for a shared host: the periodic application disk check is not a hard disk limit. Start with an 8 GB quota plus separate bounded container logs. Do not reuse another service's temporary directory.
5. Create `worker.env` with mode 0600 outside source control. Allow only deployment edition, dedicated DATABASE_URL, dedicated private-bucket storage credentials, storage endpoint/bucket settings, internal metrics secret, and media limits. Storage needs read on authorized source objects, write/read on derivative objects, and delete on its staging prefix. No public-bucket publication permission is required.
6. Set `SCENELITH_IMAGE` to the verified digest and `MEDIA_TEMP_DIRECTORY` to that directory. Start with one light and one transcode slot, two FFmpeg threads, 2 CPU and 2 GB memory. No capacity increase until measuring the actual host.
7. Verify health from inside the container and perform the synthetic fixture/load/restart checks before enabling `SCENELITH_MEDIA_QUEUE_ENABLED=true` on web and generation admission.

A read-only image and private-bucket access keep user data outside the container layer. Inspect metrics inside the container at `/metrics` with the metrics bearer secret; do not publish its health port. Report queue wait, download, processing and upload separately.

During rollback disable only new admission. Keep the compatible media worker running until accepted work drains. Do not delete queue rows, staging inventories, migrations, saved results or reservations. SIGTERM stops claims and allows a bounded drain; leases recover interrupted work.

The standalone manifest is a template, not evidence that a host has been provisioned or passed load tests. Self-host's ordinary Compose service uses the same entry point; production operators on shared hosts must configure a hard temporary-disk quota there too.
