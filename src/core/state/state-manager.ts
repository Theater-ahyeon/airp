// src/core/state/state-manager.ts
// Event-sourced state manager with branch-aware state projection and physical forgetting semantics.

import { StateOp, StateSnapshot, applyStateOp } from "../types/state.js";
import { StateOpSchema } from "../types/schema.js";

export class StateManager {
  /**
   * Replays StateOps while filtering out operations tied to forgotten floors or pruned branches.
   * If a branch or floor was physically forgotten in tree, its associated state ops do not survive.
   */
  static projectState(
    initialState: StateSnapshot,
    ops: StateOp[],
    activeFloorIds?: Set<string> | string[]
  ): StateSnapshot {
    const validFloorSet = activeFloorIds ? new Set(activeFloorIds) : null;
    let current: StateSnapshot = { ...initialState };

    for (const op of ops) {
      // Validate schema
      StateOpSchema.parse(op);

      // If activeFloorIds provided, only apply ops tied to existing visible floors
      if (validFloorSet && !validFloorSet.has(op.floorId)) {
        continue;
      }

      current = applyStateOp(current, op);
    }

    return current;
  }
}
