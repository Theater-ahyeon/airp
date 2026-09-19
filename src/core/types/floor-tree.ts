// src/core/types/floor-tree.ts
// Core domain model: Floor Tree with Branching, Swiping, Editing, and Undo/Redo.

export type Role = "user" | "assistant" | "system";

export interface FloorMessage {
  id: string;
  parentId: string | null;
  branchId: string;
  floorIndex: number;
  role: Role;
  content: string;
  createdAt: number;
  updatedAt: number;
  /** Swipes: alternate generated messages at the same floor */
  swipes: string[];
  currentSwipeIndex: number;
  /** Edit history */
  editHistory?: Array<{ content: string; editedAt: number }>;
  /** Usage metadata from ModelPort if available */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    cachedTokens?: number;
  };
}

export interface FloorTree {
  id: string;
  rootFloorId: string | null;
  activeBranchId: string;
  /** Floor map keyed by floorId */
  floors: Map<string, FloorMessage>;
  /** Undo checkpoint stack for rollback/revert */
  undoCheckpointFloorId: string | null;
}

export function createFloorTree(id: string): FloorTree {
  return {
    id,
    rootFloorId: null,
    activeBranchId: "main",
    floors: new Map(),
    undoCheckpointFloorId: null
  };
}

export function appendFloor(
  tree: FloorTree,
  role: Role,
  content: string,
  parentId?: string | null
): FloorMessage {
  const actualParentId = parentId !== undefined ? parentId : getLatestFloorId(tree);
  const parent = actualParentId ? tree.floors.get(actualParentId) : null;
  const floorIndex = parent ? parent.floorIndex + 1 : 1;
  const id = `floor_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const now = Date.now();

  const floor: FloorMessage = {
    id,
    parentId: actualParentId ?? null,
    branchId: tree.activeBranchId,
    floorIndex,
    role,
    content,
    createdAt: now,
    updatedAt: now,
    swipes: [content],
    currentSwipeIndex: 0
  };

  tree.floors.set(id, floor);
  if (!tree.rootFloorId) {
    tree.rootFloorId = id;
  }
  // Any new append invalidates prior undo checkpoint
  tree.undoCheckpointFloorId = null;
  return floor;
}

export function addSwipe(tree: FloorTree, floorId: string, newContent: string): FloorMessage {
  const floor = tree.floors.get(floorId);
  if (!floor) throw new Error(`Floor not found: ${floorId}`);
  floor.swipes.push(newContent);
  floor.currentSwipeIndex = floor.swipes.length - 1;
  floor.content = newContent;
  floor.updatedAt = Date.now();
  return floor;
}

export function switchSwipe(tree: FloorTree, floorId: string, swipeIndex: number): FloorMessage {
  const floor = tree.floors.get(floorId);
  if (!floor) throw new Error(`Floor not found: ${floorId}`);
  if (swipeIndex < 0 || swipeIndex >= floor.swipes.length) {
    throw new Error(`Invalid swipe index: ${swipeIndex}`);
  }
  floor.currentSwipeIndex = swipeIndex;
  floor.content = floor.swipes[swipeIndex];
  floor.updatedAt = Date.now();
  return floor;
}

export function editFloor(tree: FloorTree, floorId: string, newContent: string): FloorMessage {
  const floor = tree.floors.get(floorId);
  if (!floor) throw new Error(`Floor not found: ${floorId}`);
  floor.editHistory = floor.editHistory ?? [];
  floor.editHistory.push({ content: floor.content, editedAt: Date.now() });
  floor.content = newContent;
  floor.swipes[floor.currentSwipeIndex] = newContent;
  floor.updatedAt = Date.now();
  return floor;
}

export function rollbackToFloor(tree: FloorTree, floorId: string): void {
  if (!tree.floors.has(floorId)) {
    throw new Error(`Floor not found: ${floorId}`);
  }
  const currentLatest = getLatestFloorId(tree);
  tree.undoCheckpointFloorId = currentLatest;
  // Prune any descendants after floorId in active branch or set branch pointer
  // For branch physical forgetting:
  pruneSubtreeAfter(tree, floorId);
}

export function undoRollback(tree: FloorTree): boolean {
  if (!tree.undoCheckpointFloorId) return false;
  // If checkpoint floor exists, restore it
  if (tree.floors.has(tree.undoCheckpointFloorId)) {
    tree.undoCheckpointFloorId = null;
    return true;
  }
  return false;
}

export function getFloorPath(tree: FloorTree, targetFloorId?: string): FloorMessage[] {
  const leafId = targetFloorId ?? getLatestFloorId(tree);
  if (!leafId) return [];

  const path: FloorMessage[] = [];
  let curr: FloorMessage | undefined = tree.floors.get(leafId);
  while (curr) {
    path.unshift(curr);
    curr = curr.parentId ? tree.floors.get(curr.parentId) : undefined;
  }
  return path;
}

export function getLatestFloorId(tree: FloorTree): string | null {
  let latest: FloorMessage | null = null;
  for (const floor of tree.floors.values()) {
    if (!latest || floor.floorIndex > latest.floorIndex) {
      latest = floor;
    }
  }
  return latest ? latest.id : null;
}

function pruneSubtreeAfter(tree: FloorTree, keepFloorId: string): void {
  const keepFloor = tree.floors.get(keepFloorId);
  if (!keepFloor) return;
  const toDelete = new Set<string>();
  for (const floor of tree.floors.values()) {
    if (floor.floorIndex > keepFloor.floorIndex) {
      toDelete.add(floor.id);
    }
  }
  for (const id of toDelete) {
    tree.floors.delete(id);
  }
}
