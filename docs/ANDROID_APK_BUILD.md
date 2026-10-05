# Android APK Build

Updated: 2026-10-03

## Scope

- Standalone internal-distribution APK, not Expo Go or a development client.
- Existing Expo project: `uyrvyi/yishu`.
- Android package: `com.yishu.app`, version `1.0.0`, versionCode `1`.
- Backend: `https://8.136.121.71`.
- No Play Store submission, signing-key replacement, or paid build authorized.
- The previous deployment task remains paused; this record is not a Release Gate.

## Build Preparation

The existing EAS build `e0e0db41-2abf-438d-b364-1a64c16c5935` failed
in EAGER_BUNDLE because `@yishu/shared/dist/index.js` was missing.

- Added `eas-build-post-install` to build `@yishu/shared` from source.
- Aligned Expo SDK 57 patch dependencies with Expo's compatibility check.
- Added root `.easignore` for monorepo archives. Excludes environment files,
  private keys, local backups, temporary deployment images, and screenshots.
- Existing preview profile requests an internal APK and the public HTTPS API.

Verified in Docker:

| Check | Result |
| --- | --- |
| Expo Doctor | 21/21 PASS |
| Mobile TypeScript | PASS |
| Mobile tests | 165/165 PASS |
| Shared build hook | PASS |
| Android production export | PASS |
| Clean archive before dependency installation | 328 files, 0 sensitive files |
| Frozen-lockfile install in clean archive | PASS |
| Shared build hook in clean archive | PASS |
| Android export from clean archive | PASS |

The owner approved EAS cloud building with the existing project and signing
credentials, excluding paid builds and signing-key changes. Build
`477e13ab-b3ba-424d-b285-aa2e952377b9` was submitted at
2026-10-03 04:44:30 UTC. EAS reused the existing remote Android keystore and
uploaded a 2.4 MB source archive. The build is not yet complete; no installable
APK has been produced yet. Android device testing is not claimed.

[Build status](https://expo.dev/accounts/uyrvyi/projects/yishu/builds/477e13ab-b3ba-424d-b285-aa2e952377b9)

## Public HTTPS

With owner approval of the Let's Encrypt subscriber agreement, the existing
Caddy 2.11.6 gateway obtained a publicly trusted IP certificate using
`shortlived` and TLS-ALPN validation on the existing TCP 443 listener.

- Issuer: Let's Encrypt YE1.
- SAN: IP Address `8.136.121.71`.
- Validity: 2026-10-03 03:43:10 UTC to 2026-10-09 19:43:09 UTC.
- SHA-256: `B9:5D:34:9E:5B:C5:5D:A9:CE:8A:8B:C9:E4:A5:94:70:D3:D3:A8:27:6D:9F:FF:2D:29:25:C8:4E:8C:AF:9B:6C`.
- `/data` and `/config` now use persistent Caddy Docker volumes.
- Caddy manages renewal automatically and received ACME renewal information.
  A future renewal cycle has not yet been observed.
- Certificate and private-key files have mode 0600.
- Original gateway configuration and storage were backed up on the server at
  `/opt/yishu/.local/tls-backup-20261003` before the change.

Verified with default system/Node certificate validation, without TLS bypass:
health 200, unauthenticated letters 401, public ready 404. After a gateway
restart, the same trusted certificate remained available and health returned
200. API, Worker, PostgreSQL, and Redis container IDs were unchanged and all
were healthy. No additional public port was published.

Sources: [Caddy TLS](https://caddyserver.com/docs/caddyfile/directives/tls),
[Let's Encrypt IP certificates](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability),
[EAS build hooks](https://docs.expo.dev/build-reference/npm-hooks/).
