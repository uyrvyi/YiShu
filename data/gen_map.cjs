#!/usr/bin/env node
/**
 * Phase 8 本地地图资产生成器（开发规范 §14 / §15 / §17；Gate M5 修复后）。
 *
 * **两个独立职责的数据源**（不混用）：
 * 1. 行政边界底图：vendored 静态源 `data/maps/source/geoBoundaries-CHN-ADM1-2019-simplified.geojson`
 *    （geoBoundaries gbOpen / CHN / ADM1，pinned revision `9469f09`，34 个 ADM1 features；离线只读）。
 * 2. 路线锚点：`data/graphs/china-v1/station_nodes.json`（294 个 station；只提供 route anchor /
 *    站点位置 / Journey 几何，**不再作为行政边界来源**）。
 *
 * **唯一坐标管线**（Gate M5）：
 * ```text
 * 边界 lng/lat ─┐
 *               ├─→ Phase 4 canonical projection (data/map_projection.cjs) ─→ mapX/mapY
 * station 锚点 ─┘                                                                 │
 *                                                        MAP_FIT（@yishu/shared）  │
 *                                                                 ↓              ↓
 *                                                   viewBox "0 0 1000 800"（统一）
 * ```
 *
 * **禁止**（M5 明确）：station 点云凸包 / 外扩 / 六边形 / 自定义简化 / buffer；
 * 独立 scale「视觉对齐」；运行时网络访问（只读 vendored source，并校验 SHA-256）。
 *
 * 生成物（职责不变）：
 * 1. `data/maps/china-districts.json`：canonical 生成几何（ADM1 边界 + outline + fit 元数据）
 * 2. `data/maps/china-map.svg`：可直接预览的 SVG（viewBox 0 0 1000 800，含 fit 变换组）
 * 3. `apps/mobile/src/map/chinaMapData.ts`：Mobile bundle 使用的 TS 模块（同一几何）
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const polygonClipping = require("polygon-clipping");

const { round1, projectLngLat, projectStation } = require("./map_projection.cjs");

const ROOT = path.resolve(__dirname, "..");
const MAP_VERSION = "china-v1";
const NODES_PATH = path.join(ROOT, "data", "graphs", MAP_VERSION, "station_nodes.json");
const SOURCE_PATH = path.join(
  ROOT,
  "data",
  "maps",
  "source",
  "geoBoundaries-CHN-ADM1-2019-simplified.geojson"
);
const OUT_DIR = path.join(ROOT, "data", "maps");
const OUT_DISTRICTS = path.join(OUT_DIR, "china-districts.json");
const OUT_SVG = path.join(OUT_DIR, "china-map.svg");
const OUT_MOBILE = path.join(ROOT, "apps", "mobile", "src", "map", "chinaMapData.ts");

const VIEWBOX = { width: 1000, height: 800 };
const MARGIN = 60;
/** 冻结源完整性（Gate M5：源文件字节级固定；变更必须走负责人裁定 + 文档更新）。 */
const SOURCE_SHA256 = "bc4afc7eacf4351ae5b3ae7a612327987ce1123cb5deb8574fb49107091c6623";
const SOURCE_EXPECTED_FEATURES = 34;
/** 与 `packages/shared/src/index.ts` 的 MAP_DATA_BOUNDS 必须一致（数据即契约）。 */
const EXPECTED_BOUNDS = { minX: 704.4, maxX: 874.3, minY: 161.9, maxY: 319.3 };

/** 坐标序列化精度（mapX/mapY 单位；0.001 ≈ 53 m，远小于 1 viewBox 单位）。 */
const COORD_DECIMALS = 3;

/**
 * route province（station graph 中文 canonical）→ 源 ADM1 `shapeName` 的**显式**映射。
 *
 * 禁止 substring / fuzzy match；未列出的源 feature 不参与 route province 映射（仅作底图）。
 * 当前 station graph 的 31 个 route province 必须 31/31 命中（脚本内断言）。
 */
const ROUTE_PROVINCE_TO_ADM1 = {
  北京市: "Beijing Municipality",
  天津市: "Tianjin Municipality",
  河北省: "Hebei Province",
  山西省: "Shanxi Province",
  内蒙古自治区: "Inner Mongolia Autonomous Region",
  辽宁省: "Liaoning Province",
  吉林省: "Jilin Province",
  黑龙江省: "Heilongjiang Province",
  上海市: "Shanghai Municipality",
  江苏省: "Jiangsu Province",
  浙江省: "Zhejiang Province",
  安徽省: "Anhui Province",
  福建省: "Fujian Province",
  江西省: "Jiangxi Province",
  山东省: "Shandong Province",
  河南省: "Henan Province",
  湖北省: "Hubei Province",
  湖南省: "Hunan Province",
  广东省: "Guangzhou Province",
  广西壮族自治区: "Guangxi Zhuang Autonomous Region",
  海南省: "Hainan Province",
  重庆市: "Chongqing Municipality",
  四川省: "Sichuan Province",
  贵州省: "Guizhou Province",
  云南省: "Yunnan Province",
  西藏自治区: "Tibet Autonomous Region",
  陕西省: "Shaanxi Province",
  甘肃省: "Gansu Province",
  青海省: "Qinghai Province",
  宁夏回族自治区: "Ningxia Ningxia Hui Autonomous Region",
  新疆维吾尔自治区: "Xinjiang Uyghur Autonomous Region",
};

/** 源 feature 的权威 metadata（来自 pinned revision；README 记录同一份事实）。 */
const SOURCE_METADATA = {
  provider: "geoBoundaries",
  dataset: "gbOpen",
  iso: "CHN",
  boundaryType: "ADM1",
  boundaryID: "CHN-ADM1-43563684",
  boundaryCanonical: "People’s Republic of China",
  boundaryYearRepresented: 2019,
  upstreamRevision: "9469f09",
  upstreamLicense: "Public Domain",
  upstreamLicenseNote:
    'gbOpen 项目总体按 CC-BY 4.0 说明；该 boundary 的 metadata 标记为 "Public Domain"',
  upstreamSource: "geoBoundaries, Wikimedia Commons",
  upstreamSourceDataUpdateDate: "2023-01-19",
  upstreamBuildDate: "2023-12-12",
  admUnitCount: 34,
  inputArtifact: "geoBoundaries-CHN-ADM1_simplified.geojson",
  vendoredPath: "data/maps/source/geoBoundaries-CHN-ADM1-2019-simplified.geojson",
  runtimeNetworkAccess: "none",
};

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function fail(message) {
  throw new Error(`gen_map: ${message}`);
}

/** 顶点序列化（定点小数，去除浮点噪声；确定性）。 */
function fmt(value) {
  return String(Number(value.toFixed(COORD_DECIMALS)));
}

/** 环（ring）→ SVG 子路径（`M x y L x y ... Z`）。 */
function ringToPath(ring) {
  const body = ring.map((p) => `${fmt(p[0])} ${fmt(p[1])}`).join(" L ");
  return `M ${body} Z`;
}

/**
 * GeoJSON Polygon / MultiPolygon（已投影到 mapX/mapY）→ SVG path。
 *
 * 保留**全部** polygon 与 ring（岛屿、飞地、洞都不丢；禁止只取 `polygon[0]` / largest ring）。
 */
function geometryToPath(polygons) {
  const parts = [];
  for (const polygon of polygons) {
    for (const ring of polygon) parts.push(ringToPath(ring));
  }
  return parts.join(" ");
}

/** 校验 SHA-256（源文件字节级冻结）。 */
function assertSourceIntegrity(sourceBuffer) {
  const actual = crypto.createHash("sha256").update(sourceBuffer).digest("hex");
  if (actual !== SOURCE_SHA256) {
    fail(
      `行政边界源 SHA-256 漂移：\n  expected=${SOURCE_SHA256}\n  actual  =${actual}\n` +
        "源文件是 pinned vendored artifact（禁止手工编辑 / 静默替换）；" +
        "如确需升级，请由项目负责人裁定并同步 data/maps/README.md"
    );
  }
}

/** 把源 feature 的 geometry 投影到 mapX/mapY（全精度；不做任何简化 / 外扩）。 */
function projectFeature(feature) {
  const type = feature.geometry.type;
  const raw = feature.geometry.coordinates;
  const polygons = type === "MultiPolygon" ? raw : type === "Polygon" ? [raw] : null;
  if (polygons === null) {
    fail(`不支持的 geometry type: ${type}（feature ${feature.properties.shapeID}）`);
  }
  return polygons.map((polygon) =>
    polygon.map((ring) => ring.map((c) => projectLngLat(c[0], c[1])))
  );
}

function main() {
  // ---- 1) 源：vendored ADM1 边界（离线只读 + 完整性校验） ----
  const sourceBuffer = fs.readFileSync(SOURCE_PATH);
  assertSourceIntegrity(sourceBuffer);
  const geo = JSON.parse(sourceBuffer.toString("utf8"));
  if (geo.type !== "FeatureCollection") fail(`源不是 FeatureCollection: ${geo.type}`);
  if (geo.features.length !== SOURCE_EXPECTED_FEATURES) {
    fail(`ADM1 feature 数漂移：expected=${SOURCE_EXPECTED_FEATURES} actual=${geo.features.length}`);
  }
  const shapeIds = new Set();
  const shapesById = new Map();
  for (const feature of geo.features) {
    const { shapeID, shapeName } = feature.properties;
    if (typeof shapeID !== "string" || shapeID.length === 0) fail("feature 缺少 shapeID");
    if (shapeIds.has(shapeID)) fail(`feature shapeID 重复: ${shapeID}`);
    shapeIds.add(shapeID);
    shapesById.set(shapeID, { shapeID, shapeName, geometry: projectFeature(feature) });
  }

  // ---- 2) station 锚点（路线用；不得作为行政边界来源） ----
  const nodes = readJson(NODES_PATH);
  if (!Array.isArray(nodes) || nodes.length === 0) fail(`empty station nodes: ${NODES_PATH}`);
  for (const n of nodes) {
    if (typeof n.mapX !== "number" || typeof n.mapY !== "number") {
      fail(`station ${n.id} missing numeric mapX/mapY`);
    }
    // Gate M5：Phase 4 canonical projection 必须能复现冻结值（不允许第二套投影）
    const [x, y] = projectStation(n.lng, n.lat);
    if (Math.abs(x - n.mapX) > 1e-6 || Math.abs(y - n.mapY) > 1e-6) {
      fail(
        `MAP PROJECTION MISMATCH: station ${n.id} frozen=(${n.mapX},${n.mapY}) ` +
          `recomputed=(${x},${y})`
      );
    }
  }

  // ---- 3) route province → ADM1 映射完整性（31/31；显式映射，无 fuzzy match） ----
  const routeProvinces = [...new Set(nodes.map((n) => n.province))].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0
  );
  const adm1NameToShape = new Map();
  for (const shape of shapesById.values()) {
    if (adm1NameToShape.has(shape.shapeName)) {
      fail(`ADM1 shapeName 重复（映射不唯一）: ${shape.shapeName}`);
    }
    adm1NameToShape.set(shape.shapeName, shape);
  }
  const unmappedRouteProvinces = routeProvinces.filter((p) => !ROUTE_PROVINCE_TO_ADM1[p]);
  if (unmappedRouteProvinces.length > 0) {
    fail(`route province 未登记 ADM1 映射: ${unmappedRouteProvinces.join(", ")}`);
  }
  const usedShapeIds = new Set();
  for (const province of routeProvinces) {
    const adm1Name = ROUTE_PROVINCE_TO_ADM1[province];
    const shape = adm1NameToShape.get(adm1Name);
    if (!shape) fail(`route province ${province} 映射到不存在的 ADM1 feature: ${adm1Name}`);
    if (usedShapeIds.has(shape.shapeID)) {
      fail(`ADM1 feature 被多个 route province 复用: ${adm1Name}`);
    }
    usedShapeIds.add(shape.shapeID);
  }

  // ---- 4) bounds / fit（边界 ∪ 站点的 mapX/mapY 范围；向外取整到 0.1 保证包含） ----
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const extend = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) fail(`非有限坐标: (${x},${y})`);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  for (const shape of shapesById.values()) {
    for (const polygon of shape.geometry) {
      for (const ring of polygon) for (const [x, y] of ring) extend(x, y);
    }
  }
  for (const n of nodes) extend(n.mapX, n.mapY);
  const bounds = {
    minX: Math.floor(minX * 10) / 10,
    maxX: Math.ceil(maxX * 10) / 10,
    minY: Math.floor(minY * 10) / 10,
    maxY: Math.ceil(maxY * 10) / 10,
  };
  for (const key of Object.keys(EXPECTED_BOUNDS)) {
    if (Math.abs(bounds[key] - EXPECTED_BOUNDS[key]) > 1e-9) {
      fail(
        `bounds drift on ${key}: computed=${bounds[key]} expected=${EXPECTED_BOUNDS[key]}；` +
          "请同步 packages/shared 的 MAP_DATA_BOUNDS"
      );
    }
  }
  const spanX = bounds.maxX - bounds.minX;
  const spanY = bounds.maxY - bounds.minY;
  const scale = Math.min(
    (VIEWBOX.width - 2 * MARGIN) / spanX,
    (VIEWBOX.height - 2 * MARGIN) / spanY
  );
  const tx = MARGIN + (VIEWBOX.width - 2 * MARGIN - spanX * scale) / 2 - bounds.minX * scale;
  const ty = MARGIN + (VIEWBOX.height - 2 * MARGIN - spanY * scale) / 2 - bounds.minY * scale;
  const fit = { scale, tx, ty };

  // ---- 5) 外轮廓：全部 ADM1 geometry 的 union（保留源拓扑；不做凸包 / 不做简化） ----
  const unioned = polygonClipping.union(...[...shapesById.values()].map((shape) => shape.geometry));
  if (!Array.isArray(unioned) || unioned.length === 0) fail("outline union 失败（空结果）");
  const outlineD = geometryToPath(unioned);
  const outlineRingCount = unioned.reduce((sum, polygon) => sum + polygon.length, 0);
  if (outlineD.length === 0) fail("outline path 为空");

  // ---- 6) 省级（ADM1）形状：全部 34 个 feature；route province 映射为可选字段 ----
  const provinceByAdm1 = new Map();
  for (const province of routeProvinces)
    provinceByAdm1.set(ROUTE_PROVINCE_TO_ADM1[province], province);
  const stationCountByProvince = new Map();
  for (const n of nodes) {
    stationCountByProvince.set(n.province, (stationCountByProvince.get(n.province) ?? 0) + 1);
  }
  const orderedAdm1 = [...shapesById.values()].sort((a, b) =>
    a.shapeName < b.shapeName ? -1 : a.shapeName > b.shapeName ? 1 : 0
  );
  const shapes = orderedAdm1.map((shape, index) => {
    const routeProvince = provinceByAdm1.get(shape.shapeName) ?? null;
    return {
      id: `adm1-${String(index + 1).padStart(2, "0")}`,
      province: routeProvince,
      sourceName: shape.shapeName,
      sourceFeatureId: shape.shapeID,
      stationCount: routeProvince === null ? 0 : (stationCountByProvince.get(routeProvince) ?? 0),
      d: geometryToPath(shape.geometry),
    };
  });
  const mappedCount = shapes.filter((s) => s.province !== null).length;
  if (mappedCount !== routeProvinces.length) {
    fail(`route province 映射数不符：mapped=${mappedCount} route=${routeProvinces.length}`);
  }

  const counts = {
    administrativeBoundaryFeatureCount: shapes.length,
    routeStationProvinceCount: routeProvinces.length,
    stationCount: nodes.length,
    multiPolygonFeatureCount: geo.features.filter((f) => f.geometry.type === "MultiPolygon").length,
  };

  const header = {
    mapVersion: MAP_VERSION,
    generatedBy: "node data/gen_map.cjs",
    generatedFrom: SOURCE_METADATA.vendoredPath,
    routeAnchorSource: `data/graphs/${MAP_VERSION}/station_nodes.json`,
    source: SOURCE_METADATA,
    sourceSha256: SOURCE_SHA256,
    coordinateSpace: "mapX-mapY",
    projection: "Phase 4 canonical equirectangular projection (data/map_projection.cjs)",
    note: "V1 本地可视化底图；非官方测绘成果、非法律边界认定文件（见 data/maps/README.md）",
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    OUT_DISTRICTS,
    `${JSON.stringify(
      {
        ...header,
        viewBox: { ...VIEWBOX },
        margin: MARGIN,
        bounds,
        fit,
        counts,
        outline: { d: outlineD, ringCount: outlineRingCount },
        provinces: shapes,
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const svgLines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<!-- source: ${SOURCE_METADATA.provider} ${SOURCE_METADATA.dataset} ${SOURCE_METADATA.iso} ${SOURCE_METADATA.boundaryType} (revision ${SOURCE_METADATA.upstreamRevision}, boundaryID ${SOURCE_METADATA.boundaryID}, year ${String(SOURCE_METADATA.boundaryYearRepresented)}) -->`,
    `<!-- generated by node data/gen_map.cjs; do not edit. ${header.note} -->`,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEWBOX.width} ${VIEWBOX.height}" width="${VIEWBOX.width}" height="${VIEWBOX.height}">`,
    `  <g id="map-fit" transform="translate(${round1(tx)} ${round1(ty)}) scale(${round1(scale * 1000) / 1000})">`,
    `    <path id="china-outline" d="${outlineD}" fill="none" stroke="#c8c8c8" stroke-width="1.2"/>`,
    '    <g id="province-boundaries" fill="none" stroke="#e2e2e2" stroke-width="0.8">',
    ...shapes.map(
      (s) =>
        `      <path id="${s.id}" data-source-feature-id="${s.sourceName}" data-route-province="${s.province ?? ""}" d="${s.d}"/>`
    ),
    "    </g>",
    "  </g>",
    "</svg>",
    "",
  ];
  fs.writeFileSync(OUT_SVG, svgLines.join("\n"), "utf8");

  const mobileLines = [
    "/**",
    " * 本文件由 `node data/gen_map.cjs` 自动生成（勿手工编辑）。",
    " *",
    ` * 行政边界来源：${SOURCE_METADATA.provider} ${SOURCE_METADATA.dataset} / ${SOURCE_METADATA.iso} / ${SOURCE_METADATA.boundaryType}`,
    ` *   pinned revision ${SOURCE_METADATA.upstreamRevision}（boundaryID ${SOURCE_METADATA.boundaryID}，year ${String(SOURCE_METADATA.boundaryYearRepresented)}）`,
    ` *   vendored：${SOURCE_METADATA.vendoredPath}`,
    " *   来源为 open static administrative boundary dataset，用于 V1 本地可视化；非官方测绘成果、非法律边界认定文件。",
    ` * 路线锚点来源：\`data/graphs/${MAP_VERSION}/station_nodes.json\`（仅站点位置 / 路线锚点）。`,
    " * 坐标空间：mapX/mapY（Phase 4 canonical projection）；渲染时统一应用 `@yishu/shared` 的",
    " * `MAP_FIT` 映射到固定 viewBox(0 0 1000 800)（开发规范 §17）。运行时完全离线。",
    " */",
    "",
    "export interface ChinaProvinceShape {",
    "  /** 稳定 id（生成本确定序）。 */",
    "  id: string;",
    "  /** route province（中文 canonical）；未映射的 ADM1 feature 为 null。 */",
    "  province: string | null;",
    "  /** 源数据 feature 名称（来自 vendored source）。 */",
    "  sourceName: string;",
    "  /** 源数据 feature 稳定 id。 */",
    "  sourceFeatureId: string;",
    "  /** 该 route province 的 station 数（未映射为 0）。 */",
    "  stationCount: number;",
    "  /** SVG path（mapX/mapY 坐标系；MultiPolygon 为多个子路径）。 */",
    "  d: string;",
    "}",
    "",
    "export const CHINA_MAP_META = {",
    `  mapVersion: "${MAP_VERSION}",`,
    `  viewBox: { width: ${VIEWBOX.width}, height: ${VIEWBOX.height} },`,
    `  generatedFrom: "${SOURCE_METADATA.vendoredPath}",`,
    `  routeAnchorSource: "${`data/graphs/${MAP_VERSION}/station_nodes.json`}",`,
    `  boundarySource: "${SOURCE_METADATA.provider} ${SOURCE_METADATA.dataset} ${SOURCE_METADATA.iso} ${SOURCE_METADATA.boundaryType}",`,
    `  boundaryRevision: "${SOURCE_METADATA.upstreamRevision}",`,
    `  administrativeBoundaryFeatureCount: ${counts.administrativeBoundaryFeatureCount},`,
    `  routeStationProvinceCount: ${counts.routeStationProvinceCount},`,
    "} as const;",
    "",
    "/** 中国外轮廓（全部 ADM1 geometry 的 union；保留源拓扑，非凸包）。 */",
    "export const CHINA_MAP_OUTLINE_D =",
    `  ${JSON.stringify(outlineD)};`,
    "",
    "/** ADM1 行政单元边界（34 个 feature；route province 映射见 `province`）。 */",
    "export const CHINA_PROVINCE_SHAPES: readonly ChinaProvinceShape[] = [",
    ...shapes.flatMap((s) => [
      "  {",
      `    id: ${JSON.stringify(s.id)},`,
      `    province: ${s.province === null ? "null" : JSON.stringify(s.province)},`,
      `    sourceName: ${JSON.stringify(s.sourceName)},`,
      `    sourceFeatureId: ${JSON.stringify(s.sourceFeatureId)},`,
      `    stationCount: ${s.stationCount},`,
      `    d: ${JSON.stringify(s.d)},`,
      "  },",
    ]),
    "];",
    "",
  ];
  fs.mkdirSync(path.dirname(OUT_MOBILE), { recursive: true });
  fs.writeFileSync(OUT_MOBILE, mobileLines.join("\n"), "utf8");

  process.stdout.write(
    [
      "gen_map: OK",
      `  source        : ${SOURCE_METADATA.provider}/${SOURCE_METADATA.dataset}/${SOURCE_METADATA.iso}/${SOURCE_METADATA.boundaryType} rev=${SOURCE_METADATA.upstreamRevision}`,
      `  adm1 features : ${counts.administrativeBoundaryFeatureCount} (mapped route provinces: ${mappedCount}/${routeProvinces.length}, multiPolygon: ${counts.multiPolygonFeatureCount})`,
      `  stations      : ${nodes.length}`,
      `  outline rings : ${outlineRingCount}`,
      `  bounds        : ${JSON.stringify(bounds)}`,
      `  fit           : scale=${fit.scale} tx=${fit.tx} ty=${fit.ty}`,
      `  → ${path.relative(ROOT, OUT_DISTRICTS)}`,
      `  → ${path.relative(ROOT, OUT_SVG)}`,
      `  → ${path.relative(ROOT, OUT_MOBILE)}`,
      "",
    ].join("\n")
  );
}

main();
