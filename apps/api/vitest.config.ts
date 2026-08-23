import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 集成测试共享同一 PostgreSQL 数据库，串行执行测试文件避免并发清库冲突。
    fileParallelism: false,
  },
});
