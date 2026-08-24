// 静态路网校验与报告生成（Phase 4 MEDIUM-3：单一可重复命令）。
// 用法：
//   node data/validate_graph.cjs            # 先自测（selftest），再校验 data/graphs/<version>/ 并写出 GRAPH_VALIDATION_REPORT.json
//   node data/validate_graph.cjs --selftest # 仅运行语义自测（isolated / disabled / duplicate-disabled fixtures），不写报告
// 根脚本：pnpm graph:validate
// gen_graph.cjs 重新生成数据后也会调用本文件，保证报告与数据永不漂移。
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const GRAPHS_DIR = path.join(__dirname, "graphs");
const REPORT_PATH = path.join(__dirname, "GRAPH_VALIDATION_REPORT.json");

const TRANSPORT = ["HAND_CARRY", "HORSE_RELAY", "EXPRESS_RELAY", "PIGEON"];

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

/**
 * 纯统计函数（LOW-3：语义修正）。
 * - enabled 必须是布尔；enabled=false 是合法边（不判 invalid），但不计入有效 adjacency（不参与连通性）。
 * - isolatedNodeCount 按“有效度数”统计：无任何有效边的节点（不是 ids.size - visited.size）。
 */
function analyzeGraph(nodes, edges, region) {
  // 1) 节点 id 唯一
  const ids = new Set();
  let duplicateNodeIds = 0;
  for (const n of nodes) {
    if (ids.has(n.id)) duplicateNodeIds++;
    ids.add(n.id);
  }

  // 2) 边校验：端点存在 / 自环 / distance>0 / enabled 布尔 / allowedTransport 合法
  let invalidEdgeCount = 0;
  let duplicateEdgeCount = 0;
  let selfLoopCount = 0;
  let invalidDistanceCount = 0;
  let disabledEdgeCount = 0;
  const seen = new Set();
  const adj = {};
  for (const e of edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) {
      invalidEdgeCount++;
      continue;
    }
    if (e.from === e.to) {
      selfLoopCount++;
      invalidEdgeCount++;
      continue;
    }
    if (!(e.distanceKm > 0)) {
      invalidDistanceCount++;
      invalidEdgeCount++;
      continue;
    }
    if (
      typeof e.enabled !== "boolean" ||
      !Array.isArray(e.allowedTransport) ||
      e.allowedTransport.length === 0 ||
      !e.allowedTransport.every((t) => TRANSPORT.includes(t))
    ) {
      invalidEdgeCount++;
      continue;
    }
    const key = e.from < e.to ? `${e.from}|${e.to}` : `${e.to}|${e.from}`;
    if (seen.has(key)) {
      duplicateEdgeCount++;
      continue;
    }
    seen.add(key);
    if (e.enabled === false) {
      // 合法禁用边：仍参与去重，但不加入有效 adjacency（不计入连通性）
      disabledEdgeCount++;
      continue;
    }
    (adj[e.from] ??= []).push(e.to);
    (adj[e.to] ??= []).push(e.from);
  }

  // 3) 连通性（BFS，仅有效边）
  const visited = new Set();
  let connectedComponentCount = 0;
  for (const id of ids) {
    if (visited.has(id)) continue;
    connectedComponentCount++;
    const stack = [id];
    while (stack.length) {
      const c = stack.pop();
      if (visited.has(c)) continue;
      visited.add(c);
      for (const n of adj[c] ?? []) if (!visited.has(n)) stack.push(n);
    }
  }
  // 孤立节点 = 有效度数 0（不在任何有效边端点上）
  const isolatedNodeCount = [...ids].filter((id) => (adj[id] ?? []).length === 0).length;

  // 4) Region→Station 映射校验：重复 city、mapping 指向有效节点、省级覆盖
  const cityCount = {};
  for (const n of nodes) cityCount[n.city] = (cityCount[n.city] ?? 0) + 1;
  const duplicateCities = Object.keys(cityCount).filter((c) => cityCount[c] > 1);
  const badMappings = [];
  for (const [k, v] of Object.entries(region.cities ?? {}))
    if (!ids.has(v)) badMappings.push(`cities.${k}->${v}`);
  for (const [k, v] of Object.entries(region.provinces ?? {}))
    if (!ids.has(v)) badMappings.push(`provinces.${k}->${v}`);
  const nodeProvinces = new Set(nodes.map((n) => n.province));
  const missingProvince = [];
  for (const p of nodeProvinces) if (!region.provinces[p]) missingProvince.push(p);

  const fullyConnected =
    connectedComponentCount === 1 &&
    isolatedNodeCount === 0 &&
    duplicateNodeIds === 0 &&
    invalidEdgeCount === 0 &&
    duplicateEdgeCount === 0;

  return {
    nodeCount: nodes.length,
    duplicateNodeIds,
    edgeCount: edges.length,
    invalidEdgeCount,
    duplicateEdgeCount,
    selfLoopCount,
    invalidDistanceCount,
    disabledEdgeCount,
    connectedComponentCount,
    isolatedNodeCount,
    fullyConnected,
    duplicateCities,
    badMappings,
    missingProvince,
  };
}

/** 校验单个图版本目录，返回统计与问题列表。 */
function validateGraphDir(version) {
  const dir = path.join(GRAPHS_DIR, version);
  const nodes = loadJson(path.join(dir, "station_nodes.json"));
  const edges = loadJson(path.join(dir, "route_edges.json"));
  const region = loadJson(path.join(dir, "region_station_map.json"));
  return { version, ...analyzeGraph(nodes, edges, region) };
}

/** 语义自测：isolated 节点与 disabled 边（LOW-3）。 */
function selftest() {
  const nodes = [
    { id: "A", name: "A", city: "甲市", province: "P1" },
    { id: "B", name: "B", city: "乙市", province: "P2" },
    { id: "C", name: "C", city: "丙市", province: "P3" },
    { id: "D", name: "D", city: "丁市", province: "P4" },
  ];
  const region = {
    cities: { 甲市: "A", 乙市: "B", 丙市: "C", 丁市: "D" },
    provinces: { P1: "A", P2: "B", P3: "C", P4: "D" },
  };
  const base = (from, to, extra = {}) => ({
    from,
    to,
    distanceKm: 100,
    enabled: true,
    allowedTransport: ["HORSE_RELAY"],
    ...extra,
  });
  const edges = [
    base("A", "B"),
    // disabled 边：合法（enabled=false），但不参与连通性
    base("B", "C", { enabled: false }),
  ];

  const r = analyzeGraph(nodes, edges, region);
  // 有效边仅 A-B；C（只连 disabled 边）与 D（无边）有效度数均为 0 → 孤立
  assert.strictEqual(r.isolatedNodeCount, 2, "C/D 有效度数 0，应统计为孤立节点");
  // disabled 边不算 invalid，且不把 B-C 连起来 → 连通分量：A-B 分量 + C + D 各自独立
  assert.strictEqual(r.invalidEdgeCount, 0, "enabled=false 是合法边，不应判 invalid");
  assert.strictEqual(r.disabledEdgeCount, 1, "应识别 1 条禁用边");
  assert.strictEqual(r.connectedComponentCount, 3, "B-C(disabled) 不连通，C/D 各自独立分量");
  assert.strictEqual(r.fullyConnected, false, "存在孤立/多分量时应非 fullyConnected");

  // enabled 非布尔 → invalid
  const bad = analyzeGraph(nodes, [base("A", "B", { enabled: "yes" })], region);
  assert.strictEqual(bad.invalidEdgeCount, 1, "enabled 非布尔应判 invalid");

  // 重复 disabled 边：去重仍生效（不判 invalid，也不重复计入 disabled）
  const dupDisabled = analyzeGraph(
    nodes,
    [base("A", "B", { enabled: false }), base("A", "B", { enabled: false })],
    region
  );
  assert.strictEqual(dupDisabled.invalidEdgeCount, 0, "重复 disabled 边不应判 invalid");
  assert.strictEqual(dupDisabled.duplicateEdgeCount, 1, "重复 disabled 边应去重");
  assert.strictEqual(dupDisabled.disabledEdgeCount, 1, "重复 disabled 边只计 1 条禁用边");

  return true;
}

/** 校验 registry 中所有版本并写 GRAPH_VALIDATION_REPORT.json。返回是否全部通过。 */
function run() {
  const registry = loadJson(path.join(GRAPHS_DIR, "registry.json"));
  const graphs = {};
  let ok = true;
  for (const v of registry.versions) {
    const r = validateGraphDir(v);
    graphs[v] = r;
    if (
      !r.fullyConnected ||
      r.duplicateCities.length > 0 ||
      r.badMappings.length > 0 ||
      r.missingProvince.length > 0
    ) {
      ok = false;
    }
  }
  const report = {
    generatedAt: new Date().toISOString(),
    defaultVersion: registry.defaultVersion,
    graphs,
    ok,
  };
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + "\n");
  return ok;
}

module.exports = { run, validateGraphDir, analyzeGraph, selftest, GRAPHS_DIR, REPORT_PATH };

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes("--selftest")) {
    // 仅自测，不写报告
    selftest();
    console.log("graph validation selftest: OK (no report written)");
    process.exit(0);
  }
  selftest();
  const ok = run();
  console.log(`graph validation: ${ok ? "OK" : "FAILED"} (selftest PASS) -> ${REPORT_PATH}`);
  process.exit(ok ? 0 : 1);
}
