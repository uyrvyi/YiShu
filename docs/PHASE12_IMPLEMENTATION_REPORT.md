# Phase 12 实施记录

> 2026-09-30 · IN PROGRESS · 本机 Docker 生产演练

```text
PHASE 12 COMPLETE: NO
LOCAL DOCKER REHEARSAL: PASS (SCOPED CHECKS BELOW)
RELEASE GATE: NOT PASSED
V1 RELEASE READY: NO
```

负责人已确认先完成本机 Docker 演练，服务器和域名稍后提供。此前 Phase 11 的 503/0 与独立 302/0 是历史封板证据；本轮业务规则、schema、migration history、开发 `.env` 和既有数据未改，部署相关变更另行回归，不冒称通过独立 Release Gate。

## 已实施

- `Dockerfile.prod` 多阶段构建；运行镜像只安装后端 prod 依赖，移除应用源码，非 root、只读根文件系统。不包含开发 `.env`、Mobile 或 Metro；实际依赖目录仍含 Prisma CLI 与 TypeScript，裁剪尚未完成。
- 独立 `docker-compose.prod.yml`：Caddy、API、Worker、一次性迁移任务、PostgreSQL 17、Redis AOF/noeviction；独立网络和数据卷，只有 localhost 8443/18080 发布。
- 受控内部 CA 的真实 HTTPS、HTTP 308 重定向；只信任 Caddy 单个固定 IP，覆盖客户端伪造转发头；Caddy 不开放内部 ready。
- API 依赖就绪检查、安全 503；Worker 消费者/数据库/Redis 心跳与优雅关闭；API/Worker/Caddy 日志轮转。
- 演练随机 secrets 保存在忽略目录；迁移管理员与运行角色分离。备份与临时库恢复比对工具、正文解密检查、升级/回滚手册。

## 本轮实测

| 检查              | 结果与范围                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 全 workspace 回归 | **515/0**：API 330、Mobile 106、Config 29、Shared 11、DB 2、Simulation 12、Routing 19、Worker 6；新增代理/readiness/心跳测试                     |
| Typecheck / lint  | PASS；首次测试类型标注问题已修复后复跑                                                                                                           |
| 干净 Docker 构建  | frozen lockfile、供给链检查、Prisma generate、共享包/Worker/API 编译与镜像构建通过；Worker 在 API 前编译                                         |
| Compose / 启动    | 校验通过；首次 8080 端口占用及自动 IP 占用已修正，所有常驻演练服务健康，一次性 migrate exit 0                                                    |
| 宿主 HTTPS        | 显式 CA 校验的 health 200；HTTP 308 指向 `https://localhost:8443/api/v1/health`                                                                  |
| TLS 业务冒烟      | 注册/登录、寄信、路线、Timeline、地图；收件人送达前正文为空/不能拆信/不能查看计划，寄件人无 readState/openedAt；**LOCAL_TLS_SMOKE_PASS**         |
| 依赖故障注入      | 只停止演练 Redis；API ready 安全 503，Worker 探针 exit 1；Redis恢复后两者自动恢复，不手工重启 API/Worker                                         |
| 迁移历史          | 演练库 disk/applied **16/16**，SHA-256 checksum、完成记录和唯一性全部一致                                                                        |
| 备份恢复          | 最终角色分离候选 **RESTORE_CHECK_PASS**：13 张表逐表行数/摘要一致，2 封加密信可解密；临时恢复库残留 0（首轮为 1 封，单独记录）                   |
| 运行账号权限      | 实际账号 `yishu_app`；superuser/createdb/createrole/replication/bypassrls、schema CREATE、migration INSERT 均为 false；最终镜像重复迁移/启动成功 |
| 真实代理限流      | 12 次请求逐次伪造 X-Forwarded-For / Forwarded / X-Real-IP，经 Caddy 收到 8 个 400 + 4 个 429，未绕过同一客户端额度                               |
| 日志与文件权限    | 实际 API/Worker 日志未匹配 5 个演练密钥、Bearer/token/正文标记；凭据和最终备份文件 0600、目录 0700；不是所有故障路径的全面日志审计               |
| 原开发环境        | dev / PostgreSQL / Redis 均保持健康，开发数据卷和正文密钥未替换                                                                                  |

上述故障与恢复验证针对当前 Mac Docker Desktop、本地 arm64 和单节点。TLS 使用内置 CA，不是公网证书；515 项回归不是签名真机测试。未在生产环境加速业务时钟，也未把模拟器/测试库的送达测试冒称为本机 HTTPS 完整送达验收。角色分离后的最终镜像已复跑业务冒烟、权限和备份恢复，既有正文密钥兼容，开发环境未受影响。

## 尚未通过的发布项

Phase 12 尚未封板，不能进入“V1 完成”。负责人后续选择在本机以 IP 发布，暂不使用域名；仍须验证正式业务入口的 TLS 信任、入站策略、可信代理、外部告警、secret 保管、异地备份、不可变发布镜像和真实版本回滚。若后续采用域名，再验证 DNS 与配套证书。

Phase 11 留下的 audit **4 HIGH / 3 Moderate（exit 1）** 与 Expo version check **exit 1** 是此前全 workspace 结果；本轮未重新宣称 audit PASS，最终镜像依赖扫描仍待做。兼容升级/冻结例外、真实 iOS 开发/发布构建、签名真机流程、恶意 Deep Link、SecureStore、远程通知送达/点击/冷启动仍待验。当前 backend 隔离网没有公共 Push 出站链路，且无 EAS project ID/Apple 推送凭据；本地通知不代替远程推送。

操作命令、端口和备份/回滚边界见 [部署手册](PHASE12_DEPLOYMENT.md)。本轮未 commit / push，未修改已有 Phase 10 UI，也未添加产品功能。

## 2026-10-02 外网入口诊断

- 系统代理确实影响出口 IP 查询；已通过绕过代理的国内查询服务获得宽带直连出口，但没有据此宣称公网 IPv4 入站可达。
- 负责人授权后，临时将独立 Docker HTTPS 诊断服务绑定到 Mac 的指定全局 IPv6、TCP 18443。只提供静态 `/health`，其他路径 404；未连接 API、数据库或真实用户数据，未修改光猫、系统代理与防火墙。
- 本机 IPv4 / IPv6 HTTPS 均返回 200，使用独立 CA 文件严格验证证书通过。诊断容器配置 15 分钟自动停止。
- Agent 实际操作 iPhone 镜像，观察到手机 5G 状态及 Safari 返回 `{"service":"yishu-network-probe","status":"ok"}`。手机收到的证书序列号、公钥与诊断服务一致：**蜂窝网络 IPv6 连通性 PASS**。
- 浏览器安全警告交由负责人处理，Agent 未代替点击继续访问。最终页面仍标记“不安全”：**iPhone 系统 CA 信任未验收**，不将浏览器例外写成正式 HTTPS 信任通过。
- 测试完成后立即停止并移除诊断容器，复测公网端口连接失败；诊断配置已恢复为仅本机回环，独立证书卷保留。原开发与生产演练配置、数据库和密钥未改。
- 家庭网络地址和诊断配置只保存在 Git 忽略目录 `.local/network-probe`，未写入仓库发布资料。

以上只确认一个 IPv6 诊断入口的连通性，不代表驿书已正式发布，不验证 IPv4 客户端兼容性，也不改变本阶段 `RELEASE GATE: NOT PASSED`。正式发布的数据来源、持续开放范围和手机证书信任仍需确认或验收。

## 2026-10-02 开发数据迁移

负责人确认 IPv6 试运行和迁移开发数据；开发时钟曾快进 10 天，现有信件的运输时间在真实日期之后。已再次确认原样保留记录、生产恢复真实时钟，未清理或改写测试信件。

- 在只读 Repeatable Read 事务中导出 PostgreSQL 快照，同一快照用于 13 张表的行数/摘要和 `pg_dump`，开发服务未停止。首次发现开发容器的客户端为 PostgreSQL 15，导出失败且未生成有效备份；已改用数据库容器的 PostgreSQL 17 客户端，重新导出成功。
- 新建隔离的 `yishu-production` 数据卷、网络和私有 secrets，保留正文密钥，其他密码和 JWT 重新生成。原开发库和 `yishu-phase12` 演练库未覆盖；新库只恢复到空库，使用单事务。
- `DEV_DATA_IMPORT_PASS`：**13 张表全部摘要一致、2 个账号、1 封加密信正文解密通过**。迁移镜像检测 **16 个 migration，无待应用迁移**，授权后运行角色不具备管理权限，migration history 不可 UPDATE。
- 12 个自增序列均不小于各表最大 ID。原信件仍为已送达，运输时间未改写；新环境时钟偏移为 0。
- 拒绝重复快照、拒绝覆盖非空目标库、有效格式但错误的正文密钥导致校验失败，均实际验证。正确配置复验成功；crypto 单元测试 **11/0**。
- 新 API/Caddy/PostgreSQL/Redis 健康；严格 CA 验证的本机 HTTPS health **200**、未认证个人资料 **401**、内部 ready **404**、非 API 路径 **404**。只发布 `127.0.0.1:19443`；Worker 不启动，未执行推送或运输推进。
- 最后只读核对源库，13 张表与快照仍一致；这只是核对当时的状态，**未实施停写或最终切流**。旧 RefreshToken 散列仍保留，旧会话撤销策略待确认。
- 已启动 API 后，初版使用 API 服务的一次性验证容器遇到固定 IP 冲突；改为独立 `verify-import` 服务，仅连接 backend、无发布端口，只读挂载备份和摘要，复验不需停止 API。
- 重新执行 workspace prod audit：**11 HIGH / 5 Moderate、exit 1**。在当前运行镜像中审计仍按 workspace lockfile统计同样总数，不能当作镜像 SBOM 的纯后端计数；但公告路径明确命中后端 Fastify、Prisma CLI 下的 deepmerge-ts/mysql2。依赖更新、真实镜像扫描及复测仍阻塞公网业务入口；未冒称 audit PASS。

本轮仅完成私有数据迁移和上述局部验证，没有复跑全 workspace 515 项测试，也未完成签名真机或独立发布审查。前端仍连接开发 API，正式 IPv6 地址/端口、手机 CA 信任、停写窗口、会话处理与公网开放尚未完成。`RELEASE GATE: NOT PASSED` 保持不变。

## 2026-10-02 试运行候选加固（尚未切流）

负责人确认验收范围为本机 IPv6 后端、现有 Expo Go 接入和 iPhone 真机复验，不含 App Store 或真实远程推送；授权只开放当前 Mac 的指定全局 IPv6 TCP 19443，以及短暂停写、最终核对和仅在目标库撤销旧会话。这些授权不等于设备验收通过，也不等于接受未修复漏洞。

- Fastify 更新为 5.12.5，Docker 内安装及 frozen lockfile 构建通过。完整 workspace 回归 **586/0**（API 340、Mobile 165、Worker 6、Routing 19、Config 29、Shared 13、Simulation 12、DB 2）；typecheck/lint PASS。
- 实际后端依赖闭包裁剪后为 118 个公共 npm 包名；移除 Prisma CLI、TypeScript、mysql2、deepmerge-ts 和全局包管理器。运行容器不保留安装用 lockfile，仓库及构建阶段仍保留 frozen lockfile。官方 npm 公告接口对实际安装包审计 **RUNTIME_NPM_AUDIT_PASS**，不将它视为 OS/全镜像扫描 PASS。
- 候选 `trial-20261002t120509` 的 API/Worker 镜像使用固定 digest 的 Distroless Node 24 / Debian 13，UID/GID 65532、无 shell/包管理器；实际 Node 24.21.0、arm64。Argon2 原生 hash/verify、API 启动、严格 CA HTTPS health、13 张表与已有密文解密复验通过。Worker 尚未启动，不宣称新镜像运输推进已验收。
- 网关使用官方 Caddy 2.11.6 发布资产，校验固定 SHA-256；官方 Docker tag 尚未提供该版本，基于固定 digest 的 2.11.4 镜像替换二进制、补 OS 安全更新并删除 curl。实际版本、私有 HTTPS health 和公开入口配置验证通过。CA 数据卷保留，未重新生成正文密钥或替换开发配置。
- PostgreSQL 17.11 / Redis 7.4.11 保持版本系列，派生镜像仅补系统安全更新；PostgreSQL 原有 `en_US.utf8` 排序规则未改变。升级前另存本地目标库备份，权限 0600。原开发与独立演练环境保持运行，未执行源库停写。
- Grype 0.119.0 扫描实际镜像导出的 archive，无 Docker socket、无忽略列表或仅 fixed 过滤；数据库构建时间 2026-10-02 06:31:53 UTC，校验有效。Docker Scout 因要求登录而未执行，不能记为 PASS。

| 最终候选镜像             | Critical / High 命中数 | 结论           |
| ------------------------ | ---------------------- | -------------- |
| API / Worker（共用镜像） | 0 / 7                  | exit 2，未通过 |
| Caddy 网关               | 0 / 1                  | exit 2，未通过 |
| PostgreSQL               | 1 / 76                 | exit 2，未通过 |
| Redis                    | 0 / 1                  | exit 2，未通过 |

计数为包/漏洞匹配，不是独立漏洞数。四种候选合计 **22 个不同 Critical/High ID**，剩余告警在当前扫描数据库中均无发行版修复版本。数据库 Critical 为 `CVE-2026-6653`（libxml2 XML 解析 UAF/DoS）；Debian 将它记录为稳定版 Minor/no-dsa，但这不使扫描 PASS，也不证明对本应用不可利用。[Debian 状态](https://security-tracker.debian.org/tracker/CVE-2026-6653)

API/Worker 剩余为 zlib `CVE-2026-85091`、glibc `CVE-2026-5435` / `CVE-2026-19499`、GCC 运行库 `CVE-2026-102010`，共 4 个 ID、7 个包匹配。网关和 Redis 均剩 zlib 告警。没有在业务源码中找到公告所列函数的直接调用，但没有完成全 native 调用图或独立安全审查，不能据此写“不可达”。数据库仅安装 plpgsql 扩展、没有 Python 包，且不发布端口；这些是边界证据，不替代漏洞修复。[zlib](https://security-tracker.debian.org/tracker/CVE-2026-85091)、[glibc DNS](https://security-tracker.debian.org/tracker/CVE-2026-5435)、[glibc 格式化](https://security-tracker.debian.org/tracker/CVE-2026-19499)、[GCC](https://security-tracker.debian.org/tracker/CVE-2026-102010)

原始报告、镜像 archive、运行包 inventory 与摘要均保存在忽略目录 `.local/production`，未上传源码、数据库或 secrets 给扫描服务；镜像本地扫描，仅下载公告库。迁移镜像保留构建工具链且不提供常驻服务，未纳入上述四种常驻镜像扫描结果，不宣称其零漏洞。

**当前结论：试运行仍待负责人明确接受剩余告警或继续修复，不开放公网业务入口。** 目标 API/Caddy/PostgreSQL/Redis 为私有健康候选，只发布 localhost 19443；源库最新核对仍与原快照一致。旧会话尚未撤销，前端未切换，iPhone CA 完全信任与 Wi-Fi/5G 应用流程尚未验收。证书下载服务仅 LAN、15 分钟自动停止，现已到期。`RELEASE GATE: NOT PASSED`，Phase 12 不封板。

### 候选环境备份恢复复验

在上述补丁候选环境中，以私有目标备份创建临时数据库，单事务恢复后通过候选运行镜像复核：**RESTORE_CHECK_PASS，13 张表摘要一致、1 封加密信正文解密通过**。运行账号在临时库只授予读取权限，未改写源库或目标业务库。检查完成后临时库残留为 0；工具实际拒绝独立演练环境的备份路径。再次只读核对开发源库，仍为 **FINAL_SOURCE_MATCH_PASS**。

此次复验不等于最终停写同步、会话撤销、公网切流或真机通过。工具为 `scripts/trial-restore-check.sh`，证据位于私有 `trial-restore-check.json`；现有安全风险和设备确认仍待负责人答复。

### 限定试运行处置决定

负责人在收到剩余镜像告警说明后，明确将证书之外的部署细节委托 Agent 决定，并随后确认 iPhone 已安装并信任根证书。Agent 决定继续此前明确授权的 IPv6 后端 / Expo Go 限定试运行；不是负责人逐项确认所有 CVE，不作为正式安全验收或 Phase 12 封板批准。

实际 HTTPS 输入边界复验：XML 请求返回 415，超过 1 MiB 的 JSON 请求返回 413，均未创建业务数据。运行路由使用参数化 Prisma / SQL，不向用户暴露任意 SQL 或原始 XML 解析接口；数据库 / Redis 不发布端口，运行账号不具备管理权限。以上降低已知触发路径的暴露，不是完整 native 调用图证明；四种镜像扫描仍为 NOT PASSED，22 个独立告警保留，迁移镜像不作为常驻服务。试运行结束后的正式发布须重新处理告警并完成独立门禁。

当前仅准备执行已授权的停写、最终备份、目标旧会话撤销、切流与真机验证；完成后另行追加实际证据，不将计划记为已执行。

## 2026-10-02 限定试运行实际切流

本节更新此前私有候选的历史状态，不改变完整 `RELEASE GATE: NOT PASSED`。

- 已停止源开发 `dev` 中的 API/Worker/Metro，保留源 PostgreSQL/Redis 和数据卷。停写后只读核对仍为 `FINAL_SOURCE_MATCH_PASS`，13 张表与迁移快照一致；最终源库、目标库分别另存权限 0600 的备份。
- 目标事务复核并解密现有 1 封信成功，仅撤销目标库的 1 个旧 RefreshToken；其他表摘要保持一致。原快进运输记录保留，目标时钟偏移为 0。源库旧会话不修改。
- `trial-20261002t120509` 的 API、Worker、Caddy、PostgreSQL、Redis 已启动并健康。业务入口仅绑定配置中的指定全局 IPv6 TCP 19443 与本机回环；数据库、Redis 和内部 API 不发布端口，内部 ready 对外 404。
- 本机严格 CA 验证 IPv6 HTTPS health 200、未认证个人资料 401、内部 ready 404。真实 HTTPS 后端冒烟 `TRIAL_BACKEND_TLS_SMOKE_PASS`，创建 2 个标识测试账号和 1 封信；登录、寄信、幂等重试、运输数据和角色隐私边界通过，凭据仅留在忽略目录。
- 独立 `yishu-preview` 仅运行 Metro，绑定指定 LAN IPv4 8081；iOS bundle 检查为 `IOS_PREVIEW_BUNDLE_API_PASS`，内联的新地址指向 IPv6 HTTPS 业务入口。恢复原 Expo CLI 登录会话后，`expo whoami` 与手机 Expo Go 账号一致。开发 API/Worker 不重新启动。
- 负责人手动安装并信任本环境 CA；Agent 在 iPhone 镜像中实际观察到根证书完全信任开关开启。随后 Safari 在 Wi-Fi 下返回真实 `yishu-api` health JSON（2026-10-02 12:35:33 UTC），无浏览器证书警告；不将旧诊断端口的 5G 结果充当业务入口验收。
- 临时 LAN 证书下载服务已停止并移除。iPhone 应用重新登录、迁移信件和物流地图、蜂窝网业务访问尚待完成，当前不宣称限定试运行验收完成。

私有证据为 `cutover.json`、`trial-smoke.json`、源/目标最终备份及原扫描报告。会话撤销、Worker 推进和冒烟写入后，初次迁移快照不再是目标库的当前摘要；不能重复运行首次导入或用历史摘要覆盖正在使用的目标库。

### iPhone Wi-Fi 应用复验

负责人在新版登录页手动完成原驿书账号登录后重新锁屏，Agent 继续观察镜像并操作地图按钮。原迁移信件的正文、寄收信息、绿色最新动态入口及独立物流详情显示正常，百度底图实际出现，缩放按钮改变地图层级和比例尺。收件人画面仅显示已确认路线和动态，没有未来计划路段；后端同期信件详情、timeline、map 请求均返回 200。

未将镜像中无明显响应的拖动/滚动尝试记为地图平移通过。负责人已授权临时断开 Wi-Fi，镜像无法打开控制中心，已请求其手动切换 5G 后重新锁屏；截至本记录蜂窝网业务访问尚未完成。新寄信/收信仅有 HTTPS 后端冒烟证据，没有新增真机寄信验收，限定试运行仍待收尾。

### 真机新增寄信与 Worker 复核

随后 Agent 在已登录的 iPhone Expo Go 中，使用现有 `test1` / `test2` 测试账号完成收件人查询、填写明确标注的验收正文、确认寄出和绿色物流入口跳转。API 创建信件、初始化旅程均返回 201；手机显示新信运输中和寄收信息，寄件人物流页显示下一站预计时长。没有快进目标时钟或修改原信件。

只读复核目标库为 `PHONE_SEND_PERSISTENCE_PASS`：新信在 2026-10-02 12:54:01 UTC 创建，密文用原正文密钥解密后与输入逐字一致；旅程 `IN_PROGRESS`，Worker 已推进到 12:59:01 UTC，时钟偏移保持 0。证据保存在私有 `phone-send.json`。新信真实送达仍需要实际运输时间，不将创建成功写成已送达或远程通知通过。

镜像已实际显示 5G、无 Wi-Fi 状态图标，但切网后镜像的应用点击没有响应，已请负责人在手机上打开已加载的驿书并进入新信物流页面。蜂窝网应用请求尚待核对，不能单凭 5G 图标或缓存页面记为通过。

### 2026-10-03 蜂窝网络重试（未通过）

iPhone 重启后镜像恢复，Expo Go 在 Wi-Fi 下重新加载驿书，原登录会话刷新及信件列表请求返回 200。通过控制中心临时断开 Wi-Fi 后，实际观察到中国联通 5G 和 VPN 标识；进入新信详情出现“信件暂时无法更新，请稍后重试”，未取得该次蜂窝详情请求的后端成功证据。

Safari 输入包含 HTTPS、IPv6 方括号及 TCP 19443 的业务 health 地址后出现“此连接不安全”提示。Agent 未点击“继续”，未关闭证书验证，也未据此断言证书、VPN 或公网防火墙中的任何一项为根因。网关同期没有新增错误日志；这些证据不足以判定公网连接成功。已重新开启 Wi-Fi，控制中心显示正在搜索网络，尚未确认重新关联完成。

已向负责人请求临时停用 iPhone VPN 并在对照测试后恢复的授权；未获得答复前不修改 VPN。当前蜂窝业务验收仍未通过，限定试运行未完成最终验收，完整 `RELEASE GATE: NOT PASSED` 保持不变。

随后发现镜像对主屏幕快捷键没有响应，不能把冻结画面当作持续网络状态。仅退出并重新打开 Mac 的镜像应用后连接恢复，控制中心实际显示 Wi-Fi 已连接、VPN 仍启用；此前临时断开 Wi-Fi 的设置已经恢复。本机严格 CA 校验 health 在 2026-10-02 16:27:24 UTC 返回 200，此为本机证据，不替代蜂窝网验收。

重连后对同一个 Safari HTTPS 页面完成对照：Wi-Fi 下刷新返回新的 health 时间戳 `2026-10-02T16:29:37.958Z`，未出现安全警告；随后仅断开 Wi-Fi（VPN 不变），刷新同一页面再次出现“此连接不安全”。未绕过警告，已重新开启 Wi-Fi。此结果排除单凭旧缓存页面的误判，但仍不能确定 VPN、运营商路径或家庭入站规则中的哪一项导致失败；停用 VPN 的对照授权仍待确认。

### VPN 停用后的对照

负责人随后手动停用手机 VPN。Agent 实际观察到 VPN 应用未连接、控制中心无 VPN 标识；按既有授权临时断开 Wi-Fi 后显示中国联通 5G。驿书新信详情仍处于加载状态，Safari 刷新同一业务 HTTPS health 页面后显示“无法连接服务器”，没有取得蜂窝请求成功证据，也未绕过浏览器安全提示。仅停用 VPN 尚未解决公网访问问题，不将此前安全提示直接归因为证书故障。

Mac 全局 IPv6 未变化，Docker API/Worker/Caddy/PostgreSQL/Redis 均健康；`lsof` 实际确认 Docker 后端进程监听指定 IPv6 TCP 19443 与回环。系统应用防火墙查询为关闭状态，仅查询，没有修改。上述本机状态不能替代外网可达性。

光猫管理地址 `192.168.1.1:8080` 在不经过代理的本机 HTTP HEAD 检查中返回 200；Safari 则显示 AdGuard 连接错误页，当前默认 IPv4 网关的 HTTP 检查超时。未修改网关或防护设置，已请求仅对光猫管理页临时停用过滤、只读检查并恢复的确认。手机镜像随后多次因用户改变应用而中断恢复操作，已请求负责人确认 Wi-Fi 重新连接并锁屏；不能将恢复尝试记为已恢复。当前外网验收仍未通过。

### 光猫只读检查

负责人手动停用 AdGuard 后，Safari 重新加载管理页成功；Agent 使用负责人先前提供的现有凭据登录同一本地光猫，没有创建账号或更改凭据。设备为 HN8156XR-10，页面显示上网业务 IPv4/IPv6 均为桥接。安全菜单中的 IPv6 转发防火墙已使能，普通账号 `useradmin` 的复选框及应用按钮均禁用；当前可见网络、应用菜单没有单端口 IPv6 放行入口。没有修改防火墙、桥接、远程管理、LAN、无线或其他网关设置。

Mac IPv6 默认路由走 `en0` 家庭网关，系统 HTTP/HTTPS/SOCKS 代理指向本机 7897；仅查询，未改代理。既有诊断端口 18443 的历史成功不能代替 19443 的当前验收，防火墙使能状态也不能单独证明本次失败的根因。已请求负责人提供官方管理员登录或联系电信装维核对，并限定为当前 Mac IPv6 TCP 19443 的单端口需求，不建议关闭整个 IPv6 防火墙。

负责人自行停用的手机 VPN 和 AdGuard 未由 Agent 重新启用。手机 Wi-Fi 开关已重新开启，重新关联仍需观察确认。公网业务验收、完整 Release Gate 均未通过。

### AdGuard 停用后重试与 IPv4 查询

随后确认 Wi-Fi 已重新关联，Safari 在 Wi-Fi 下返回新的 health 时间戳 `2026-10-02T16:43:38.456Z`。再次临时断开 Wi-Fi，控制中心显示中国联通 5G、无 VPN 标识；Safari 刷新后长时间停留在旧时间戳及加载进度，没有取得新 HTTPS 成功证据。API 日志中同期唯一的 Docker 网关来源 health 请求对应上述 Wi-Fi 时间戳，不能将旧页面记为蜂窝通过。恢复 Wi-Fi 并重新连接镜像后，控制中心实际显示 Wi-Fi 已连接；Safari 此时出现 HTTP 请求发送到 HTTPS 服务的错误，不将恢复后的错误页面归属于先前 5G HTTPS 请求，也不据此确定防火墙或代理根因。未关闭证书校验或绕过安全警告。

负责人提出改用 IPv4。只读检查当前 Safari 的另一网关管理界面（`192.168.1.1/cgi-bin/luci/`）：网关信息显示 WAN IPv4 为 `192.168.71.3`，LAN 为 `192.168.1.1`；高级设置存在 IPv4 端口映射表单。该 WAN 是内网地址，尚未确认真正宽带出口的公网 IPv4 或上游 NAT 结构，不能直接认定运营商 CGNAT，也不能仅添加此处映射就判定外网可达。没有填写或提交映射，没有扩大公网监听；IPv4 切流及证书适配尚未执行，需先核实公网 IPv4 条件。
