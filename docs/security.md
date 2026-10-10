# Security

This page describes credential encryption, session security, backup handling, and HTTPS configuration in tagave.

## APP_SECRET

`APP_SECRET` is a required 32+ byte random value used for:

- **Credential encryption:** Discogs tokens and AcoustID keys stored in the database are encrypted with AES-256-GCM using a key derived from `APP_SECRET`
- **Sign-in:** the sign-in layer ([Better Auth](https://better-auth.com)) uses a secret derived from `APP_SECRET` (HKDF, `tagave/better-auth`). It signs the session cookie and encrypts authenticator-app secrets and backup codes. There is no second secret to manage.

## Sessions

- Signing in sets one cookie, `tagave.session_token` (`__Secure-tagave.session_token` when `PUBLIC_URL` is https). It is httpOnly, `SameSite=Lax`, and holds a random session token plus an HMAC signature made with the secret above. The server looks the token up in `auth_sessions` on every request, so signing out or revoking a session takes effect at once.
- A session lasts 30 days and is extended once a day while you use it.
- Sign-in requests are accepted only from `PUBLIC_URL` and the origins listed in `ALLOWED_ORIGINS` (Better Auth's origin and Fetch-Metadata checks). Open tagave at the address in `PUBLIC_URL`, or list the other addresses you use in `ALLOWED_ORIGINS`.
- Repeated sign-in attempts are rate limited (Better Auth's limiter, stored in the database). Behind a reverse proxy that sets `X-Forwarded-For`, set `TRUST_PROXY=true` so the limit applies per client.
- Passwords are hashed with argon2id.
- **Upgrading from 0.6:** you stay signed in. The first request with the old `sessionId` cookie swaps it for the new cookie, and your password is unchanged.

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

Rotating `APP_SECRET` also changes the sign-in secret, so **everyone is signed out** and signs in again with their password.

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
TRUST_PROXY=true
```

With an https `PUBLIC_URL` the session cookie gets the `secure` flag and the `__Secure-` prefix. `ALLOW_INSECURE_HTTP=false` (the default) refuses to create the owner account over plain http.

**In development,** to test over HTTP without a TLS certificate, set:

```sh
ALLOW_INSECURE_HTTP=true
```

This allows cookies to be sent over HTTP. Never set this in production: cookies become vulnerable to interception.
