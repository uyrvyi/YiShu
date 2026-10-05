# 网关健康探针子进程自动回收（2026-10-04）

## 原因与范围

- 经用户授权只读核对后，确认 HTTPS 网关中有 4193 个直接挂在 Caddy 主进程下、状态为 `Z` 的 `ssl_client` 子进程。Docker PID 计数为 4202，Caddy 主进程自身只有 9 个线程，不能将该故障解释为 Caddy 创建了 4200 个线程。
- 原健康探针使用 `wget --no-check-certificate -q -O /dev/null https://localhost/api/v1/health`，TLS 辅助子进程退出后成为孤儿，原容器 PID 1 未回收其退出状态。探针后来因无法启动进程而失败；公网 API 当时仍返回 HTTPS 200。
- 僵尸进程已经退出，不能靠单独发送 `kill` 清除。处理方式是在 `docker-compose.cloud.yml` 的 Caddy 服务启用 `init: true`，由 Docker init 自动接管并回收孤儿子进程；本次重建网关清除旧积累。不使用定时重启、不关闭 HTTPS、不开放新端口。
- 此机制针对本次确认的孤儿子进程；不是自动终止所有活跃进程，也不保证修复其他程序仍持有、但不执行 wait 的直接子进程。

## 发布与验证

- 发布前比较完整有效 Compose JSON，唯一差异为 Caddy 的 `init: true`。只重建 `yishu-cloud-caddy-1`；API、Worker、PostgreSQL、Redis 和 Expo 预览的启动时间保持不变。
- 网关镜像、环境、命令、入口、端口、挂载与静态网络 IP 均与原运行配置一致。未修改证书或数据库。配置备份为 `/opt/yishu/docker-compose.cloud.yml.before-caddy-init-20261004`。
- 配置文件 SHA-256：旧版 `19e8cb38e6e09d34de4bde4929cebdfdfe09474ecb40b75edcbcf8a78f2042e3`，新版 `e4aa4cb5128691414e94c7bae666a1d9c117bce37cb4d4ca25f15616e9cd183d`。上传和服务器替换前均核对哈希。
- 回读 `HostConfig.Init=true`，网关恢复 `healthy`。连续执行 12 次同一健康探针后，PID 计数为 9，init 及 Caddy 子进程中的僵尸计数为 0；公网 API 返回 HTTPS 200，通过 `GATEWAY_INIT_PASS`。
- 随后完成服务器预览重建、冷启动预热和公网代码检查，再次回读网关 PID 计数为 9、僵尸计数为 0；全部六个运行容器健康、公网 API HTTPS 200，通过 `GATEWAY_POST_PREVIEW_REAPING_PASS`。
- 配置回归 `phase12-proxy.test.ts` 的 8 项测试通过，包含启用 PID 1 回收的断言。该断言用于防止配置回退；自动回收的实际证据来自上述运行时探针测试。
- 这是有界探针验证，不是多小时耐久验收。后续发现同类故障应先核对父进程、进程状态和探针日志，不采用无差别杀进程。
