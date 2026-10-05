# Phase 12 Docker 部署演练

> 2026-09-30 · 仅本机隔离演练，不是公开生产部署或 Release Gate PASS

## 入口与隔离

HTTPS API 为 `https://localhost:8443/api/v1/health`；HTTP `http://localhost:18080` 重定向至 HTTPS。该入口只提供 API，不托管 Mobile UI。原开发 API `4000`、Expo Metro `8081` 及开发数据保持不变。

使用独立 Compose project `yishu-phase12`，专属网络与 PostgreSQL / Redis / Caddy 数据卷。仅 Caddy 发布 localhost 端口；API、Worker、数据库、Redis 不向宿主或公网发布端口。固定代理 IP `172.31.231.2`、API IP `172.31.231.3`，网络 `172.31.231.0/28`；更换网段时必须同步可信代理配置，禁止信任所有代理。

本机证书由 Caddy 内部 CA 签发，不是公网受信任证书。不会自动安装到 macOS/iPhone 信任库；浏览器可能显示不受信任。测试通过单独指定 CA 文件验证 TLS，不把容器 healthcheck 的 `--no-check-certificate` 当成证书验收。正式部署须另外确定公网入口、入站策略与证书信任；域名方式需配置 DNS，IP 方式需验证证书覆盖实际 IP 地址并在目标设备正确受信任。具体开放端口由选定方案决定，不自动开放 80/443。[Caddy HTTPS 文档](https://caddyserver.com/docs/automatic-https)

2026-10-02 已在负责人授权下完成独立诊断服务的 iPhone 5G IPv6 连通性测试，测试后关闭临时入口。驿书 API 的持续外网发布尚未实施，iPhone 正式 CA 信任尚未验收。详见 [实施记录](PHASE12_IMPLEMENTATION_REPORT.md)。

## 启动

开发容器须已运行，以在 Docker 内生成演练凭据；不要把开发 `.env` 复制为生产配置。

```bash
sh scripts/prod.sh init
sh scripts/prod.sh config --quiet
sh scripts/prod.sh build
sh scripts/prod.sh up -d --wait --wait-timeout 180
sh scripts/prod.sh ps --all
sh scripts/prod.sh cp caddy:/data/caddy/pki/authorities/local/root.crt .local/phase12/root.crt
curl --cacert .local/phase12/root.crt https://localhost:8443/api/v1/health
sh scripts/dev.sh exec -T dev node scripts/phase12-smoke.mjs
# 业务冒烟之后另测伪造 IP 限流；会消耗登录额度
sh scripts/dev.sh exec -T dev node scripts/phase12-smoke.mjs --proxy-only
```

凭据在忽略目录 `.local/phase12/local.env`，文件权限 0600、目录初始化为 0700；随机生成且重复初始化保留既有值，仅补齐新增字段。不打印、不提交、不烘焙进镜像。正文密钥必须单独安全备份；更换它会导致原信件无法解密，禁止把删除配置文件后重新生成密钥当作升级。

冒烟会在演练库创建两个随机账号和一封信，不写开发库。频繁重跑会触发注册/登录限流，应等待窗口恢复，不清 Redis 或改变 IP 来绕过。`--proxy-only` 检查故意消耗登录额度，不能紧接着把受限登录误判为服务故障。

迁移镜像先 `prisma migrate deploy`，再为 `yishu_app` 授予业务表 DML 与 sequence 权限；迁移历史只读。迁移管理员为 `yishu`，API/Worker 使用单独密码与非超级用户 `yishu_app`，不允许建库、建角色、复制或绕过 RLS。账号权限不等于数据库级多租户 RLS，本项目仍由 API 授权保护用户数据。迁移失败或发现已有运行角色具备管理员权限时，任务非零退出，阻止后续服务启动。[Compose 启动顺序](https://docs.docker.com/compose/how-tos/startup-order/)

## 健康与日志

- `/api/v1/health` 保持进程存活语义；内部 `/api/v1/ready` 实查 PostgreSQL/Redis，2 秒超时返回不含驱动详情的 503。Caddy 不对外暴露 ready。
- Worker 每 5 秒检查消费者运行状态和 PostgreSQL/Redis，成功写心跳；失败撤销，容器探针拒绝超过 30 秒的心跳。SIGTERM 先停止心跳，再关闭消费者、队列和数据库。
- API/Worker 非 root、只读根文件系统、独立 `/tmp`、drop capabilities；API/Worker/Caddy JSON 日志轮转 10MB × 3。Caddy 不开 access log，并过滤默认日志 request 对象，避免记录 URL/凭据。
- 当前没有外部告警接收方、Sentry 或日志汇聚；数据库/Redis 的日志留存、整机磁盘容量、备份失败告警和恢复目标仍需正式部署配置。

## 备份与恢复比对

仅对可信、由本演练生成的备份执行恢复。`pg_dump --format custom --no-owner --no-acl` 生成权限受限的本地文件，内容含敏感数据，不上传或提交。实际备份是 PostgreSQL 一致快照，但逐表比较要求停写；不能在后台仍写入时把源库变化误判为恢复失败。

```bash
sh scripts/prod.sh stop api worker
sh scripts/prod-backup.sh
# 使用上一条实际输出的 .local/phase12/backups/...dump 路径
sh scripts/prod-restore-check.sh .local/phase12/backups/<实际文件名>.dump
sh scripts/prod.sh start api worker
sh scripts/prod.sh ps --all
```

恢复工具仅创建随机 `yishu_restore_check_*` 临时库；不会覆盖 `yishu`。恢复后授予运行账号只读验证权限，逐表比较行数和内容摘要，并使用既有正文密钥验证每封信的 AES-GCM 解密；退出时删除本次临时库。备份不含正文密钥、角色密码、Caddy CA 或 Redis AOF；这些需要独立备份策略。摘要不是备份文件真实性签名，也不代替异地恢复演练。[PostgreSQL pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html)

若工具中途失败，先检查并恢复 API/Worker；保留备份与错误证据，不重建开发数据卷。禁止 `down -v`，也不要删除已有密钥文件。

## 升级与回滚边界

演练标签 `phase12-local` 是可变开发标签，不作为生产版本或已验证 rollback artifact。正式发布应使用不可变 tag/digest，保存旧应用、图/规则、migration history、数据库备份和配套密钥。

升级前停写/备份，单次运行迁移任务，再启动 API/Worker并执行健康与业务验收。仅在旧代码兼容新 schema 时回退应用镜像；不得假设 Prisma 自动 down migration。破坏性迁移须单独审核恢复方案：在新库恢复完整备份并验证密钥/数据后切换连接，不能在正在写入的库上原地覆盖。当前没有旧生产镜像、破坏性迁移或真实服务器，所以不宣称版本回滚已实测通过。

## 发布前开放项

剩余依赖公告、Expo SDK 推荐补丁、最终运行依赖裁剪与镜像漏洞扫描仍待验；当前运行目录仍包含 Prisma CLI/TypeScript，不能宣称已彻底移除构建工具链。`backend` 为隔离内网，Worker 当前没有公共推送出站链路；本机演练无 EAS/Apple 凭据，不执行真实远程推送。

正式发布必须完成选定域名或 IP 的 TLS 信任、生产 secrets、外网与防火墙、Push 出站与凭据、Expo 版本冻结、签名构建/真机核心流程、恶意 Deep Link、SecureStore、通知点击/冷启动、监控/告警、异地备份和可回滚版本验证。当前只完成本机部署能力的一部分，不是 V1 发布批准。

## 开发数据迁移到独立待发布环境

2026-10-02 负责人确认先以 IPv6 试运行、迁移开发账号和信件，并原样保留快进时钟生成的记录，生产环境使用真实时钟。独立 project `yishu-production` 不复用 `yishu-phase12` 或开发环境的数据卷、数据库密码、Redis 密码和 JWT 密钥；仅正文密钥从开发环境安全保留，用于读取已有密文。文件位于忽略目录 `.local/production`，目录 0700、凭据/备份/摘要 0600。

以下是首次迁移流程，不是可直接反复执行的更新命令。快照脚本遇到已有证据时拒绝覆盖；恢复脚本只接受空目标库，恢复采用单事务，不使用 `--clean` 或删除数据卷。源库与目标库都必须使用可信备份。

```bash
sh scripts/import-source.sh
sh scripts/import-prod.sh config --quiet
sh scripts/import-prod.sh build api migrate
sh scripts/import-prod.sh up -d --wait postgres redis
sh scripts/import-restore.sh
sh scripts/import-prod.sh up -d migrate
# 确认 migrate 正常退出后校验，失败则不启动 API
sh scripts/import-prod.sh logs --tail 30 migrate
sh scripts/import-prod.sh run --rm --no-deps verify-import
sh scripts/import-prod.sh up -d --wait api caddy
sh scripts/import-prod.sh cp caddy:/data/caddy/pki/authorities/local/root.crt .local/production/root.crt
curl --noproxy '*' --cacert .local/production/root.crt https://localhost:19443/api/v1/health
```

`import-source.sh` 在开发容器内维持只读 Repeatable Read 事务，通过导出快照让 PostgreSQL 17 容器内的 `pg_dump` 与逐表摘要共用同一数据视图。不要使用开发容器的 PostgreSQL 15 客户端导出 17 版数据库。备份文件另存 SHA-256，导入后比较全部 13 张表，包括密码散列、会话、运输记录和迁移历史；校验每封信的 AES-GCM 解密，检查运行角色无管理权限、迁移历史只读。不输出正文或 secrets。

待发布环境当前只绑定 `127.0.0.1:19443`，网络 `172.31.232.0/28`；可信代理为 `172.31.232.2`。Worker 放在显式 `delivery` profile 中，默认不启动；数据库与 Redis 不发布端口。不要通过激活 profile 或改端口把私有验证环境直接当成通过发布门禁的正式服务。

**快照不是持续同步，也不是最终切流。** 开发环境继续运行，快照后新增数据不会自动进入目标库。切流之前必须确认停写窗口、最后一份数据校验、旧会话处理、客户端 API 地址、IPv6 端口和证书信任。快进测试记录保持原始时间，真实时钟下未来动态可能暂不可见。旧 RefreshToken 散列原样保留；更换 JWT 密钥不能独自撤销 RefreshToken，切流前需确认是否只在目标库撤销旧会话、要求重新登录。

当前依赖审计未通过；必须处理后端命中的高危公告并复测，再决定公网业务入口。该数据迁移不表示 Phase 12 封板或正式发布。

## IPv6 试运行候选（待风险确认）

`scripts/trial.sh` 使用忽略目录 `.local/production/trial.env`，沿用待发布目标库与正文密钥，但选择新的候选镜像；不会使用开发或独立演练库。默认模式仍只发布 localhost 19443。`docker-compose.trial-base.yml` 仅为此目标增加补丁镜像，不更改独立演练正在使用的镜像。

```bash
sh scripts/trial.sh config --quiet
sh scripts/trial.sh build api migrate
sh scripts/trial.sh build caddy postgres redis
sh scripts/trial-backup.sh
sh scripts/trial.sh up -d --wait --wait-timeout 90 postgres redis
sh scripts/trial.sh up -d --wait --wait-timeout 90 api caddy
sh scripts/trial.sh run --rm --no-deps verify-import
```

备份脚本仅备份试运行目标库，默认不停止服务；需要逐表恢复比对或切流一致性时须另外停写。不得拿独立演练的 `prod-backup.sh` 当作此目标的备份，也不得反复执行首次恢复覆盖目标库。当前补丁镜像有未修复 OS 告警，完整扫描未通过，详见实施报告；不因 npm audit PASS 自动开放公网。

`sh scripts/trial-restore-check.sh .local/production/backups/<实际文件名>.dump` 仅接受此目标的可信备份，创建随机临时库、单事务恢复，并通过无发布端口的 `verify-import` 一次性容器比对全部表及解密正文，最后删除临时库。核对要求目标数据在备份和检查期间不变；正常运行后须在受控停写窗口执行，不能在写入中的库上期待历史备份与当前摘要一致。此工具不会恢复覆盖正式业务库。

**以下只说明后续已授权切流的操作顺序，尚未全部执行。** 公网开放前必须另外取得剩余安全告警的明确处置结论、完成 iPhone 手动安装与完全信任根 CA。临时描述文件只含公开根证书，没有私钥；下载端口仅绑定 LAN，15 分钟自动结束。Agent 不代替跳过浏览器警告或输入设备密码。

1. 停止开发 `dev` 服务内 API/Worker/Metro，保留源 PostgreSQL/Redis；以一次性开发容器运行 `check-cutover-source.mjs`。若源数据已变化，停止切流并设计最后同步，不覆写现有目标库。
2. 保留最终源库备份与目标库备份；停止目标 API，运行 `finalize-trial.mjs --approved-revoke-sessions`，在单事务中复核目标摘要和正文密钥，且仅撤销目标 RefreshToken。撤销后原快照的 RefreshToken 摘要预期不再一致，必须使用新的切流摘要核对。
3. 仅在前置检查成功后使用 `sh scripts/trial.sh --public ...`。显式公网 overlay 只绑定指定 IPv6 TCP 19443；DB/Redis/内部 API 不发布端口，内部 ready 不暴露，IP 无 SNI 的连接由 `default_sni` 处理。地址不写入公共仓库文档。
4. 启动独立 `yishu-preview`：它只运行 Metro、绑定指定 LAN IPv4 8081，读取 `preview.env` 的新业务 API 地址，不启动开发 API/Worker。先在家中 Wi-Fi 加载 Expo Go bundle，再以蜂窝网检查已加载应用访问后端。这不是给外网发布 Metro 或独立安装包。
5. 严格 CA 后端冒烟会在目标库创建 2 个有标识的测试账号和 1 封信，凭据仅保存于私有文件。另行执行 iPhone 登录、原信件查看、新寄信/收信、绿色物流入口/地图以及蜂窝网络验证；后端冒烟不替代真机。

公网 overlay 激活后，后续重新创建服务必须继续使用 `--public`；默认私有模式 `up` 会恢复 loopback 入口。恢复开发环境时停止独立 Metro 后再启动开发 `dev`，避免抢占 8081；成功切流后不要重新启动源 Worker，避免两个库分别推进。试运行不代表 App Store、远程推送、独立 Release Gate 或 Phase 12 封板。

### 已切流环境的操作入口

2026-10-02 已按限定试运行决定执行切流。上文首次导入及私有候选步骤为历史准备流程，不应重复恢复。当前目标使用 `trial.env` 中的不可变候选版本，源开发服务保持停止；完整安全扫描及正式发布门禁仍未通过。

```bash
# 保持指定 IPv6 公网入口和唯一目标 Worker
sh scripts/trial.sh --public --profile delivery ps --all
sh scripts/trial.sh --public --profile delivery up -d --wait --wait-timeout 120 api worker caddy

# 独立 LAN Metro，不启动源 API/Worker
sh scripts/dev.sh --env-file .local/production/trial.env --file docker-compose.preview.yml up -d --wait preview
sh scripts/dev.sh --env-file .local/production/trial.env --file docker-compose.preview.yml exec preview pnpm --filter @yishu/mobile exec expo whoami

# 目标库备份；需要摘要比对时先安排停写窗口
sh scripts/trial-backup.sh
```

手机先在家中 Wi-Fi 打开 Expo Go 的 LAN 项目，加载指向新 HTTPS 后端的 bundle，再测试蜂窝网业务访问。Metro 不在公网开放；仅有公网 API 不意味着手机能从外网首次下载或重新加载开发 bundle。

新预览容器需要与 Expo Go 相同的 Expo CLI 账号。本轮已复用原开发容器的登录会话并验证 `whoami`；仅 `restart` 会保留容器内登录状态，删除或重建容器可能需要重新登录。届时在上面的独立预览容器中运行 `pnpm --filter @yishu/mobile exec expo login`，由负责人在终端输入密码，不将会话文件或密码提交到仓库。

目标撤销了迁移的旧登录会话，用户需使用原驿书账号重新登录。既有未来时间动态仍保留，可能暂不显示；这是保留测试记录的已确认行为，不通过改时钟或清空信件来修正。当前切流证据、最终源/目标备份和测试凭据都在忽略目录，不能用初次导入摘要当作目标库当前状态。

### Expo 公网隧道预览（2026-10-03）

按负责人要求，`docker-compose.preview.yml` 已从 LAN 切换到 `expo start --host tunnel --go`。这替代上面的 LAN Metro 启动方式；手机不再要求与 Mac 同一 Wi-Fi。业务后端仍为 `preview.env` 配置的 `https://8.136.121.71`，不修改 APK 或生产服务。

`Dockerfile.preview` 基于本机已有 `yishu-dev` 镜像安装固定版本 `@expo/ngrok@4.1.3`，所有依赖仍在 Docker 内。宿主机端口仅绑定 `127.0.0.1:8081`，公网通过隧道转发，不开放路由器端口。

```bash
docker compose --env-file .local/production/preview.env -f docker-compose.preview.yml up -d --build preview
# 读取当前隧道地址，使用 HTTPS URL；Expo Go 地址将 https:// 替换为 exps://
docker compose --env-file .local/production/preview.env -f docker-compose.preview.yml exec preview node -e 'fetch("http://127.0.0.1:4040/api/tunnels").then(r=>r.json()).then(j=>console.log(j.tunnels.filter(t=>t.proto==="https").map(t=>t.public_url)))'
```

本轮实际公网 iOS manifest / bundle 均 HTTP 200，manifest 内的 bundle URL 使用同一公网隧道，不引用 LAN IP。手机实际打开仍需负责人复验。Mac 和 Docker 必须保持运行并联网；隧道不是永久发布入口，重启后应重新查询地址。该入口公开开发预览，不应分享给无关人员。
