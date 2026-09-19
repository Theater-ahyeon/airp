// src/core/importers/png-card-extractor.ts
// Robust pure-TS PNG chunk parser to extract embedded SillyTavern character card JSON (chara / ccv3).

export function extractPngMetadata(pngBuffer: Buffer): Record<string, string> {
  // Validate PNG signature: 89 50 4E 47 0D 0A 1A 0A
  if (pngBuffer.length < 8 || pngBuffer.readUInt32BE(0) !== 0x89504e47) {
    throw new Error("Invalid PNG: missing standard 8-byte PNG signature");
  }

  let offset = 8;
  const chunks: Record<string, string> = {};

  while (offset + 8 <= pngBuffer.length) {
    const length = pngBuffer.readUInt32BE(offset);
    const type = pngBuffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;

    if (dataEnd > pngBuffer.length) {
      break; // Corrupted / truncated tail
    }

    if (type === "tEXt") {
      const data = pngBuffer.subarray(dataStart, dataEnd);
      const nullIdx = data.indexOf(0);
      if (nullIdx !== -1) {
        const keyword = data.toString("latin1", 0, nullIdx);
        const text = data.toString("latin1", nullIdx + 1);
        chunks[keyword] = text;
      }
    }

    offset += 12 + length;
  }

  return chunks;
}

export function extractCharacterCardFromPng(pngBuffer: Buffer): unknown {
  const metadata = extractPngMetadata(pngBuffer);

  // SillyTavern stores base64-encoded JSON in 'chara' (v2/v1) or 'ccv3' (v3)
  const encodedPayload = metadata["chara"] || metadata["ccv3"];
  if (!encodedPayload) {
    throw new Error("PNG does not contain 'chara' or 'ccv3' metadata chunks");
  }

  const jsonString = Buffer.from(encodedPayload, "base64").toString("utf-8");
  return JSON.parse(jsonString);
}
