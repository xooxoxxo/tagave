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
- Passwords are hashed with argon2id. New passwords need at least 12 characters. Change yours in Settings › Security › Password; ticking **Sign out my other devices** ends every other session.
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

## Passkeys and security keys

Settings › Security › **Passkeys and security keys** adds a passkey (iCloud Keychain, Google Password Manager, Windows Hello, 1Password, a phone) or a hardware security key such as a **YubiKey**. The sign-in page then offers **Sign in with a passkey**, and browsers that support it list your passkeys in the email field's autofill.

- **A PIN or fingerprint is required.** tagave asks the authenticator to verify you (WebAuthn user verification) and refuses a key that only registers a touch. A YubiKey without a PIN: your browser asks you to create one when you add it. Because of this, a passkey sign-in counts as two factors and never asks for the authenticator code.
- **Passkeys are bound to `PUBLIC_URL`'s host name.** They work only when you open tagave at that address, over https or on `localhost`. Changing the host name later means signing in with your password and adding them again; `liner-doctor doctor` warns when `PUBLIC_URL` no longer matches the host your passkeys were made for.
- Add at least two (for example a YubiKey and your phone) so losing one does not lock you out. Settings › Security shows how many factors you have.
- The setup wizard ends with a skippable **Protect your account** step that offers the same choices.

## Two-factor sign-in and backup codes

Settings › Security › **Authenticator app** turns on a second step after the password: a 6-digit code from an app on your phone (1Password, Aegis, Google Authenticator and so on).

- Setting it up asks for your password, shows a QR code made in your browser (the secret never goes to a third-party service) and the key as text, and turns on only after you enter one correct code.
- You then get **10 backup codes**, shown once, to download or print. Each signs you in once instead of the code. Settings › Security shows how many are left; making new ones cancels the old ones.
- The authenticator secret and the backup codes are stored encrypted with the sign-in secret derived from `APP_SECRET`. `liner-doctor reseal` re-encrypts them when you rotate `APP_SECRET` (it changes nothing and stops if one cannot be decrypted with either secret).
- Ten wrong codes in a row lock the second step for 15 minutes.
- Passkey sign-in never asks for the code: a passkey with its PIN or fingerprint already counts as two factors.

### Trusted devices

On the code page, **Don't ask for a code on this device for 30 days** remembers that browser. Settings › Security › **Trusted devices** lists every remembered browser (browser, last use, expiry) and forgets any of them. Turning the authenticator off or changing your password forgets them all.

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
