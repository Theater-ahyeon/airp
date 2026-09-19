// tests/runtime/store/paths.test.ts
import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import {
  resolveAirpHome,
  assertSafeId,
  cardDir,
  sessionDir,
  runsDir,
  snapshotsDir,
  backupsDir,
  eventsPath
} from "../../../src/runtime/paths.js";

describe("Paths & Security (验收点 7)", () => {
  it("应正确解析 AIRP_HOME 环境变量（绝对路径与相对路径）", () => {
    // 相对路径
    const relHome = resolveAirpHome({ AIRP_HOME: "./custom_airp" });
    expect(relHome).toBe(path.resolve("./custom_airp"));

    // 绝对路径
    const absPath = path.resolve(os.tmpdir(), "airp-home-test");
    const absHome = resolveAirpHome({ AIRP_HOME: absPath });
    expect(absHome).toBe(absPath);

    // 未设置时回退到 ~/.airp
    const defaultHome = resolveAirpHome({});
    expect(defaultHome).toBe(path.resolve(path.join(os.homedir(), ".airp")));
  });

  it("防路径穿越校验：合法的 cardId 与 sessionId 应通过", () => {
    expect(assertSafeId("card_123")).toBe("card_123");
    expect(assertSafeId("sess-ABC_xyz-99")).toBe("sess-ABC_xyz-99");
  });

  it("防路径穿越校验：非法 ID 必须抛出异常（验收点 7: cardId = '../evil'）", () => {
    expect(() => assertSafeId("../evil", "cardId")).toThrow(/Invalid cardId/);
    expect(() => cardDir("C:/airp", "../evil")).toThrow(/Invalid cardId/);
    expect(() => sessionDir("C:/airp", "card1", "../../etc/passwd")).toThrow(/Invalid sessionId/);
    expect(() => assertSafeId("has/slash")).toThrow();
    expect(() => assertSafeId("has\\backslash")).toThrow();
    expect(() => assertSafeId("")).toThrow();
    expect(() => assertSafeId("a".repeat(65))).toThrow();
  });

  it("目录生成辅助函数应返回正确层级结构", () => {
    const home = "C:/airp";
    expect(cardDir(home, "c1")).toBe(path.join(home, "cards", "c1"));
    expect(sessionDir(home, "c1", "s1")).toBe(path.join(home, "cards", "c1", "sessions", "s1"));
    expect(snapshotsDir(home, "c1", "s1")).toBe(path.join(home, "cards", "c1", "sessions", "s1", "snapshots"));
    expect(runsDir(home, "c1", "s1")).toBe(path.join(home, "cards", "c1", "sessions", "s1", "runs"));
    expect(backupsDir(home, "c1")).toBe(path.join(home, "cards", "c1", "backups"));
    expect(eventsPath(home, "c1", "s1")).toBe(path.join(home, "cards", "c1", "sessions", "s1", "events.jsonl"));
  });
});
