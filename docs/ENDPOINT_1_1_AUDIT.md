# 1.1 上线前端点与驿站核验

日期：2026-10-06。结论：逐项审核已形成可复核证据，**不是全国端点放行或生产上线 PASS**。生产默认运单规则和图注册表均未修改。

## 区县端点与本市驿站整包对照

服务范围沿用已确认的 `service-scope-20261006-r2`。逐项联查发现 22 个区县代表点与新图本市驿站重合，计时的起运／派送段会退化成一个点。仅针对这些重合项改用同源区界的内部代表点，再按原校验器检查县区、所属市和省的包含关系。没有手工偏移坐标、改变源区界或修改市驿站；代表点仍不是用户的精确街道地址。

最新几何证据为 `data/maps/audit/endpoint-release-distinct-20261006/`，候选端点为 `data/maps/district-anchors-1.1-candidate.json`，SHA 为 `7925324e2ffa6e1ff74767e0f905af89beb08ddaa2d5b87ad66b98602c433d44`。先前 r1/r2 审计原样保留。新增 `--city-graph` 会校验新图输入 SHA、全部本市映射及市几何；如果内部代表点仍重合或不在父区，直接失败，不伪造位移。

`verify_transport_assets.py` 从入库的候选端点读取，不依赖私有 `.local` 文件，逐项联查手机地区清单、后端目录、CSV 源点和新图：2851 项目录、2849 项服务端点、370 个本市驿站，缺失、错配、重合均为 0，22 项明确记录代表点调整。校验包含来源、政策、新图节点／映射／边 SHA，及冻结的旧图、旧地区选择和旧运行端点。结果见 `data/maps/audit/transport-1.1-candidate-20261006.json`，状态仍为 candidate，不能替代完整发布门禁。

- 实施方 Docker GIS 全量 96 项通过；新增回归覆盖同源代表点选择、源对象不变、父区检查、仍重合时拒绝，以及整包漏项、重复、身份／坐标／驿站错配和非数值坐标拒绝。
- 新图测试 6 项通过，包含四种方式共 1480 条路线，以及存储的三个新图运行资产与来源绑定重建结果逐字段相同。
- API 全量 436 项／44 文件通过，类型检查通过。新增 3 项测试只在隔离测试进程中加载候选端点并注册新图，调用真实读取与校验函数，逐项覆盖全部 2849 个端点的 origin／destination 角色、同市驿站归属和非重合连接；金门及三沙南沙区无伪造端点，默认图仍为 `china-v2`。
- 上述不是服务器运行或真机结果，没有激活实际地区清单、端点或图注册表。最新普通证据检查通过且服务范围无缺失项；`--require-release` 实跑仍返回 `release_gate_not_passed`，现行界线与地图发布核验仍 pending。

随后修复独立审查发现的两项制品校验问题：冻结的 `china-v2` 三文件完整清单及 SHA 改为固定基线，候选清单不得删项、增项或自行重签旧文件；图输入来源路径统一为仓库内相对路径，相同文件用绝对路径生成时不会改变来源身份。新增真实 `verify_files` 内存篡改回归覆盖四种清单绕过及三个旧文件分别变化，均拒绝且不修改磁盘。原有候选数据、旧运行资产与默认图没有改动。

独立只读复核已关闭这两项 P2，限定范围内没有新增发现：Reviewer 断网 Docker GIS 96 项通过，8 种冻结基线篡改全部拒绝；相对、绝对及含 `..` 的等价路径来源一致，仓库外路径拒绝，规范化后的来源通过真实联查。实施方另用 `/workspace/data/graphs/china-v3` 绝对路径完成全源 CLI 重生成，隔离输出 `.local/maps/endpoint-release-pathcheck-20261006/` 的候选端点和证据 summary 与已保存版本逐字节相同，下游联查通过。该复核不等于整个版本 Final Gate、正式地图批准或生产验收。

## 完整候选数据的实际业务联调

此前新图寄信集成仅在测试进程中注册 `china-v3`，仍读取旧运行端点。本轮将该测试进程同时切换到完整候选端点，真实运行注册、资料更新、寄信、Journey 初始化、地图／正文读取及数据库推进。磁盘运行端点、手机下拉清单、注册表和默认图均未替换。

- 目标集成文件 29 项通过。新增黄浦区到浦东新区、杭州上城区到余杭区、重庆两江新区到永川区、草湖市同址寄信四项：实际 PATCH 更新地区，寄信后起运与派送两段坐标均不重合；第 3 小时到本市驿站并开始派送，第 9 小时送达。收件人送达前没有未来连接、未来路径或正文，送达后取得目的区县及正文。
- 原有跨市、四种方式一年期回放、延迟初始化改地址、60 封积压并发初始化及停服／无效端点回归也使用完整候选端点，不再只使用旧库；全量运行的积压变更约 366 毫秒，仍不代表生产任意规模性能。
- 本轮 Docker 实跑 API 440 项／44 文件、移动端 441 项／43 文件、共享包 69 项、Worker 9 项通过；API／移动端类型检查及 API 编译通过。
- 云端配置 3 项通过：缺省及显式 `1.0` 保持旧配置，显式 `1.1` 只改变 API 新信创建开关。该纯解析脚本依赖 Docker Compose CLI，工具容器内缺少 CLI 的首次执行未运行断言；改用桌面自带 Node 调用现有 Mac Docker CLI 后通过，无新增安装、服务启动或数据库操作。
- 本轮 Workbench 只读核对生产七个服务均 healthy，API/Worker 仍是 `e2ee-20261005-reviewed-r1`，预览仍是 `preview-20261006-auto-e2ee-r5`；API 中 `NEW_LETTER_RULES_VERSION` 未设置，注册表仍为 v1/v2、默认 v2。实际 `--require-release` 再次返回 `release_gate_not_passed`；未停写、备份、部署或切流。

这不是全端点真实寄信穷举或 iPhone 原生验收，也不是整个版本 Final Gate。

独立只读复核未发现新的 P1/P2。在断网、只读代码挂载及独立临时 PostgreSQL 中，Reviewer 重跑目标文件 29/29 通过，临时实例已清理。未 mock API、Prisma 或推进逻辑；只替换该测试进程的候选端点和图注册表，真实读取 v3 节点／边。复跑前后六个资产及测试文件 SHA 不变，默认 v2 未注册 v3。四个新增例使用 PIGEON、非 E2EE 正文和 app.inject，不代表生产 E2EE、外部 HTTP、Worker 或真机结果；API 全量与类型检查属于实施方结果，不记为 Reviewer 复跑。

复跑整包检查（无需原始 GIS 大文件）：

```sh
docker run --rm --init --network none -v "$PWD:/workspace" \
  yishu-gis-nlsc:local python scripts/gis/verify_transport_assets.py
docker exec yishu-next-version-tools-1 node --test scripts/test-city-graph.mjs
docker exec yishu-next-version-tools-1 pnpm --filter @yishu/api exec vitest run \
  src/lib/transport-assets-candidate.test.ts
```

重新生成候选端点需要已核验的原始快照；输出仍不覆盖运行资产：

```sh
docker run --rm --init --network none --memory 3g -v "$PWD:/workspace" \
  yishu-gis-nlsc:local python scripts/gis/audit_endpoint_release.py \
  --city-graph data/graphs/china-v3 \
  --anchor-output data/maps/district-anchors-1.1-candidate.json \
  --output .local/maps/endpoint-release-distinct-20261006 \
  --evidence-output data/maps/audit/endpoint-release-distinct-20261006
```

## 服务范围修订后的最新结果

用户确认港澳台、金门县及三沙南沙区暂不提供服务。最新 r2 证据为 `data/maps/audit/endpoint-release-service-scope-20261006-r2/`，业务与审计共用 `packages/shared/src/service-scope.json`，原范围审计、r1 审计及原 347 项输入均保留。

- 原 347 项：137 项几何候选、207 项不在正式县级清单、2 项已撤销、1 项金门县暂不服务；金门没有坐标、来源几何或几何 PASS。
- 全部目录 2851 项；服务范围内 2849 项均有候选几何，金门与三沙南沙区共 2 项明确停服，无伪造端点。服务范围几何为 `snapshot_pass`，全目录仍为 pending，不因业务排除而宣称全国全目录通过。广州南沙 `440115` 不受影响。
- 普通 r2 证据检查返回 `auditEvidence=PASS`、`originalRows=347`、`pendingCodes=[]`；`--require-release` 实际返回 `release_gate_not_passed`。全国现行界线变更完整性、公开地图发布核验及最终放行仍为 pending。r1 原证据仍保留南沙待补，不改写旧结果。
- 最新 Docker 复跑：GIS 76 项、API 433 项、移动端 441 项、共享包 69 项、Worker 9 项通过；共享包构建和 API／移动端类型检查通过。新增范围回归拒绝篡改范围证据或将不服务写成几何通过，并核对三沙／广州同名地区及旧“南沙群岛”入口。iOS Hermes 隔离导出 3371 模块、23 资源通过，不替代真机验收。
- 最新独立限定复核关闭三项发现：删掉南沙后重签数量／SHA 的完整性绕过、原 347 表与可选表的几何结论不一致、混合简繁名称漏拦。Reviewer 独立 GIS 73 项、11 组篡改共 22 次拒绝、23 种名称归一化及 5 个误封反例通过。没有独立复跑 API 等全量及数据库竞态，不构成完整发布批准；详细边界见 [服务范围复核](SERVICE_AVAILABILITY.md)。
- 随后 r2 范围增量独立复核未发现新增 P1/P2：Reviewer GIS 75 项、11 个拒绝／12 个允许案例、16 组政策篡改及真实证据 14 次篡改拒绝通过。两版 `--require-release` 均拒绝；实施方后来增加的真实 r2 回归不标为 Reviewer 已复跑。

## 新取得的官方全国地区树

从[民政部国家地名信息库](https://dmfw.mca.gov.cn/XzqhVersionPublish.html)正常浏览器页面保存完整 DOM。虽然当时只展开上海，页面加载的整棵省／市／县区树均已保存。原件为 `.local/regions/mca-query-shanghai-20261006.html`，SHA-256 `c6611ef7f3a0cd16b45005957f1733190104f2618653e99ba3947ab59beb0abb`；没有绕过访问限制。

`verify_mca_tree.py` 对原件 SHA、保存来源、唯一树结构、代码重复、真实省市父区及无区县城市分类逐项校验：31 个内地省级地区、2851 个端点，与草案的代码、名称、所属省市、层级类型全部一致。包括金门的目录身份，但不为其开放业务。报告见 `data/maps/audit/mca-live-tree-20261006.json`，身份对照为 PASS；新增 10 项解析／对照回归通过。

地区树来自公开 `xzqh/getList` 的 `code=0, trimCode=true, maxLevel=3` 数据。页面另一个代码查询表声明 `Xzqh20251231`，但地区树实际包含岑岭、草湖等 2026 年新增条目，不能将该表名当成树的有效日期。报告 `effectiveThrough=null`，只记录 2026-10-06 的取得时间。名称代码对照没有证明所有行政界线变更已核验，故全国变更及地图发布门禁仍 pending，运行清单和生产未替换。

复跑：

```sh
docker run --rm --init --network none -v "$PWD:/workspace" \
  yishu-gis-nlsc:local python scripts/gis/verify_mca_tree.py

docker run --rm --init --network none -v "$PWD:/workspace:ro" \
  yishu-gis-nlsc:local python scripts/gis/check_endpoint_evidence.py \
  data/maps/audit/endpoint-release-service-scope-20261006-r2
```

普通证据检查 PASS 不是发布批准，必须另行通过 `--require-release`。

以下为范围修订之前的历史快照，不代表当前金门业务状态。

## 347 项原范围结论

| 结论             | 数量 | 含义                                                               |
| ---------------- | ---: | ------------------------------------------------------------------ |
| 不在官方县级清单 |  207 | 不再混入正式省市区县下拉选项，不删除已有账号地址或旧信件快照       |
| 已撤销地区       |    2 | 重庆江北区、渝北区；旧记录保留                                     |
| 来源几何候选     |  137 | 身份、唯一匹配、区界内代表点和所属省市检查完成，不等于官方边界认证 |
| 几何待补         |    1 | 金门县，未以市中心或其他地区坐标兜底                               |
| 合计             |  347 | 全部有逐项结论，排除项不能计作几何通过                             |

证据：`data/maps/audit/endpoint-release-20261006/original-347.csv`。审核器固定原报告 SHA，确保没有换掉未通过条目来凑数。

## 当前全国草案

31 个省级地区，2847 个县级条目、4 个明确标记的无区县城市，共 **2851 个可选端点**；2849 个有几何候选，2 个待补。

- 身份基线为[民政部 2024 年行政区划代码表](https://www.mca.gov.cn/mzsj/xzqh/2025/202401xzqh.html)，叠加已取得官方证据的重庆 2025 年调整，以及新疆 2026 年新增岑岭县、草湖市。
- 新增地区名称和归属分别核对[岑岭县设立公告](https://www.xinjiang.gov.cn/xinjiang/tzgg/202603/285e5d25b8ad4eae8df6b0f0efe847f6.shtml)、[草湖市设立公告](https://www.xinjiang.gov.cn/xinjiang/tzgg/202604/3691350b13064945947d8f78933ccb3e.shtml)。代码来自[新疆民政厅截至 2026 年 6 月 30 日代码表](https://mzt.xinjiang.gov.cn/xjmzt/c112990/202607/d4e25e9ed58e4371a1798d6e623ffc3d.shtml)第 41、67 页，人工核对图片并记录原件 SHA；不是 OCR 猜测。
- 全国截至 2026-10-06 的变更完整性仍待核查，不能把以上几个补丁描述为全国现行版本已经完全确认。
- 全部可选项及其几何来源见 `selected-regions.csv`；汇总、源 SHA、未通过项及门禁见 `summary.json`，二者与原 347 项清单均入库。
- `pca-current.json` 仍是未启用草案；界面继续使用原 `pca-code.json`。候选坐标没有覆盖 `data/maps/district-anchors.json`。

## 显式来源修正

`district-source-corrections.json` 限定固定 OSM 快照和官方代码表，包含 90 个编号修正、5 个双语名称修正。必须同时匹配原编号、原名称和官方目标身份；禁止模糊名称猜测和重复编号择优。

补充几何来自同一 2026-10-03 快照的完整中国 PBF，不混入新的实时对象：

- 文登区：原关系有正确区名和代码，但缺少 `admin_level`，单独声明县级身份适配，不重新手绘边界。
- 汉南区：源 `r3076294` 是经开区管理范围，包含蔡甸、汉阳部分区域，不能直接改名为汉南区。使用四个 `420113` 街道的同源几何并集作为候选，并记录[官方文件对原汉南四街和经开七街范围的区分](https://www.whkfq.gov.cn/xxgk/zc/qtzdgk/gwhqzf/202201/t20220124_1912899.html)。仍不是权属边界认证。
- 容城、安新、雄县：官方代码属于保定；OSM 保定关系的 `subarea` 也包含这三个县，但其外环将雄安管理范围排除。仅对审计父区包含检查，使用保定原形状和三个已列为子区的县形状并集；不扩大县界，也不改在线底图。

## 两项未通过

1. **金门县 350527**：同源 `r3339695` 存在，但源层级为 4，且来源管辖口径与当前官方清单存在差异。不能直接将它改成 6 级并扩大福建、泉州父边界后宣称通过。需要核实适用口径的完整县界。
2. **三沙南沙区 460303**：冻结快照未取得适用的区级多边形；同名 `r3287345` 是广州南沙区 `440115`，已明确拒绝。不能以永暑礁点、岛群中心、市中心或任意海域多边形代替县区边界。

## 后续官方来源核验

- 已取得[福建省截至 2026 年 6 月 30 日地区清单](https://mzt.fujian.gov.cn/gk/tzgg/202607/t20260710_7176497.htm)，94 个县级及以上记录，包括 9 个市和 84 个县级条目。候选目录的 84 项名称、编号、所属市全部一致；源文件 SHA 和逐项比较见 `data/maps/audit/fujian-202606-identity.json`。`verify_fujian_catalog.py` 对原件 SHA、结构、重复和父区检查后才导出报告，7 项新增回归通过。仅证明福建截至该日的身份，不关闭全国现行变化或几何／发布门禁。
- 已实际下载国土测绘中心的金门县／乡镇矢量数据，县和六乡镇共 7 个几何有效，5 项新增来源回归通过；[金门来源记录](KINMEN_MAP_SOURCE.md)保存原件 SHA、许可、坐标系与两版轮廓差异。该来源含乌坵，仍未直接映射成 `350527`，所以主审计计数与 pending 状态不变。
- 本地云端 Compose 已补 API 创建规则环境开关注入，缺省继续为 `1.0`；尚未更新服务器。`test-cloud-rules-config.mjs` 的 3 项解析回归通过（包括实际 `delivery` profile），只检查配置，不启动容器或改变生产规则。
- 本次 GIS 全量复跑为 **56 项通过**（原 44 项加福建身份 7 项、金门来源 5 项）；`git diff --check` 通过。实际重跑 `--require-release` 仍以 `release_gate_not_passed` 拒绝放行。没有修改主审核表或把局部新增证据当作全国发布批准。

## 新图草案

用户确认：已有当地驿站补官方名称映射，缺少的新增当地驿站；省直辖县级地区设本地驿站，旧图与旧信不变。

- 现有 `china-v2` 对草案中的 370 个市／州／盟／直辖县级业务地区，只有 293 个直接映射，77 个会落到省会兜底。
- 新图 `data/graphs/china-v3/` 包含 370 个节点、2869 条边，77 个新节点的候选坐标来自已核对所属省市的同源多边形；没有城市缺省回退。
- 旧库大同、七台河的坐标不在所属市源多边形内，仅在新图改用对应市的源代表点，旧版本三个资产保持原 SHA。
- 莱州是县级地区，不再作为新图中间驿站；莱州收寄归烟台市驿站。旧图莱州节点和旧信不改。
- 新边沿用项目已有的最近 4 邻居、同省互连、1600 公里距离上限和 Haversine 算法；运输速度和事件规则不变。边是业务模拟网络，不是实际道路导航。
- 新图未注册，默认仍为 `china-v2`。`manifest.json` 记录新增节点、两处坐标修正、移除的县级中转节点、源 SHA、输出 SHA 和连通报告；`releaseApproval=pending`。
- 新图映射声明 `provinceFallback=reject`：运行时拒绝未知城市及省市不匹配，不再静默使用省会。旧图没有该声明，继续使用旧版兜底行为；旧图三个资产与注册表 SHA 未变。
- `geometry-validation.json` 已核对全部 370 个节点：真实经纬度及地图坐标解码后均在所属市源多边形内，缺失映射和跨市点均为 0；这是快照几何门禁，不是正式地图发布批准。

## 回归证据

- GIS 测试 44 项通过：官方身份、行政层级、原 347 项唯一覆盖、源 SHA、缓存完整性、来源修正、父区包含、街道归属和草案导出；门禁汇总不能覆盖缺失区界或其他 pending 条件。独立审查后的回归同时检查几何成功状态、有效对象编号、坐标和点来源，填入编号不能将失败条目变为通过。
- 新图测试 5 项通过：370 个当地映射、旧数据不修改、确定性生成、全部节点四种方式共 1480 条路线验证、默认图不变。
- 旧图冻结与地区解析回归 13 项通过；新图重复生成的三个运行资产和 manifest 逐字节一致。旧图三个资产及注册表 SHA 保持原值。
- 区县起运集成与地图测试 10 项通过：3 小时起运、6 小时末端、同市 9 小时、改道边界、旧规则和事实权限。
- API 最新全量 **409 项通过（42 个文件）**，包含滁州新图集成 24 项和寄出前地区校验 4 项。使用真实 PostgreSQL 测试库，图注册仅在测试进程中模拟，未修改实际注册表：琅琊区到滁州驿站到南谯区第 9 小时送达；滁州到上海第 3 小时才开始市际运输，目的地浦东仍为末端派送，收件人不见未来路线。包括延迟初始化时第 1、4、20 小时改地区的组合回归。
- 新图运行解析测试 3 项通过，逐项检查全部 370 个正式市级身份、简称兼容、错配拒绝和旧图兼容。上述新图测试及旧图解析、起运时序关键回归共 16 项复跑通过，API 类型检查通过。
- 移动端最新全量 **435 项通过（43 个文件）**，API 与移动端类型检查、API 编译通过。以上都是本机 Docker 验证，不是服务器发布或 iPhone 真机 PASS。

## 地区兼容与寄出前检查

- `scripts/prepare-transport-region-catalog.mjs` 从已记录 SHA 的 `pca-current.json` 生成 `data/regions/canonical-candidate.json`，并核对审核报告的身份、条目完整性、编号与地区三元组唯一性。共 2851 条，包含 4 个无区县城市；来源与 MIT 许可一起保留。它仍是 candidate，不是全国现行版本认证。
- 手机现有下拉组件仅在测试进程中替换候选清单，逐项与后端全部 2851 条省／市／区县比较一致；直辖市、草湖等省直辖县级地区、东莞等无区县城市均覆盖。真实界面仍导入旧 `pca-code.json`，等待共同上线。
- 仅 `1.1` 新信创建及其寄送时长估算校验：候选正式清单中存在地区、运行端点库有区县坐标、同版本驿站属于本省本市。不能把省会回退当成本市驿站，不能把历史坐标当作已撤销县区的可选身份。
- 创建时在资料锁内重新读取双方地址，再做校验；失败返回 422 的 `origin_region_unavailable`／`destination_region_unavailable`。不会创建信件或抢占草稿图片；手机沿用失败弹窗并明确需要哪一方重选地址。既有地址不自动转换，旧信快照与 `1.0` 行为保持原样。
- 已创建信件的相同幂等请求先返回原信，不因后来地区失效而改写历史或拒绝正常重试。收件地区更新时先按原运输事实追赶时钟，仅对仍在途的 `1.1` 信件校验新端点；不支持时整笔事务回滚资料、目标和运输推进，不留下半条改道记录。
- 后端候选清单重复生成 SHA 一致：`b7d0df53c51402346231bfe8a0944cddc5fdf4c7b3f2e34c0a72bd22a44ef8a4`。旧地区选择文件 SHA 仍为 `83b7536f853ad16beb4d37b92890a3fd7bb9d33d4f37e7c8885fb948749a9bc4`，旧运行端点库 SHA 仍为 `3a17cf5a08bf4f7e50f57e8d1c88dc7729060741ef1b2ada39ba2eb88cb041ad`。
- 用户已授权独立只读审查。初审发现延迟初始化改地址的运输因果错误，以及对象编号替代几何结论的门禁漏洞；两项已修复并补回归，独立限定范围复核通过。审查不是专业地图审核或生产放行。

## 独立审查修复

- 初审独立复跑 API 41 项、移动端 10 项及新图 5 项，均通过，但另行复现了两个已有标准用例漏掉的问题；初审结论为技术暂不通过，未修改生产。
- 仅对无 Journey 的 `1.1` 信件，在资料事务及收件人锁内，复用 Journey 初始化服务按原目标建立运输，再追赶当前时钟，最后决定是否记录目的地变更。原目标在改地址之前已到达终态时保留原信；其他状态使用已有带时间戳的 `DestinationChange`，不追溯使用新地址。`1.0` 无 Journey 时行为未改。
- 几何证据检查器将成功状态、关系编号、有限且在范围内的经纬度及非空点来源一起校验；失败状态带编号或坐标会拒绝。候选数量、待补条目和失败统计都按逐行验证结果计算，不按编号存在与否统计。
- 修复后聚焦 API 40 项、全量 API 396 项及 GIS 44 项通过，API 类型检查和构建通过。普通证据完整性检查仍为 347 项原报告、2851 项正式草案、2 项待补；`--require-release` 仍拒绝放行。
- 独立复核重新运行 API 40 项／4 文件，全部通过；另外用隔离 HTTP 脚本复现黄浦寄往浦东、延迟初始化、改为徐汇的场景：第 20 小时改地址后仍保留浦东第 9 小时送达的事实；第 1／4 小时变更不开放正文；显式初始化重试均为 200 且只有一个 Journey。非法目标导致资料、初始化和推进整体回滚，`1.0` 无 Journey 行为保留，`1.1` 初始化与资料更新的一次并发交错通过。临时数据已清理。
- 独立纯内存复核确认编号伪装和 9 种无效几何字段全部被拒绝，真实发布检查仍拒绝放行。结论为原 P1、P2 可关闭、这两个修复的技术复核通过；未独立复跑全量测试、类型检查或构建，仍缺高并发和大量积压信件的事务耗时验证，不能写成完整发布 Final Gate PASS。

## 后续回归补充

- 针对 `china-v3`／`1.1` 四种运输方式分别使用三个固定种子，补 12 项一年期回放：一次大跳时与随机分段、重复推进、倒退时钟的信件状态、Journey、Leg、WorldEvent 和可见 Timeline 逐字段一致；运输不得早于第 3 小时起运，最多一段 ACTIVE，收件人仍无未来路线或 ETA。
- 增加 60 封未初始化信件的资料变更及并发初始化用例：30 封按原目标已到达、30 封仍在起运阶段，已到达目标不改，仍在途的保留请求时间，全部只有一个 Journey。聚焦运行改地址请求约 436 毫秒，全量运行约 380 毫秒。仅是本机隔离环境单场景结果，不证明生产上限或任意积压量均能在事务超时前完成。
- 补充后聚焦新图 24 项、全量 API 409 项及类型检查通过。没有改业务运行代码或生产配置，没有重新宣称完整独立审查／GIS／发布门禁通过；更大规模、高并发及正式端点库共同切换仍需进一步验证。

## 复跑

```sh
docker run --rm --init --network none --memory 3g \
  -v "$PWD:/workspace" yishu-gis-tools:local python \
  scripts/gis/audit_endpoint_release.py \
  --evidence-output data/maps/audit/endpoint-release-20261006

docker run --rm --init --network none --memory 3g \
  -v "$PWD:/workspace" yishu-gis-tools:local python scripts/gis/station_candidates.py

docker exec yishu-next-version-tools-1 node scripts/prepare-city-graph.mjs
docker exec yishu-next-version-tools-1 node --test scripts/test-city-graph.mjs
docker exec yishu-next-version-tools-1 node scripts/prepare-transport-region-catalog.mjs

docker exec yishu-next-version-tools-1 pnpm --filter @yishu/api test
docker exec yishu-next-version-tools-1 pnpm --filter @yishu/mobile test

docker run --rm --init --network none --memory 3g \
  -v "$PWD:/workspace" yishu-gis-tools:local python \
  scripts/gis/station_candidates.py --verify-graph data/graphs/china-v3

docker run --rm --init --network none --memory 1g \
  -v "$PWD:/workspace" yishu-gis-tools:local python \
  scripts/gis/check_endpoint_evidence.py data/maps/audit/endpoint-release-20261006
```

最后一条只检查审计证据完整性。加 `--require-release` 将在上线门禁仍 pending 时拒绝放行，不能将它的普通 PASS 当作上线批准。

## 历史来源排查

- 已取得[福建省自然资源厅 2026 年政务用图发布说明](https://zrzyt.fujian.gov.cn/zwgk/xwdt/zrzyyw/202604/t20260408_7120364.htm)。其中明确包含金门县，公开文件为 JPG；下载入口为[福建标准地图服务](https://bzdt.fjmap.net/)。原公告缓存 SHA：`3906ed92feef8f77fcda2c44d60c3509cba6df29b43ea5cc065d247e95071cf9`。公告证明有参考资料，不证明已取得符合本项目精度的矢量县界；没有从图片手描边界或套用审图号。
- 福建标准地图页面可读取，但本次按其公开页面请求 GDB 目录超时，未取得并核验矢量文件。未将下载失败计作数据通过，也未改在线底图。
- 新取得[福建省自然资源厅 2026 年 9 月标准地图发布公告](https://zrzyt.fujian.gov.cn/zwgk/xwdt/tpxw/202609/t20260921_7216251.htm)，确认官方公开 JPG／PDF／GDB 多格式渠道。原公告缓存 SHA 为 `55539d85ddcdafab866068a6a9f99bbc392b09eae6d94fc41a1d57305a258a9c`；正常浏览器及按公开页面字段筛选 2026 年 GDB 的请求仍超时，没有取得金门完整区界。[资料交接清单](MAP_DATA_HANDOFF.md)记录需要的原件、许可及核验要求。
- 民政部国家地名信息库现行区划页面／公开树接口本次访问为 403，未取得全国现行原件；未绕过限制，也未将社区镜像视作官方版本证明。
- 三沙南沙区仍无适用的同源完整区界；搜索中的广州南沙标准地图属于 `440115`，不能补 `460303`。

上述是此前排查的历史结果。后续已取得官方全国地区树，详见前文；金门县和三沙南沙区经确认停服，其区界缺口只保留作未来开通条件，不再阻塞本次服务范围内的候选几何联查。全国界线现行性与公开发布核验仍单独记录，不能仅因资料可下载而放行。

## 切流前历史待办

服务范围内候选端点、本市驿站和隔离新流程联调已完成，停服地区不要求本轮补齐区界。全国现行界线与本版本公开地图核验仍缺可绑定的资料，机器发布门禁尚未放行；用户确认已记录，不再追问，也未写成正式批准。前置放行后，仍须实际替换正式端点／手机地区清单、注册新图、完成最终发布审查、服务器配对备份与恢复验证、部署、新旧信对照及 iPhone 真机复验。任一步未完成，都不能标记整个版本最终上线 PASS。

具体切流、备份与回滚边界见 [1.1 运单发布检查](TRANSPORT_1_1_RELEASE_CHECKLIST.md)。该清单尚未执行，不代表批准切换。

## 2026-10-06 实际发布更新

后续用户明确要求继续部署 1.1，并减少重复审查。本次没有重复全量审计或再派独立 Reviewer；完成运行库分版本选择和真实手机地区清单启用的聚焦测试后，执行服务器配对备份、全表与全部媒体恢复校验、新制品切流及 HTTPS 临时账号业务冒烟测试，均通过。新信现使用 1.1 / china-v3，旧信冻结资产与端点库保留。详见 [服务器发布记录](TRANSPORT_1_1_SERVER_RELEASE.md)。正式地图批准与界线现行性仍 unverified，真机最终结果仍 pending，未把此前资料或审查缺口改成 PASS。
