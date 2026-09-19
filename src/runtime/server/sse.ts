// src/runtime/server/sse.ts
// AIRP Run 事件 SSE 流视图实现。
// 语义：SSE 只是视图，权威状态在 EventLog。断线重连靠 from/Last-Event-ID 重放恢复。

import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { RunEventSink, RunManagerFacade, RuntimeEvent, RunRecord } from "../contracts.js";

/**
 * 解析客户端请求中传入的 fromSeq。
 * Last-Event-ID 头优先，其次为 ?from=<seq> 查询参数。
 * 默认值为 0（表示从第一条事件 seq=1 开始重放）。
 */
export function extractFromSeq(c: Context): number {
  const lastEventId = c.req.header("last-event-id") ?? c.req.header("Last-Event-ID");
  if (lastEventId !== undefined && lastEventId.trim().length > 0) {
    const parsed = Number.parseInt(lastEventId.trim(), 10);
    if (!Number.isNaN(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  const queryFrom = c.req.query("from");
  if (queryFrom !== undefined && queryFrom.trim().length > 0) {
    const parsed = Number.parseInt(queryFrom.trim(), 10);
    if (!Number.isNaN(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  return 0;
}

/**
 * 格式化并发送单条 SSE 事件帧。
 * id: <seq>\nevent: <type>\ndata: <JSON>\n\n
 */
export async function writeSSEEvent(
  stream: { writeSSE: (msg: { id?: string; event?: string; data: string }) => Promise<void> },
  event: RuntimeEvent
): Promise<void> {
  await stream.writeSSE({
    id: String(event.seq),
    event: event.type,
    data: JSON.stringify(event),
  });
}

/**
 * 处理 GET /api/runs/:runId/events 的 SSE 端点。
 */
export function handleRunEventsSSE(runManager: RunManagerFacade) {
  return async (c: Context) => {
    const runId = c.req.param("runId");
    if (!runId) {
      return c.json({ error: "Missing runId parameter" }, 400);
    }

    const run = await runManager.getRun(runId);
    if (!run) {
      return c.json({ error: `Run not found: ${runId}` }, 404);
    }

    const fromSeq = extractFromSeq(c);

    return streamSSE(c, async (stream) => {
      let unsubscribe: (() => void) | null = null;
      let cleanedUp = false;

      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        clearInterval(keepaliveTimer);
        if (unsubscribe) {
          try {
            unsubscribe();
          } catch (err) {
            console.error("Error during SSE unsubscribe:", err);
          }
          unsubscribe = null;
        }
      };

      // 客户端断开连接时触发退订
      stream.onAbort(() => {
        cleanup();
      });

      // 兜底监听 raw request signal abort
      const rawSignal = c.req.raw?.signal;
      if (rawSignal && typeof rawSignal.addEventListener === "function") {
        rawSignal.addEventListener("abort", () => {
          cleanup();
        });
      }

      // 每 15 秒发送一次注释 keepalive 帧防代理超时
      const keepaliveTimer = setInterval(() => {
        if (cleanedUp) return;
        stream.write(": keepalive\n\n").catch(() => {
          cleanup();
        });
      }, 15000);

      const queue: Array<() => Promise<void>> = [];
      let isProcessing = false;

      const processQueue = async () => {
        if (isProcessing) return;
        isProcessing = true;
        while (queue.length > 0 && !cleanedUp) {
          const action = queue.shift();
          if (action) {
            try {
              await action();
            } catch (err) {
              console.error("Error writing SSE frame:", err);
              cleanup();
              break;
            }
          }
        }
        isProcessing = false;
      };

      const sink: RunEventSink = {
        onEvent(ev: RuntimeEvent) {
          if (cleanedUp) return;
          queue.push(async () => {
            await writeSSEEvent(stream, ev);
          });
          void processQueue();
        },
        onEnd(record: RunRecord) {
          if (cleanedUp) return;
          queue.push(async () => {
            await stream.writeSSE({
              event: "end",
              data: JSON.stringify(record),
            });
            cleanup();
            await stream.close();
          });
          void processQueue();
        },
      };

      try {
        unsubscribe = await runManager.subscribe(runId, fromSeq, sink);
        if (rawSignal?.aborted && !cleanedUp) {
          cleanup();
        }
      } catch (err) {
        cleanup();
        throw err;
      }

      // 保持当前流打开，直到 stream.close() 或被 abort
      await stream.sleep(100);
      while (!cleanedUp) {
        await stream.sleep(200);
      }
    });
  };
}
