# 服务器 Expo Go 预览

## 当前入口与证据（2026-10-05）

入口：[服务器 HTTPS Expo Go 预览](https://8.136.121.71/expo)。在 iPhone Safari 点击“打开 Expo Go”，进入 `exps://8.136.121.71:443`。不再使用旧 `.exp.direct` 地址，不要求与 Mac 同一 Wi-Fi；服务运行在服务器，Mac 关机不停止它。手机仍使用现有 `uyrvyi` Expo Go 账号。HTTPS 对应的 `exps` 用法见 [Expo 官方链接说明](https://docs.expo.dev/linking/into-your-app/)。

- 当前镜像为 `yishu-cloud-preview:preview-20261005-gallery-preload`，ID `sha256:2739035517bdf5ccab26a0985a5def5948331323fd5de6826172b9051addd9a9`。补丁归档 SHA-256 `e7e50c93f57489cd8fce3ba58541c5adb6e29a76036173dd52bba531566b6662`，六个运行源码、Dockerfile 和源哈希清单，不含凭据、后端配置或用户图片。服务器无网络源哈希核对和只读非 root iOS 导出通过（3338 模块、约 15 MB）。
- 同一封信的图片在正文可见后整组并发预加载，缩略图与全屏复用已获取的数据；左右切换和关闭后重开不重复请求。缓存只属于当前信件组件，不落盘，组件卸载或切换账号后清理，并忽略旧请求结果。未送达收件人的正文/图片权限保持不变。已缓存图片仍需由原生组件解码，不承诺任何情况下都零显示延迟。
- 短路线自动适配最多放大到手动上限减三档：在线瓦片初始上限 12、手动仍可到 15；离线底图初始上限 10、手动仍可到 13。长路线仍优先完整展示，地图刷新不覆盖用户手动缩放。路线、时长、地区选择及运输事实权限不变。
- 经用户授权，预览改为内部 LAN 启动并设置 `EXPO_PACKAGER_PROXY_URL=https://8.136.121.71`，由现有 Caddy TCP 443 提供 HTTPS。关闭懒加载，网关支持 gzip，Metro 按客户端协商也可返回 Brotli；只允许读取 Expo 清单、固定入口代码包和指定图片/字体媒体资源。`/open`、`/_expo/open`、`/inspector`、`/json/list`、`/message`、`/symbolicate`、环境文件和令牌路径返回 404，预览 POST 返回 404。公网不提供热更新/调试控制；新发布后从新入口重新打开或 Reload。这个代理环境变量按当前安装的 SDK 57 CLI 实际行为验证，升级 CLI 后必须重新核对 URL 生成与资源路径。
- `DIRECT_PREVIEW_RELEASE_PASS`、服务器及 Mac 两端 `EXPO_PREVIEW_HTTP_PASS` 通过：SDK 57、owner uyrvyi、签名头和证书链提供、HTTPS 实际 iOS 开发代码包 20,951,131 字符、生产 API、所有已有功能和新图片预加载/缩放限制均核对通过。浏览器实际显示“驿书 / 打开 Expo Go”，链接目标为 `exps://8.136.121.71:443`。检查签名头/证书链存在不替代 Expo Go 的真机信任验证；真机手势与 Mac 关机后重新加载仍待用户复验。
- 容器 running/healthy、重启次数 0、`unless-stopped`、非 root、Docker init、只读根目录、无宿主端口，仅连接 `yishu-cloud-preview_default`。网关额外加入该预览网络，预览不加入后端或数据库网络、不挂载生产数据；网关仍只有 TCP 443，TLS 账户和证书卷保留。API、Worker、PostgreSQL、Redis、地图容器的镜像与启动时间一致，`BUSINESS_CONTAINERS_UNCHANGED_PASS`；业务健康与地图地名 HTTPS 200。采样可用内存约 1747 MiB，不作为耐久门禁。
- 直连前新旧镜像均发生 ngrok `remote gone away` / `failed to start tunnel`，已停止无限重试。本次不依赖 ngrok，也未购买隧道服务。首轮直连检查误把被 CLI 省略的 `lazy` 参数视为未关闭，自动回退；核对安装 CLI 只在 `lazy=true` 时加参数后修正检查，再次发布通过。Docker 工具容器外网 TLS 检查曾连接重置，随后使用 Mac 的内置 Node 运行同一检查通过，不把失败的工具容器检查算作 PASS。
- 本机移动端 377 项测试（36 文件）、TypeScript、格式及 `git diff --check` 通过。数据库没有迁移，区县起运规则未启用，旧信件不改，APK 未更新。本次不记 Final Gate / 真机 PASS。
- 额外核对 SDK 57 原生资源：32 个内置图片尺寸文件与应用 PNG 图标读取通过，实际协商代码包压缩为 `br`。仅允许当前 React Native 0.86.3 / Expo Router 57.0.24 的三个已安装资源目录，原始查询参数结构与解码后的路径同时校验；越界、非图片/字体文件和重复 `unstable_path` 均返回 404。`DIRECT_ASSETS_RELEASE_PASS` 与 `PREVIEW_AND_BUSINESS_UNCHANGED_PASS`；此次只强制重建网关，预览和业务容器均不重启。首次 Compose 未重建正在运行的网关，资源检查失败后回退，随后明确使用 `--force-recreate` 发布通过；不把首轮失败计入 PASS。

### 直连回退

`deploy/release-direct-preview.sh` 仅更新预览和网关，先验证 Caddy，再预热代码，公网验证失败自动恢复网关。当前备份后缀为 `before-direct-https-20261005-r2`，四份备份分别位于 `/opt/yishu-preview/preview.env`、同目录预览 Compose、`/opt/yishu/docker-compose.cloud.yml` 和 `/opt/yishu/deploy/Caddyfile.cloud` 的同后缀文件。原始首轮备份也保留。不删除证书、账号凭据卷或旧镜像。

手工回退需恢复上述四份配置，仅用 `sh /opt/yishu/scripts/cloud.sh up -d --no-deps --force-recreate --wait caddy` 重建网关，并停止当前预览。旧 ngrok 服务未验证恢复可用，不自动启动旧隧道循环；需要重新核对后才能恢复。数据库、API、Worker、地图和 APK 不回滚。

仅回退原生图片路径补充时，恢复 `/opt/yishu/deploy/Caddyfile.cloud.before-direct-package-assets-20261005-r2`，使用同一条强制重建 caddy 命令；不要重启预览或业务。该回退保留 HTTPS 直连，但会再次阻断上述内置图片，仅用于应急；后续应修复并重新核对资源。独立补充脚本为 `deploy/release-direct-assets.sh`。

### 图片切换补丁（上一版历史记录）

- 当前预览为 `yishu-cloud-preview:preview-20261005-gallery`，ID `sha256:1dff0d609b4b1b3a9ba4cf9ed3a34d699919eefaa674bb72d0ad518a0fcb4d26`。经用户确认，仅叠加信件详情、写信页与两个图片预览组件。同一封信内原始大小左右滑动上一张/下一张，首尾不循环、不退出；放大后单指平移，双指始终只缩放/平移。单击关闭与原始大小纵向拖动退出保留，多图显示序号。写信草稿同样支持切换，不修改正文/图片权限。
- 归档 SHA-256 `da50f51c6b866981ed9f67593356894cbb6e745fd7c0f9631f607745a960ec2a`，恰好四个运行源码、Dockerfile 和哈希清单，无配置、凭据或用户照片。服务器无网络构建、逐项源哈希检查 `GALLERY_SOURCE_PASS`、只读非 root 隔离 iOS 导出通过（3337 模块、约 15 MB）。仅重建预览并通过 `GALLERY_RELEASE_PASS`；healthy、init、只读、无宿主端口。
- 本机移动端 368 项测试、TypeScript 与格式检查通过，覆盖连续左右切换、首尾回弹、双指/放大后平移不切页不关闭、重开从选中图开始、草稿及已寄信图片列表。API、Worker、PostgreSQL、Redis、Caddy 和地图服务的镜像及启动时间一致，`BUSINESS_CONTAINERS_UNCHANGED_PASS`。不部署区县起运规则、不迁移数据库、不更新 APK。回退备份 `/opt/yishu-preview/preview.env.before-gallery-20261005`，恢复后仅重建 preview，旧镜像和凭据卷保留。
- 服务器预热 `NATIONAL_MAP_PREWARM_PASS`（20,914,285 字符），公网全部已有标志加 `--letter-gallery` 检查 `EXPO_PREVIEW_HTTP_PASS`（20,914,319 字符），SDK 57、owner uyrvyi、签名、证书链、生产 API、地图与已有图片功能核对通过。当前入口仍为 [iPhone Expo Go 预览](https://eu9qlby-uyrvyi-8081.exp.direct/_expo/loading?platform=ios)。公网业务健康正常；真机左右切换、缩放和平移待用户复验，不把 HTTP / 导出 / 健康检查记为真机 PASS。Reload 前先处理未发送的草稿。

### 上传提示补丁（上一版）

- 上一版预览为 `yishu-cloud-preview:preview-20261005-upload-feedback`，ID `sha256:0ccef398af4d9efce6d91cbec148ebce777549877db03aa235bd9d655d250e64`。经用户确认，仅叠加写信页和头像裁切组件：成功不弹窗，上传失败/部分失败仍弹窗；头像保存成功直接关闭裁切。相册选择、缩略图、进度、删除确认、图片手势和业务权限不改。
- 补丁归档 SHA-256 `45f20c2e3f740e725ab90332907517df6000ff78bc69e5d11f09810d125a28ae`，只含两个运行源码、Dockerfile 和哈希清单，不含环境变量、凭据或用户照片。服务器离线源哈希核对通过 `UPLOAD_FEEDBACK_SOURCE_PASS`，只读、非 root、无网络隔离 iOS 导出通过（3337 模块、约 15 MB）；随后仅重建预览，通过 `UPLOAD_FEEDBACK_RELEASE_PASS`，healthy、init、只读、无宿主端口。
- 预览前后 API、Worker、PostgreSQL、Redis、Caddy 和地图服务的镜像及启动时间一致，`BUSINESS_CONTAINERS_UNCHANGED_PASS`；公网 HTTPS 业务健康正常。数据库没有迁移，新区县运输规则未启用，APK 未重打。配置备份 `/opt/yishu-preview/preview.env.before-upload-feedback-20261005`，回退时恢复此备份并仅重建 preview；旧全国底图镜像与凭据卷保留。
- 本机移动端 353 项、类型检查、6 项起运集成测试通过。卡片按用户最新决定保留市级展示，不包含 district 展示补丁。区县起运业务与端点审核按用户确认须完成后一起上线，未审核候选库不包含在此预览补丁。
- 服务器预热通过 `NATIONAL_MAP_PREWARM_PASS`（20,911,044 字符）；公网所有已有标志加 `--upload-feedback` 检查通过 `EXPO_PREVIEW_HTTP_PASS`（20,911,078 字符）。实际 iOS 开发 JS 包中成功弹窗文案已移除，失败提示保留；静态地图、地图滚动锁与图片手势检查仍通过。SDK 57、owner uyrvyi、签名和证书链正常。入口仍为 [iPhone Expo Go 预览](https://eu9qlby-uyrvyi-8081.exp.direct/_expo/loading?platform=ios)，本次手机操作未复验，不把 HTTP 通过当作真机 PASS。

### 全国静态地图基底

- 前一版预览为 `yishu-cloud-preview:preview-20261005-national`，ID `sha256:2e903d4bd0633c561e6b7ee2aee42eb11e2b8a5e40e8b9ebabb9ee12d88b4f4f`。经用户授权发布全国静态矢量背景及主要道路；`EXPO_PUBLIC_MAP_TILE_BASE_URL=https://8.136.121.71/maps/national-20261003-v2`。按视野加载，水系、海岸线和区界同源，Canvas 渲染，不调用百度 API。完整数据、部署与回退见 [全国静态地图](SELF_HOSTED_VECTOR_MAP.md)。
- 仅叠加指定地图文件和 fflate / topojson-client 已安装依赖，源哈希逐项一致，服务器无网络、只读、非 root iOS 导出通过（3337 模块、约 15 MB）。本机 347 项移动端测试、TypeScript 和 6 项静态服务测试通过；不改正文权限、运输事实、地区输入、规则版本或 APK。
- 独立地图容器与 Expo 预览均 healthy、Docker init、只读且无宿主端口映射。网关短暂重建后接入地图内部网络，只有现有 TCP 443 对外；API、Worker、PostgreSQL、Redis 镜像和启动时间完全不变，业务 HTTPS 健康 200，数据库未迁移。
- 服务器预热通过 `NATIONAL_MAP_PREWARM_PASS`（实际 iOS 开发 JS 包 20,911,275 字符）。全部已有上传 / 图片手势 / 地图滚动锁检查加 `--static-tiles` 的公网检查通过 `EXPO_PREVIEW_HTTP_PASS`（20,911,309 字符），SDK 57、owner uyrvyi、签名、证书链、dev=true、生产 API 和公网瓦片地址均核对通过。离线版的 `connect-src 'none'` 旧断言仅在非静态瓦片模式保留，联网模式核对 URL 校验模块和实际公网地址，不取消清单 / 签名检查。
- 公网实际解码 11 处瓦片，主要道路均存在；上海含 2306 条道路、40 个水面和 31 段边界，数字是抽查瓦片中的要素数，不是行政区域总数。地名文件与本机 SHA 一致，gzip、CORS、长期缓存、304 和公开许可 / 数据库下载通过。社区地图未获官方边界精度或审图认证，正式地图发布门禁仍待单独验收。
- 入口仍为 [iPhone Expo Go 预览](https://eu9qlby-uyrvyi-8081.exp.direct/_expo/loading?platform=ios)。手机先保留未发送草稿，再 Reload；这版的真机地图缩放 / 平移 / 页面滚动和 Mac 关机后的加载仍待用户复验。HTTP 和导出通过不等于真机 PASS，已安装 APK 未更新。
- 预览配置备份 `/opt/yishu-preview/preview.env.before-national-20261005` 及同目录 Compose 备份；网关两份配置也有同后缀备份。旧镜像、凭据卷和版本数据保留；不把令牌、后端密钥、原始 GIS 大文件或用户数据放进补丁。

- 前一版预览为 `yishu-cloud-preview:preview-20261004-map-scroll-lock-r2`，ID `sha256:f375f740465bc3ff2dfe4a934feafc72aee2b664b05798091221aeb1d7428dbb`。修复地图纵向拖动与物流页滚动竞争：原生触摸捕获阶段立即暂停外层 ScrollView，但返回 false 不抢 WebView 手势；最后一指松开或取消、后台切换、地图失败/卸载/重试时释放。页面通过原生 `setNativeProps` 与 React 状态共同控制 `scrollEnabled`，不等待地图 WebView 的异步 postMessage。
- Android 同时启用 WebView 的 `nestedScrollEnabled`；HTML 禁止滚动链与浏览器默认触摸滚动，非 passive 的 touchmove 只 preventDefault，不截断 Leaflet 的事件传播。依据：[ScrollView scrollEnabled](https://reactnative.dev/docs/scrollview#scrollenabled)、[WebView nestedScrollEnabled](https://github.com/react-native-webview/react-native-webview/blob/master/docs/Reference.md#nestedscrollenabled)。不改正文权限、运输事实或地图坐标。
- 本机 331 项移动端测试、类型检查、iOS 导出（3264 模块，约 5.9 MB）通过；新增测试覆盖双指剩余一指保持锁定、取消/后台/失败/卸载释放以及页面原生属性和状态一致。390×312 / 1024×700 浏览器地图回归通过；这些不替代 iPhone 嵌套原生 ScrollView 真机手势验证。
- 经用户确认仅复制 `InteractiveRouteMap.tsx`、`localMapHtml.ts`、物流页三个运行文件，服务器无网络构建；六项源码/既有图片模块哈希核对通过 `MAP_SCROLL_PATCH_SOURCE_PASS`。修正版补丁包 SHA-256 为 `cb465cdce76621ab804d860c696bfcf3ea6b267223c63f89446bfad232e118dd`，Linux 列表确认恰好四项、无隐藏元数据或配置。服务器无网络、只读、非 root 隔离 iOS 导出通过（3264 模块，约 5.9 MB，207 秒），随后切换预览并回读 healthy、`Ports={}`。旧镜像保留，配置备份 `/opt/yishu-preview/preview.env.before-map-scroll-lock-r2-20261004`；不改 API/Worker、数据库、凭据卷或 APK。
- 修正版预热通过 `MAP_SCROLL_PREWARM_PASS`；随后全部已有标志加 `--map-scroll-lock` 公网检查通过 `EXPO_PREVIEW_HTTP_PASS`，实际 iOS JS 包 11,984,628 字符，含地图触摸锁、页面原生滚动控制和 Android 嵌套滚动配置；SDK 57、生产 API、签名、证书链和开发模式正常。入口仍为 `https://eu9qlby-uyrvyi-8081.exp.direct/_expo/loading?platform=ios`。发布后 API/Worker/Caddy/PostgreSQL/Redis 健康且启动时间不变，通过 `BUSINESS_CONTAINERS_UNCHANGED_PASS`，严格 TLS 公网业务健康 200。预览保持 node 用户、只读根目录、Docker init、无宿主端口。iPhone 地图内上下拖动、双指缩放、地图外页面滚动和切后台恢复仍待真机复验；Reload 前保留未发送草稿。
- 前一版预览为 `yishu-cloud-preview:preview-20261004-geographic`，ID `sha256:39bcd4702b78b6be32a520d2e7f34dc844d7fdce4c7026e3914790195a1a6e5f`。按用户要求单独发布地图重绘：用内置 Leaflet / 原 ADM1 源和统一 Mercator 投影替换百度交互地图，静态兜底同样修正纵向拉伸；支持全国视图、可见路线适配、缩放和平移，轮询不复位。不是地图内容合规或全国区县规则发布 PASS。
- 发布只替换九个地图源码/许可文件，附加六个从本机锁文件已安装依赖复制的纯 JS/类型包。基于已核对 ID 的 touch-session 镜像无网络构建，源码哈希逐项匹配，图片手势、压缩、上传及物流页面文件哈希均保持原样，通过 `GEOGRAPHIC_PATCH_SOURCE_PASS`。补丁包约 262 KB，传输 SHA-256 为 `0f42171f18701ccf86314bebd0fda9a03cc5d400104c975ebdc98a0ad9697793`。
- 服务器隔离无网络、只读容器的 iOS 导出通过（3264 模块、Hermes 约 5.9 MB）；沿用既有预览未包含 `google-services.json` 的配置警告，不构建 APK 或验收 FCM。只重建 Expo 预览，回读新镜像且健康、宿主端口映射仍为 `{}`。原配置备份 `/opt/yishu-preview/preview.env.before-geographic-20261004`，旧镜像与凭据卷保留。
- 区县定位候选库与 `1.1` 三小时起运规则仍未部署；API/Worker 镜像、数据库、规则开关、网络端口及 APK 不改。前端地图只使用原服务端已过滤的可见 DTO，不能把寄件人未来路线补给收件人。详见 [区县运输地图](DISTRICT_TRANSPORT_MAP.md)。
- 全部既有预览检查及新增 `--geographic-map` 公网检查通过 `EXPO_PREVIEW_HTTP_PASS`：实际 iOS 开发 JS 包 11,982,607 字符，含内置 Leaflet / Mercator 几何与全国按钮，旧百度加载界面不在运行包中，生产 API、SDK 57、清单签名及证书链正常。中文 JSX 按钮在 Metro 中被编码为大写 Unicode 转义，验证脚本同时识别原文与转义，不降低代码存在性检查。入口保持 `https://eu9qlby-uyrvyi-8081.exp.direct/_expo/loading?platform=ios`。
- 发布后回读 `BUSINESS_CONTAINERS_UNCHANGED_PASS`：API、Worker、Caddy、PostgreSQL、Redis 健康且启动时间与发布前完全一致。预览运行 ID 与新镜像一致，保持只读根目录、Docker init、无宿主端口；公网业务健康 HTTPS 200。本机 327 项移动端测试、类型检查及桌面/手机尺寸浏览器验证通过；Expo Go 真机重绘、双指及重新加载仍待用户复验。先保留未发送草稿再 Reload，不将 HTTP 通过写成真机 PASS。
- 前一版预览为 `yishu-cloud-preview:preview-20261004-touch-session`，ID `sha256:9ee057f5924afec8c9a414e3813ad7bed2f6dc3fab381fb3a7601692351eef2e`。增加独立物理触摸序列保护，跨 responder 重建保留多指标记，取消旧点击计时器并拒绝已排队的旧回调，避免双指松手误触发单击退出。四项回归在旧源码失败、新源码通过；移动端 321 项测试和类型检查通过，真机松手仍待复验。详见 [图片生命周期](MEDIA_LIFECYCLE.md)。
- 仅更新一个前端模块，服务器运行源码哈希与本机一致；预览健康、无宿主端口映射，配置备份 `/opt/yishu-preview/preview.env.before-touch-session-20261004`。本轮发布前另经授权修复网关僵尸进程积累，启用自动回收并只重建 Caddy，详见 [网关自动回收](GATEWAY_HEALTHCHECK_REAPING.md)；其后预览更新期间所有业务容器启动时间不变且健康，API 公网健康 200。未更新 APK、业务应用镜像或数据库。
- 新版本地预热和公网检查通过；全部既有检查加 `--preview-touch-session` 返回 `EXPO_PREVIEW_HTTP_PASS`。实际公网 iOS JS 包 11,519,300 字符，物理触摸与旧点击回调保护均存在，SDK 57、生产 API、签名、证书链和开发模式正常；服务器入口不变，真机仍待复验，Reload 前先保留未发送草稿。
- 前一版预览为 `yishu-cloud-preview:preview-20261004-persistent-pan`，ID `sha256:4b51a3794030ac0d04f4d2de5b65c5c2aac9bf1aae60d31cbf5ea9e1e882bbf2`。修复原生动画图缓存旧普通位移：平移改为稳定 Animated 节点，缩放 / 平移后松手保留合法位移，后续双指拖动继续响应。按用户最新要求，双指整段手势永不退出，包含抬起一指后的剩余操作；原始大小纯单指仍可全方向拖动退出。312 项移动端测试和类型检查通过；回归用实际安装的 React Native 缓存算法，旧源码失败、新源码通过，不代替真机验证。
- 只替换一个前端运行模块；源码哈希与本机一致，预览健康、无宿主端口映射，业务容器健康且启动时间均不变，API 公网健康 200。配置备份 `/opt/yishu-preview/preview.env.before-persistent-pan-20261004`。APK、业务后端、数据库不变；真机连续缩放 / 平移 / 松手待复验。
- 服务器本地预热通过，公网检查全部既有标志加 `--persistent-preview-pan` 通过 `EXPO_PREVIEW_HTTP_PASS`；实际 iOS JS 包 11,515,934 字符包含原生位移节点同步和整段多指退出保护，不含旧静态位移 transform。SDK 57、生产 API、清单签名、证书链和开发模式正常。服务器入口不变，真机手感仍待复验，Reload 前先保留未发送草稿。
- 前一版全方向拖动预览为 `yishu-cloud-preview:preview-20261004-any-direction`，ID `sha256:b3e28d3fe85eabf46e81d4e0d070e20b5a734fcf7be3d4c821679bd707b6240c`。按当时要求，原始大小支持上下左右及斜向单指拖动，松手超过距离阈值退出，未超过则两轴回弹；放大后仍为平移，触边不退出。306 项移动端测试、类型检查通过；仅更新一个前端模块，预览健康、源码哈希一致、无宿主端口映射，业务容器启动时间均不变，API 公网健康 200。配置备份 `/opt/yishu-preview/preview.env.before-any-direction-20261004`；APK 与业务后端不变，真机手势待复验。
- 全方向补丁在服务器本地预热后，通过全部已有上传 / 生命周期检查及 `--any-direction-preview` 公网检查，实际 iOS JS 包 11,515,258 字符；两个退出位移轴、二维距离与重置代码存在，旧的仅向下退出分支不再存在。SDK 57、生产 API、签名、证书链、开发模式正常；仍使用下方服务器入口，Reload 前先保留未发送草稿，HTTP 检查不代替真机手势验收。
- 前一版生命周期预览为 `yishu-cloud-preview:preview-20261004-media-lifecycle`，ID `sha256:54242b08e0d50718a0f3cb686704841a29f89169c2388a06e2b3bf9e9f5faa42`。增加多指手势获权恢复、弹窗重开重置、退出动画与点击清理，保持单击退出和已有缩放 / 拖动规则；写信页退出回收未寄临时图片，保护已发送和结果未确认的图片。288 项移动端测试通过，包含十次关闭重开的状态回归；真机手势仍待复验，APK 不变。详见 [图片生命周期](MEDIA_LIFECYCLE.md)。
- 此次同时发布 API 的定期过期清理和提前配额检查，API 镜像为 `yishu-server:next-1.1.1-media-cleanup-20261004`，ID `sha256:889da669c7d58c0e8ff804d27601f7b02f43847881c568bbe27b941d7e6c7f64`。后端 363 项测试、类型检查和构建通过；仅 API 与预览重建，其他业务容器未重启。运行文件哈希一致、容器健康、API 公网健康 200，预览无宿主端口映射；配置有备份，无数据库迁移或新增端口。
- 新版先在服务器本地预热，再通过全部上传检查及 `--media-lifecycle` 公网核对；实际 iOS JS 包 11,515,079 字符，新增手势和回收代码存在，签名 / 证书链 / 开发模式正常。真机跨图片重复打开手势仍待复验，Reload 前先妥善保留草稿，已清理的旧临时图片须重新添加。
- 历史压缩预览为 `yishu-cloud-preview:preview-20261004-smaller-photos`，镜像 ID `sha256:ad7f59717e27b3cea4b9f3c1f059c848da8d5edb36b5801fbe57876cbfcac7c9`。按用户最新同意，普通信件照片长边最多 1600 像素、JPEG 75%，目标 500 KiB；复杂照片最多编码三次，缩小下限 960 像素，体积目标不是硬保证。原文件 10 MiB 限制不变，透明图片 / GIF / 头像保持原策略，正文权限与加密不变。上传当前图片时提前准备下一张，网络 POST 仍逐张执行；重试复用压缩结果。277 项移动端测试及类型检查通过，真机画质与速度待复验，APK 不变。
- 基于核对过 ID 的 upload-flow 镜像无网络构建，仅复制五个前端文件，源码哈希逐项与本机一致；上下文 SHA-256 `0e79186880458f0181af889f325f3e51df435672bd5ce199e43b84cb341c5876` 经服务器校验。预览健康、无宿主端口映射，业务容器健康且启动时间不变，API 公网健康 200。配置备份 `/opt/yishu-preview/preview.env.before-smaller-photos-20261004`；未改数据库、业务后端或网络入口。详见 [上传排查](UPLOAD_DIAGNOSTIC.md)。
- 本地预热后，公网检查 `--upload-optimized --upload-progress --native-abort-compatible --upload-flow --smaller-photos` 通过 `EXPO_PREVIEW_HTTP_PASS`，实际 iOS JS 包 11,510,964 字符；1600 / 0.75 数值、体积控制及准备流水线、已有进度和兼容性补丁均存在。生产 API、SDK 57、清单签名、证书链和开发模式正常；不代替真机账号与图片验收，Reload 前先妥善保留草稿。
- 历史上传流程优化版本为 `yishu-cloud-preview:preview-20261004-upload-flow`，服务器镜像 ID `sha256:ab3ba2ecf26214ef309f4b0a6fe1a490bfa88d95693eaf0e9594cf11fef00a54`。用户已确认上一版 Wi-Fi 上传可成功，本轮针对等待体验和额外客户端处理优化：已压缩 JPEG 直接读取缓存生成 data URI，不再二次解码 / 缩放 / 编码；原生上传不再构造不用的 JS FormData；成功响应不再等待多余的原生取消调用。准备、连接、上传和等待确认分开显示，不伪造进度或提前宣布成功。263 项移动端测试及类型检查通过，画质与内容权限不变。只更新服务器预览，APK 不变，真机提速幅度待复验。
- upload-flow 基于已核对的 upload-fix 镜像，仅复制五个前端文件，源码哈希逐项与本机一致；压缩模块仍为 `c88e83c4547139ec9a74736c6b25f6fa66c472a1df920d18ea55387546b3f052`。预览健康、无宿主端口映射，API / Worker / Caddy / PostgreSQL / Redis 均健康且启动时间不变。备份配置 `/opt/yishu-preview/preview.env.before-upload-flow-20261004`。详见 [上传排查](UPLOAD_DIAGNOSTIC.md)。
- upload-flow 已先在服务器内预热 iOS JS 包，再通过公网 `EXPO_PREVIEW_HTTP_PASS`：实际包 11,507,687 字符，包含快速 JPEG 预览及新阶段提示，压缩 / 原生进度 / AbortSignal 兼容性检查均通过，生产 API、清单签名、证书链和开发模式正常。API 公网健康 200；真机新版本耗时仍待同图对照，Reload 前先妥善保留草稿。
- 历史上传兼容性补丁 `yishu-cloud-preview:preview-20261004-upload-fix` 的服务器镜像 ID 为 `sha256:5c8a1d292bce805afe56ce90a0362621c28c13b18f8f76842e1fa8e6e9f9fea3`。用户反馈选图后立即失败；原进度代码调用了 React Native 的 AbortSignal polyfill 不支持的 `throwIfAborted()`，请求发出前即抛 TypeError，被误显示为网络不可用。已改为读取 `aborted`，使用实际安装的 React Native polyfill 新增三项回归；修复前复现失败，修复后全部 256 项移动端测试及类型检查通过。
- 本补丁基于 progress 镜像，只复制 `imageUploadFetch.ts`。源码 SHA-256 为 `47720d779ed6524998247ef541c5cd6b22a970d8df331268e68b865feae2faba`，服务器与本机一致；压缩模块哈希不变。预览健康、无宿主端口映射，隧道地址不变；API / Worker / Caddy / PostgreSQL / Redis 健康且启动时间不变，API 公网健康 200。APK 未更新，真机上传成功与速度仍待复验。Reload 前须妥善保留未发送草稿。
- 补丁公网检查通过 `EXPO_PREVIEW_HTTP_PASS`：实际 iOS JS 包 11,506,749 字符，兼容性检查确认上传实现不再调用 `throwIfAborted()`，原压缩与进度逻辑均保留，清单签名、证书链、开发模式正常。首次冷启动编译 119 秒，检查连接在编译期间断开；编译完成后重试通过。此项不代替真机上传验收。
- 历史进度版本 `yishu-cloud-preview:preview-20261004-progress` 的服务器镜像 ID 为 `sha256:67623ddede031b0dc17819be8d1ef2611696897ef92655e2694aba02c4162a92`，基于前一个 upload 镜像仅复制五个进度相关源码文件。源码哈希与本机一致；压缩模块哈希保持 `c88e83c4547139ec9a74736c6b25f6fa66c472a1df920d18ea55387546b3f052`。用户选择保留画质，本轮不更改压缩参数。253 项移动端测试及类型检查通过；仍只更新服务器预览，不更新 APK。
- 进度版本公网检查通过 `EXPO_PREVIEW_HTTP_PASS`：iOS JS 包 11,506,518 字符，含圆形进度组件、原生字节回调及原压缩逻辑，签名与证书链正常，保持开发模式。真机上传进度与速度仍待复验，完成当前草稿后再 Reload。
- 图片上传默认压缩已按用户确认发布到服务器预览：镜像 `yishu-cloud-preview:preview-20261004-upload`，服务器镜像 ID `sha256:f4297e40d1901d28470be359adcbe276bf434c47415ee00a95aee41da6d38026`。基于已核对 ID 的原预览镜像，仅增加三个媒体源码文件；源码 SHA-256 与本机逐项一致。更新只重建预览容器，业务后端启动时间均保持不变。入口仍为下方 `eu9qlby` 地址；240 项移动端测试和类型检查通过。图片压缩及上传速度仍需用户真机复验，不能把代码回归记为网络问题已解决。详见 [上传排查](UPLOAD_DIAGNOSTIC.md)。
- 压缩版本公网检查通过：实际 iOS JS 包 11,494,881 字符，含压缩模块和生产 API 地址，清单签名、证书链与开发模式均正常；真机耗时仍待复验。完成当前草稿后再 Reload，以免丢失未发送内容。
- 当前服务器入口：[iPhone Expo Go 预览](https://eu9qlby-uyrvyi-8081.exp.direct/_expo/loading?platform=ios)。用户要求停用本机预览、仅保留服务器；本机 `yishu-preview-preview-1` 已停止且运行时重启策略设为 `no`。服务器预览已连接，仍使用 Expo ngrok 隧道，未切换 Cloudflare。旧入口 `https://uzhgdyy-uyrvyi-8081.exp.direct` 不再使用。免费地址应在重启后重新核对。
- 用户真机截图已证明认证后的前端代码可以下载，但随后在 Expo Router 初始化时出现 `Cannot make a deep link into a standalone app with no custom scheme defined`。原因是启动参数 `--no-dev` 配合未显式配置 scheme，触发当前 Expo Linking 的生产模式校验。已从服务器 Compose 命令及仓库 Dockerfile 默认命令移除 `--no-dev` / `--minify`；当前服务器仍用原镜像，由 Compose 覆盖旧镜像 CMD，无需修改业务代码或 APK。
- 在 Docker 内用当前已安装的 `expo-linking` 模块和实际 app 配置做隔离回归：iOS / Android 的旧模式均复现同一错误，开发模式均解析为 `exp`，通过 `LINKING_MODE_REGRESSION_PASS`。这是代码级检查，不代替真机导航验收。HTTP 检查新增 `dev=true`、不启用 minify 的断言；Expo 默认省略 `minify=false` 时也应允许。新服务器清单已实际回读 `owner=uyrvyi`、`dev=true`、minify 未设置。
- 重启时 ngrok SDK 诊断曾报 `ERR_NGROK_108`，Expo 共用 ngrok 账号达到 5000 并发 agent 会话上限；关闭旧 Mac 预览隧道后首次重试仍失败。临时诊断容器自动删除，失败预览也曾停下以避免循环重试。用户要求仅保留服务器后再次限次启动成功，恢复服务器预览的 `unless-stopped` 策略；没有更换隧道或购买服务。释放本机 agent 不意味着能永久预留共用账号的空位给服务器，后续仍可能受全局上限影响。
- 原匿名服务器入口 `https://uzhgdyy-anonymous-8081.exp.direct` 曾在真机遇到账号校验失败：手机登录 `uyrvyi`，服务器 CLI 未登录。已获用户授权，配置现有本机 Expo 访问令牌并只重建预览容器。新入口仍待真机确认，不沿用旧匿名地址。
- 凭据在本机容器内用 AES-GCM 加密，密钥用服务器临时 RSA 公钥封装后经 Workbench 传输；只在目标容器内解密。令牌位于专用 home 卷的 `/home/node/.expo/preview-token`，UID 1000、文件权限 0600、目录权限 0700。不放入镜像、源码、Compose 环境配置或聊天。两端临时密文及服务器临时私钥已删除。该令牌具有账号访问权限，并非项目级权限；停用预览时应按需在 Expo 账号中撤销令牌，撤销也会影响复用该令牌的本机预览。
- 初次手势版本 AMD64 镜像 `yishu-cloud-preview:preview-20261003-gestures`，镜像 ID `sha256:9533ef670f7e92b2844b79fbc0f95211dee77fa525b7192b9640af3bd506b5fb`。包含最终双指缩放、单指拖动及下拉退出代码，现作为压缩补丁的基底及回滚版本保留。
- 镜像包分为 29 个片段经 Workbench 传输；重组后 SHA-256 `7b903153f6e5ed8065dbd4b042f90a174b04cdca4da27f2df0369342ca80b54b` 与本机一致。首次大包上传超时，随后分块成功；加载命令连接中断后已独立回读确认镜像存在且 ID 一致，不据中断结果假称部署成功。
- 初次部署时已回读服务器容器健康、`Ports={}`、非 root / 只读根目录 / CPU 与内存限制。本机临时试启动容器、网络和卷已删除；原本 Mac 预览当时保留，现已按用户要求停止。
- `scripts/check-expo-preview.mjs` 从公网验证 Expo SDK `57.0.0` 清单、服务器来源的实际 iOS JS 包及启动页，通过 `EXPO_PREVIEW_HTTP_PASS`；JS 包 8,806,997 字符，并包含生产 API 配置。不把 HTTP 验证写成手机运行通过。
- 认证修复后再次通过加强的 HTTP 检查：账号 owner 为 `uyrvyi`，请求签名时返回 `expo-signature`，multipart 返回证书链，新入口 iOS JS 包 8,806,994 字符并含生产 API 配置。该检查确认签名和证书链已提供，不替代 Expo Go 在真机上的信任校验。
- 仅保留服务器后的开发模式检查通过 `EXPO_PREVIEW_HTTP_PASS`：当前 `eu9qlby-uyrvyi-8081.exp.direct` 返回签名、证书链和 11,491,842 字符的 iOS 开发 JS 包，生产 API 配置存在，`developmentMode=true`。真机导航及图片手势仍待用户复验；此次全局限额后成功连接不保证后续永远有可用空位。
- API / Worker / Caddy / PostgreSQL / Redis 启动时间与部署前一致，无生产容器重启；公网 `/api/v1/health` 与容器内 `/api/v1/ready` 均 200。预热过程中预览内存约 538 MiB，服务器可用内存约 1679 MiB；这是一次采样，不是持续性能门禁。
- 手机使用新入口及 Mac 关机后的重新加载仍待用户实测。APK 没有重新打包，真实远程推送不属于此次 Expo Go 预览验收。

## 范围

服务器预览只提供移动端前端代码，业务请求仍访问 `https://8.136.121.71`。它不是 API 部署或 APK 更新，也不是生产发行渠道。

独立 Compose 项目 `yishu-cloud-preview`，目录 `/opt/yishu-preview`。预览容器不加入后端网络，仅网关加入专用预览网络；不挂载数据库、Redis、媒体卷或宿主 Docker Socket，不复制后端 `.env`、证书、FCM 服务端私钥或备份。服务器 CLI 需要匹配手机账号；配置登录会话或令牌前必须取得用户授权，不得擅自复制本机凭据。当前已按授权配置，启动命令从私有文件读取令牌；文件不存在或为空时停止启动，不静默退回匿名预览。

`Dockerfile.cloud-preview.dockerignore` 使用允许列表；镜像只含移动端、共享类型及所需依赖。运行用户为 `node`，根文件系统只读，禁用新增权限，CPU 上限 0.75 核、内存上限 1280 MiB，Metro 单 Worker、Node 堆上限 768 MiB。无宿主端口映射，公网由现有 HTTPS 网关提供，不启动 ngrok。

## 构建和发布

前端不是自动同步。每次修改后先回归测试，然后构建新的不可变预览标签，再将镜像和配置通过 Workbench 上传到服务器。不要同步整个工作区或服务器环境文件。

在本机仓库构建 AMD64 镜像：

```sh
docker build --platform linux/amd64 -f Dockerfile.cloud-preview \
 -t yishu-cloud-preview:<new-preview-tag> .
```

如果 npm 直连失败，可仅对这次构建传递已有代理的 `HTTP_PROXY` / `HTTPS_PROXY` 参数，不改变系统或生产网络配置。包版本与完整性仍由锁文件校验。

服务器 `preview.env` 只填写预览镜像标签和浏览器端地图 AK，不放入 JWT、数据库密码、加密密钥、Expo 登录令牌或 FCM 私钥。API 地址固定于 Compose 的公开客户端配置中。

新服务器首次启动前，必须经用户授权安全配置上述令牌文件到专用 home 卷，不能仅凭镜像匿名启动。之后替换镜像时保留该卷即可；令牌失效则重新授权配置。

### 地图补丁发布与回退

滚动锁补丁必须在 Linux 工具容器内打包，并在服务器检查归档恰好包含三个运行文件和 Dockerfile，不得包含 `._*`、`.DS_Store` 或环境文件。macOS tar 的本机列表可能隐藏 AppleDouble 条目，不能据此认定 Linux 解包后没有隐藏文件。首版滚动锁在预热时因 `._logistics.tsx` 被 Expo Router 扫描而返回 500，已恢复 geographic 版；修正版镜像构建清除继承的 AppleDouble 元数据，最终保持 `USER node`，发布前先完成隔离 iOS 导出，不把容器 healthy 等同于代码可运行。

`scripts/prepare-geographic-preview.mjs` 只将指定地图源码和已经安装、与锁文件一致的 Turf 依赖闭包复制到 `.local/cloud-preview/geographic-20261004/context`；不复制工作区配置、登录凭据、地区候选数据库或后端文件。服务器用 `deploy/Dockerfile.cloud-preview-geographic` 基于核对过 ID 的旧镜像构建，无网络安装。发布脚本为 `deploy/release-geographic-preview.sh`，替换前检查旧运行镜像和配置，备份配置，仅重建 preview；健康失败则恢复旧配置和预览。

当前滚动锁版本回退到已发布的地图重绘版时，只恢复这一份预览配置，保留现有账号凭据卷，不回滚生产 API 或数据库：

```sh
cd /opt/yishu-preview
cp -p preview.env.before-map-scroll-lock-r2-20261004 preview.env
docker compose --env-file preview.env -f docker-compose.cloud-preview.yml up -d --no-deps --wait preview
```

回退或重新创建后仍须重新核对隧道地址与公网包；不能保证免费隧道地址和共用配额永久稳定。

传输后先核对镜像包 SHA-256，再 `docker load`；随后在服务器执行：

```sh
cd /opt/yishu-preview
docker compose --env-file preview.env -f docker-compose.cloud-preview.yml up -d --wait
```

不会重启或替换 `yishu-cloud` 的生产容器。Expo Go 预览使用默认开发模式，不添加 `--no-dev`；CI 模式仍禁用源码监听，因此代码更新需要发布新镜像，手机 Reload 本身不会同步 Mac 上未发布的修改。

## 获取入口

服务器上执行：

```sh
docker compose --env-file /opt/yishu-preview/preview.env \
  -f /opt/yishu-preview/docker-compose.cloud-preview.yml exec -T preview \
  node -e 'fetch("http://127.0.0.1:4040/api/tunnels").then(r=>r.json()).then(j=>console.log(j.tunnels.filter(t=>t.proto==="https").map(t=>t.public_url)))'
```

用返回的 HTTPS 地址打开 `/_expo/loading?platform=ios`，再跳转 Expo Go。切换入口后可能需要重新登录驿书；Expo Go 的 SDK 必须兼容当前项目。

Mac 关机不影响服务器容器，但服务器停机、隧道中断、手机网络限制仍会影响预览。免费隧道不承诺固定地址或生产可用性；重启后应重新核对入口。不把 Expo Go 当作真实远程推送验收环境。

## 验证要求

- 确认服务器预览容器健康、无宿主端口映射、没有访问生产卷。
- 从公网读取 Expo 清单和实际 JS 包，并确认前端使用生产 API 地址。
- Expo Go 启动包必须为 `dev=true`，且 minify 为 false 或省略；不得用生产包的下载通过替代 Expo Go 导航初始化验证。
- 核对服务器 CLI 与手机 Expo Go 的账号一致，并在真机确认项目认证和加载。HTTP 检查不能验证手机账号校验。
- 对比 API / Worker / Caddy / PostgreSQL / Redis 的启动时间，检查公网健康与容器内就绪端点。生产网关有意不公开 `/ready`，公网返回 404 不代表数据库就绪失败。
- 真机使用新的服务器入口，验证加载及图片手势；服务端检查不替代真机确认。

HTTP 检查可在本机 Docker 工具容器中执行：

```sh
node scripts/check-expo-preview.mjs https://eu9qlby-uyrvyi-8081.exp.direct
```
