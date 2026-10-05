import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

assert.ok(
  process.argv[2],
  "Usage: node scripts/verify-next-version-android.mjs <prebuilt-mobile-dir>"
);
const target = resolve(process.argv[2]);
const source = fileURLToPath(new URL("../apps/mobile/", import.meta.url));
const app = JSON.parse(await readFile(join(source, "app.json"), "utf8")).expo;
const originalConfig = await readFile(join(source, "google-services.json"));
const nativeConfig = await readFile(join(target, "android/app/google-services.json"));
assert.ok(originalConfig.equals(nativeConfig), "Native Firebase configuration differs from source");
const firebase = JSON.parse(nativeConfig.toString("utf8"));
assert.ok(
  !firebase.private_key && !firebase.private_key_id,
  "Client config contains a private key"
);
assert.ok(firebase.project_info?.project_id, "Missing Firebase project ID");
assert.ok(
  firebase.client?.some(
    (client) => client.client_info?.android_client_info?.package_name === app.android.package
  ),
  "Firebase Android package differs from app config"
);

const requireMobile = createRequire(join(target, "package.json"));
const requireExpo = createRequire(requireMobile.resolve("expo/package.json"));
const { AndroidConfig } = requireExpo("@expo/config-plugins");
const mainManifest = await AndroidConfig.Manifest.readAndroidManifestAsync(
  join(target, "android/app/src/main/AndroidManifest.xml")
);
const notificationManifest = await AndroidConfig.Manifest.readAndroidManifestAsync(
  join(
    dirname(requireMobile.resolve("expo-notifications/package.json")),
    "android/src/main/AndroidManifest.xml"
  )
);
const permissions = (mainManifest.manifest["uses-permission"] ?? [])
  .filter((permission) => permission.$["tools:node"] !== "remove")
  .map((permission) => permission.$["android:name"]);
assert.ok(permissions.includes("android.permission.ACCESS_FINE_LOCATION"));
assert.ok(!permissions.includes("android.permission.ACCESS_BACKGROUND_LOCATION"));
assert.ok(!permissions.includes("android.permission.CAMERA"));
assert.ok(!permissions.includes("android.permission.RECORD_AUDIO"));

// Notification permissions and the FCM receiver are merged from the library during Gradle build.
assert.ok(
  notificationManifest.manifest["uses-permission"].some(
    (permission) => permission.$["android:name"] === "android.permission.POST_NOTIFICATIONS"
  )
);
const fcmService = notificationManifest.manifest.application[0].service.find(
  (service) => service.$["android:name"] === ".service.ExpoFirebaseMessagingService"
);
assert.ok(fcmService, "Missing Expo FCM receiver service");
assert.equal(fcmService.$["android:exported"], "false");
assert.ok(
  fcmService["intent-filter"].some((filter) =>
    filter.action.some(
      (action) => action.$["android:name"] === "com.google.firebase.MESSAGING_EVENT"
    )
  )
);
const gradle = await readFile(join(target, "android/app/build.gradle"), "utf8");
assert.match(gradle, /^apply plugin:\s*["']com\.google\.gms\.google-services["']/m);
assert.match(gradle, new RegExp(`\\bversionCode\\s+${app.android.versionCode}\\b`));
const version = app.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
assert.match(gradle, new RegExp(`\\bversionName\\s+["']${version}["']`));
console.log(
  JSON.stringify({
    status: "ANDROID_NATIVE_FCM_CONFIG_CHECK_PASS",
    projectId: firebase.project_info.project_id,
    package: app.android.package,
    version: app.version,
    versionCode: app.android.versionCode,
    googleServicesCopied: true,
    googleServicesGradlePlugin: true,
    notificationLibraryPermissionAndService: true,
    foregroundLocationOnly: true,
    cameraAndMicrophoneNotRequested: true,
    scope: "prebuild-inputs-only",
    nativeApkBuilt: false,
  })
);
