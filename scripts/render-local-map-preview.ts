import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { buildLocalMapHtml, mapUpdateScript } from "../apps/mobile/src/map/localMapHtml.js";
import { geographicMapPayload } from "../apps/mobile/src/map/displayProjection.js";
import { mapDetailsForViewport } from "../apps/mobile/src/map/mapDetails.js";
import { districtPoint } from "../apps/api/src/lib/district-map.js";
import { resolveMapStationPoint } from "../apps/api/src/lib/map-station-point.js";
import { resolveStationForRegion } from "../apps/api/src/lib/stationGraph.js";
const region = { province: "上海市", city: "上海市", district: "黄浦区" };
const origin = districtPoint(region)!;
const destination = districtPoint({ ...region, district: "浦东新区" })!;
const station = resolveMapStationPoint({
  graphVersion: "china-v1",
  nodeId: resolveStationForRegion(region, "china-v1"),
})!;
const view = {
  status: "DISPATCHED" as const,
  origin,
  destination,
  completedPath: [origin],
  remainingPath: [],
  lastKnownPosition: origin,
  approximatePosition: null,
  facts: [],
  stations: [station],
  collection: { from: origin, to: station, state: "IN_PROGRESS" as const },
  delivery: { from: station, to: destination, state: "PLANNED" as const },
};
const stationFor = (province: string, city: string, district: string) => {
  const region = { province, city, district };
  return resolveMapStationPoint({
    graphVersion: "china-v1",
    nodeId: resolveStationForRegion(region, "china-v1"),
  })!;
};
const hangzhou = stationFor("浙江省", "杭州市", "上城区"),
  ningbo = stationFor("浙江省", "宁波市", "海曙区");
const provinceDetails = mapDetailsForViewport({ id: 1, zoom: 13, bounds: [118, 27, 124, 33] });
const tileLabels = JSON.parse(
  readFileSync(new URL("../.local/maps/labels.json", import.meta.url), "utf8")
) as { name: string; level: number; center: number[] }[];
const previewDistrict = (code: string, province: string, city: string) => {
  const feature = provinceDetails.districts.find((f) => f.properties.code === code);
  const candidates = tileLabels.filter((p) => p.level === 6 && p.name === feature?.properties.name);
  const center = candidates.length === 1 ? candidates[0]!.center : undefined;
  if (!feature || !center) throw new Error("preview_district_missing:" + code);
  return {
    name: city + feature.properties.name,
    province,
    city,
    district: feature.properties.name,
    x: ((center[0]! + 180) / 360) * 1000,
    y: ((90 - center[1]!) / 180) * 800,
  };
};
// Synthetic fixtures use same-source OSM representatives, not historical business anchors.
const haishu = previewDistrict("330203", "浙江省", "宁波市");
const yuhang = previewDistrict("330110", "浙江省", "杭州市");
const provinceView = {
  ...view,
  status: "IN_TRANSIT" as const,
  origin: haishu,
  destination: yuhang,
  stations: [ningbo, hangzhou],
  collection: { from: haishu, to: ningbo, state: "COMPLETED" as const },
  delivery: { from: hangzhou, to: yuhang, state: "PLANNED" as const },
  remainingPath: [ningbo, hangzhou],
  completedPath: [haishu, ningbo],
  lastKnownPosition: ningbo,
};
// Use the production origin only for an explicit deployment verification run.
const previewTileBase = process.env.MAP_PREVIEW_TILE_BASE_URL ?? "http://127.0.0.1:4180/maps/national-20261003-v2";
const sampleAreas = [
  { name: "北京", center: [116.4, 39.91] },
  { name: "武汉", center: [114.3, 30.58] },
  { name: "成都", center: [104.07, 30.66] },
  { name: "广州", center: [113.28, 23.13] },
  { name: "乌鲁木齐", center: [87.62, 43.82] },
  { name: "拉萨", center: [91.13, 29.65] },
  { name: "海口", center: [110.33, 20.03] },
  { name: "香港", center: [114.17, 22.3] },
  { name: "澳门", center: [113.55, 22.2] },
  { name: "台北", center: [121.56, 25.04] },
];
const toolbar = `<nav id="preview-modes"><button type="button" id="overview" aria-pressed="true">全国底图</button><button type="button" id="province" aria-pressed="false">浙江省内</button><button type="button" id="route" aria-pressed="false">上海路线</button><select id="sample-area" aria-label="全国地区预览"><option value="">更多地区</option>${sampleAreas.map((a, i) => `<option value="${i}">${a.name}</option>`).join("")}</select></nav><style>#preview-modes{position:absolute;top:14px;left:14px;right:14px;width:max-content;max-width:calc(100% - 28px);z-index:1000;display:flex;flex-wrap:wrap;padding:3px;background:#fff;border:1px solid #dce5e9;border-radius:12px;box-shadow:0 2px 12px #0001}#preview-modes button,#sample-area{font:13px Arial,sans-serif;border:0;border-radius:9px;background:transparent;color:#52707c;padding:9px 10px;cursor:pointer;min-width:0}#preview-modes button[aria-pressed=true]{background:#edf5f2;color:#176954;font-weight:600}</style>`;
const html = buildLocalMapHtml({ baseUrl: previewTileBase })
  .replace("var layer=", "window.yishuPreviewMap=map;var layer=")
  .replace('<div id="map"></div>', '<div id="map"></div>' + toolbar)
  .replace("</head>", "<title>驿书地图重绘预览</title></head>")
  .replace(
    "</body>",
    `<script>window.yishuPreviewView=${JSON.stringify(geographicMapPayload(view))};window.yishuProvinceView=${JSON.stringify(geographicMapPayload(provinceView))};
${mapUpdateScript(view, 64)}window.yishuMapOverview();
var overview=document.getElementById('overview'),route=document.getElementById('route'),province=document.getElementById('province');
var select=function(button){[overview,route,province].forEach(function(b){b.setAttribute('aria-pressed',String(b===button))});if(button)document.getElementById('sample-area').value=''};
overview.onclick=function(){select(overview);window.yishuMapOverview()};
route.onclick=function(){select(route);window.yishuUpdateMap(window.yishuPreviewView,64);window.yishuMapFit()};
province.onclick=function(){select(province);window.yishuUpdateMap(window.yishuProvinceView,64);window.yishuMapFit()};
document.getElementById('sample-area').onchange=function(){if(this.value==='')return;select(null);var a=${JSON.stringify(sampleAreas)}[Number(this.value)];window.yishuPreviewMap.setView([a.center[1],a.center[0]],11,{animate:false})};
</script></body>`
  );
mkdirSync(new URL("../.local", import.meta.url), { recursive: true });
mkdirSync(new URL("../.local/water-source", import.meta.url), { recursive: true });
if (process.env.MAP_PREVIEW_TILE_BASE_URL) {
  writeFileSync(new URL("../.local/cloud-map-preview.html", import.meta.url), html);
} else {
  writeFileSync(new URL("../.local/map-preview.html", import.meta.url), html);
  writeFileSync(new URL("../.local/geographic-map-preview.html", import.meta.url), html);
}
writeFileSync(
  new URL("../.local/water-source/preview-endpoints.json", import.meta.url),
  JSON.stringify(
    [
      ["310101", geographicMapPayload(view).origin],
      ["310115", geographicMapPayload(view).destination],
      ["330203", geographicMapPayload(provinceView).origin],
      ["330110", geographicMapPayload(provinceView).destination],
    ].map(([code, point]) => ({
      code,
      point,
      geometry: provinceDetails.districts.find((f) => f.properties.code === code)!.geometry,
    }))
  )
);
writeFileSync(
  new URL("../.local/water-source/shanghai-rendered.geojson", import.meta.url),
  JSON.stringify({
    type: "FeatureCollection",
    features: [
      ...provinceDetails.districts.filter((f) => f.properties.source === "OSM"),
      ...provinceDetails.waters,
    ],
  })
);
console.log(process.env.MAP_PREVIEW_TILE_BASE_URL ? ".local/cloud-map-preview.html" : ".local/map-preview.html");
