// src/ui/sse-client.ts
import { RuntimeEvent } from "../runtime/contracts.js";

export interface SSEClientOptions {
  url: string;
  token: string;
  fromSeq?: number;
  onEvent: (event: RuntimeEvent) => void;
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

    this.eventSource.onmessage = (msg) => {
      try {
        const parsed = JSON.parse(msg.data) as RuntimeEvent;
        if (parsed && typeof parsed.seq === "number") {
          this.currentSeq = parsed.seq;
          this.options.onEvent(parsed);
        }
      } catch {
        // ignore parse error
      }
    };

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
