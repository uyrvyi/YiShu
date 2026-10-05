# UI 与运输预估更新

日期：2026-09-30。开发环境更新，不代表 Phase 12 生产发布或新增 Final Gate。

## 已确认的需求调整

- 负责人取消旧版禁止 ETA 的规则，允许写信时比较四种运输方式的参考寄送时长。
- 运输中“在路上 / 预计还有多久到下一站”仅向寄件人展示。
- 收件人仍只能看到已发生、已确认的事实，不展示未来路线或下一站预估。
- 使用 iOS 风格大圆角；底栏悬浮并接入原生 Liquid Glass，寄信保持中央加号按钮。

历史阶段报告保留原验收口径，不回写为已通过本次新增功能的真机验证。

## 运输预估

`POST /api/v1/transport-estimates` 需要登录。以已确认收件人的 UID 或账号，以及当前双方地区为输入，按现有图版本、四种运输规则计算，包含 6 小时末端派送。无法建立陆路时省略对应方式。该接口不创建信件、Journey 或 WorldEvent。

`GET /api/v1/letters/:trackingNo/estimate` 仅寄件人可访问；收件人、第三方均返回 404。返回 `state`、`remainingSeconds`、`asOf`，不暴露站点内部 ID、异常或种子。

下一站参考预估只使用已可见的最新出发事实、冻结的计划路段时长与 SimulationClock；不读取隐藏异常、WorldEvent payload 或实际路段状态。不把参考时间写入 Timeline。无出发事实、延误、失联、终态或超过参考时长时显示预估不可用，不宣告到站。

## 地图与界面

- 在线百度地图在 WebView 容器尺寸确定后取景，利用 SDK 投影与浮点缩放，让路线填满可用范围，同时避开预估提示、缩放按钮与底部地图信息。
- 站点标记随缩放保持稳定像素大小；容器尺寸变化重新取景。手势缩放不触发取景。地图快照轮询变化仍会重载 WebView，这是现有实现的限制。
- 离线仍沿用固定全国底图兜底，不声称与在线地图具有相同紧凑取景或可缩放能力。
- 依据负责人的真机反馈进一步扩大圆角：卡片与地图 28，输入与主按钮 26，分段控件内层 22；底栏维持 72 高的悬浮胶囊。具体数值是应用设计选择，不是 Apple 文档规定的通用尺寸。设置页按最新确认改为“账号信息”“设置”两个大圆角卡片，组内使用缩进细分隔线，保留长地区信息。退出登录为独立圆角按钮。
- 原生材质使用 `expo-glass-effect`，运行时同时检查系统 API 与应用支持性。支持的 iOS 26+ 使用原生 Liquid Glass；不支持的 iOS 使用 `expo-blur`；其他平台或系统“降低透明度”开启时使用实色。
- 底栏玻璃层不使用 opacity 动画；按钮使用局部背景或缩放反馈。
- 原生玻璃改为与导航内容分离的底层，等待容器布局后使用明确宽高挂载；容器禁止视图折叠。查件与我的切换取消 Stack 转场，减少原生层在不可见转场期间初始化的问题。开发态“我的 → 底栏材质诊断”显示设备版本、原生 API、应用支持性、透明度偏好和所选择材质；这不是视觉成功检测。
- `UIDesignRequiresCompatibility: false` 只对本项目后续原生构建生效，不会修改 Expo Go 的编译配置。负责人使用 iOS 27 / Expo Go、降低透明度关闭，已对修复后的静态底栏材质回复“可以了”。此反馈不覆盖后续新增的拖动交互。
- 底栏选择胶囊支持横向拖动，拖动时使用原生 clear 玻璃、松手后切换为普通磨砂；弹簧吸附至查件或我的。纵向移动、取消手势及中央写信按钮不触发拖动导航。手势为应用自定义 PanResponder，吸附使用原生驱动 Animated，不声称是系统 UITabBar 或完全复刻其物理效果。
- 百度 SDK 等待从 12 秒调整为 30 秒，重复公开坐标去重后转换；加载期间有状态提示，失败后明确标记离线地图并提供重试。真实 Safari SDK 已显示上海至北京路线，390×312 容器取景及缩放按钮已实测。延长超时不是本次真机故障的修复依据，见下节。

## 百度地图尺寸故障修复

2026-09-30，负责人重新加载后反馈具体错误为“地图尺寸无效”。安装的 `react-native-webview` 13.16.1 在 iOS 上有外层容器和内部原生 WebView；之前只定位内部层，外层默认 `flex: 1` 在滚动页面中可能塌缩。SDK 的有限布局重试最终读取零尺寸并回退离线地图。

- 等待父容器 `onLayout` 返回有效宽高，再挂载 WebView；外层 `containerStyle` 和内层 `style` 同时传入明确宽高，取消外层弹性伸缩并禁止父视图折叠。
- 加载期间不再隐藏 WebView，保持底图实际可见；原有进度提示仍覆盖于地图上方。
- SDK 改用官方异步 callback 加载；取景完成且收到 `firsttileloaded` 或 `tilesloaded` 后才发出 `ready`，避免仅脚本执行成功就隐藏提示。
- 回退显示白名单原因，包括 SDK 加载、坐标转换、地图尺寸、底图等待及网页进程中断，不向界面输出 AK、请求地址或原始异常。

验证：移动端 165 项测试、类型检查、lint、仓库格式检查及 iOS Expo 导出通过。新增测试覆盖布局前不挂载、两层明确尺寸、加载期间不隐藏、错误回退、异步 callback 和底图事件就绪。真实 Safari 在 390×312 尺寸下显示百度底图及路线，桥接状态为 `ready`。iPhone 镜像中已观察到底图和路线恢复；修正加载完成事件名后，负责人在 Expo Go 重新加载并复验百度底图出现、加载提示自动消失、双指缩放与拖动，回复“全部正常了”。本次地图修复真机复验 PASS，依据为负责人实测反馈；不扩展为其他功能或 Phase 12 Final Gate PASS。

## 验证边界

自动化测试验证页面结构、交互语义、回退策略、数学取景边界及 API 权限。SDK 替身测试不等同于真实百度 SDK 的视觉验收；iOS 导出成功也不等同于 iPhone 上原生材质、触控和透明度设置的实测。

真机仍需检查：底栏悬浮与玻璃观感、滚动到末项无遮挡、中央加号寄信、降低透明度回退、四种寄送介绍及参考时长、在线地图首次取景与手势、断网兜底、收件人无未来路线与预估。

本轮移动端自动化测试已通过，包括分组卡片、拖动取消与加号保护、材质切换、坐标去重、加载超时及离线重试。百度地图尺寸修复已获负责人 iPhone 复验通过；新底栏拖动效果仍待负责人复验。

## SDK 独立诊断

只使用公开城市样例，不读取用户信件。临时服务器端口为 `127.0.0.1:8090`，`/?mobile` 为 390×312 尺寸。调试完停止临时容器，不影响 8081 Expo 与 4000 API：

```sh
docker compose run -d --rm --no-deps --name yishu-map-check -p 127.0.0.1:8090:8090 -w /workspace/apps/api dev pnpm exec tsx /workspace/scripts/preview-baidu-map.ts
docker stop yishu-map-check
```

官方依据：[Expo GlassEffect](https://docs.expo.dev/versions/latest/sdk/glass-effect/)、[百度地图状态](https://lbs.baidu.com/docs/jsapi?title=jsapi4/guide/map/state)、[百度 JSAPI 异步加载](https://lbs.baidu.com/docs/jsapi?title=jsapi4/guide/concepts/load)。

设计依据：[Apple 材质指南](https://developer.apple.com/design/human-interface-guidelines/materials)、[Apple 新设计适配](https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass)、[Apple 列表与表格](https://developer.apple.com/design/human-interface-guidelines/lists-and-tables)。内容层保持实色，不给全部设置卡片叠加玻璃材质。
