// src/runtime/paths.ts
// AIRP Runtime 路径解析与 ID 安全防线。

import path from "node:path";
import os from "node:os";
import { CARD_LAYOUT, SESSION_LAYOUT } from "./contracts.js";

/** ID 安全校验正则：仅允许字母、数字、下划线、短横线，长度 1-64 */
const SAFE_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * 校验 cardId / sessionId 的安全性，防止目录穿越。
 * 格式不匹配时抛出明确异常。
 */
export function assertSafeId(id: string, name = "id"): string {
  if (typeof id !== "string" || !SAFE_ID_REGEX.test(id)) {
    throw new Error(
      `Invalid ${name}: "${id}". Must match [A-Za-z0-9_-]{1,64} and contain no path traversal characters.`
    );
  }
  return id;
}

/**
 * 解析 AIRP_HOME 绝对路径。
 * 优先级：
 * 1. env.AIRP_HOME（或 process.env.AIRP_HOME），相对路径转换为绝对路径
 * 2. 回退到 path.join(os.homedir(), ".airp")
 */
export function resolveAirpHome(env: NodeJS.ProcessEnv = process.env): string {
  const custom = env.AIRP_HOME;
  if (custom && custom.trim().length > 0) {
    return path.resolve(custom.trim());
  }
  return path.resolve(path.join(os.homedir(), ".airp"));
}

/** <AIRP_HOME>/cards */
export function cardsBaseDir(home: string): string {
  return path.join(home, "cards");
}

/** <AIRP_HOME>/cards/<cardId> */
export function cardDir(home: string, cardId: string): string {
  assertSafeId(cardId, "cardId");
  return path.join(cardsBaseDir(home), cardId);
}

/** <AIRP_HOME>/cards/<cardId>/meta.json */
export function cardMetaPath(home: string, cardId: string): string {
  return path.join(cardDir(home, cardId), CARD_LAYOUT.meta);
}

/** <AIRP_HOME>/cards/<cardId>/card.json */
export function cardPayloadPath(home: string, cardId: string): string {
  return path.join(cardDir(home, cardId), CARD_LAYOUT.card);
}

/** <AIRP_HOME>/cards/<cardId>/backups */
export function backupsDir(home: string, cardId: string): string {
  return path.join(cardDir(home, cardId), CARD_LAYOUT.backups);
}

/** <AIRP_HOME>/cards/<cardId>/original.json（ST 不可变原版） */
export function cardOriginalPath(home: string, cardId: string): string {
  return path.join(cardDir(home, cardId), CARD_LAYOUT.original);
}

/** <AIRP_HOME>/cards/<cardId>/compat.json（ST 兼容报告） */
export function cardCompatPath(home: string, cardId: string): string {
  return path.join(cardDir(home, cardId), CARD_LAYOUT.compat);
}

/** <AIRP_HOME>/cards/<cardId>/worldbook.json（世界书存储） */
export function cardWorldbookPath(home: string, cardId: string): string {
  return path.join(cardDir(home, cardId), CARD_LAYOUT.worldbook);
}

/** <AIRP_HOME>/cards/<cardId>/sessions */
export function sessionsBaseDir(home: string, cardId: string): string {
  return path.join(cardDir(home, cardId), CARD_LAYOUT.sessions);
}

/** <AIRP_HOME>/cards/<cardId>/sessions/<sessionId> */
export function sessionDir(home: string, cardId: string, sessionId: string): string {
  assertSafeId(sessionId, "sessionId");
  return path.join(sessionsBaseDir(home, cardId), sessionId);
}

/** <AIRP_HOME>/cards/<cardId>/sessions/<sessionId>/events.jsonl */
export function eventsPath(home: string, cardId: string, sessionId: string): string {
  return path.join(sessionDir(home, cardId, sessionId), SESSION_LAYOUT.events);
}

/** <AIRP_HOME>/cards/<cardId>/sessions/<sessionId>/snapshots */
export function snapshotsDir(home: string, cardId: string, sessionId: string): string {
  return path.join(sessionDir(home, cardId, sessionId), SESSION_LAYOUT.snapshots);
}

/** <AIRP_HOME>/cards/<cardId>/sessions/<sessionId>/runs */
export function runsDir(home: string, cardId: string, sessionId: string): string {
  return path.join(sessionDir(home, cardId, sessionId), SESSION_LAYOUT.runs);
}
