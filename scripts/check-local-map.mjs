import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.YISHU_PLAYWRIGHT_PATH || "playwright");
const browser = await chromium.launch({
  headless: true,
  ...(process.env.YISHU_BROWSER_PATH ? { executablePath: process.env.YISHU_BROWSER_PATH } : {}),
});
try {
  for (const viewport of [
    { width: 390, height: 312 },
    { width: 1024, height: 700 },
  ]) {
    const page = await browser.newPage({ viewport });
    const errors = [],
      requests = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (new URL(request.url()).origin !== "http://127.0.0.1:4179") requests.push(request.url());
    });
    await page.goto("http://127.0.0.1:4179/geographic-map");
    await page.locator(".leaflet-marker-icon").first().waitFor();
    const country = await page.locator(".leaflet-geographic-base-pane path").count();
    if (country !== 34) throw new Error("national geometry incomplete");
    if (await page.locator(".leaflet-province-borders-pane").count())
      throw new Error("coarse province outline layer still present");
    const coarseStrokes = await page
      .locator(".leaflet-geographic-base-pane path")
      .evaluateAll((paths) => paths.some((path) => getComputedStyle(path).stroke !== "none"));
    if (coarseStrokes) throw new Error("coarse base outlines still visible");
    if (!(await page.locator("#map").getAttribute("class")).includes("national-view"))
      throw new Error("overview labels not suppressed");
    await page.screenshot({ path: `.local/geographic-national-${viewport.width}.png` });
    await page.getByRole("button", { name: "上海路线", exact: true }).click();
    if (
      (await page.locator(".journey-segment").count()) !== 2 ||
      (await page.locator(".journey-segment.transport").count()) !== 0
    )
      throw new Error("same-city journey must have exactly two district legs");
    const projection = await page.evaluate(() => {
      const map = window.yishuPreviewMap;
      const point = window.yishuPreviewView.stations[0];
      const marker = map.latLngToContainerPoint([point.lat, point.lng]);
      const icon = document.querySelector(".leaflet-marker-icon").getBoundingClientRect();
      return {
        crs: map.options.crs.code,
        distance: Math.hypot(marker.x - icon.x - 6, marker.y - icon.y - 6),
      };
    });
    if (projection.crs !== "EPSG:3857" || projection.distance > 2)
      throw new Error("route projection drift");
    const labels = await page.locator(".leaflet-tooltip").allTextContents();
    if (
      !labels.some((label) => label.includes("黄浦区")) ||
      !labels.some((label) => label.includes("浦东新区"))
    )
      throw new Error("district labels missing");
    const position = () =>
      page
        .locator(".leaflet-marker-icon")
        .first()
        .evaluate((el) => el.style.transform);
    const initial = await position();
    await page.locator(".leaflet-control-zoom-in").click();
    await page.waitForTimeout(400);
    if ((await position()) === initial) throw new Error("zoom did not change geometry");
    await page.mouse.move(viewport.width / 2, viewport.height / 2);
    await page.mouse.down();
    await page.mouse.move(viewport.width / 2 + 60, viewport.height / 2 + 30, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    const moved = await position();
    await page.evaluate(() => window.yishuUpdateMap(window.yishuPreviewView, 64));
    if ((await position()) !== moved) throw new Error("polling reset the viewport");
    // Existing overlays are not refitted unless the user requests it.
    await page.evaluate(() => window.yishuMapFit());
    await page.waitForTimeout(400);
    if ((await position()) === moved) throw new Error("fit did not restore framing");
    const clipped = await page.locator(".leaflet-tooltip").evaluateAll((labels) =>
      labels
        .map((el) => ({ label: el.textContent, rect: el.getBoundingClientRect() }))
        .filter(
          ({ rect }) =>
            rect.left < 0 || rect.right > innerWidth || rect.top < 0 || rect.bottom > innerHeight
        )
        .map(({ label }) => label)
    );
    await page.waitForFunction(
      () => document.querySelectorAll(".leaflet-district-boundaries-pane path").length >= 5
    );
    await page.screenshot({ path: `.local/geographic-route-${viewport.width}.png` });
    console.log(
      JSON.stringify({
        viewport,
        labels,
        errors,
        externalRequests: requests.length,
        clipped,
        debug: await page.evaluate(() => ({
          center: window.yishuPreviewMap.getCenter(),
          zoom: window.yishuPreviewMap.getZoom(),
          bounds: window.yishuPreviewMap.getBounds(),
          markers: [...document.querySelectorAll(".leaflet-marker-icon")].map(
            (e) => e.style.transform
          ),
        })),
      })
    );
    if (errors.length || requests.length || clipped.length)
      throw new Error("map verification failed");
    await page.evaluate(() => {
      window.yishuUpdateMap(window.yishuPreviewView, 96);
      window.yishuMapFit();
    });
    await page.waitForTimeout(400);
    const occluded = await page
      .locator(".leaflet-tooltip")
      .evaluateAll((labels) => labels.some((el) => el.getBoundingClientRect().top < 96));
    if (occluded) throw new Error("progress overlay would obscure labels");
    await page.waitForTimeout(250);
    const districtPaths = await page.locator(".leaflet-district-boundaries-pane path").count();
    if (districtPaths < 5) throw new Error("Shanghai district background missing");
    const shanghaiWaters = await page.locator(".leaflet-physical-water-pane path").count();
    if (!shanghaiWaters) throw new Error("same-source Shanghai hydrology missing");
    const collisions = await page.locator(".place-label").evaluateAll((nodes) => {
      const boxes = nodes.map((n) => n.getBoundingClientRect());
      return boxes.some((a, i) =>
        boxes
          .slice(i + 1)
          .some((b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top)
      );
    });
    if (collisions) throw new Error("background labels overlap");
    const stale = await page.locator(".leaflet-district-boundaries-pane").innerHTML();
    await page.evaluate(() =>
      window.yishuMapDetails({ id: -1, cities: [], districts: [], waters: [] })
    );
    if ((await page.locator(".leaflet-district-boundaries-pane").innerHTML()) !== stale)
      throw new Error("stale details replaced the current viewport");
    await page.getByRole("button", { name: "浙江省内", exact: true }).click();
    if (
      (await page.locator(".journey-segment").count()) !== 3 ||
      (await page.locator(".journey-segment.delivery").count()) !== 1 ||
      (await page.locator(".journey-segment.collection").count()) !== 1
    )
      throw new Error("province journey is missing a district or city leg");
    const fixture = await page.evaluate(() => window.yishuProvinceView);
    if (fixture.destination.district !== "余杭区" || fixture.delivery.from.city !== "杭州市")
      throw new Error("Hangzhou station-to-Yuhang destination is missing");
    await page.waitForFunction(
      () => document.querySelectorAll(".leaflet-city-boundaries-pane path").length > 3
    );
    await page.waitForFunction(() =>
      [...document.querySelectorAll(".place-label.city")].some((el) => el.textContent === "绍兴市")
    );
    await page.waitForTimeout(250);
    const cityPaths = await page.locator(".leaflet-city-boundaries-pane path").count();
    const waterPaths = await page.locator(".leaflet-physical-water-pane path").count();
    const routeLabelCollision = await page.evaluate(() => {
      const places = [...document.querySelectorAll(".place-label")].map((el) =>
        el.getBoundingClientRect()
      );
      const route = [
        ...document.querySelectorAll(".leaflet-marker-icon:not(.place-label), .leaflet-tooltip"),
      ]
        .filter((el) => {
          const s = getComputedStyle(el);
          return s.display !== "none" && Number(s.opacity) > 0.05;
        })
        .map((el) => el.getBoundingClientRect());
      return places.some((a) =>
        route.some(
          (b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
        )
      );
    });
    if (routeLabelCollision) throw new Error("background names obscure route markers or labels");
    await page.screenshot({ path: `.local/geographic-province-${viewport.width}.png` });
    console.log(
      JSON.stringify({
        status: "OFFLINE_DETAIL_BROWSER_PASS",
        viewport,
        cityPaths,
        districtPaths,
        waterPaths,
        labels: await page.locator(".place-label").allTextContents(),
      })
    );
    await page.getByRole("button", { name: "全国底图", exact: true }).click();
    await page.waitForTimeout(250);
    if (
      await page
        .locator(
          ".leaflet-city-boundaries-pane path,.leaflet-district-boundaries-pane path,.leaflet-physical-water-pane path"
        )
        .count()
    )
      throw new Error("national view retained heavyweight details");
    await page.close();
  }
} finally {
  await browser.close();
}
