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

/** 卡片列表条目（GET /api/cards）。 */
export interface CardListItem {
  cardId: string;
  name: string;
  description?: string;
  updatedAt?: number;
}

/** ReplayResult 的前端投影（GET /api/sessions/:id/tree）。 */
export interface SessionTreeProjection {
  tree: {
    floors: Record<
      string,
      {
        id: string;
        parentId: string | null;
        branchId: string;
        floorIndex: number;
        role: "user" | "assistant" | "system";
        content: string;
        createdAt: number;
        updatedAt: number;
        swipes: string[];
        currentSwipeIndex: number;
      }
    >;
    activeBranchId: string;
    undoCheckpointFloorId: string | null;
  };
  state: Record<string, unknown>;
  summary: string | null;
  lastSeq: number;
}
