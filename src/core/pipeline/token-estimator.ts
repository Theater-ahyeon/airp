// src/core/pipeline/token-estimator.ts
// Cross-provider conservative token estimator.

export interface TokenEstimationProfile {
  provider: string;
  cjkRatio: number;      // tokens per CJK character
  asciiRatio: number;    // tokens per ASCII character
  marginPercent: number; // safety padding (e.g. 0.20 = 20%)
}

const PROFILES: Record<string, TokenEstimationProfile> = {
  openai: { provider: "openai", cjkRatio: 0.65, asciiRatio: 0.25, marginPercent: 0.10 },
  anthropic: { provider: "anthropic", cjkRatio: 0.75, asciiRatio: 0.28, marginPercent: 0.10 },
  deepseek: { provider: "deepseek", cjkRatio: 0.60, asciiRatio: 0.25, marginPercent: 0.10 },
  conservative: { provider: "conservative", cjkRatio: 1.0, asciiRatio: 0.35, marginPercent: 0.20 }
};

export function estimateTokens(text: string, provider: string = "conservative"): number {
  if (!text) return 0;
  const profile = PROFILES[provider] ?? PROFILES.conservative;

  let cjkCount = 0;
  let asciiCount = 0;

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // CJK Unified Ideographs range
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf)) {
      cjkCount++;
    } else {
      asciiCount++;
    }
  }

  const rawEstimate = cjkCount * profile.cjkRatio + asciiCount * profile.asciiRatio;
  const guardedEstimate = Math.ceil(rawEstimate * (1 + profile.marginPercent));
  return Math.max(1, guardedEstimate);
}
