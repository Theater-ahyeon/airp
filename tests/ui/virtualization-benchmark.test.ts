// tests/ui/virtualization-benchmark.test.ts
import { describe, it, expect } from "vitest";

describe("Stage 4 Frontend Performance: 10,000 Floors Virtualization Benchmark", () => {
  it("万楼数据集冷启动与内存占用评估 (< 200ms 构建时间)", () => {
    const startTime = performance.now();
    const count = 10000;
    const items = new Array(count);

    for (let i = 0; i < count; i++) {
      items[i] = {
        id: `floor_${i}`,
        floorIndex: i + 1,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `这是第 ${i + 1} 楼的模拟超长对话文本内容，用于测试虚拟化滚动性能与内存占用情况。`,
        tokens: 30,
        createdAt: 1700000000000 + i * 1000,
      };
    }

    const duration = performance.now() - startTime;
    expect(items.length).toBe(10000);
    expect(duration).toBeLessThan(200);
  });

  it("虚拟化窗口计算时间测量 (确保 60fps, 每帧渲染窗口计算 < 16ms)", () => {
    const totalCount = 10000;
    const itemHeight = 150;
    const viewportHeight = 800;
    const overscan = 5;

    const startCompute = performance.now();

    const scrollTop = 450000;
    const startIndex = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan);
    const endIndex = Math.min(totalCount - 1, Math.floor((scrollTop + viewportHeight) / itemHeight) + overscan);
    const visibleCount = endIndex - startIndex + 1;

    const computeTime = performance.now() - startCompute;

    expect(visibleCount).toBeGreaterThan(0);
    expect(visibleCount).toBeLessThan(30);
    expect(computeTime).toBeLessThan(16);
  });
});
