import assert from "node:assert/strict";
import process from "node:process";
import console from "node:console";
import { URL } from "node:url";
/* global fetch, AbortSignal, Response, Blob */

const base = new URL(process.argv[2] ?? "");
assert.equal(base.protocol, "https:");
const directHttps = base.hostname === "8.136.121.71";
assert.ok(directHttps || base.hostname.endsWith(".exp.direct"));

const manifestResponse = await fetch(base, {
  headers: {
    "expo-platform": "ios",
    accept: "application/expo+json",
    "expo-expect-signature": 'keyid="expo-root", alg="rsa-v1_5-sha256"',
  },
  signal: AbortSignal.timeout(120000),
});
assert.ok(manifestResponse.ok, `manifest HTTP ${manifestResponse.status}`);
assert.ok(manifestResponse.headers.get("expo-signature"), "signed Expo manifest missing");
const manifest = await manifestResponse.json();
assert.equal(manifest.extra?.expoClient?.sdkVersion, "57.0.0");
assert.equal(manifest.extra?.expoClient?.owner, "uyrvyi");
const certificateResponse = await fetch(base, {
  headers: {
    "expo-platform": "ios",
    accept: "multipart/mixed",
    "expo-expect-signature": 'keyid="expo-root", alg="rsa-v1_5-sha256"',
  },
  signal: AbortSignal.timeout(120000),
});
assert.ok(certificateResponse.ok, `certificate manifest HTTP ${certificateResponse.status}`);
const certificateType = certificateResponse.headers.get("content-type") ?? "";
assert.ok(certificateType.startsWith("multipart/mixed"), "certificate multipart missing");
const certificateParts = await new Response(await certificateResponse.arrayBuffer(), {
  headers: { "content-type": certificateType.replace("multipart/mixed", "multipart/form-data") },
}).formData();
const certificateChain = certificateParts.get("certificate_chain");
assert.ok(certificateChain instanceof Blob, "certificate chain missing");
assert.ok((await certificateChain.text()).includes("BEGIN CERTIFICATE"), "certificate PEM missing");
assert.ok(manifest.launchAsset?.url, "launch asset missing");
const bundleUrl = new URL(manifest.launchAsset.url);
assert.equal(bundleUrl.hostname, base.hostname, "bundle must come from the preview server");
if (directHttps) {
  assert.equal(bundleUrl.protocol, "https:", "direct bundle must already use HTTPS");
  assert.equal(bundleUrl.port || "443", "443", "direct bundle must use existing ingress");
  assert.equal(
    bundleUrl.searchParams.get("lazy") ?? "false",
    "false",
    "public preview must be self-contained"
  );
}
assert.equal(
  bundleUrl.searchParams.get("dev"),
  "true",
  "Expo Go preview must use development mode"
);
assert.equal(
  bundleUrl.searchParams.get("minify") ?? "false",
  "false",
  "Expo Go preview must not be minified"
);
bundleUrl.protocol = "https:";
const bundleResponse = await fetch(bundleUrl, { signal: AbortSignal.timeout(180000) });
assert.ok(bundleResponse.ok, `bundle HTTP ${bundleResponse.status}`);
const bundle = await bundleResponse.text();
assert.ok(bundle.length > 100000, "bundle is unexpectedly small");
let packagedAssetFiles = 0;
if (directHttps) {
  assert.ok(
    ["gzip", "br"].includes(bundleResponse.headers.get("content-encoding")),
    "bundle compression missing"
  );
  const iconUrl = new URL(manifest.extra.expoClient.iconUrl);
  assert.equal(iconUrl.protocol, "https:");
  assert.equal(iconUrl.hostname, base.hostname);
  const iconResponse = await fetch(iconUrl, { signal: AbortSignal.timeout(15000) });
  assert.equal(iconResponse.status, 200, "preview image asset unavailable");
  const icon = new Uint8Array(await iconResponse.arrayBuffer());
  assert.deepEqual(
    [...icon.slice(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
    "preview asset is not PNG"
  );
  const assets = [
    ...bundle.matchAll(/\.registerAsset\((\{\s*"__packager_asset":[\s\S]*?\})\)/g),
  ].map((match) => JSON.parse(match[1]));
  assert.ok(assets.length > 0, "native asset metadata missing");
  for (const asset of assets) {
    for (const scale of asset.scales) {
      const suffix = scale === 1 ? "" : `@${scale}x`;
      const url = new URL(`${asset.httpServerLocation}/${asset.name}${suffix}.${asset.type}`, base);
      url.searchParams.set("platform", "ios");
      url.searchParams.set("hash", asset.hash);
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
      assert.equal(response.status, 200, `native asset unavailable: ${asset.name}${suffix}`);
      const pixels = new Uint8Array(await response.arrayBuffer());
      assert.ok(pixels.length > 0);
      if (asset.type === "png")
        assert.deepEqual([...pixels.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
      packagedAssetFiles++;
    }
  }
  const validUrl = new URL(
    `${assets[0].httpServerLocation}/${assets[0].name}.${assets[0].type}`,
    base
  );
  const invalidPaths = [
    "./../../home/node/.expo/preview-token",
    "./../../node_modules/.pnpm/../.env",
    "./../../node_modules/.pnpm/expo-router@57.0.24_fake/node_modules/expo-router/assets/../../../../.env",
    "./../../node_modules/.pnpm/expo-router@57.0.24_fake/node_modules/expo-router/assets/test.json",
  ];
  for (const path of invalidPaths) {
    const url = new URL(validUrl);
    url.searchParams.set("unstable_path", path);
    url.searchParams.set("platform", "ios");
    url.searchParams.set("hash", assets[0].hash);
    assert.equal(
      (await fetch(url, { signal: AbortSignal.timeout(10000) })).status,
      404,
      "package asset path escape allowed"
    );
  }
  const duplicate = new URL(validUrl);
  duplicate.searchParams.set("platform", "ios");
  duplicate.searchParams.set("hash", assets[0].hash);
  duplicate.searchParams.append("unstable_path", invalidPaths[0]);
  assert.equal(
    (await fetch(duplicate, { signal: AbortSignal.timeout(10000) })).status,
    404,
    "duplicate asset path allowed"
  );
}
assert.ok(bundle.includes("https://8.136.121.71"), "production API configuration missing");
const checkE2ee = process.argv.includes("--e2ee");
if (checkE2ee) {
  for (const symbol of [
    "yishu-e2ee-v1",
    "getRandomBytesAsync",
    "prepareEnrollment",
    "verifyContact",
    "e2ee_contact_unverified",
    "e2ee_recovery_required",
    "e2ee_session_changed",
    "x-yishu-content-protocol",
  ])
    assert.ok(bundle.includes(symbol), `E2EE preview module missing: ${symbol}`);
}
const checkKeyboard = process.argv.includes("--keyboard-all");
if (checkKeyboard) {
  for (const symbol of ["KeyboardFrame", "revealBody", "bodyTop.current", "setBodyHeight"])
    assert.ok(bundle.includes(symbol), `keyboard avoidance missing: ${symbol}`);
  assert.ok(
    [...bundle.matchAll(/nativeInsets:\s*true\b/g)].length >= 3,
    "native keyboard mode missing from an input page"
  );
  assert.ok(
    [...bundle.matchAll(/automaticallyAdjustKeyboardInsets:\s*true\b/g)].length >= 3,
    "native keyboard scroll insets missing from an input page"
  );
  assert.ok(
    /keyboardVerticalOffset:\s*0\b/.test(bundle),
    "region-modal keyboard coordinate offset missing"
  );
}
const checkAutomatic = process.argv.includes("--automatic-e2ee");
if (checkAutomatic) {
  for (const symbol of [
    "EncryptionBootstrap",
    "ensureReady",
    "backupRecoveryCode",
    "contactChecks",
    "revealKeyboardInput",
    "measureInWindow",
    "focusedInput.current",
  ])
    assert.ok(bundle.includes(symbol), `automatic E2EE/keyboard module missing: ${symbol}`);
  assert.ok(
    !bundle.includes('if (!pinned) throw new Error("e2ee_contact_unverified")'),
    "manual contact gate still present"
  );
}
const checkLetterGallery = process.argv.includes("--letter-gallery");
if (checkLetterGallery) {
  for (const symbol of [
    "changePage",
    "pages.current.index",
    "previewItems",
    "activeImage.id",
    "pageIndicator",
  ])
    assert.ok(bundle.includes(symbol), `letter gallery missing: ${symbol}`);
  assert.ok(bundle.includes('start.axis === "horizontal"'), "horizontal page gesture missing");
  assert.ok(bundle.includes("letter.images"), "letter-scoped image list missing");
}
const checkGalleryPreload = process.argv.includes("--gallery-preload");
if (checkGalleryPreload) {
  for (const symbol of [
    "createPrivateImageCache",
    "cache.preload()",
    "cache.read(activeImage.id)",
    ".getImageData(id, false,",
    "cache.dispose()",
    "idsKey",
    "sameSession",
  ])
    assert.ok(bundle.includes(symbol), `gallery preloading missing: ${symbol}`);
}
const checkRouteFitLimit = process.argv.includes("--route-fit-limit");
if (checkRouteFitLimit) {
  assert.ok(bundle.includes("routeFitMaxZoom"), "route auto-fit zoom limit missing");
  assert.ok(bundle.includes("maxZoom:routeFitMaxZoom"), "route auto-fit does not use zoom limit");
}
const checkUploadFeedback = process.argv.includes("--upload-feedback");
if (checkUploadFeedback) {
  const contains = (symbol) => {
    const escaped = symbol.replace(
      /[\u0080-\uFFFF]/g,
      (character) => "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0")
    );
    return (
      bundle.includes(symbol) ||
      bundle.includes(escaped) ||
      bundle.includes(escaped.toUpperCase().replaceAll("\\U", "\\u"))
    );
  };
  for (const symbol of ["图片已添加", "头像已更新"])
    assert.ok(!contains(symbol), `upload success alert still present: ${symbol}`);
  for (const symbol of ["部分图片未上传", "图片未上传", "头像未更新"])
    assert.ok(contains(symbol), `upload failure alert missing: ${symbol}`);
}
const checkUploadOptimization = process.argv.includes("--upload-optimized");
if (checkUploadOptimization) {
  for (const symbol of ["prepareUploadImage", "MAX_UPLOAD_EDGE", "UPLOAD_JPEG_QUALITY"])
    assert.ok(bundle.includes(symbol), `upload optimization missing: ${symbol}`);
}
const checkUploadProgress = process.argv.includes("--upload-progress");
if (checkUploadProgress) {
  for (const symbol of [
    "image-upload-progress",
    "createUploadTask",
    "totalBytesExpectedToSend",
    "imageUploadFetch",
  ])
    assert.ok(bundle.includes(symbol), `native upload progress missing: ${symbol}`);
}
const checkNativeAbortCompatibility = process.argv.includes("--native-abort-compatible");
if (checkNativeAbortCompatibility) {
  assert.ok(
    bundle.includes("assertImageUploadNotAborted"),
    "native abort compatibility fix missing"
  );
  const uploadStart = bundle.indexOf("function assertImageUploadNotAborted");
  const uploadEnd = bundle.indexOf("Network upload interrupted", uploadStart);
  assert.ok(uploadStart >= 0 && uploadEnd > uploadStart, "native upload implementation missing");
  assert.ok(
    !/\.throwIfAborted\s*\(/.test(bundle.slice(uploadStart, uploadEnd)),
    "upload module still calls unsupported throwIfAborted"
  );
}
const checkUploadFlow = process.argv.includes("--upload-flow");
if (checkUploadFlow) {
  for (const symbol of ["preparedMimeType", "准备中", "连接中", "等待确认"])
    assert.ok(bundle.includes(symbol), `upload flow optimization missing: ${symbol}`);
}
const checkSmallerPhotos = process.argv.includes("--smaller-photos");
if (checkSmallerPhotos) {
  for (const symbol of [
    "TARGET_JPEG_BYTES",
    "MIN_JPEG_EDGE",
    "MAX_JPEG_ENCODINGS",
    "AVATAR_JPEG_QUALITY",
    "nextPreparation",
  ])
    assert.ok(bundle.includes(symbol), `smaller photo pipeline missing: ${symbol}`);
  assert.ok(
    /MAX_UPLOAD_EDGE\s*=\s*(?:exports\.MAX_UPLOAD_EDGE\s*=\s*)?1600\b/.test(bundle),
    "1600-pixel limit missing"
  );
  assert.ok(
    /UPLOAD_JPEG_QUALITY\s*=\s*(?:exports\.UPLOAD_JPEG_QUALITY\s*=\s*)?0\.75\b/.test(bundle),
    "75% JPEG setting missing"
  );
}

const checkMediaLifecycle = process.argv.includes("--media-lifecycle");
if (checkMediaLifecycle) {
  for (const symbol of [
    "resetPreview",
    "beginGesture",
    "requestClose",
    "onStartShouldSetPanResponderCapture",
    "onPanResponderTerminationRequest",
    "createDraftMediaLifecycle",
    "sameSession",
  ])
    assert.ok(bundle.includes(symbol), `media lifecycle fix missing: ${symbol}`);
}

const checkAnyDirectionPreview = process.argv.includes("--any-direction-preview");
if (checkAnyDirectionPreview) {
  for (const symbol of ["dismissX", "dismissY", "dragDistance", "resetDismiss"])
    assert.ok(bundle.includes(symbol), `any-direction preview missing: ${symbol}`);
  assert.ok(
    /dragDistance\s*=\s*Math\.hypot\(dx,\s*dy\)/.test(bundle),
    "two-axis dismissal distance missing"
  );
  assert.ok(!bundle.includes("start.dragDown"), "down-only dismissal still present");
}

const checkPersistentPreviewPan = process.argv.includes("--persistent-preview-pan");
if (checkPersistentPreviewPan) {
  for (const symbol of ["panX", "panY", "multiTouch"])
    assert.ok(bundle.includes(symbol), `persistent preview pan missing: ${symbol}`);
  for (const axis of ["x", "y"])
    assert.ok(
      new RegExp(`pan${axis.toUpperCase()}\\.setValue\\(bounded\\.${axis}\\)`).test(bundle),
      `native animated pan axis ${axis} missing`
    );
  assert.ok(bundle.includes("!start.multiTouch"), "multi-touch dismiss protection missing");
  assert.ok(!bundle.includes("translateX: position.x"), "static preview pan still present");
}

const checkPreviewTouchSession = process.argv.includes("--preview-touch-session");
if (checkPreviewTouchSession) {
  for (const symbol of [
    "touchSession",
    "observeMultiTouch",
    "trackTouchStart",
    "trackTouches",
    "cancelTouches",
    "protectedTouch",
    "tapEpoch",
  ])
    assert.ok(bundle.includes(symbol), `preview touch session protection missing: ${symbol}`);
  assert.ok(
    bundle.includes("onTouchStart: trackTouchStart"),
    "physical touch-start tracking missing"
  );
  assert.ok(
    bundle.includes("onTouchCancel: cancelTouches"),
    "physical touch-cancel tracking missing"
  );
}

const checkGeographicMap = process.argv.includes("--geographic-map");
if (checkGeographicMap) {
  // JSX labels can be emitted as Unicode escapes in Metro's development bundle.
  const contains = (symbol) => {
    const escaped = symbol.replace(
      /[\u0080-\uFFFF]/g,
      (character) => "\\u" + character.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")
    );
    return (
      bundle.includes(symbol) || bundle.includes(escaped) || bundle.includes(escaped.toLowerCase())
    );
  };
  for (const symbol of [
    "CHINA_GEOGRAPHIC_GEOJSON",
    "CHINA_GEOGRAPHIC_META",
    "geographicMapPayload",
    "toDisplayPoint",
    "查看全国底图",
    "window.yishuMapOverview",
    "crs:L.CRS.EPSG3857",
    "var base=L.geoJSON(",
    ...(process.argv.includes("--static-tiles") ? ["staticTileConfig"] : ["connect-src 'none'"]),
  ])
    assert.ok(contains(symbol), `geographic map missing: ${symbol}`);
  assert.ok(!bundle.includes("crs:L.CRS.Simple"), "distorted simple map projection still active");
  assert.ok(!contains("百度地图加载中"), "old Baidu interactive map still active");
}

const launchResponse = await fetch(new URL("/_expo/loading?platform=ios", base), {
  signal: AbortSignal.timeout(30000),
});
const checkMapScrollLock = process.argv.includes("--map-scroll-lock");
if (checkMapScrollLock) {
  for (const symbol of [
    "beginMapTouch",
    "finishMapTouch",
    "onInteractionChange",
    "handleMapInteraction",
    "mapInteracting",
    "pageScroll.current?.setNativeProps",
    "nestedScrollEnabled: true",
    "touch-action:none;overscroll-behavior:none",
    "{passive:false}",
  ])
    assert.ok(bundle.includes(symbol), `map scroll ownership missing: ${symbol}`);
}
const checkStaticTiles = process.argv.includes("--static-tiles");
if (checkStaticTiles) {
  for (const symbol of [
    "https://8.136.121.71/maps/national-20261003-v2",
    "staticTileScript",
    "L.vectorGrid.protobuf",
    "rendererFactory:L.canvas.tile",
    "maxNativeZoom:12",
    "water,road,coastline,boundary",
  ])
    assert.ok(
      bundle.includes(symbol) || bundle.includes(symbol.replaceAll(",", "','")),
      `static tiles missing: ${symbol}`
    );
}
assert.ok(launchResponse.ok, `launch page HTTP ${launchResponse.status}`);
if (directHttps) {
  assert.ok((await launchResponse.text()).includes('href="exps://8.136.121.71:443"'));
  for (const path of [
    "/open",
    "/_expo/open",
    "/inspector",
    "/json/list",
    "/message",
    "/symbolicate",
    "/.env",
    "/status",
    "/assets/home/node/.expo/preview-token",
    "/assets/../package.json",
  ]) {
    const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 404, `debug/private route exposed: ${path}`);
  }
  const blockedWrite = await fetch(new URL(bundleUrl), {
    method: "POST",
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(blockedWrite.status, 404, "preview write route exposed");
}
console.log(
  JSON.stringify({
    status: "EXPO_PREVIEW_HTTP_PASS",
    sdk: manifest.extra.expoClient.sdkVersion,
    host: base.hostname,
    directHttps,
    bundleCompression: bundleResponse.headers.get("content-encoding"),
    packagedAssetFiles,
    bundleCharacters: bundle.length,
    productionApiConfigured: true,
    signedManifestProvided: true,
    certificateChainProvided: true,
    developmentMode: true,
    uploadOptimizationProvided: checkUploadOptimization ? true : "not_checked",
    uploadProgressProvided: checkUploadProgress ? true : "not_checked",
    nativeAbortCompatible: checkNativeAbortCompatibility ? true : "not_checked",
    uploadFlowOptimized: checkUploadFlow ? true : "not_checked",
    smallerPhotosProvided: checkSmallerPhotos ? true : "not_checked",
    mediaLifecycleProvided: checkMediaLifecycle ? true : "not_checked",
    anyDirectionPreviewProvided: checkAnyDirectionPreview ? true : "not_checked",
    persistentPreviewPanProvided: checkPersistentPreviewPan ? true : "not_checked",
    previewTouchSessionProvided: checkPreviewTouchSession ? true : "not_checked",
    geographicMapProvided: checkGeographicMap ? true : "not_checked",
    mapScrollLockProvided: checkMapScrollLock ? true : "not_checked",
    staticTilesProvided: checkStaticTiles ? true : "not_checked",
    uploadFeedbackProvided: checkUploadFeedback ? true : "not_checked",
    letterGalleryProvided: checkLetterGallery ? true : "not_checked",
    galleryPreloadProvided: checkGalleryPreload ? true : "not_checked",
    routeFitLimitProvided: checkRouteFitLimit ? true : "not_checked",
    e2eeProtocolBundled: checkE2ee ? true : "not_checked",
    keyboardAvoidanceProvided: checkKeyboard ? true : "not_checked",
    automaticEncryptionProvided: checkAutomatic ? true : "not_checked",
    expoGoAccountVerification: "pending",
    deviceVerification: "pending",
  })
);
