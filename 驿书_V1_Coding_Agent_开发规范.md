# 驿书 V1（MVP）Coding Agent 开发规范

> 本文档是 **驿书 V1 的唯一开发基线**。  
> Coding Agent 必须严格按本文档实现，不自行增加未定义功能，不自行替换技术栈。

---

# 1. 项目定义

驿书是一款“现代世界 + 古代通信方式”的点对点通信 App。

世界仍然使用：

- 现代日期和时间
- 现代中国行政区划
- 现代城市和真实地理距离
- 现代手机 App

但消息通过古代方式传递：

- 托人捎信
- 驿马
- 加急驿递
- 飞鸽传书

用户发送一封纯文字信件后，信件会在中国地图上独立旅行。发送者与接收者都可以追踪运输状态，但无法干预已经发出的信件。

---

# 2. 核心业务原则

V1 必须满足：

1. 没有好友系统
2. 没有聊天会话
3. 没有群聊
4. 没有关注 / 粉丝
5. 没有在线状态
6. 没有已读回执
7. 没有撤回
8. 没有加速
9. 用户不能主动改路线
10. 用户不能主动改运输方式
11. 用户不能主动重新派送
12. 每封信都是独立实体
13. 同一用户之间可同时存在多封在途信
14. 后发出的信允许先到
15. Sender 与 Recipient 看到相同运输 Timeline
16. Recipient 在 DELIVERED 前看不到正文
17. Sender 永远不知道 Recipient 是否拆阅
18. 用户只能看到“可确认的事实”，不能直接看到后台上帝状态
19. 地图只显示大概位置
20. 随机事件使用固定概率
21. 不实现疲劳值、健康值、治安值等复杂属性
22. 地图完全本地静态，不接外部地图服务
23. 路线在本地 Graph 上动态寻路
24. 不显示预计送达时间和倒计时
25. 信件允许极低概率永久失败
26. 绝大多数信最终应能送达

---

# 3. V1 功能范围

## 3.1 必做

- 账号密码注册
- 账号密码登录
- 昵称
- 8 位短 UID
- 首次收发区域设置
- 按账号或 UID 搜索收件人
- 点对点发信
- 纯文字正文
- 选择运输方式
- Journey
- TransportLeg
- 本地 Graph 动态寻路
- 固定概率随机事件
- WorldEvent
- TimelineEvent
- 中国地图追踪
- 已走路线实线
- 未走路线虚线
- 当前大概位置
- 掉落范围
- 遗失最后确报
- 已发生事实节点
- 双方同步运输状态
- DELIVERED 后 Recipient 解锁正文
- Recipient 独有 UNOPENED / OPENED
- 拉黑
- 终态信件隐藏
- Demo 加速模式
- 固定 Seed 可复现模拟

## 3.2 明确不做

- 好友
- 好友申请
- 群聊
- 即时聊天
- 评论
- 点赞
- 表情回应
- 朋友圈
- 图片
- 视频
- 音频
- 文件
- 附件
- Markdown 富文本
- 信件内容损坏模拟
- 疲劳值
- 健康值
- NPC 成长
- 马匹属性
- 鸽子养成
- 动态天气 API
- 动态治安
- 复杂 AI
- 外部地图 API
- 在线地图瓦片
- ETA
- 剩余时间
- 已读回执
- 用户拒收
- 发送限流业务
- 匿名信
- 第三方登录
- 手机验证码登录
- WebSocket
- Kubernetes

---

# 4. 用户身份体系

## 4.1 Internal ID

数据库内部主键：

```text
BIGINT 自增
```

示例：

```text
184721
```

规则：

- 仅数据库内部使用
- 不展示
- 不用于搜索
- 不用于分享

## 4.2 UID

对外短 UID：

```text
8 位随机纯数字
```

示例：

```text
52739184
```

规则：

- 第一位不能为 0
- 注册时随机生成
- 全局唯一
- 永久绑定用户
- 不可修改
- 不可重置
- 可用于搜索
- 不使用连续自增
- 碰撞则重新生成

## 4.3 Account

账号用于：

- 登录
- 对外展示
- 搜索收件人
- 通知显示

规则：

```text
4~24 字符
```

仅允许：

```text
a-z
0-9
_
```

保存前统一转小写。

必须全局唯一。

## 4.4 Nickname

```text
1~20 Unicode 字符
```

规则：

- 可重复
- 可修改
- 不是唯一身份
- 历史信件保存寄出时昵称快照

## 4.5 Password

```text
8~72 字符
```

服务端使用：

```text
Argon2id
```

禁止明文保存。

---

# 5. 注册与登录

注册接口：

```http
POST /api/v1/auth/register
```

Body：

```json
{
  "account": "xiangshen",
  "password": "example-password",
  "nickname": "香神",
  "province": "上海市",
  "city": "上海市",
  "district": "徐汇区"
}
```

登录：

```http
POST /api/v1/auth/login
```

Body：

```json
{
  "account": "xiangshen",
  "password": "example-password"
}
```

登录态：

```text
Access Token + Refresh Token
```

Access Token：

```text
JWT，15 分钟
```

Refresh Token：

```text
随机 opaque token，30 天
```

数据库只保存 Refresh Token Hash。

移动端 Refresh Token 存入：

```text
expo-secure-store
```

---

# 6. 首次收发区域

首次进入：

```text
请求定位权限
↓
GPS 获取经纬度
↓
本地行政区边界 Point-in-Polygon
↓
得到省 / 市 / 区县
↓
用户确认
```

如果用户拒绝定位、定位失败或匹配失败：

```text
手动选择省 / 市 / 区县
```

用户最终必须确认一个默认收发区域。

V1 确认后：

```text
不允许修改
```

发件起点：

```text
Sender.defaultRegion
```

收件终点：

```text
Recipient.defaultRegion
```

---

# 7. 用户搜索

支持：

```text
account
或
8 位 UID
```

接口：

```http
GET /api/v1/users/search?q=52739184
```

或：

```http
GET /api/v1/users/search?q=xiangshen
```

返回：

```json
{
  "account": "xiangshen",
  "uid": "52739184",
  "nickname": "香神",
  "region": {
    "province": "上海市",
    "city": "上海市",
    "district": "徐汇区"
  }
}
```

不得返回 Internal ID、密码哈希、精确 GPS 等私有字段。

---

# 8. 发信

V1 仅支持纯文字。

最大正文：

```text
2000 Unicode 字符
```

发信流程：

```text
输入 account / UID
↓
搜索
↓
展示 nickname + account + UID + 收件区域
↓
确认收件人
↓
输入正文
↓
选择运输方式
↓
确认寄出
↓
创建 Letter
↓
创建 Journey
↓
通知 Recipient
```

发送后：

- 不能撤回
- 不能修改
- 不能取消
- 不能改路线
- 不能改运输方式
- 不能加速
- 不能重派

Recipient：

```text
不能拒收
不能退回
```

---

# 9. 收件人提前可见信息

信件创建后立即通知：

```text
xiangshen 给你送了一封信
```

Recipient 在送达前可以看到：

- Sender nickname
- Sender account
- Sender UID
- 起点区县
- 发出时间
- 当前运输方式
- 当前运输状态
- 地图
- Timeline

不得看到：

- 正文
- 字数
- 标题
- 内容预览

---

# 10. 拉黑

拉黑后：

```text
被拉黑用户不能再创建新的信件
```

但：

```text
拉黑前已创建的在途信继续运输
```

不得取消、退回或销毁旧 Journey。

---

# 11. Letter 身份快照

Letter 创建时保存：

```text
senderAccountSnapshot
senderUidSnapshot
senderNicknameSnapshot

recipientAccountSnapshot
recipientUidSnapshot
recipientNicknameSnapshot
```

用户之后改昵称不影响历史信件展示。

---

# 12. Tracking Number

数据库内部 Letter ID 可使用 BIGINT。

对外显示独立 Tracking Number：

```text
YS-20260821-K7P2M8
```

禁止使用纯自增展示编号。

---

# 13. 运输方式

## 13.1 托人捎信

```text
HAND_CARRY
35 km/day
```

## 13.2 驿马

```text
HORSE_RELAY
120 km/day
```

## 13.3 加急驿递

```text
EXPRESS_RELAY
300 km/day
```

## 13.4 飞鸽传书

```text
PIGEON
60 km/h
每天最多模拟飞行 8 小时
```

约：

```text
480 km/day
```

V1 允许支持区域之间点对点飞鸽。

不实现真实归巢鸽限制。

飞鸽不走普通陆路 Graph。

---

# 14. 地图总原则

V1 地图：

```text
完全本地
```

禁止：

- 高德
- 百度
- 腾讯地图
- Google Maps
- Apple Maps
- Mapbox
- 在线瓦片
- 在线路线 API
- 在线逆地理编码

GPS 仅用于首次定位，不等于地图服务。

---

# 15. 地图数据

```text
data/
├─ maps/
│  ├─ china-map.svg
│  └─ china-districts.json
├─ station_nodes.json
└─ route_edges.json
```

地图运行时不依赖互联网。

---

# 16. 地图坐标

StationNode 保存：

```text
lat
lng
mapX
mapY
```

示例：

```json
{
  "id": "CN-SH-XUHUI",
  "province": "上海市",
  "city": "上海市",
  "district": "徐汇区",
  "name": "徐汇驿站",
  "lat": 31.18,
  "lng": 121.43,
  "mapX": 812.4,
  "mapY": 531.8
}
```

移动端地图优先使用：

```text
mapX / mapY
```

---

# 17. 地图渲染

使用：

```text
react-native-svg
```

中国地图：

```text
viewBox="0 0 1000 800"
```

组件结构：

```text
RouteMap
├─ ChinaOutlineLayer
├─ ProvinceBoundaryLayer
├─ CompletedRouteLayer
├─ RemainingRouteLayer
├─ ApproximatePositionLayer
├─ DropAreaLayer
├─ LastKnownPositionLayer
└─ FactNodeLayer
```

---

# 18. 地图视觉规则

已走路线：

```text
实线
```

未走路线：

```text
虚线
```

正常运输：

```text
起点
━━ 已走路线
◉ 当前大概位置
- - 未走路线
终点
```

当前大概位置不得展示精确 GPS 点。

---

# 19. 信件掉落

状态：

```text
LETTER_DROPPED
```

地图显示：

```text
半透明圆形范围
```

用户端不返回精确掉落坐标。

范围半径：

```text
10~40 km
```

双方看到相同范围。

---

# 20. 信件遗失

状态：

```text
LETTER_MISSING
```

地图：

- 不再显示当前推测位置
- 已走实线停在最后确报
- 只显示最后确报位置
- 未走路线仍可保留虚线
- 7 个模拟日未恢复后转 PERMANENTLY_LOST

---

# 21. 既定事实节点

所有用户可见既定事实永久进入 Timeline。

地图默认最多显示最近 5 个重要事实。

优先级：

1. 运输方式改变
2. 信件掉落
3. 信件被找回
4. 信使失联
5. 到达重要驿站
6. 普通经过驿站

点击节点仅显示事件详情，不提供任何操作。

---

# 22. 驿站 Graph

V1 目标：

```text
约 150~250 个主要驿站节点
```

优先覆盖：

- 直辖市
- 省会
- 主要地级市
- 核心交通连接节点

---

# 23. RouteEdge

```json
{
  "from": "CN-SH-XUHUI",
  "to": "CN-SH-JIADING",
  "distanceKm": 32.5,
  "enabled": true,
  "allowedTransport": [
    "HAND_CARRY",
    "HORSE_RELAY",
    "EXPRESS_RELAY"
  ]
}
```

---

# 24. 动态寻路

使用：

```text
Dijkstra
```

唯一权重：

```text
distanceKm
```

不使用：

- 天气权重
- 治安权重
- 疲劳
- 拥堵
- NPC 属性

---

# 25. 重新寻路

随机事件可临时禁用当前 Edge：

```text
当前节点
↓
禁用 Edge
↓
重新 Dijkstra
↓
得到新的 remainingPath
```

必须保证：

```text
completedPath 永远不可修改
```

已经发生的 TimelineEvent 也不可改写。

---

# 26. 飞鸽路线

飞鸽：

```text
当前节点 → 目标节点
```

直接 Point-to-Point。

地图使用平滑弧线。

途中可发生：

- 偏航
- 临时停留
- 迷路
- 失联
- 掉落
- 严重事故

---

# 27. 随机事件总原则

所有概率写入配置文件。

禁止在业务代码里散落魔法数字。

每完成一个：

```text
TransportLeg
```

进行一次一级事件判定。

不按分钟 / 小时持续抽奖。

---

# 28. 托人捎信概率

```text
正常          84.0%
延误           5.0%
改变路线       4.0%
迷路           2.0%
遭遇抢劫       2.0%
信使失联       1.5%
信件掉落       1.0%
严重事故       0.5%
```

---

# 29. 驿马概率

```text
正常          94.0%
延误           2.0%
临时改道       1.0%
信使失联       0.8%
遭遇抢劫       0.8%
信件掉落       0.3%
严重事故       0.1%
其他普通异常   1.0%
```

---

# 30. 加急驿递概率

```text
正常          96.0%
延误           1.5%
改道           0.8%
信使失联       0.5%
遭遇抢劫       0.5%
信件掉落       0.2%
严重事故       0.1%
其他           0.4%
```

---

# 31. 飞鸽概率

```text
正常          92.0%
偏航           3.0%
临时停留       2.0%
迷路           1.5%
信件掉落       0.5%
飞鸽失联       0.7%
严重事故       0.3%
```

---

# 32. 抢劫二级分支

```text
55% 信使逃脱，仅延误
25% 信使受伤，继续运输
15% 信使失联 + 信件掉落
5%  信使死亡 + 信件掉落
```

---

# 33. 掉落后拾获

```text
24 小时内      50%
1~3 天         25%
3~7 天         15%
7 天未找回     10%
```

7 个模拟日仍未恢复：

```text
PERMANENTLY_LOST
```

---

# 34. 拾获后处理

```text
70% 送往最近驿站
20% 拾获者继续捎带
10% 暂时搁置
```

---

# 35. 自动改变运输方式

用户只能选择初始运输方式。

之后系统可自动变化。

例如：

```text
托人捎信
↓
信件掉落
↓
被路人拾获
↓
进入驿站
↓
改为飞鸽传书
```

双方同步：

```text
寄送方式已变更
驿马 → 飞鸽传书
```

没有用户操作按钮。

---

# 36. 永久失败

整体设计目标：

```text
驿马        ~0.2%
加急驿递    ~0.1%
飞鸽        ~0.5%
托人捎信    ~0.8%
```

这是最终结果目标，不代表单次事件直接使用该概率。

---

# 37. LetterStatus

```ts
type LetterStatus =
  | "CREATED"
  | "DISPATCHED"
  | "IN_TRANSIT"
  | "AT_STATION"
  | "TRANSFER"
  | "DELAYED"
  | "COURIER_MISSING"
  | "LETTER_DROPPED"
  | "LETTER_MISSING"
  | "RECOVERED"
  | "TRANSPORT_CHANGED"
  | "OUT_FOR_DELIVERY"
  | "DELIVERED"
  | "PERMANENTLY_LOST"
  | "DESTROYED";
```

最终终态仅：

```text
DELIVERED
PERMANENTLY_LOST
DESTROYED
```

---

# 38. 不做正文损坏

V1 不实现：

- 部分缺字
- 落水模糊
- 烧毁一半
- 部分可读

正文只有：

```text
完整送达
或
永远无法送达
```

---

# 39. WorldEvent 与 TimelineEvent

必须分离。

## WorldEvent

仅服务器知道。

例如：

```text
信使死亡
信件实际掉落
```

## TimelineEvent

Sender / Recipient 可见。

例如：

```text
信使失联
信件已被拾获
寄送方式已变更
```

---

# 40. 上帝视角规则

WorldEvent 不自动等于 TimelineEvent。

例如：

真实后台：

```text
信使已死亡
```

用户可能只能先看到：

```text
信使失联
```

直到死亡信息被确认后，才产生新的可见事实。

---

# 41. 双方状态同步

所有用户可见既定事实：

```text
Sender / Recipient 完全同步
```

唯一例外：

```text
RecipientReadState
```

---

# 42. 阅读状态

Recipient：

```text
UNOPENED
OPENED
```

Sender 的接口响应中：

```text
完全不存在 readState 字段
```

禁止用 null 替代。

---

# 43. Delivered

到达目标驿站：

```text
不等于 Delivered
```

流程：

```text
目标驿站
↓
OUT_FOR_DELIVERY
↓
进入 Recipient 收件账户
↓
DELIVERED
```

---

# 44. Delivered 后

Sender：

```text
只看到 Delivered
```

Recipient：

```text
待拆阅
```

Recipient 点击拆信：

```text
OPENED
```

Sender 永远不知道。

---

# 45. 不显示 ETA

V1 禁止：

- 预计送达时间
- 剩余小时
- 剩余天数
- 到达倒计时

---

# 46. 历史信件

在途：

```text
不能删除
不能隐藏
```

终态：

```text
DELIVERED
PERMANENTLY_LOST
DESTROYED
```

允许用户：

```text
从自己的列表中隐藏
```

这是软隐藏。

双方隐藏互不影响。

服务端不物理删除。

---

# 47. 正文保存

正文长期保存。

不做：

- 阅后即焚
- 自动过期
- 到期删除

---

# 48. 正文安全

正文使用：

```text
AES-256-GCM
```

应用层加密后入 PostgreSQL。

保存：

```text
ciphertext
iv
authTag
```

服务器密钥来自环境 Secret。

这不是端到端加密。

---

# 49. 正文权限

Recipient 且：

```text
status != DELIVERED
```

API 必须：

```json
{
  "content": null
}
```

不得提前下发正文再靠 UI 隐藏。

Sender 始终可查看自己发送的正文。

---

# 50. 最终技术栈

## Mobile

```text
React Native
Expo SDK 57
React Native 0.86
TypeScript strict
Expo Router
TanStack Query
Zustand
React Hook Form
Zod
react-native-svg
react-native-gesture-handler
react-native-reanimated
expo-location
expo-notifications
expo-secure-store
AsyncStorage
```

## Server

```text
Node.js 24 LTS
TypeScript
Fastify 5
Zod
Pino
```

## Database

```text
PostgreSQL 17
Prisma 7
```

## Worker

```text
Redis
BullMQ
```

## Test

```text
Vitest
React Native Testing Library
```

## Package Manager

```text
pnpm
```

---

# 51. Monorepo

使用：

```text
pnpm workspace
```

不使用 Turborepo。

目录：

```text
yishu/
├─ apps/
│  ├─ mobile/
│  ├─ api/
│  └─ worker/
├─ packages/
│  ├─ shared/
│  ├─ simulation/
│  ├─ routing/
│  └─ config/
├─ data/
│  ├─ maps/
│  │  ├─ china-map.svg
│  │  └─ china-districts.json
│  ├─ station_nodes.json
│  └─ route_edges.json
├─ prisma/
│  └─ schema.prisma
├─ docs/
│  └─ YISHU_V1_SPEC.md
├─ docker-compose.yml
├─ pnpm-workspace.yaml
└─ package.json
```

---

# 52. Prisma User

```prisma
model User {
  id              BigInt   @id @default(autoincrement())
  uid             String   @unique
  account         String   @unique
  passwordHash    String
  nickname        String

  province        String
  city            String
  district        String

  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  sentLetters     Letter[] @relation("SentLetters")
  receivedLetters Letter[] @relation("ReceivedLetters")
}
```

---

# 53. Letter 字段

至少包含：

```text
id
trackingNo

senderId
recipientId

senderAccountSnapshot
senderUidSnapshot
senderNicknameSnapshot

recipientAccountSnapshot
recipientUidSnapshot
recipientNicknameSnapshot

encryptedContent
contentIv
contentAuthTag

originProvince
originCity
originDistrict

targetProvince
targetCity
targetDistrict

status
initialTransport
currentTransport

rulesVersion
graphVersion
simulationSeed

sentAt
deliveredAt
createdAt
updatedAt
```

---

# 54. Journey

```text
id
letterId
totalDistanceKm
progress
currentNodeId
lastKnownNodeId
currentApproximateMapX
currentApproximateMapY
uncertaintyRadiusKm
currentLegIndex
graphVersion
rulesVersion
```

---

# 55. TransportLeg

```text
id
journeyId
fromNodeId
toNodeId
distanceKm
transportType
status
startedAt
expectedEndAt
endedAt
```

---

# 56. WorldEvent

```text
id
letterId
type
happenedAt
nodeId
metadata
```

仅服务端内部使用。

---

# 57. TimelineEvent

```text
id
letterId
type
title
description
province
city
district
mapX
mapY
uncertaintyRadiusKm
happenedAt
visibleAt
importance
metadata
```

只返回：

```text
visibleAt <= SimulationClock.now()
```

---

# 58. RecipientState

```text
letterId
recipientId
readState
openedAt
hiddenAt
```

readState：

```text
UNOPENED
OPENED
```

Sender 无权读取。

---

# 59. SenderState

保存：

```text
hiddenAt
```

用于 Sender 自己隐藏终态信件。

---

# 60. SimulationClock

所有模拟业务禁止直接使用：

```ts
Date.now()
```

统一使用：

```ts
simulationClock.now()
```

生产：

```text
speed = 1
```

开发可支持：

```text
60
1000
10000
```

---

# 61. Demo 模式

开发环境：

```env
SIMULATION_MODE=demo
SIMULATION_SPEED=1000
SIMULATION_SEED=demo-001
```

固定 Demo 剧情：

```text
徐汇发出
↓
昆山
↓
苏州
↓
信使失联
↓
信件掉落
↓
路人拾获
↓
进入驿站
↓
改飞鸽
↓
北京
↓
DELIVERED
```

---

# 62. 确定性随机数

禁止：

```ts
Math.random()
```

实现：

```text
DeterministicRandom
```

输入：

```text
simulationSeed + eventIndex
```

同一 Seed 必须得到同一事件序列。

---

# 63. 规则版本

配置：

```text
simulation_rules_v1.json
```

Journey 保存：

```text
rulesVersion = "1.0"
```

以后规则更新时：

```text
旧信继续跑旧规则
```

---

# 64. Graph 版本

例如：

```text
graphVersion = "china-v1"
```

Journey 创建时锁定。

后续 Graph 更新不改变旧 Journey 的历史。

---

# 65. Worker

API 与 Worker 必须是独立进程。

```text
Fastify API
     ↓
PostgreSQL
     ↓
Redis
     ↓
BullMQ
     ↓
Simulation Worker
```

---

# 66. Job 幂等

Job ID：

```text
letterId:leg:legIndex
```

重复执行不得重复生成 TimelineEvent。

必须使用：

- Transaction
- Unique Constraint
- Idempotency Check

---

# 67. 创建信件幂等

客户端生成：

```text
clientRequestId
```

数据库唯一约束：

```text
senderId + clientRequestId
```

重复请求：

```text
返回原 Letter
```

不得创建重复信。

---

# 68. 状态同步

V1 不使用 WebSocket。

Letter Detail：

```text
每 5 秒 Poll
```

Home：

```text
每 30 秒 Poll
```

App 回前台：

```text
立即 Refetch
```

重要事件：

```text
Push
```

---

# 69. Push

使用：

```text
Expo Push Notifications
```

iOS 底层：

```text
APNs
```

Push 只是提醒。

真实状态来源：

```text
PostgreSQL
```

---

# 70. 时间

数据库统一：

```text
UTC
```

客户端 Timeline V1 统一：

```text
Asia/Shanghai
```

不随手机时区变化。

---

# 71. API 前缀

```text
/api/v1
```

---

# 72. 核心 API

## Auth

```http
POST /api/v1/auth/register
POST /api/v1/auth/login
POST /api/v1/auth/refresh
POST /api/v1/auth/logout
```

## User

```http
GET /api/v1/users/me
GET /api/v1/users/search?q=
POST /api/v1/users/:uid/block
```

## Letter

```http
POST /api/v1/letters
GET /api/v1/letters
GET /api/v1/letters/:trackingNo
GET /api/v1/letters/:trackingNo/map
GET /api/v1/letters/:trackingNo/timeline
POST /api/v1/letters/:trackingNo/open
POST /api/v1/letters/:trackingNo/hide
```

---

# 73. 创建信件 API

```http
POST /api/v1/letters
```

Body：

```json
{
  "recipient": "52739184",
  "content": "今晚打游戏吗？",
  "transportType": "HORSE_RELAY",
  "clientRequestId": "client-generated-id"
}
```

`recipient` 可以是：

```text
account
或
uid
```

---

# 74. Map API

```http
GET /api/v1/letters/:trackingNo/map
```

返回：

```json
{
  "status": "IN_TRANSIT",
  "origin": {},
  "destination": {},
  "completedPath": [],
  "remainingPath": [],
  "approximatePosition": {},
  "dropArea": null,
  "lastKnownPosition": {},
  "facts": []
}
```

所有地图业务坐标来自本地数据。

---

# 75. Timeline API

```http
GET /api/v1/letters/:trackingNo/timeline
```

只返回当前用户有权查看且：

```text
visibleAt <= now
```

的 TimelineEvent。

---

# 76. 首页排序

默认：

1. 异常中的在途信
2. 最近产生事件的在途信
3. Recipient 待拆阅
4. 终态历史信

不按联系人分组。

---

# 77. 首页卡片

寄出的：

```text
寄往 xiangshen
UID 52739184

上海市徐汇区 → 北京市海淀区

当前方式：驿马
状态：运输中

最后确报：江苏省苏州市
```

寄给我的：

```text
来自 xiangshen
UID 52739184

状态：运输中
内容：🔒
```

---

# 78. Letter Detail

必须包含：

- Tracking Number
- Sender
- Recipient
- 起点
- 终点
- 当前状态
- 当前运输方式
- 地图
- 完整 Timeline
- 发出时间

不得包含：

- ETA
- 剩余时间
- 用户干预按钮

---

# 79. 开发者调试面板

仅：

```text
__DEV__
```

存在。

功能：

- 推进 1 小时
- 推进 1 天
- 完成当前 Leg
- 强制抢劫
- 强制信使失联
- 强制掉落
- 强制拾获
- 强制改飞鸽
- 强制 Delivered
- 查看 WorldState
- 查看 Simulation Seed
- 查看当前 Node
- 查看当前 Edge

Release Build 必须移除。

---

# 80. 日志

使用：

```text
Pino
```

HTTP 日志必须包含：

```text
requestId
```

Simulation 日志至少包含：

```text
letterId
journeyId
legId
eventId
seed
```

---

# 81. 测试

## Unit Test

必须测试：

- UID 唯一生成
- Account 唯一
- 密码 Hash
- 概率总和
- Dijkstra
- 状态转移
- Recipient 正文权限
- Sender 无 readState
- dropped 返回范围
- missing 只返回最后确报
- rulesVersion
- graphVersion
- Seed 可复现
- Job 幂等
- 创建信件幂等

## Golden Integration Test

必须覆盖：

```text
注册 A
↓
注册 B
↓
A 搜索 B
↓
A 给 B 寄信
↓
B 知道有信
↓
B 看不到正文
↓
Journey 开始
↓
运输
↓
信使失联
↓
信件掉落
↓
被拾获
↓
进入驿站
↓
自动改飞鸽
↓
DELIVERED
↓
B 拆信
↓
B = OPENED
↓
A API 仍然完全不知道 B 已读
```

---

# 82. 代码规范

```text
TypeScript strict
ESLint
Prettier
```

禁止无理由使用：

```text
any
@ts-ignore
eslint-disable
```

---

# 83. Git

```text
main
feature/*
fix/*
```

`main` 必须始终：

- 能启动
- 能测试

---

# 84. 本地开发

依赖：

```bash
docker compose up -d
```

启动：

```text
PostgreSQL
Redis
```

项目：

```bash
pnpm dev
```

同时启动：

```text
mobile
api
worker
```

---

# 85. iOS 开发方式

主要：

```text
VS Code
+
Expo Development Build
+
iPhone 真机
```

使用 Fast Refresh 调 UI。

Xcode 用于：

- 原生调试
- iOS 签名
- Build
- TestFlight
- App Store

---

# 86. 部署

V1 不使用 Kubernetes。

服务器：

```text
Linux
+
Docker Compose
```

服务：

```text
Caddy
Fastify API
Simulation Worker
PostgreSQL
Redis
```

---

# 87. iOS 发布

开发：

```text
Expo Development Build
```

内部测试：

```text
TestFlight
```

构建：

```text
EAS Build
```

正式：

```text
App Store
```

---

# 88. Coding Agent 开发顺序

## Phase 1：项目骨架

1. pnpm workspace
2. mobile
3. api
4. worker
5. shared packages
6. Prisma
7. Docker Compose
8. Env
9. ESLint / Prettier / TS strict

## Phase 2：账号

1. 注册
2. 登录
3. UID
4. Token
5. 默认区域
6. 用户搜索
7. 拉黑

## Phase 3：信件

1. Letter
2. 身份快照
3. 发信
4. 列表
5. 详情
6. Recipient 正文权限
7. Hide

## Phase 4：路线

1. station_nodes
2. route_edges
3. Dijkstra
4. Journey
5. TransportLeg

## Phase 5：模拟

1. SimulationClock
2. DeterministicRandom
3. Probability Config
4. WorldEvent
5. TimelineEvent
6. Worker
7. BullMQ
8. 事件分支
9. 自动改运输方式

## Phase 6：地图

1. 中国 SVG
2. 起终点
3. Completed 实线
4. Remaining 虚线
5. Approximate Position
6. Drop Area
7. Last Known
8. Fact Nodes
9. Timeline

## Phase 7：通知与调试

1. Push
2. Polling
3. DEV Panel
4. Demo Seed
5. Time Acceleration

---

# 89. Coding Agent 禁止自行添加

```text
好友
聊天
群聊
评论
点赞
已读回执
ETA
倒计时
匿名信
图片
附件
外部地图 SDK
GPS 实时追踪
复杂天气系统
人物属性
疲劳值
NPC AI
WebSocket
Kubernetes
手机号验证码注册
额外 Communication ID
UUID 用户搜索
```

---

# 90. V1 验收标准

V1 完成必须满足：

1. 用户可用账号密码注册
2. 自动生成 8 位随机 UID
3. 可以 account / UID 搜索收件人
4. 可以寄纯文字信
5. Recipient 在发出时立即知道有信
6. Recipient 在 Delivered 前看不到正文
7. Sender / Recipient 运输 Timeline 完全一致
8. 用户不能干预已发出的信
9. Journey 可在本地 Graph 动态寻路
10. 已走路线是实线
11. 未走路线是虚线
12. 正常运输只显示大概位置
13. 掉落显示大概范围圆
14. 遗失只显示最后确报
15. 既定事实显示在地图和 Timeline
16. 随机事件使用固定概率
17. 支持掉落、失联、拾获、改运输方式
18. 7 个模拟日未找回可永久遗失
19. 极低概率可彻底失败
20. Delivered 后 Recipient 可拆信
21. Sender 永远看不到 Recipient 是否拆阅
22. Demo 模式可以快速跑完整旅程
23. 同一 Seed 可复现同一旅程
24. 地图完全离线
25. App 可在 iPhone Development Build 真机运行

满足以上全部条件：

```text
驿书 V1 MVP 完成
```

---

# 91. Coding Agent 第一条 Prompt

```text
请完整阅读 docs/YISHU_V1_SPEC.md，并将它视为项目唯一需求来源。

首先只完成 Phase 1：项目骨架。

技术栈必须严格使用：
- React Native + Expo SDK 57
- TypeScript strict
- Expo Router
- Node.js 24 LTS
- Fastify 5
- PostgreSQL 17
- Prisma 7
- Redis + BullMQ
- pnpm workspace

要求：
1. 初始化 monorepo
2. 创建 apps/mobile、apps/api、apps/worker
3. 创建 packages/shared、simulation、routing、config
4. 配置 Prisma
5. 配置 Docker Compose，包含 PostgreSQL 和 Redis
6. 配置统一 TypeScript、ESLint、Prettier
7. 提供 .env.example
8. 提供 pnpm dev
9. 添加 health check
10. 添加最基础 Vitest
11. README 写明启动方式
12. 不开始实现后续业务
13. 不允许自行替换技术栈
14. 不允许添加本文档未定义功能

完成后运行测试和 TypeScript 检查，并汇报实际结果。
```
