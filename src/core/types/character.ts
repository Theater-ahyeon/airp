// src/core/types/character.ts
// Core domain model: Character card with immutable original and working copy.

export interface CharacterAttributes {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  firstMessage: string;
  mesExamples: string;
  systemPrompt?: string;
  postHistoryInstructions?: string;
  tags?: string[];
  creatorNotes?: string;
}

export interface CharacterCard {
  id: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  /** Immutable original asset imported from user/ST */
  readonly original: Readonly<CharacterAttributes>;
  /** Mutable working copy where runtime modifications land */
  workingCopy: CharacterAttributes;
}

export function createCharacterCard(id: string, initial: CharacterAttributes): CharacterCard {
  const now = Date.now();
  const frozenOriginal = Object.freeze({ ...initial });
  return {
    id,
    version: 1,
    createdAt: now,
    updatedAt: now,
    original: frozenOriginal,
    workingCopy: { ...initial }
  };
}

export function resetWorkingCopy(card: CharacterCard): CharacterCard {
  return {
    ...card,
    updatedAt: Date.now(),
    workingCopy: { ...card.original }
  };
}
