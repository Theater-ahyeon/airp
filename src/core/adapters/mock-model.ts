// src/core/adapters/mock-model.ts
// Pure TypeScript mock model and mock tool adapter for Core testing.

export interface MockStreamEvent {
  type: "start" | "text_delta" | "done" | "tool_call";
  text?: string;
  toolCall?: { id: string; name: string; args: Record<string, unknown> };
  usage?: {
    promptTokens: number;
    completionTokens: number;
    cachedTokens?: number;
  };
}

export interface ModelRequestOptions {
  model: string;
  messages: Array<{ role: string; content: string }>;
  tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
  abortSignal?: AbortSignal;
}

export class MockModelAdapter {
  private cannedResponses: string[] = [];
  private cannedToolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];

  enqueueResponse(text: string): void {
    this.cannedResponses.push(text);
  }

  enqueueToolCall(name: string, args: Record<string, unknown>): void {
    this.cannedToolCalls.push({ id: `call_${Date.now()}`, name, args });
  }

  async *stream(req: ModelRequestOptions): AsyncGenerator<MockStreamEvent, void, unknown> {
    if (req.abortSignal?.aborted) {
      throw new Error("Request aborted before start");
    }

    yield { type: "start" };

    if (this.cannedToolCalls.length > 0) {
      const call = this.cannedToolCalls.shift()!;
      yield { type: "tool_call", toolCall: call };
      yield {
        type: "done",
        usage: { promptTokens: 100, completionTokens: 20, cachedTokens: 80 }
      };
      return;
    }

    const reply = this.cannedResponses.shift() ?? "这是假模型的默认回复。";
    const slices = reply.match(/.{1,4}/g) ?? [reply];

    for (const slice of slices) {
      if (req.abortSignal?.aborted) {
        throw new Error("Request aborted during stream");
      }
      yield { type: "text_delta", text: slice };
    }

    yield {
      type: "done",
      usage: {
        promptTokens: 150,
        completionTokens: reply.length,
        cachedTokens: 120
      }
    };
  }
}
