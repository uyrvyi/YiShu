# 图片上传排查（2026-10-04）

## 结论与边界

后续“等待确认后失败”出现独立的配额问题：`test1` 的临时图片达到现有 36 张上限，近期上传返回 429。经用户授权清理了精确匹配的 36 张临时图片，已寄信件和头像未改动；随后已发布草稿退出回收、后台 24 小时过期清理和上传前配额检查。不要将这一故障继续归因为压缩或公网网速。规则、证据和发布记录见 [图片生命周期](MEDIA_LIFECYCLE.md)。

最新经用户确认，将普通信件照片改为长边最多 1600 像素、JPEG 编码质量 75%，目标约 500 KiB。此为驿书的速度与画质取舍，不是已验证的微信朋友圈或 Instagram 内部参数；500 KiB 为软目标，75% 不表示保留 75% 的视觉信息。服务器预览已发布并完成公网包核对，实际手机画质和速度仍待同图对照。

新增圆形进度后，用户又反馈“直接显示上传失败”。已复现并修复一个独立的前端兼容性回归：上传开始前调用了 Expo Go / React Native 的 AbortSignal polyfill 没有的 `throwIfAborted()`，TypeError 被通用错误提示误归类为网络不可用。修复已发布服务器预览，随后用户确认可上传成功。这不证明此前公网慢传已全面解决。

后续用户确认在 Wi-Fi 下可上传成功，描述当前等待不到 10 秒，但希望继续缩短等待。已移除普通 JPEG 预览的重复处理、原生上传不用的 JS multipart 构造及成功后的额外取消等待，并区分真实阶段。新版本实际手机耗时尚未对照测量，不能据此宣称网络吞吐已提升。

已修正公网 HTTPS 网关的协议宣告，但不能把它记为图片慢传已解决。用户复验仍反馈一张图片耗时接近一分钟。服务器内部对照表明，本次慢传主要发生在公网传输阶段；尚未定位到具体运营商、代理、客户端或网络设备。

控制台只读核对：实例 `i-bp103s2ngusptzyctu4r` 公网带宽峰值为 100 Mbps，按使用流量计费。该配置不是实际吞吐量保证，也不据此扩大带宽或购买服务。

## 实测

所有账号、图片均为经用户授权生成的临时诊断数据，不使用用户照片，不发送信件。公网请求来自 Mac 上的 Docker Node fetch，不代表 iPhone 原生上传通过。

| 场景                  | 图片大小    | 上传结果 | 上传耗时  | 预览读取耗时 |
| --------------------- | ----------- | -------- | --------- | ------------ |
| 网关修正前，公网      | 110 B       | 201      | 91 ms     | 166 ms       |
| 网关修正前，公网      | 4,925,269 B | 201      | 40,829 ms | 899 ms       |
| 网关修正后，公网      | 110 B       | 201      | 83 ms     | 169 ms       |
| 网关修正后，公网      | 4,925,269 B | 201      | 70,443 ms | 915 ms       |
| 服务器 API 容器内回环 | 110 B       | 201      | 60 ms     | 74 ms        |
| 服务器 API 容器内回环 | 4,925,269 B | 201      | 313 ms    | 369 ms       |

生成的大图为 1280 × 1280 随机 RGB PNG，约 4.7 MiB，旨在测量传输，不代表普通照片压缩率。同尺寸图的服务端 `inspectImage` 单次耗时 114 ms。样本有限，不是性能门禁，也不证明所有网络环境都有相同表现。

此前生产日志出现过图片 POST 201（约 52 秒）、中途断开及网关 502。不存在据此可以确认的“Caddy 默认 60 秒超时”；当前反向代理没有配置这类读写超时。

## 网关修正

- 原网关宣告 HTTP/3，但 Docker 未映射 UDP 443。
- `deploy/Caddyfile.cloud` 限定 `protocols h1 h2`，响应 `Alt-Svc: clear` 清除旧的协议缓存。
- 使用与生产相同的网关镜像验证候选配置通过；旧配置备份于 `/opt/yishu/deploy/Caddyfile.cloud.before-upload-fix-20261004`。
- 经用户授权，仅重启 `yishu-cloud-caddy-1`。API、Worker、PostgreSQL、Redis、服务器 Expo 预览的启动时间均未改变。
- 公网健康端点回读 HTTP/2 200、`Alt-Svc: clear`，约 0.14 秒。全部上述容器健康；仍仅公开 TCP 443，没有新增端口。
- `phase12-proxy.test.ts` 的 7 项测试通过，包括协议配置回归检查。

协议配置参考：[Caddy protocols](https://caddyserver.com/docs/caddyfile/options#protocols)、[RFC 7838 Alt-Svc clear](https://www.rfc-editor.org/rfc/rfc7838.html#section-3)。

## 诊断清理与后续

三轮诊断账号分别为 `ud2274f8ad16043b0b`、`udb9de08e8450badcb`、`ud22d1156c0fcdd9ca`，均已通过严格账号匹配和无信件检查后删除，各清理两张测试图片及登录会话。开发库、已有账号和信件未修改。

复用脚本为 `scripts/cloud-upload-diagnostic.mjs`，必须显式设置 `YISHU_UPLOAD_DIAGNOSTIC=1`。服务器内回环另需 `YISHU_UPLOAD_DIAGNOSTIC_LOCAL=1` 且必须是 production；运行后必须执行该脚本的 cleanup 模式，不能仅凭测试成功跳过清理。

用户已确认上传前默认压缩：静态图片长边最多 2048 像素，JPEG 质量 85%，不另存原图；头像最终仍按原裁切逻辑输出最多 1024 像素，质量改为 85%。具有潜在透明通道的 PNG / WebP / AVIF 保守输出 PNG，避免透明背景丢失，因此体积缩小程度不能保证；GIF 原样保留，避免丢失动画帧。10 MB 原文件限制、加密与内容权限不变。

本次前端补丁使用 `deploy/Dockerfile.cloud-preview-upload`，基于已有服务器预览镜像仅复制三个媒体源码文件，不修改业务后端。服务器预览更新需重建预览容器；上线后应先保存或发送当前草稿，再重新加载新预览进行真机测试。测试及实际发布结果另行记录，不能将模拟原生模块的单元测试记为真机压缩通过。

## 前端发布记录

- 移动端 27 个测试文件、240 项测试全部通过，TypeScript 检查通过。覆盖长边缩放、JPEG 质量、潜在透明通道、HEIC、原文件与生成文件大小限制、失败时资源释放、相册与文件选择入口、头像导出。
- 补丁上下文只包含 Dockerfile 和三个媒体源码文件，不包含环境文件、用户照片或凭据。上传包 SHA-256 为 `7844f1255deae7cee1db41b3d8e5266e8ad697e888cd04e90967b187da4051f6`，服务器校验通过；使用已有镜像在无网络构建模式下生成新镜像。
- 服务器镜像为 `yishu-cloud-preview:preview-20261004-upload`，ID `sha256:f4297e40d1901d28470be359adcbe276bf434c47415ee00a95aee41da6d38026`。三个源码文件的 SHA-256 与本机一致。服务器 `preview.env` 的旧版本备份为 `/opt/yishu-preview/preview.env.before-upload-20261004`。
- 预览容器健康，无宿主端口映射；公网隧道仍为 `https://eu9qlby-uyrvyi-8081.exp.direct`。API、Worker、Caddy、PostgreSQL、Redis 在此次前端发布中均未重启且健康。
- 加强的公网检查通过 `EXPO_PREVIEW_HTTP_PASS`：实际 iOS 开发 JS 包 11,494,881 字符，包含生产 API 地址、`prepareUploadImage`、`MAX_UPLOAD_EDGE` 与 `UPLOAD_JPEG_QUALITY`；签名和证书链均提供。实际 iPhone 压缩、上传耗时仍待用户复验。APK 未重打包。

原生处理 API 参考：[Expo SDK 57 ImageManipulator](https://docs.expo.dev/versions/v57.0.0/sdk/imagemanipulator/)。PNG 编码为无损格式，85% 参数不能被当作 PNG 的体积缩减保证。

## 每图上传进度（2026-10-04）

用户复验上传仍慢，要求每张图片显示圆形进度。在进一步压缩的确认问题中，用户选择“保持当前画质，只加进度条”，因此本轮不降低原有 2048 像素 / JPEG 85% 参数，不调整透明图片或 GIF 策略。

选图后先显示待上传缩略图，每张独立标记等待、上传进度、处理中或失败。字节回调来自 `expo-file-system/legacy` 的 `createUploadTask`，不使用定时器虚构百分比；传输完成但尚未收到成功响应时显示处理中，未知总量显示不定进度。这个上传 API 随当前 Expo SDK 57 的 Expo Go 提供，不引入新原生依赖。参考：[Expo FileSystem legacy](https://docs.expo.dev/versions/v57.0.0/sdk/filesystem-legacy/)。

进度上传仍经共享认证包装器，保留 401 单次续期、会话代际检查与 120 秒取消。普通请求和头像现有无进度调用仍走原 fetch 路径。多图顺序传输；一张失败继续处理其他图片，成功项保留，失败项可点缩略图重试或确认移除。有未上传图片时禁止寄出，不将本地临时 ID 发给服务器。

28 个移动端测试文件、253 项测试及类型检查通过；结构测试和原生模块模拟测试不代替真机进度与耗时验收。发布仅更新服务器预览，APK 与业务后端不在此次更新范围。

已发布服务器镜像 `yishu-cloud-preview:preview-20261004-progress`，ID `sha256:67623ddede031b0dc17819be8d1ef2611696897ef92655e2694aba02c4162a92`。只传输五个进度相关源码文件及补丁 Dockerfile，不复制环境文件或凭据。上传包 SHA-256 `654073ef5d0d17a09ab5c7836b6530c45c59275627501adec2598381a35d2cb8` 经服务器校验；五个文件源码哈希逐项一致，原压缩模块哈希未变。旧预览配置备份于 `/opt/yishu-preview/preview.env.before-progress-20261004`。

预览健康、无宿主端口映射，隧道仍为 `https://eu9qlby-uyrvyi-8081.exp.direct`。API、Worker、Caddy、PostgreSQL、Redis 启动时间不变且健康，公网 API 健康 200。加强的公网检查通过 `EXPO_PREVIEW_HTTP_PASS`：实际 iOS JS 包 11,506,518 字符，包含原压缩模块、圆形进度组件及原生上传字节回调，清单签名、证书链和开发模式正常。冷启动首次 Metro 编译约 112 秒，后续编译 250 ms；这是前端预览编译，不是图片业务上传耗时。真机进度和速度仍待用户反馈，不宣称慢传已解决。

## 上传立即失败的兼容性修复（2026-10-04）

- 当前 React Native 0.86.3 的 `Libraries/Core/setUpXHR.js` 使用 `abort-controller@3.0.0`。实际实例的 `signal.throwIfAborted` 为 undefined；Expo 的 AbortSignal 补丁提供静态 timeout / any，但未补齐这个实例方法。直接调用复现 `TypeError: s.throwIfAborted is not a function`。
- `imageUploadFetch.ts` 原有两次方法调用均发生在创建原生上传任务之前，因此可能根本没有 POST 到服务器。已用 `assertImageUploadNotAborted` 读取 `aborted`，保留存在的 reason，旧运行库无 reason 时提供取消错误；真实进度、认证续期、会话隔离及取消逻辑保持原有行为。
- 回归测试从当前已安装 React Native 的真实依赖路径加载 AbortController，覆盖正常上传、已取消及上传中取消。三项新测试在修复前全部失败，修复后 28 个文件、256 项移动端测试通过；TypeScript、Prettier、`git diff --check` 通过。原生文件上传模块仍为测试 mock，不将此记录为手机端上传成功。
- 仅部署服务器 Expo Go 预览：镜像 `yishu-cloud-preview:preview-20261004-upload-fix`，ID `sha256:5c8a1d292bce805afe56ce90a0362621c28c13b18f8f76842e1fa8e6e9f9fea3`。补丁上下文仅包含一个上传源码和 Dockerfile / allowlist，包 SHA-256 `3c0ed084144bf2f8e81da6ae58fbb3c1c5dbafde8682d6caa21b58d2d80897d0` 经服务器核验，使用已有镜像无网络构建。配置备份 `/opt/yishu-preview/preview.env.before-upload-compat-20261004`。
- 上传源码 SHA-256 `47720d779ed6524998247ef541c5cd6b22a970d8df331268e68b865feae2faba` 本机与服务器一致；压缩模块仍为 `c88e83c4547139ec9a74736c6b25f6fa66c472a1df920d18ea55387546b3f052`。保留 JPEG 85% / 2048 像素及透明 / GIF 策略，不增加压缩，不修改数据库、端口或后端。
- 预览健康、隧道地址不变；业务容器均健康且启动时间不变，API 公网健康 HTTP 200。真机上传和耗时仍需复验，Reload 前先妥善保留未发送草稿；APK 没有重新打包。
- 公网检查 `scripts/check-expo-preview.mjs ... --upload-optimized --upload-progress --native-abort-compatible` 通过 `EXPO_PREVIEW_HTTP_PASS`：实际 iOS JS 包 11,506,749 字符，包含兼容性补丁且上传实现不再调用不支持的方法，保留压缩 / 圆形进度、生产 API、清单签名和证书链，开发模式正常。首次请求因冷启动编译 119 秒断开，编译完成后第二次检查通过；不将预览编译时间计为图片上传耗时。

## 上传流程优化（2026-10-04）

- 用户确认 Wi-Fi 下可上传成功，希望优化 0% 和传输结束后的等待；沿用“保持画质”的约束，不增加压缩，不调整 GIF / 潜在透明图片策略。
- `prepareDraftPreview` 对 picker 已生成的 JPEG 直接调用缓存文件的异步 `base64()`，保留独立 data URI，避免重新解码、缩放和 JPEG 编码。正文仍上传同一份 2048 像素 / 85% JPEG 文件；非 JPEG 预览保持原有渲染路径。预览失败仍不能寄出空白图片。
- 原生进度请求直接传文件元数据，不再构造不会使用的 JS FormData；没有进度回调的请求和头像仍使用原来的 Expo File multipart。认证续期、会话隔离、120 秒取消及 HTTPS 验证均保留。
- 已安装的 legacy `UploadTask.uploadAsync()` 正常完成会自行移除进度订阅。因此成功时不再额外调用 / 等待 cancelAsync；失败和取消时仅清理一次，清理 Promise 不阻塞结果，晚到字节回调仍被 settled / aborted 检查屏蔽。不将这一冗余调用认定为此前数秒等待的已证明根因。
- 圆形进度区分准备中、连接中、上传中和等待确认。收到真实字节前不显示卡住的 0%，字节计数到总量但响应未成功时不显示 100% 完成；继续等待服务端成功后才加入可寄出的图片。不使用定时器或假百分比掩盖等待。
- 28 个文件、263 项移动端测试及 TypeScript / Prettier / `git diff --check` 通过。覆盖复用 JPEG、空预览、非 JPEG 回退、原生上传无 JS multipart、成功路径不取消、挂起的失败清理不阻塞错误及准备 / 连接 / 等待确认状态。原生模块测试 mock 不代替真机速度验证。
- 仅部署服务器预览镜像 `yishu-cloud-preview:preview-20261004-upload-flow`，ID `sha256:ab3ba2ecf26214ef309f4b0a6fe1a490bfa88d95693eaf0e9594cf11fef00a54`。基于已核对 ID 的 upload-fix 镜像，以 allowlist 传输五个前端文件，包 SHA-256 `3e64a7add2a97357c3516cd14d6061f3b63390c16f040a7a17db830e79c16913` 经服务器校验，在无网络构建模式下构建。配置备份 `/opt/yishu-preview/preview.env.before-upload-flow-20261004`。
- 五个源码 SHA-256 与本机逐项一致，原压缩模块哈希不变。预览健康、无宿主端口映射；业务容器均健康且未重启。不修改数据库、媒体文件或网络配置，APK 未重打包。手机复测前须妥善保留未发送草稿，再 Reload。
- 先从服务器本地预热 iOS Bundle，然后公网检查 `--upload-optimized --upload-progress --native-abort-compatible --upload-flow` 通过 `EXPO_PREVIEW_HTTP_PASS`。公网实际 JS 包 11,507,687 字符，快速 JPEG 分支 / 真实进度 / 新阶段提示 / 兼容性补丁均存在，生产 API、清单签名、证书链、开发模式正常；API 公网健康 200。用户尚未复测新版本，不宣称已达到某个上传耗时或速度提升比例。

## 加强照片压缩与准备流水线（2026-10-04）

- 用户随后明确同意 1600 像素 / JPEG 75% / 约 500 KB 策略，替代此前仅加进度条、保留画质的约束。普通静态信件照片首次长边不超过 1600 像素、质量 0.75；超过 500 KiB 时按体积估算继续等比缩小，最多编码三次，缩小下限为长边 960 像素，不放大小图。到达下限或尝试上限后可高于目标，仍必须满足 10 MiB 上传限制。
- 每次编码从解码源生成，不把已保存的有损 JPEG 作为下一次编码源。原文件 10 MiB 限制不变；PNG / 潜在透明 WebP / AVIF 保留 PNG 和原 2048 像素策略，GIF 原样保留。头像源仍为 2048 像素 / 85%，裁切输出仍最多 1024 像素 / 85%；不额外保存服务器原图，加密与正文可见性权限不变。
- 选图校验后即加入准备状态；只提前准备下一张，重叠当前图片的网络上传，不无限并发压缩或并发 POST。图片顺序、逐图真实进度和失败项保留不变；重试复用已压缩文件和已生成预览。压缩成功但缩略图失败时只重做预览；认证失效后不继续发后续上传请求。
- 28 个文件、277 项移动端测试及 TypeScript 检查通过。覆盖多次压缩、尺寸与尝试上限、透明格式与头像隔离、缓存清理失败、准备与上传重叠、准备失败、会话失效和重试复用。测试模拟原生模块，不替代手机耗时或画质验收。
- 仅发布服务器预览 `yishu-cloud-preview:preview-20261004-smaller-photos`，镜像 ID `sha256:ad7f59717e27b3cea4b9f3c1f059c848da8d5edb36b5801fbe57876cbfcac7c9`。基于已核对 ID 的 upload-flow 镜像，通过 allowlist 复制五个前端源码文件；上下文 SHA-256 `0e79186880458f0181af889f325f3e51df435672bd5ce199e43b84cb341c5876` 经服务器校验，无网络构建，源码哈希逐项一致。配置备份 `/opt/yishu-preview/preview.env.before-smaller-photos-20261004`。
- 预览健康、无宿主端口映射；API / Worker / Caddy / PostgreSQL / Redis 均健康且启动时间不变，公网 API 健康 200。未修改后端、数据库、端口或凭据，APK 未重打包。
- 本地预热完成后，公网检查加上 `--smaller-photos` 通过 `EXPO_PREVIEW_HTTP_PASS`，实际 iOS JS 包 11,510,964 字符，核对 1600 / 0.75 数值、体积目标和流水线源码，原上传优化 / 真实进度 / AbortSignal 兼容性均保留。SDK 57、生产 API、清单签名、证书链及开发模式正常；手机账号与新版速度、清晰度仍待真机复验。先妥善保留未发送草稿，再 Reload。
