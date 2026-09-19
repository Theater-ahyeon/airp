// src/runtime/session/mock-port.ts
// 使用 MockModelAdapter 包装出的 ModelStreamPort 实现。

import type { ModelStreamPort, ModelStreamChunk, TokenUsage } from "../contracts.js";
import { MockModelAdapter } from "../../core/adapters/mock-model.js";

export interface MockPortOptions {
  adapter?: MockModelAdapter;
  /** 每个 delta 产生后的延迟（毫秒），用于模拟慢速流 */
  deltaDelayMs?: number;
}

export class MockModelPort implements ModelStreamPort {
  readonly adapter: MockModelAdapter;
  readonly deltaDelayMs: number;

  constructor(options: MockPortOptions = {}) {
    this.adapter = options.adapter ?? new MockModelAdapter();
    this.deltaDelayMs = options.deltaDelayMs ?? 0;
  }

  async *stream(req: {
    model: string;
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    abortSignal: AbortSignal;
  }): AsyncGenerator<ModelStreamChunk, void, unknown> {
    const { model, messages, abortSignal } = req;
    const generator = this.adapter.stream({
      model,
      messages,
      abortSignal
    });

    for await (const event of generator) {
      if (abortSignal?.aborted) {
        throw new Error("Request aborted during stream");
      }

      if (event.type === "start") {
        yield { type: "start" };
      } else if (event.type === "text_delta" && event.text !== undefined) {
        if (this.deltaDelayMs > 0) {
          const { promise, resolve } = Promise.withResolvers<void>();
          setTimeout(resolve, this.deltaDelayMs);
          await promise;
          if (abortSignal?.aborted) {
            throw new Error("Request aborted during stream");
          }
        }
        yield { type: "text_delta", text: event.text };
      } else if (event.type === "done") {
        const usage: TokenUsage | undefined = event.usage
          ? {
              promptTokens: event.usage.promptTokens,
              completionTokens: event.usage.completionTokens,
              cachedTokens: event.usage.cachedTokens
            }
          : undefined;
        yield { type: "done", usage };
      }
    }
  }
}
