import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { RouteEdge, StationNode } from "@yishu/routing";
import { getDataDir, getDefaultGraphVersion, getStationNode } from "./stationGraph.js";

/**
 * Phase 8 Gate「Yangquan 修复」——图版本数据级契约测试（不依赖数据库，不启动服务）。
 *
 * 1. 版本注册表是「新信件默认版本」的唯一来源（业务代码禁止硬编码版本号）；
 * 2. `china-v1` = Phase 4 冻结基线：三个资产 SHA-256 固定，重新生成必须逐字节复现；
 * 3. 生成器确定性（两次运行输出逐字节相同），且 `--out-root` 模式不改写仓库数据；
 * 4. `china-v2` 相对 `china-v1` 的差异被**穷尽列出**：唯一节点坐标修正 + 由它机械派生的最近邻边变化，
 *    任何未列出的差异都会让本测试失败（防止「顺手改数据」）；
 * 5. `validate_graph.cjs --json` 的真实跨版本校验结果（与 `pnpm graph:validate` 同一实现）。
 */
const DATA_DIR = getDataDir();
const REPO_ROOT = path.dirname(DATA_DIR);
const GRAPHS_DIR = path.join(DATA_DIR, "graphs");

const GRAPH_VERSIONS = ["china-v1", "china-v2"] as const;
const FROZEN_FILES = ["station_nodes.json", "route_edges.json", "region_station_map.json"] as const;

/** `china-v1` 字节冻结基线（Phase 4 交付物；sha256 与文件内容同为契约）。 */
const CHINA_V1_SHA256 = {
  "station_nodes.json": "d933f37b1539c58002ddc48c7a45c1011f80e9dd28c892eacc1e6b251ba48176",
  "route_edges.json": "bd5c19b13163ad63e5be6c329fe0dd4495397b2d9f23e20e748860aae709e880",
  "region_station_map.json": "bb196ce39f18be922333af5d416ddc495d7e57b00fbe44013afebc0a333ec384",
} as const;

/** 每个版本的边数（v2 因阳泉换省少 6 条跨省边）。 */
const EDGE_COUNTS = { "china-v1": 1949, "china-v2": 1943 } as const;

/** v1 中 yangquan（冻结坐标落在河南一侧）跨省连到的河南节点。 */
const HENAN_NEIGHBOURS = ["hebi", "jiaozuo", "kaifeng", "luoyang", "xinxiang", "zhengzhou"];

/**
 * v2 相对 v1 的完整边差异清单（key = 两端 id 按字典序拼接的无向边）。
 * - removed：阳泉与河南 6 城的跨省边 + 2 条被「西侧邻居」挤出 k=4 最近邻表的边；
 * - added：阳泉与河北 2 城的边（真实相邻关系）；
 * - reDistanced：阳泉相关边按新坐标重算的距离；
 * - reordered：端点写入顺序变化（无向边语义等价，方向由最近邻表的写入先后决定）。
 */
const V2_EDGES_REMOVED = [
  "datong|xingtai",
  "hebi|yangquan",
  "jiaozuo|yangquan",
  "kaifeng|yangquan",
  "luoyang|yangquan",
  "shijiazhuang|xinzhou",
  "xinxiang|yangquan",
  "yangquan|zhengzhou",
];
const V2_EDGES_ADDED = ["shijiazhuang|yangquan", "xingtai|yangquan"];
const V2_EDGES_RE_DISTANCED: [string, number, number][] = [
  ["changzhi|yangquan", 134.3, 173],
  ["datong|yangquan", 274.8, 32],
  ["jinzhong|yangquan", 287.3, 74.3],
  ["linfen|yangquan", 211.3, 267.8],
  ["lvliang|yangquan", 337.4, 217.3],
  ["taiyuan|yangquan", 311.3, 89.1],
  ["xinzhou|yangquan", 365.9, 95.5],
  ["yangquan|yuncheng", 236.7, 392.4],
];
const V2_EDGES_REORDERED = [
  "baoding|shijiazhuang",
  "jiaozuo|kaifeng",
  "jinzhong|lvliang",
  "lvliang|taiyuan",
  "xuchang|zhengzhou",
];

/**
 * 生成器输出目录必须位于仓库内：`writeJson` 依赖 Prettier 从 filepath 向上查找仓库配置，
 * 仓库外目录会因缺少 `.prettierrc` 而产出不同排版（从而无法做字节级对比）。
 */
const RUN_A = path.join(REPO_ROOT, ".tmp-graph-freeze-a");
const RUN_B = path.join(REPO_ROOT, ".tmp-graph-freeze-b");

interface ValidationGraphReport {
  version: string;
  nodeCount: number;
  edgeCount: number;
  duplicateNodeIds: number;
  duplicateEdgeCount: number;
  selfLoopCount: number;
  invalidEdgeCount: number;
  invalidDistanceCount: number;
  disabledEdgeCount: number;
  connectedComponentCount: number;
  isolatedNodeCount: number;
  fullyConnected: boolean;
  duplicateCities: string[];
  badMappings: string[];
  missingProvince: string[];
}

interface ValidationReport {
  defaultVersion: string;
  graphs: Record<string, ValidationGraphReport>;
  ok: boolean;
}

function readJson<T>(absolutePath: string): T {
  return JSON.parse(readFileSync(absolutePath, "utf8")) as T;
}

function readNodes(graphVersion: string): StationNode[] {
  return readJson<StationNode[]>(path.join(GRAPHS_DIR, graphVersion, "station_nodes.json"));
}

function readEdges(graphVersion: string): RouteEdge[] {
  return readJson<RouteEdge[]>(path.join(GRAPHS_DIR, graphVersion, "route_edges.json"));
}

function sha256(absolutePath: string): string {
  return createHash("sha256").update(readFileSync(absolutePath)).digest("hex");
}

function pairKey(edge: { from: string; to: string }): string {
  return edge.from < edge.to ? `${edge.from}|${edge.to}` : `${edge.to}|${edge.from}`;
}

/** 仓库图数据快照（生成器不得改动其中任何字节）。 */
function repoGraphHashes(): Record<string, string> {
  const hashes: Record<string, string> = {
    "registry.json": sha256(path.join(GRAPHS_DIR, "registry.json")),
  };
  for (const version of GRAPH_VERSIONS) {
    for (const file of FROZEN_FILES) {
      hashes[`${version}/${file}`] = sha256(path.join(GRAPHS_DIR, version, file));
    }
  }
  return hashes;
}

/** 与 `data/gen_graph.cjs` 同一实现：Haversine（R=6371）+ 0.1 取整。 */
function haversineKm(a: StationNode, b: StationNode): number {
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  const d = 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
  return Math.round(d * 10) / 10;
}

function generateInto(outRoot: string): void {
  const result = spawnSync(process.execPath, ["data/gen_graph.cjs", `--out-root=${outRoot}`], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `gen_graph 失败 (status=${String(result.status)}): ${result.stdout}\n${result.stderr}`
    );
  }
}

afterAll(() => {
  for (const dir of [RUN_A, RUN_B]) rmSync(dir, { recursive: true, force: true });
});

describe("图版本注册表", () => {
  it("registry 是默认版本唯一来源，且业务读取与数据一致（禁止硬编码版本号）", () => {
    const registry = readJson<{ versions: string[]; defaultVersion: string }>(
      path.join(GRAPHS_DIR, "registry.json")
    );
    expect(registry.versions).toEqual(["china-v1", "china-v2"]);
    expect(registry.defaultVersion).toBe("china-v2");
    expect(getDefaultGraphVersion()).toBe(registry.defaultVersion);
  });
});

describe("china-v1 冻结基线", () => {
  it("三个资产字节冻结（SHA-256 与 Phase 4 基线一致）", () => {
    for (const file of FROZEN_FILES) {
      expect(sha256(path.join(GRAPHS_DIR, "china-v1", file)), file).toBe(CHINA_V1_SHA256[file]);
    }
  });

  it("重生成：v1 逐字节复现冻结基线、两次运行输出一致，且不改写仓库数据", () => {
    const repoBefore = repoGraphHashes();
    for (const dir of [RUN_A, RUN_B]) rmSync(dir, { recursive: true, force: true });
    generateInto(RUN_A);
    generateInto(RUN_B);

    for (const version of GRAPH_VERSIONS) {
      for (const file of FROZEN_FILES) {
        const first = sha256(path.join(RUN_A, version, file));
        expect(sha256(path.join(RUN_B, version, file)), `${version}/${file} 非确定性`).toBe(first);
        if (version === "china-v1") {
          expect(first, `${version}/${file} 与冻结基线不一致`).toBe(CHINA_V1_SHA256[file]);
        }
      }
    }
    expect(sha256(path.join(RUN_A, "registry.json"))).toBe(
      sha256(path.join(GRAPHS_DIR, "registry.json"))
    );

    expect(repoGraphHashes()).toEqual(repoBefore);
  }, 60000);
});

describe("china-v2 修正范围", () => {
  it("节点差异只有 yangquan 的坐标字段（lat/lng/mapY），其余 293 站点逐字段一致", () => {
    const v1Nodes = readNodes("china-v1");
    const v2Nodes = readNodes("china-v2");
    expect([v1Nodes.length, v2Nodes.length]).toEqual([294, 294]);

    const v2ById = new Map(v2Nodes.map((node) => [node.id, node]));
    const changedNodeIds: string[] = [];
    const changedFields = new Set<string>();
    for (const node of v1Nodes) {
      const other = v2ById.get(node.id);
      if (other === undefined) {
        changedNodeIds.push(node.id);
        continue;
      }
      if (JSON.stringify(other) !== JSON.stringify(node)) changedNodeIds.push(node.id);
      for (const field of ["name", "province", "city", "lat", "lng", "mapX", "mapY"] as const) {
        if (node[field] !== other[field]) changedFields.add(field);
      }
    }
    expect(changedNodeIds).toEqual(["yangquan"]);
    expect([...changedFields].sort()).toEqual(["lat", "lng", "mapY"]);
  });

  it("边差异与「已知派生差异清单」完全一致（无未解释变更）", () => {
    const v1Edges = readEdges("china-v1");
    const v2Edges = readEdges("china-v2");
    expect([v1Edges.length, v2Edges.length]).toEqual([
      EDGE_COUNTS["china-v1"],
      EDGE_COUNTS["china-v2"],
    ]);

    const v1ByPair = new Map(v1Edges.map((edge) => [pairKey(edge), edge]));
    const v2ByPair = new Map(v2Edges.map((edge) => [pairKey(edge), edge]));

    const removed = [...v1ByPair.keys()].filter((key) => !v2ByPair.has(key)).sort();
    const added = [...v2ByPair.keys()].filter((key) => !v1ByPair.has(key)).sort();
    expect(removed).toEqual([...V2_EDGES_REMOVED].sort());
    expect(added).toEqual([...V2_EDGES_ADDED].sort());

    const reDistanced: [string, number, number][] = [];
    const reordered: string[] = [];
    for (const [key, before] of v1ByPair) {
      const after = v2ByPair.get(key);
      if (after === undefined) continue;
      if (before.distanceKm !== after.distanceKm) {
        reDistanced.push([key, before.distanceKm, after.distanceKm]);
        continue;
      }
      if (before.from !== after.from) {
        reordered.push(key);
        continue;
      }
      expect(after, key).toEqual(before);
    }
    const byKey = (a: [string, number, number], b: [string, number, number]): number =>
      a[0] < b[0] ? -1 : 1;
    expect(reDistanced.sort(byKey)).toEqual([...V2_EDGES_RE_DISTANCED].sort(byKey));
    expect(reordered.sort()).toEqual([...V2_EDGES_REORDERED].sort());
  });

  it("阳泉不再连到河南 6 城，改为连接河北（石家庄/邢台），且跨省边数下降", () => {
    const neighboursOf = (edges: RouteEdge[], nodeId: string): Set<string> =>
      new Set(
        edges
          .filter((edge) => edge.from === nodeId || edge.to === nodeId)
          .map((edge) => (edge.from === nodeId ? edge.to : edge.from))
      );

    const v1Neighbours = neighboursOf(readEdges("china-v1"), "yangquan");
    const v2Neighbours = neighboursOf(readEdges("china-v2"), "yangquan");

    for (const henan of HENAN_NEIGHBOURS) {
      expect(v1Neighbours.has(henan), `v1 应连 ${henan}`).toBe(true);
      expect(v2Neighbours.has(henan), `v2 不应连 ${henan}`).toBe(false);
    }
    expect(v2Neighbours.has("shijiazhuang")).toBe(true);
    expect(v2Neighbours.has("xingtai")).toBe(true);
    expect([v1Neighbours.size, v2Neighbours.size]).toEqual([14, 10]);
  });

  it("两个版本中阳泉相关边的距离都由该版本节点坐标复算得出（派生而非手改）", () => {
    for (const version of GRAPH_VERSIONS) {
      const yangquan = getStationNode("yangquan", version);
      const incident = readEdges(version).filter(
        (edge) => edge.from === "yangquan" || edge.to === "yangquan"
      );
      expect(incident.length).toBeGreaterThan(0);
      for (const edge of incident) {
        const otherId = edge.from === "yangquan" ? edge.to : edge.from;
        const other = getStationNode(otherId, version);
        expect(edge.distanceKm, `${version} ${pairKey(edge)}`).toBe(haversineKm(yangquan, other));
      }
    }
  });
});

describe("跨版本图校验（pnpm graph:validate 同一实现）", () => {
  it("--json 报告 ok=true：两版本均 294 站点、全连通、无重复/非法边与映射问题", () => {
    const result = spawnSync(process.execPath, ["data/validate_graph.cjs", "--json"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);

    const report = JSON.parse(result.stdout) as ValidationReport;
    expect(report.ok).toBe(true);
    expect(report.defaultVersion).toBe("china-v2");
    expect(Object.keys(report.graphs).sort()).toEqual([...GRAPH_VERSIONS].sort());

    for (const version of GRAPH_VERSIONS) {
      const graph = report.graphs[version];
      expect(graph, version).toBeDefined();
      if (graph === undefined) continue;
      expect(graph.nodeCount, version).toBe(294);
      expect(graph.edgeCount, version).toBe(EDGE_COUNTS[version]);
      expect(graph.fullyConnected, version).toBe(true);
      expect(graph.connectedComponentCount, version).toBe(1);
      expect(graph.isolatedNodeCount, version).toBe(0);
      expect(graph.duplicateNodeIds, version).toBe(0);
      expect(graph.duplicateEdgeCount, version).toBe(0);
      expect(graph.selfLoopCount, version).toBe(0);
      expect(graph.invalidEdgeCount, version).toBe(0);
      expect(graph.invalidDistanceCount, version).toBe(0);
      expect(graph.disabledEdgeCount, version).toBe(0);
      expect(graph.duplicateCities, version).toEqual([]);
      expect(graph.badMappings, version).toEqual([]);
      expect(graph.missingProvince, version).toEqual([]);
    }
  }, 60000);
});
