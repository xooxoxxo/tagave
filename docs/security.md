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

2. Set both the old and new secrets in your environment:
   ```sh
   export LINER_OLD_APP_SECRET=<old_secret>
   export APP_SECRET=<new_secret>
   ```

3. Run the reseal command:
   ```sh
   node packages/doctor/dist/cli.js reseal
   ```

   Or in Docker:
   ```sh
   docker compose -f docker-compose.prod.yml exec app node packages/doctor/dist/cli.js reseal
   ```

4. Update `.env` to remove `LINER_OLD_APP_SECRET` and keep only the new `APP_SECRET`.

The reseal command decrypts all stored credentials with the old secret and encrypts them with the new one. Until this completes, the app cannot decrypt credentials.

## Backup security

**Database backups** include encrypted credential material (safe without `APP_SECRET`). Dump backups with:

```sh
docker compose -f docker-compose.prod.yml exec app node packages/doctor/dist/cli.js backup --keep 14
```

Dumps land in `/cache/backups/liner-<timestamp>.pgdump` inside the app container. Copy them off the host, because the cache volume is not a backup location:

```sh
docker compose -f docker-compose.prod.yml cp app:/cache/backups ./backups
```

**Cache volume** (thumbnails and converted audio) is not sensitive.

**APP_SECRET itself must be backed up separately** in a secret store (HashiCorp Vault, AWS Secrets Manager, password manager, encrypted USB key, or a separate `.env.backup` file). If you lose it, you cannot decrypt stored credentials and must re-enter your Discogs token and AcoustID key. If you need to restore a database backup to a new system, provide the same `APP_SECRET` so the app can unseal stored credentials.

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
