# Security

This page describes credential encryption, session security, backup handling, and HTTPS configuration in tagave.

## APP_SECRET

`APP_SECRET` is a required 32+ byte random value used for:

- **Credential encryption:** Discogs tokens and AcoustID keys stored in the database are encrypted with AES-256-GCM using a key derived from `APP_SECRET`
- **Session signing:** session tokens are signed with `APP_SECRET`

### Generate your secret

Generate a new 32-byte (64 hex character) secret:

```sh
openssl rand -hex 32
```

Paste it as `APP_SECRET` in your `.env` file.

### Rotate your secret

When you need to rotate the secret (for example, after a compromise), you must reseal all encrypted credentials with the new key.

1. Generate a new secret:
   ```sh
   openssl rand -hex 32
   ```

2. Run the reseal command, passing both secrets inline:
   ```sh
   LINER_OLD_APP_SECRET=<old_secret> APP_SECRET=<new_secret> \
   node packages/doctor/dist/cli.js reseal
   ```

   Or in Docker:
   ```sh
   docker compose -f docker-compose.prod.yml exec \
     -e LINER_OLD_APP_SECRET=<old_secret> -e APP_SECRET=<new_secret> \
     app node packages/doctor/dist/cli.js reseal
   ```

   Pass them inline rather than exporting them. An exported secret stays in the
   environment of every later command in that shell, and most shells record the
   line in history.

4. Update `.env` to remove `LINER_OLD_APP_SECRET` and keep only the new `APP_SECRET`.

The reseal command decrypts all stored credentials with the old secret and encrypts them with the new one. Until this completes, the app cannot decrypt credentials.

## Backup security

**Database backups** include encrypted credential material (safe without `APP_SECRET`) and everything else in the catalog, including account email addresses and password hashes. The app writes one every night to the backups folder (`/backups` in the app container); only the owner can list, download or delete them in Settings › Backups. Treat copies you make like the database itself. Copy them off the host with:

```sh
docker compose cp app:/backups ./tagave-backups
```

See [operations](operations.md#backups) for the schedule, retention and restoring.

**Cache volume** (thumbnails and converted audio) is not sensitive.

**APP_SECRET itself must be backed up separately** in a secret store (HashiCorp Vault, AWS Secrets Manager, password manager, encrypted USB key, or a separate `.env.backup` file). If you lose it, you cannot decrypt stored credentials and must re-enter your Discogs token and AcoustID key. If you need to restore a database backup to a new system, provide the same `APP_SECRET` so the app can unseal stored credentials.

## What leaves your server

tagave has no telemetry. The server makes outbound requests only to:

- the metadata services it uses: MusicBrainz, Cover Art Archive, Wikipedia and Wikidata, plus Discogs and AcoustID when you add keys for them;
- the GitHub releases list of the official repository, once every 12 hours, to learn about new versions. It is a plain GET with a fixed `User-Agent: tagave-update-check` and no version, id or library data. Turn it off under Settings › Updates, or for the whole server with `TAGAVE_UPDATE_FEED=off` (see [Updates](install.md#updates)).

## TLS and HTTPS

**In production,** always run tagave behind a reverse proxy (nginx, Caddy, Traefik) that handles TLS. Set:

```sh
PUBLIC_URL=https://your-domain.com
ALLOW_INSECURE_HTTP=false
```

The `secure` flag on session cookies requires HTTPS; `ALLOW_INSECURE_HTTP=false` (the default) enforces it.

**In development,** to test over HTTP without a TLS certificate, set:

```sh
ALLOW_INSECURE_HTTP=true
```

This allows cookies to be sent over HTTP. Never set this in production: cookies become vulnerable to interception.
