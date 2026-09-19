// src/ui/sse-client.ts
// SSE 客户端：按命名事件注册监听（修复 M-6）。
// 服务器帧格式为 `id:<seq>\nevent:<type>\ndata:<JSON>`——带 event: 字段的帧
// 不会触发 EventSource.onmessage，必须 addEventListener 按事件名注册。
import { RuntimeEvent, RuntimeEventType } from "../runtime/contracts.js";

/** 服务器实际下发的事件名：RuntimeEventType ∪ 终帧 "end"。 */
const NAMED_EVENTS: readonly string[] = [
  "session_created",
  "floor_appended",
  "floor_swiped",
  "floor_edited",
  "branch_switched",
  "rollback",
  "undo_rollback",
  "state_op",
  "summary_updated",
  "run_created",
  "run_started",
  "run_delta",
  "run_completed",
  "run_cancelled",
  "run_failed",
  "checkpoint",
  "butler_extracted",
  "butler_degraded",
  "end",
];

export interface SSEClientOptions {
  url: string;
  token: string;
  fromSeq?: number;
  onEvent: (event: RuntimeEvent) => void;
  /** 终帧（event: "end"）：流已收尾，data 为最终 RunRecord。 */
  onEnd?: (record: unknown) => void;
  onError?: (err: Event) => void;
  onClose?: () => void;
}

export class AIRPEventSourceClient {
  private eventSource: EventSource | null = null;
  private currentSeq: number;

  constructor(private readonly options: SSEClientOptions) {
    this.currentSeq = options.fromSeq ?? 0;
  }

  connect(): void {
    const sep = this.options.url.includes("?") ? "&" : "?";
    const targetUrl = `${this.options.url}${sep}token=${encodeURIComponent(this.options.token)}&from=${this.currentSeq}`;

    this.eventSource = new EventSource(targetUrl);

    // M-6 修复核心：逐名注册。onmessage 永远收不到带 event: 字段的帧。
    for (const name of NAMED_EVENTS) {
      this.eventSource.addEventListener(name, (msg: MessageEvent) => {
        try {
          const parsed = JSON.parse(msg.data);
          if (name === "end") {
            this.options.onEnd?.(parsed);
            return;
          }
          if (parsed && typeof parsed.seq === "number") {
            this.currentSeq = parsed.seq;
            this.options.onEvent(parsed as RuntimeEvent);
          }
        } catch {
          // 单帧解析失败不中断流
        }
      });
    }

    this.eventSource.onerror = (err) => {
      if (this.options.onError) {
        this.options.onError(err);
      }
    };
  }

  close(): void {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
      if (this.options.onClose) {
        this.options.onClose();
      }
    }
  }
}
