import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 集成测试共享同一 PostgreSQL 数据库，串行执行测试文件避免并发清库冲突。
    fileParallelism: false,
    // api 集成测试为真实 PostgreSQL 重型 fixture（replay / 大跳跃 vs 分段），
    // 默认 5000ms 可能抖动超时；统一放宽到 30s（Gate LOW 修复）。
    testTimeout: 30000,
  },
});
