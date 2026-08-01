import { describe, expect, it } from "vitest";
import {
  chunkSearchConsoleMetricRows,
  decryptGoogleToken,
  encryptGoogleToken,
  normalizeSearchKeyword,
} from "./search-console";

function testKey(): string {
  const bytes = new Uint8Array(32);
  bytes.forEach((_, index) => {
    bytes[index] = index + 1;
  });
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

describe("Search Console token storage", () => {
  it("encrypts refresh tokens with AES-GCM and decrypts them for Google only", async () => {
    const encrypted = await encryptGoogleToken("refresh-token-value", testKey());

    expect(encrypted).toMatch(/^v1\./);
    expect(encrypted).not.toContain("refresh-token-value");
    await expect(decryptGoogleToken(encrypted, testKey())).resolves.toBe("refresh-token-value");
  });

  it("uses a random IV for every encrypted token", async () => {
    const first = await encryptGoogleToken("same-token", testKey());
    const second = await encryptGoogleToken("same-token", testKey());

    expect(first).not.toBe(second);
  });

  it("rejects an encryption key that is not 256 bits", async () => {
    await expect(encryptGoogleToken("token", "c2hvcnQ")).rejects.toThrow(
      "GOOGLE_TOKEN_ENCRYPTION_KEY_INVALID",
    );
  });
});

describe("normalizeSearchKeyword", () => {
  it("normalizes width, whitespace, and case for duplicate detection", () => {
    expect(normalizeSearchKeyword("  ＷＥＢ   Maintenance  ")).toBe("web maintenance");
  });
});

describe("Search Console D1 writes", () => {
  it("chunks metric inserts below D1's 100 bound-parameter limit", () => {
    const rows = Array.from({ length: 30 }, (_, index) => index);

    expect(chunkSearchConsoleMetricRows(rows)).toEqual([
      rows.slice(0, 10),
      rows.slice(10, 20),
      rows.slice(20, 30),
    ]);
  });
});
