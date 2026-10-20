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
- Repeated sign-in attempts are rate limited (Better Auth's limiter, stored in the database). Wrong passwords are also limited per account (10 in 15 minutes), from any address. Behind a reverse proxy on a private network the limit applies per client with no setting (see [Reverse proxy and client addresses](#reverse-proxy-and-client-addresses)).
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
   TAGAVE_OLD_APP_SECRET=<old_secret> APP_SECRET=<new_secret> \
   node packages/doctor/dist/cli.js reseal
   ```

   Or in Docker:
   ```sh
   docker compose -f docker-compose.prod.yml exec \
     -e TAGAVE_OLD_APP_SECRET=<old_secret> -e APP_SECRET=<new_secret> \
     app node packages/doctor/dist/cli.js reseal
   ```

   Pass them inline rather than exporting them. An exported secret stays in the
   environment of every later command in that shell, and most shells record the
   line in history.

4. Update `.env` to remove `TAGAVE_OLD_APP_SECRET` and keep only the new `APP_SECRET`.

The reseal command decrypts all stored credentials with the old secret and encrypts them with the new one. That includes Music Connections: each link's tokens and client secret, and the PKCE verifier and client secret of a link still in progress, so connections keep working. It checks the old secret first: if a stored provider secret opens with neither secret, it stops and changes nothing. A Music Connections value that opens with neither secret (a link already waiting for approval again, sealed before an earlier rotation) is left as it is, counted in a warning, and never stops the run, so running it twice is safe. Until this completes, the app cannot decrypt credentials.

Rotating `APP_SECRET` also changes the sign-in secret, so **everyone is signed out** and signs in again with their password.

## People and roles

An install can have several accounts. Everyone signed in sees the same libraries; what they may do depends on their role. The owner sets roles in **Settings › Users**.

| | Listener | Editor | Owner |
|---|:-:|:-:|:-:|
| Browse, search, album and artist pages, play | yes | yes | yes |
| Their own ratings, reviews, listens, clippings and saved views | yes | yes | yes |
| Their own Account, Security and Appearance settings | yes | yes | yes |
| Library care: scans, identify and matching, review queue, gaps, field locks, bulk edits, following artists, physical collection upkeep | | yes | yes |
| Tag changes (plans, apply, revert), tag preferences, genre mapping, follow rules, Background activity | | yes | yes |
| Music folders, Integrations (provider keys), Playback server, System status, Storage, Backups, Updates, Setup checklist | | | yes |
| Settings › Users: invite, change roles, reset sign-in, turn off, remove | | | yes |

- **Per-person data stays per person.** Ratings, reviews, listens, clippings and saved grid views are stored against the account that made them; nobody else can read or change them. Library-level things (albums, tags, tag changes, follows) are shared.
- **Every API route declares what it needs.** The server checks it before reading the request: anonymous callers get 401, a role without the permission gets 403 "Not available for your account". A route with no declaration refuses everyone, and a test fails CI over it. A second test signs in as each role and calls every route.
- **Better Auth serves only the endpoints tagave uses** (sign-in, sign-out, the caller's own session, password, authenticator app and passkeys). Open sign-up, account deletion, email change and password-reset email are not served; another person's account is managed only from Settings › Users.
- **At least one owner.** The last owner who can sign in cannot be demoted, turned off or removed.
- **Invite and set-password links** are one-time, expire after 7 days and are stored only as a SHA-256 hash; the owner copies the link (no email is sent). A set-password link signs the person out everywhere and can also remove their passkeys and authenticator app (a lost device). Opening links is rate limited per address.
- **Turning sign-in off** ends every session at once and refuses new sign-ins (password, passkey or code) until the owner turns it back on. **Removing** someone either keeps their ratings, reviews and listens (the account is closed, its email freed, its sign-in methods deleted) or deletes them with the account. Libraries and tag changes they created pass to the owner removing them.
- **Inviting, changing a role, resetting sign-in and removing** ask the owner to confirm it is them (a passkey, the authenticator app, or the password on an account with neither) unless they signed in within five minutes.

## Passkeys and security keys

Settings › Security › **Passkeys and security keys** adds a passkey (iCloud Keychain, Google Password Manager, Windows Hello, 1Password, a phone) or a hardware security key such as a **YubiKey**. The sign-in page then offers **Sign in with a passkey**, and browsers that support it list your passkeys in the email field's autofill.

- **A PIN or fingerprint is required.** tagave asks the authenticator to verify you (WebAuthn user verification) and refuses a key that only registers a touch. A YubiKey without a PIN: your browser asks you to create one when you add it. Because of this, a passkey sign-in counts as two factors and never asks for the authenticator code.
- **Passkeys are bound to `PUBLIC_URL`'s host name.** They work only when you open tagave at that address, over https or on `localhost`. Changing the host name later means signing in with your password and adding them again; `tagave-doctor doctor` warns when `PUBLIC_URL` no longer matches the host your passkeys were made for.
- Add at least two (for example a YubiKey and your phone) so losing one does not lock you out. Settings › Security shows how many factors you have.
- The setup wizard ends with a skippable **Protect your account** step that offers the same choices.

## Two-factor sign-in and backup codes

Settings › Security › **Authenticator app** turns on a second step after the password: a 6-digit code from an app on your phone (1Password, Aegis, Google Authenticator and so on).

- Setting it up asks for your password, shows a QR code made in your browser (the secret never goes to a third-party service) and the key as text, and turns on only after you enter one correct code.
- You then get **10 backup codes**, shown once, to download or print. Each signs you in once instead of the code. Settings › Security shows how many are left; making new ones cancels the old ones.
- The authenticator secret and the backup codes are stored encrypted with the sign-in secret derived from `APP_SECRET`. `tagave-doctor reseal` re-encrypts them when you rotate `APP_SECRET` (it changes nothing and stops if one cannot be decrypted with either secret).
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
- the apps you link in Settings › Connections (Music Connections), and only those: tagave pulls from them, and sends them a decision when you accept or dismiss one of their wantlist suggestions;
- the GitHub releases list of the official repository, once every 12 hours, to learn about new versions. It is a plain GET with a fixed `User-Agent: tagave-update-check` and no version, id or library data. Turn it off under Settings › Updates, or for the whole server with `TAGAVE_UPDATE_FEED=off` (see [Updates](install.md#updates)).

## The in-app updater

The updater is an optional service (compose profile `updater`) that lets **Settings › Updates** install a new release. It is off by default. `install-tagave.sh --with-updater` or `install-tagave.sh enable-updater` turns it on.

**What the Docker socket gives it.** To pull images and restart containers, the updater mounts `/var/run/docker.sock`. Access to that socket is the same as root on the host: whoever controls it can start a container that mounts `/` and change anything on the computer. Mounting it is therefore a real trade-off, which is why it is opt-in. Nextcloud AIO and Coolify make the same trade for their update buttons. If you would rather not make it, leave the updater off and use the command the page shows (`install-tagave.sh update`), which does the same steps from your shell.

**What tagave does to keep that power narrow:**

- The updater mounts the socket and the install folder (compose files and `.env`, at the same path as on the host) and nothing else. It has no access to your music, and no published port.
- It sits on its own internal Docker network, `updater`, together with the app and nothing else. That network has no route out; Docker itself downloads the images.
- It acts only on requests from the app. Every request is signed with HMAC-SHA256 using a key derived from `APP_SECRET` (`HMAC(APP_SECRET, "tagave/updater/v1")`), over the time, a nonce, the method, the path and the body. The updater refuses unsigned requests, signatures older than 60 seconds and replayed signatures, and compares in constant time. The updater signs its own calls back to the app the same way.
- It does two jobs: move this install to a release the app names, and turn modules of that release's catalogue on and off, both only after the release's signed manifest checks out (see [Signed releases](#signed-releases)). It never runs commands it is sent.
- In the app, only the owner can start an update, and only with a fresh verification: a sign-in or a re-verification (passkey or security key, then the authenticator app, then the password for an account with neither) within the last five minutes. The server enforces this; re-verification pauses for 15 minutes after five wrong answers. Each update and re-verification is logged.

Anyone who can read `.env` can sign requests, so keep `.env` private (the installer writes it with mode 600), as you already must for the database password.

**Turn it off** with `./install-tagave.sh disable-updater` in the install folder. By hand: remove `updater` from `COMPOSE_PROFILES` in `.env`, clear `TAGAVE_UPDATER_URL`, then run `docker compose rm --stop --force updater` and `docker compose up -d`.

## Signed releases

Every release publishes `release-manifest.json` next to its images: every image the release runs (tagave's own and the third-party ones, Postgres and Navidrome) pinned to a `sha256:` digest per architecture, the module catalogue, and the sha256 of `install-tagave.sh` and the compose files. CI signs its exact bytes with the project's Ed25519 release key (`release-manifest.json.sig`) and attaches both to the GitHub release, with the installer, its sha256 and its own signature. The private key exists only as a secret of the repository's `release` environment, which only `v*` tags can use (`scripts/set-release-key.sh` puts the public half in place); the public keys are in [`deploy/release-keys/`](../deploy/release-keys/), inside the updater and app images, and inside `install-tagave.sh`.

**What the updater checks** before it uses anything of a release, for an update and for every module run, in this order:

1. the signature verifies with a release key carried in its own image (the updater has no network access of its own, so nothing is fetched to check it);
2. the key that signed it is a tagave release key (a signature by any other key is refused, naming that key);
3. the manifest is for exactly the version asked for;
4. it is not older than the version that runs, nor than any release this install has run before (`.updater/release-floor`), so an old signed manifest replayed to force a downgrade is refused;
5. every image is pulled by the digest the manifest pins for this computer's architecture, and Docker's record of the pulled image must show that digest.

Each refusal names the check that failed and leaves the install untouched. Afterwards `.env` pins every image (`TAGAVE_DIGEST_*`, read by `compose.yml`), so a later `docker compose pull` cannot swap in something else under the same tag, and the updater refuses to update while `TAGAVE_PLAYER_IMAGE` replaces a pinned image.

**Checking a release yourself.** Download `install-tagave.sh`, `install-tagave.sh.sig`, `install-tagave.sh.sha256` and the release key (`tagave-release.pem`, attached to the release and in `deploy/release-keys/`) from the release page, then:

```sh
sha256sum -c install-tagave.sh.sha256
sed -n 's/^sig //p' install-tagave.sh.sig | base64 -d > install-tagave.sh.sig.bin
openssl pkeyutl -verify -pubin -inkey tagave-release.pem -rawin -in install-tagave.sh -sigfile install-tagave.sh.sig.bin
# Signature Verified Successfully
```

The same three lines check `release-manifest.json` with `release-manifest.json.sig`. Compare the key with the one in the repository rather than trusting a single download. The GitHub build provenance is a second, independent check: `gh attestation verify install-tagave.sh --repo xooxoxxo/tagave`, and `gh attestation verify oci://ghcr.io/xooxoxxo/tagave-app:<version> --repo xooxoxxo/tagave` for an image.

**The installer.** When it can (it carries the key and the computer has openssl 3, which verifies Ed25519), `install-tagave.sh` checks the manifest of the release it installs or updates to, refuses one that does not check out before it writes anything, pins the images by digest and keeps the manifest for the updater. When it cannot (no openssl 3, or a version without a manifest such as `edge`), it says so and pulls by tag, as releases before signing did; `TAGAVE_REQUIRE_SIGNATURE=1` turns that into an error.

**Why a pinned key and not Sigstore keyless.** Keyless signing ties a signature to the CI run's GitHub identity and records it in a public log, with no long-lived key to guard. Checking it needs the Sigstore trust root and, to be current, the network; the updater sits on a network with no route out, and checking a bundle offline means shipping and refreshing a trust root and a sizeable verification library inside the image. A pinned Ed25519 key is checked by Node and by openssl with nothing added, offline. The keyless provenance is still attached for auditing (above).

**Replacing the key.** A new key is added to `deploy/release-keys/` (and to the installer) one release before CI signs with it, so every updater already trusts it; the old key is removed one release later. A key that leaks is removed in a release signed with the new key; installs that skipped that release need one manual `install-tagave.sh update`.

**Modules.** Only modules in the signed official catalogue can be installed; there are no third-party or community modules. A module's compose file comes from the signed manifest, its images are pinned like the rest, and the updater refuses a catalogue entry that would mount the Docker socket, run privileged or touch tagave's own settings.

## The player

The player is an optional service (compose profile `player`): an unmodified [Navidrome](https://www.navidrome.org) that plays your albums in tagave and serves phone apps. It is off by default; `install-tagave.sh --with-player` or `enable-player` turns it on. See [Play your music](install.md#play-your-music-optional-player).

**What it can read.** Your music folder, mounted read-only (always, even with `--music-writable`), and its own `player-data` volume. Nothing else: not the tagave database, not `.env`, not the Docker socket.

**Credentials.** The installer generates Navidrome's admin password and its encryption key (`TAGAVE_PLAYER_PASSWORD`, `TAGAVE_PLAYER_ENCRYPTION_KEY`, 32 random bytes each) and writes them only to `.env`, mode 600. The compose file passes the password to Navidrome and to the app, and to no other service; the workers never get it. Navidrome refuses to start without both values, because a Navidrome with no admin lets whoever reaches its port first create one. The browser never gets the password: it plays through tagave. tagave signs each request to Navidrome with Subsonic token auth, `md5(password + salt)` with a new random salt per request, so the password itself does not cross the network. For a server of your own (Settings › Playback), tagave keeps the password sealed with `APP_SECRET` in the database, like the other provider secrets.

**People's accounts.** tagave makes one Navidrome user per tagave person (not an admin) through Navidrome's user API, signed in as the admin. Its password is 24 random bytes, sealed with `APP_SECRET` in `player_users`, and never shown or logged. A person may replace it with their own password for phone apps (Settings › Listening, at least 12 characters); tagave stores that one sealed the same way and never shows it again. Disabling or closing a tagave account locks its Navidrome user (a new random password nobody knows), so phone apps signed in as that person stop working. On a server of your own, a person's own login there is stored the same way.

**Scrobbling secrets.** The owner's Last.fm API key and shared secret (Settings › Playback › Scrobbling) are sealed with `APP_SECRET` in the library settings; `TAGAVE_LASTFM_API_KEY` / `TAGAVE_LASTFM_SECRET` in `.env` work too and reach only the app. Each person's Last.fm session key (from Last.fm's web sign-in, which never shows tagave their Last.fm password) and ListenBrainz token are sealed in `scrobble_accounts`, one row per person; nobody else, the owner included, can read or use them through tagave. The Last.fm sign-in carries a short-lived value signed with `APP_SECRET` that names the person who started it, so a returning browser cannot attach someone else's Last.fm. Losing `APP_SECRET` means everyone connects again. tagave keeps each person's plays (`player_plays`) and album listens; deleting a person with their data deletes those. Navidrome's own Last.fm and ListenBrainz scrobbling is off in the compose file: only tagave sends plays out, to the accounts each person connected.

**Network.** Navidrome's port (4533 by default, `TAGAVE_PLAYER_PORT`) is published on this computer's network, like tagave's own port, so phone apps at home can reach it. Phone apps log in with their own Navidrome user. To use them away from home, reach the port through a VPN (WireGuard, Tailscale) or put it behind your HTTPS reverse proxy. Never forward it from your router: it would answer the whole internet, over plain http. On Linux, Docker publishes ports past ufw and firewalld, so a firewall rule does not close it. Public share links, Navidrome's Jellyfin API and its anonymous usage reports (the insights collector) are turned off in the compose file.

**The stream proxy.** The browser streams through tagave, never from Navidrome directly. Every stream needs a tagave session. Each user can hold only a few streams at once (`TAGAVE_PLAYER_MAX_STREAMS`, 4 by default), with a cap for the whole server, and a request to Navidrome that does not answer or stops sending in time is cut off.

**Your responsibility.** tagave streams files you already have, to you and your household. It ships no music and fetches none. A public share link makes files downloadable by anyone who has the link, which can amount to distribution in many jurisdictions. That is why sharing is off.

## Music Connections

Music Connections lets another music app read one person's data from tagave, and lets tagave read from another app (see [Operations](operations.md#music-connections)). Each direction is a separate link with its own approval, and each can be revoked on its own. It is off by default. Off (Settings › Modules), the description, the feeds and the register, authorize and consent endpoints answer 404, and the token endpoint issues nothing (503); revoke still works.

**The OAuth provider.** Better Auth 1.7 has no OAuth-provider plugin, so tagave runs its own OAuth 2.0 server at `/api/v1/connect/*`. Better Auth supplies only the session for the consent page.

- **Registration** (`/connect/register`) accepts exactly one redirect URI. It must be http or https on a private address: an RFC 1918 or 100.64.0.0/10 IP, 127.0.0.0/8 or `localhost`. Otherwise it must be https on a host listed in `MC_TRUSTED_PUBLIC_HOSTS`. A LAN host name is never accepted as a redirect URI. At most 10 registrations a minute come from one address.
- **Authorization** is code plus PKCE S256, nothing else. Each parameter may appear only once. `offline_access` is granted only together with a capability scope (`ratings:read`, `collection:read`, `listens:read`, `identity:read`), and there is no `openid`. The consent page names the app, the host its redirect goes to and each scope in plain words. An approval sent from a browser must come from tagave's own page. A request expires after 10 minutes and its code after 5. A code works once: presenting it again revokes what it was exchanged for.
- **Tokens.** An access token lasts 1 hour. A refresh token lasts 90 days and is replaced on every use. Using a replaced refresh token again revokes the whole approval. Revocation follows RFC 7009 at `/connect/revoke`. There is no userinfo or end-session endpoint.
- **Feeds** take a bearer token. Each feed checks its own scope, answers only with the approving person's data and the install's first library, sets `Cache-Control: no-store`, and allows 60 requests a minute per token (`Retry-After`). The text of your reviews (`user_reviews.body_md`) never leaves: only ratings do.

**Token storage.** As the provider, tagave keeps only SHA-256 hashes of what it hands out: access and refresh tokens, codes and client secrets. A database dump does not contain usable tokens. As a client, it seals each link's access token, refresh token and client secret together with `APP_SECRET` (AES-256-GCM, like the other credentials), as are the PKCE verifier and client secret of a link in progress. The link's `state` is kept only as a hash. Tokens never appear in logs, URLs or error messages. `tagave-doctor reseal` re-encrypts them when you rotate `APP_SECRET`, so links keep working; a link it cannot open with either secret is left as it is and asks for approval again.

**Allow-lists.** tagave links only to remotes it may reach: private IPs, `localhost`, https hosts in `MC_TRUSTED_PUBLIC_HOSTS` (comma separated, https only), or a host name on your network such as a Docker service or `.lan` name. Every address the remote's manifest names must sit on the remote's own origin, so a token or client secret never travels to another host.

**SSRF rules,** checked on every outbound request (manifest, registration, token, revoke, every feed page):

- The host name is resolved once, and every address it resolves to is checked. The connection then goes to the address that was checked (LAN-name pinning), so a DNS answer that changes later cannot redirect it.
- A host name that is not trusted may reach private addresses only. It never reaches loopback or a public address, and a name that answers with both a private and a public address is refused.
- Link-local (169.254.0.0/16, fe80::/10), 0.0.0.0/8, multicast and broadcast are always refused. Loopback is allowed only when the address is literally `localhost` or `127.x.x.x`; IPv6 literals are refused.
- Redirects are never followed. Requests time out after 10 seconds (30 for a feed page), and bodies are capped at 64 KB (5 MB for a feed page).

**What comes in.** Every item is checked against the protocol's schema and its text is length-capped. Only `http(s)` links are kept, and everything is shown as text, never as HTML. No review prose crosses in either direction: critic reviews arrive as scores and links.

**Audit log.** Registrations, approvals and denials, code reuse, refresh failures, scope changes, address changes and revocations go to `audit_log` (actions `mc.*`), as do the album IDs a link fills in or takes back (`identity.fill`, `identity.fill_reverted`).

## Reverse proxy and client addresses

Every per-address limit (sign-in, invite links, the Music Connections endpoints and feeds) counts by the client's address. Behind a reverse proxy that address comes from `X-Forwarded-For`, and tagave takes it only from a proxy it trusts. You do not need to set anything for a proxy on a private network: on tagave's Docker network, in another compose stack that reaches tagave's published port (it arrives from the Docker gateway), on this computer, or elsewhere on your home network (Caddy, nginx, Traefik, cloudflared).

By default (`TRUST_PROXY` unset) any hop on a private network is trusted to name the client: loopback, link-local, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 and fc00::/7. A connection from a public address never names the client. On Linux Docker a visitor from the internet keeps its public address through a published port, so it cannot pick its own address.

The trade-off: whatever connects from a private address can write any address into `X-Forwarded-For`. That only puts it in a rate-limit bucket of its choosing. Nothing in tagave grants access by address, and wrong passwords are also limited per account (10 in 15 minutes), so changing the address does not buy more guesses. Who connects from a private address:

- a device on your own network that reaches tagave's port directly;
- on Docker Desktop, colima or rootless Docker, every client of a published port (it arrives from the gateway). On such a computer exposed to the internet, set `TRUST_PROXY` to your proxy's address, or publish the port on 127.0.0.1 only;
- on Linux with public IPv6 and an IPv4-only Docker network, an internet client over IPv6: Docker's proxy accepts it on the published `[::]:3100` and forwards it from the gateway. Published ports also bypass ufw.

Recommended setup, which closes all three:

- **Proxy on a shared Docker network:** attach tagave's `app` service to the proxy's network and point the proxy at `app:3000`. Then remove the app's `ports:` entry.
- **Port must stay published:** bind it to an address the internet cannot reach, `"127.0.0.1:3100:3000"` or a LAN address (`"192.168.1.10:3100:3000"`).
- **Proxy on another computer:** name it, `TRUST_PROXY=192.168.1.2`; other devices then cannot name an address.

`TRUST_PROXY` is an advanced option, needed only when your proxy is not on a private network:

- the proxies' addresses or networks, `TRUST_PROXY=203.0.113.7` or `172.21.0.0/16`: only a connection from one of them may name the client (`loopback`, `linklocal` and `uniquelocal` work too). The Docker gateway is then not trusted unless it is in the list. A network wider than /8 (`0.0.0.0/0`, `::/0`) is refused: it would trust nearly every peer.
- a hop count, `TRUST_PROXY=1`: the nearest hop is your proxy, and the rightmost address it appended is the client; entries further left, which the client could have written, are ignored. This trusts whatever connects directly, so tagave's port must be reachable only through the proxy. Prefer the address form.
- `off` (or `false`, `0`): trust no proxy; the address of the connection is the client. Behind a proxy every caller then shares one limit.

tagave never trusts every hop: a client could then write any address into `X-Forwarded-For` and step around every limit. `TRUST_PROXY=true` (and `yes`) from older releases now means `1`, with a warning in the log; remove it. Better Auth's sign-in limiter and the trusted-device list read the address tagave worked out this way, never the raw header. A value that is none of these stops the app at start.

When requests keep arriving with `X-Forwarded-For` that tagave cannot use (a proxy on a public address, as some cloud load balancers are, or one missing from `TRUST_PROXY`), the Reverse Proxy check in Settings › System and `tagave-doctor` warns and names the setting that fixes it. It stays quiet otherwise.

## TLS and HTTPS

**In production,** always run tagave behind a reverse proxy (nginx, Caddy, Traefik) that handles TLS. Set:

```sh
PUBLIC_URL=https://your-domain.com
ALLOW_INSECURE_HTTP=false
```

With an https `PUBLIC_URL` the session cookie gets the `secure` flag and the `__Secure-` prefix. `ALLOW_INSECURE_HTTP=false` (the default) refuses to create the owner account over plain http.

**In development,** to test over HTTP without a TLS certificate, set:

```sh
ALLOW_INSECURE_HTTP=true
```

This allows cookies to be sent over HTTP. Never set this in production: cookies become vulnerable to interception.
