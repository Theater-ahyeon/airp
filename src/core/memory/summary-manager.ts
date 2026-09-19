// src/core/memory/summary-manager.ts
// Versioned branch-aware summary derivation and lazy recalculation.

export interface BranchSummaryRecord {
  branchId: string;
  upToFloorId: string;
  floorCount: number;
  summary: string;
  updatedAt: number;
}

export class SummaryManager {
  private summariesByBranch = new Map<string, BranchSummaryRecord>();

  getSummary(branchId: string): string | null {
    return this.summariesByBranch.get(branchId)?.summary ?? null;
  }

  setSummary(branchId: string, upToFloorId: string, floorCount: number, summary: string): void {
    this.summariesByBranch.set(branchId, {
      branchId,
      upToFloorId,
      floorCount,
      summary,
      updatedAt: Date.now()
    });
  }

  /**
   * Evaluates if summary needs recomputation:
   * Triggers when floor delta since last summary exceeds token/floor threshold (e.g. 10 floors).
   */
  shouldRecalculate(branchId: string, currentFloorCount: number, threshold: number = 10): boolean {
    const existing = this.summariesByBranch.get(branchId);
    if (!existing) {
      return currentFloorCount >= threshold;
    }
    return currentFloorCount - existing.floorCount >= threshold;
  }

  /**
   * Prunes branch summary when branch is physically forgotten or deleted.
   */
  forgetBranch(branchId: string): void {
    this.summariesByBranch.delete(branchId);
  }
}
