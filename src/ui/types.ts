// src/ui/types.ts
export interface ChatFloor {
  id: string;
  floorIndex: number;
  role: "user" | "assistant" | "system";
  content: string;
  swipes: string[];
  currentSwipeIndex: number;
  createdAt: number;
  tokens?: number;
  stateDeltas?: Array<{ key: string; value: string }>;
}

export interface SessionState {
  cardId: string;
  cardName: string;
  cardSubtitle: string;
  sessionId: string;
  sessionTitle: string;
  sessionBranch: string;
  floors: ChatFloor[];
  currentState: Record<string, unknown>;
  rollingSummary: string | null;
  summaryCoverage: string;
  cacheHitRate: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  estimatedCost: string;
  butlerStatus: "running" | "idle" | "settling";
  undoCheckpointAvailable: boolean;
}
