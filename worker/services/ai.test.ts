import { describe, expect, it } from "vitest";
import { parseRewriteResponse } from "./ai";

const rewrite = {
  clientSummary: "Optimized public assets and verified the homepage.",
  category: "performance",
  importance: "medium",
} as const;

describe("parseRewriteResponse", () => {
  it("accepts the structured object returned by Workers AI JSON mode", () => {
    expect(parseRewriteResponse({ response: rewrite })).toEqual(rewrite);
  });

  it("accepts a JSON string response for compatibility", () => {
    expect(parseRewriteResponse({ response: JSON.stringify(rewrite) })).toEqual(rewrite);
  });

  it("accepts the OpenAI-compatible chat completion returned by GLM", () => {
    expect(
      parseRewriteResponse({
        choices: [{ message: { content: JSON.stringify(rewrite) } }],
      }),
    ).toEqual(rewrite);
  });

  it("rejects output outside the approved schema", () => {
    expect(() =>
      parseRewriteResponse({
        response: { ...rewrite, importance: "urgent" },
      }),
    ).toThrow();
  });
});
