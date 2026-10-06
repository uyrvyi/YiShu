# E2EE V1 Release Report

Date: 2026-10-05, Asia/Shanghai. Scope: production backend and server-hosted Expo Go preview only; no APK build, old-letter conversion or automatic enrollment of existing accounts.

## Gate Status

| Gate                                 | Result           | Evidence                                                                                                                                                 |
| ------------------------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared/API/mobile regression         | PASS             | 20 + 378 + 403 = 801 tests; workspace TypeScript and scoped lint/format checks passed                                                                    |
| Independent read-only code re-review | CONDITIONAL PASS | Initial account-switch/body/image/context findings fixed; 46 existing tests and 15 independent in-memory checks; metadata trust boundary documented      |
| Reviewed image source verification   | PASS             | 156 API dist files and 138 mobile app/src files matched SHA-256 manifest                                                                                 |
| Paired backup restore rehearsal      | PASS             | Isolated disposable PostgreSQL, no network/ports, restored counts equal original counts                                                                  |
| Additive production migration        | PASS             | `20261005150000_e2ee_envelopes`; previously pending nullable district-collection column also applied                                                     |
| API/worker/preview replacement       | PASS             | All healthy, restart counts 0 immediately after rollout; infrastructure images/start times unchanged                                                     |
| Production E2EE HTTP smoke           | PASS             | Generated fixtures only; ciphertext, delivery permissions, recovery, signatures, legacy reads and old-write rejection                                    |
| Automated fixture cleanup            | PASS             | Three accounts and their letters/media removed; baseline restored to 5 users / 15 letters / 9 media / 0 identities                                       |
| Public Expo Go HTTPS checks          | PASS             | Signed manifest/certificate chain, SDK 57, compressed bundle, 32 resources, E2EE modules and private-path rejection                                      |
| Real iPhone Expo Go workflow         | IN PROGRESS      | A/B enrollment confirmed; human reports B rejects wrong A safety code and accepts correct code; A-to-B verification and encrypted letters remain pending |
| Phone encrypted image upload         | RETEST PENDING   | Native-import hotfix deployed; 404 mobile tests and public HTTPS bundle checks passed; actual phone upload remains unverified                            |
| Phone QA cleanup                     | PENDING          | Run only after phone acceptance or explicit abandonment; currently no enrollment/letters were created by the server for these accounts                   |
| Final Gate                           | NOT PASSED       | Real-device enrollment, safety-code verification, body/images/time, account switching, cold start and recovery checks remain                             |

This is a code review and functional rollout, not a third-party professional cryptographic audit.

## Published Images

- API/worker: `yishu-server:e2ee-20261005-reviewed-r1`, running image ID `sha256:bd19a13c7cf17eb49c4acc0e3ccef889d8ab69a9cb48e6bb3616039e2e2e5d18`.
- Current preview after automatic E2EE and encryption keyboard fixes: `yishu-cloud-preview:preview-20261006-auto-e2ee-r5`, running image ID `sha256:868277b582064dff1f5bebf0c159f4a6e8fec7b925cf8f48e21895b8514dfd37`. Previous keyboard-all-r4 (`sha256:6a881f6a31bd0e04050dda7130efa9d3ebd55b66bfe144ce0dec4738fcacc39f`), image-import r2 and reviewed-r1 are retained.
- Migration base: `yishu-migrate:e2ee-20261005`, aliased as reviewed-r1; unchanged schema/dependency build.
- Approved preview entry: `https://8.136.121.71/expo`; deep link: `exps://8.136.121.71:443`.
- PostgreSQL, Redis, gateway and map image IDs and start timestamps matched before/after. No gateway restart, certificate change or new inbound port during this release.
- The old standalone APK can read legacy letters but cannot send new production letters; it must be rebuilt later with native Expo Crypto support.

## Backup And Release Evidence

Private server directory: `/opt/yishu/releases/e2ee-20261005`, mode 700. Environment snapshots, fixture passwords and backup archives must never be added to Git or exposed through HTTP.

- Paired database backup: `/opt/yishu/.local/e2ee-backups/20261005T145136Z-4129999.dump`.
- Database SHA-256: `5b05ea9dfe0d02861a72410151776955f7615edd8a39a1053dd20684bae7839b`.
- Paired media backup: same path plus `.media.tar`.
- Media SHA-256: `92f48be6730ac55bcb95fb178b7ecd4418bd163df17803596e3df7a491a27af9`.
- Verified source archive SHA-256: `8e488daa47a2cec8d05879156a7ebae4cc53558f6295a55da14252b41ca46bad` (`reviewed-context-verified.tgz`). Subsequent deployment-script corrections did not alter the reviewed application image contents.
- Server evidence: `backup.sha256`, `backup-paths.txt`, `counts.before`, `counts.restored`, `counts.migrated`, `infrastructure.before/after`, `applications.after`, `reviewed-sources.json`, `smoke.log`, `release-pass`.
- Public check command: `node scripts/check-expo-preview.mjs https://8.136.121.71 --e2ee --letter-gallery --gallery-preload --route-fit-limit`.
- Public check result: `EXPO_PREVIEW_HTTP_PASS`, 21,290,008 bundle characters, Brotli compression, 32 native resource files, gallery/preload/map fit and E2EE flags true. This proves delivery and module presence, not native cryptographic execution.
- After release, 16 GB disk remained available; all seven production containers were healthy.

## Rehearsal Issue And Correction

The first attempt created a complete paired backup but failed before production migration: `pg_isready` accepted PostgreSQL's temporary Unix-socket initialization server, which then shut down before restore. The failure handler also used relative environment-snapshot paths after changing directory.

Original API/worker were promptly restarted on the original images. Both faults were fixed: wait on the final TCP listener at 127.0.0.1, and use absolute snapshot paths. A separate isolated restore/migration rehearsal passed while original services were running, then the coordinated release completed successfully. An incorrectly located success marker was moved into the release evidence directory and the script was corrected to use an absolute marker path. No production database reset or plaintext conversion occurred.

The nullable `Journey.originStationReadyAtSim` migration adds schema only. The current district-collection rollout flag was not changed, old journeys were not recomputed, and existing account regions were not modified.

## Phone Workflow And Cleanup

The private `phone-qa-accounts.jsonl` file holds two generated QA credentials, without access tokens, identity secrets or recovery codes. Account prefix is `eeqa_a_` / `eeqa_b_`. `scripts/cloud-e2ee-phone-qa.mjs` supports guarded prepare/status/deliver/cleanup actions inside the production API container; it refuses to operate on letters involving accounts outside the approved pair.

At 23:03 on 2026-10-05, the human confirmed A's recovery-code acknowledgment/enrollment. iPhone Mirroring directly displayed "本机密钥已就绪" for temporary UID `83799186`; its displayed public safety code was captured for direct peer verification, not taken from a relay lookup. Production status independently reported one QA identity and zero QA letters/media. No recovery code/private key was collected.

Subsequently, the human confirmed B was ready, an altered A safety code was rejected and the correct phone-observed A safety code was accepted. A fresh production QA status check confirmed two identities and zero QA letters/media. The wrong/right-code result is human-reported, not an independently observed UI check; A's verification of B and actual encrypted letter send/read remain pending.

At 23:16, iPhone Mirroring independently displayed B's "本机密钥已就绪", temporary UID `98626623` and its public safety code. That phone-observed code will be supplied directly for A's verification; no server lookup is substituted for independent peer-code comparison. No recovery code or private key was observed.

1. Phone enrolls account A and B; human saves and confirms each recovery code outside chat.
2. Exchange public UID/safety codes directly from phone-displayed identities; wrong safety code must fail before successful verification.
3. Send generated test body and image from A to B. Sender sees body/writing time/images; undelivered recipient sees none.
4. Only the exact QA letter may be marked delivered. B then decrypts the same body/writing time/image and exercises the gallery.
5. Verify logout/account-switch/back behavior and a cold start. Actual key-loss/recovery needs a separately controlled device-key test; do not uninstall Expo Go or wipe other app keys without explicit confirmation.
6. Delete the QA letters, media and accounts; verify counts and remove the private QA credential file. Keep the paired release backup.

Until steps are evidenced, real-device acceptance and final cleanup remain pending rather than being recorded as PASS.

## Security Boundaries

New body, images and writing time use `yishu-e2ee-v1`; r5 automatically enrolls device identities and pins first-contact peer keys with TOFU. Manual safety-code verification is optional; unverified initial public-key authenticity relies on the relay. Old letters remain server-at-rest encrypted. Metadata, tracking-number association and delivery-time gating rely on the trusted server. V1 has no forward secrecy, post-compromise security, key rotation or device revocation. Expo Go receives server-delivered code and cannot defend against a malicious code publisher. Do not advertise these absent protections.

## Phone Image Native Import Hotfix

The human's iPhone error stack shows `prepareImage -> asyncRequire/importAll -> metroImportAll -> get PushNotificationIOS -> NativeEventEmitter`. The E2EE image-preparation path dynamically imported the entire `react-native` CommonJS export namespace, evaluating its lazy native-module getters instead of accessing only `Image`. This is a client module-loading failure, not an upload-network error. Fresh server checks showed healthy API/preview, zero restarts/OOM events, two QA identities and zero QA media/letters.

Released fix: static named `import { Image } from "react-native"`, remove the dynamic React Native import. No cryptographic composition, key storage, image compression, backend, database or visibility change. A regression models an unsupported `PushNotificationIOS` getter and exercises ciphertext creation, authenticated decryption, retained input and temporary-ciphertext cleanup without accessing that getter. API-session tests mock the newly static native dependency. All 404 mobile tests, 20 shared tests, mobile TypeScript, scoped ESLint and Prettier checks passed. The actual installed Metro runtime's `metroImportAll` source confirms it enumerates and reads CommonJS export getters; React Native's lazy `PushNotificationIOS` getter matches the supplied error stack.

Deployment evidence: `/opt/yishu-preview/e2ee-image-20261005`, `preview-20261005-e2ee-image-r2`, based on the exact deployed reviewed-r1 image. Client source SHA-256 `0cf1939752eaecaa2396e57b34de0019792b010c4e4a8ffb90990886b4e2b189`; Linux-built source archive SHA-256 `e7000674120b4972efe9fd7ae07aa074ce8fd5bc0e3d00d22a13b0deb96fb24c`. An initial macOS archive was rejected for AppleDouble metadata before build/restart, then replaced by the clean archive. Server source verification, isolated iOS Hermes export (3367 modules, 23 assets, `entry-831978ec58467eb8a9c1294d778b4ad5.hbc`) and preview-only replacement passed. New preview is healthy with restart count 0; all six business/infrastructure image IDs and start times were unchanged. Public checks returned `EXPO_PREVIEW_HTTP_PASS`: signed manifest and certificate chain, SDK 57, Brotli-compressed bundle (21,289,915 characters), 32 packaged resources, production API configuration, E2EE modules, gallery/preload and initial route-fit limit. Phone upload re-test remains pending; native execution is not inferred from export or HTTP success.

## Composer Keyboard Follow-Up

The composer now accounts for the top safe-area inset in keyboard avoidance, scrolls the focused editor above the keyboard after viewport layout changes, and bounds the internally scrollable editor to the available viewport (80-220 points, with 32 points reserved). Blurring the editor stops automatic page scrolling. Regression checks exercise focus, keyboard-reduced layout, blur and restored height; all 405 mobile tests and mobile TypeScript passed. Scoped ESLint still reports eight pre-existing non-null assertions in the composer/screen tests; this change adds none. Source SHA-256 `28d5306d09bbab56977d689bb0833845ae1899f9056a6568f8cc05312190dd93`; clean archive SHA-256 `77b0e31655add4dbc514688b3b0f571c3ad4a76becbdad14d21498e3decd5bb0`. The single-file preview patch was deployed as `preview-20261005-keyboard-r3`, running image ID `sha256:e9431132f40ffba6e69c471314bac11408586d2602070b39ca8ba5d494010961`. Source verification, isolated iOS export, healthy preview replacement and six unchanged business/infrastructure containers passed. Actual keyboard behavior on iPhone remains pending.

The scope was subsequently expanded to every current input surface: login/registration, nickname editing, letter search, writing, encryption enrollment/recovery/contact fields, and region-search modals. A shared `KeyboardFrame` selects native iOS scroll insets or container avoidance without applying both; Android retains height avoidance. Input scrolling preserves handled taps and drag-to-dismiss. Region-modal coordinates use offset 0 and a shrinkable result list; multiline safety-code entry is internally scrollable and capped at 120 points. Native Fabric ScrollView source confirms automatic keyboard insets also bring the active text region above the keyboard. All 408 mobile tests, mobile TypeScript, formatting and lint for the newly expanded production modules passed; the eight existing non-null assertions noted above remain. The seven-file preview patch uses keyboard-r3 as parent; archive SHA-256 `fdd496c935a51dbc424be0ae514df249e330c1403f35947387bb4be59f6e209c`. Source verification, isolated iOS Hermes export (3367 modules, 202507 ms), healthy preview-only replacement and unchanged six business/infrastructure container images/start times passed. Current preview is keyboard-all-r4 (`sha256:6a881f6a31bd0e04050dda7130efa9d3ebd55b66bfe144ce0dec4738fcacc39f`), healthy with restart count 0; evidence is under `/opt/yishu-preview/keyboard-all-20261005`. Public checks returned `EXPO_PREVIEW_HTTP_PASS`, including the all-page keyboard markers, signed manifest/certificate chain, compressed bundle (21,293,494 characters), 32 assets, production API, E2EE modules, gallery preload and route-fit limit. Actual keyboard behavior on iPhone/Android remains unverified; this HTTP check is not a device-layout test.

The human requested transparent E2EE without mandatory safety-code entry. Automatic enrollment, optional recovery backup and trust-on-first-use contact pinning were proposed for confirmation, with explicit first-contact server trust and no silent key replacement on a new device. No cryptographic trust-policy or enrollment change is included in the keyboard patch.

## 2026-10-06 Automatic E2EE And Encryption Keyboard Follow-Up

The human reported that keyboard-all-r4 still obstructed the encryption-page input and displaced its header. Its earlier structural/export checks were not device-layout acceptance. The revised encryption page keeps the header outside the scrolling and keyboard-adjusted content, disables automatic scroll/content insets for this page, and explicitly measures a non-collapsible native viewport plus the focused TextInput to reveal its full bounds. Focus/measurement generation checks prevent stale callbacks from scrolling after blur. Other input pages keep their previous keyboard mode.

The human explicitly requested automatic, unobtrusive encryption and then chose to retain Expo Go after being offered a native Signal Protocol integration. This patch therefore keeps the existing project-defined hybrid protocol, not Signal or Telegram's protocol. It does not add forward secrecy, a double ratchet, device revocation, key transparency or an independent cryptographic audit.

- After authenticated login/session restore, bootstrap automatically generates and enrolls an identity if no registration exists. Writing and image encryption also await the same setup operation; concurrent calls coalesce.
- Identity, pending enrollment and the optional recovery code are held only in account/API-scoped device SecureStore. Private identity and recovery code are persisted before enrollment, so failed requests retry the identical registration, and lost responses do not strand device keys. Recovery codes are never uploaded; the registration includes an encrypted backup.
- Existing enrolled accounts with missing local keys fail with recovery required; no new identity silently replaces them. Existing manual accounts without a locally retained recovery code must keep their original external recovery code.
- First contacts are automatically pinned with trust-on-first-use. Initial public-key authenticity depends on the relay supplying the correct key. Serialized contact checks prevent competing first-key responses from silently overwriting a pin; later changes are rejected. Manual safety-code verification is optional and is the explicit route to accept a verified changed key.
- Incoming content is authenticated/decrypted before the first peer key is pinned. Recipient delivery gating, old letter behavior and transport-fact visibility are unchanged.
- The page no longer requires manual activation, recovery-code re-entry or contact verification for normal sending/reading. Backup and verification are optional controls; genuine lost-key recovery remains a required exception.

The independent read-only review found no P0/P1 blocker and identified an optional-backup compatibility issue: an old manual account with usable keys could not import its original recovery code. This is fixed with a user-opened import action based on `backupAvailable`, reusing validated recovery without changing registration or identity. An additional two-client test automatically enrolls both devices, sends encrypted text/time/image without entering codes, verifies recipient pre-delivery hiding, and decrypts all three after delivery.

Local checks: 431 mobile tests in 42 files, 20 shared tests and mobile TypeScript passed. Relevant production modules passed scoped ESLint and formatting. Independent follow-up review confirmed the optional backup issue closed and independently reran 123 focused tests in four files, all passed. These do not prove native device execution.

Preview-only release evidence: `/opt/yishu-preview/automatic-e2ee-20261006`. Eight frontend sources are overlaid onto the exact deployed keyboard-all-r4 base; clean archive SHA-256 `718e6f360012c48c91e1fd8dd6c08368bcd7d8ba32f7af318a1608b3d58d583f`. Source checksum and unsafe native-namespace import checks passed. Network-isolated iOS Hermes export passed (3369 modules, 210489 ms, `entry-1de507259601fd34ad56b7177b2fa8e6.hbc`). The export emitted the existing absent Android google-services config notice; it is an iOS Expo Go-only verification, not an Android rebuild.

The WorkBench connection closed during export; subsequent read-only checks confirmed the remote job continued and completed. Release marker is present, r5 is healthy with restart count 0, and all six business/infrastructure container image IDs and start times matched before/after. No API/worker, database migration, certificate, port, district-rule flag or APK change was made. Phone acceptance remains pending.

Public command: `node scripts/check-expo-preview.mjs https://8.136.121.71 --e2ee --letter-gallery --gallery-preload --route-fit-limit --keyboard-all --automatic-e2ee`. Result `EXPO_PREVIEW_HTTP_PASS`: signed manifest/certificate chain, SDK 57, Brotli-compressed bundle (21,302,235 characters), 32 resources, production API, E2EE/automatic bootstrap/keyboard markers, gallery preload and route-fit limit passed. All seven containers were freshly confirmed healthy afterward. Native SecureStore, automatic enrollment, picker/image encryption and keyboard behavior still require phone verification; this is not Final Gate PASS.
