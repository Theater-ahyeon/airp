// src/core/types/schema.ts
// General structured state schema definitions and validators using Zod.

import { z } from "zod";

export const StateValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.union([z.string(), z.number(), z.boolean()])),
  z.record(z.unknown())
]);

export const StateOpSchema = z.object({
  id: z.string(),
  floorId: z.string(),
  branchId: z.string(),
  type: z.enum(["set", "inc", "push", "unset"]),
  key: z.string().min(1).max(128),
  value: z.unknown().optional(),
  timestamp: z.number().int().positive()
});

export const CardMemoryItemSchema = z.object({
  id: z.string(),
  key: z.string(),
  value: z.string(),
  confidence: z.number().min(0).max(1).default(1),
  sourceSessionId: z.string().optional(),
  createdAt: z.number().int().positive(),
  updatedAt: z.number().int().positive()
});

export type CardMemoryItem = z.infer<typeof CardMemoryItemSchema>;

export const CardLevelMemorySchema = z.object({
  cardId: z.string(),
  version: z.number().int().default(1),
  updatedAt: z.number().int().positive(),
  memories: z.array(CardMemoryItemSchema).default([])
});

export type CardLevelMemory = z.infer<typeof CardLevelMemorySchema>;
