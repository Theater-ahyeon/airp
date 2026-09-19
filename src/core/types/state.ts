// src/core/types/state.ts
// Core domain model: Structured State and StateOp event sourcing.

export type StateOpType = "set" | "inc" | "push" | "unset";

export interface StateOp {
  id: string;
  floorId: string;
  branchId: string;
  type: StateOpType;
  key: string;
  value?: unknown;
  timestamp: number;
}

export type StateSnapshot = Record<string, unknown>;

export function applyStateOp(state: StateSnapshot, op: StateOp): StateSnapshot {
  const next: StateSnapshot = { ...state };
  switch (op.type) {
    case "set":
      next[op.key] = op.value;
      break;
    case "inc": {
      const current = typeof next[op.key] === "number" ? (next[op.key] as number) : 0;
      const delta = typeof op.value === "number" ? op.value : 1;
      next[op.key] = current + delta;
      break;
    }
    case "push": {
      const arr = Array.isArray(next[op.key]) ? [...(next[op.key] as unknown[])] : [];
      arr.push(op.value);
      next[op.key] = arr;
      break;
    }
    case "unset":
      delete next[op.key];
      break;
  }
  return next;
}

export function replayStateOps(initialState: StateSnapshot, ops: StateOp[]): StateSnapshot {
  let current = { ...initialState };
  for (const op of ops) {
    current = applyStateOp(current, op);
  }
  return current;
}
