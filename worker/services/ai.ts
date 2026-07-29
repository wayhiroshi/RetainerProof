import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";
import { aiRewrites } from "../db/schema";
import type { Locale } from "../lib/locale";

const rewriteOutputSchema = z.object({
  clientSummary: z.string().min(1).max(500),
  category: z.enum(["updates", "backups", "security", "fixes", "content", "performance", "forms", "support", "other"]),
  importance: z.enum(["low", "medium", "high"]),
});

export type RewriteOutput = z.infer<typeof rewriteOutputSchema>;

export async function rewriteForClient(
  env: Env,
  input: { workspaceId: string; userId: string; sourceText: string; locale?: Locale; context?: string },
): Promise<{ rewriteId: string; result: RewriteOutput }> {
  const db = drizzle(env.DB);
  const rewriteId = crypto.randomUUID();
  const safeSource = input.sourceText.trim().slice(0, 1_500);
  const safeContext = input.context?.trim().slice(0, 200);
  try {
    const response = await withTimeout(env.AI.run("@cf/zai-org/glm-4.7-flash", {
      messages: [
        {
          role: "system",
          content: `Rewrite technical website maintenance notes as concise, calm ${
            input.locale === "ja" ? "Japanese" : "English"
          } for a non-technical client. State only completed facts. Do not invent results, risk, time saved, security claims, or business impact. Return only a JSON object with the keys "clientSummary", "category", and "importance".`,
        },
        {
          role: "user",
          content: `${safeContext ? `Context: ${safeContext}\n` : ""}Maintenance note: ${safeSource}`,
        },
      ],
      max_completion_tokens: 220,
      temperature: 0.2,
      chat_template_kwargs: { enable_thinking: false },
    }), 15_000);
    const result = parseRewriteResponse(response);
    await db.insert(aiRewrites).values({
      id: rewriteId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      sourceText: safeSource,
      generatedJson: JSON.stringify(result),
      status: "generated",
      createdAt: new Date(),
    });
    return { rewriteId, result };
  } catch (error) {
    await db.insert(aiRewrites).values({
      id: rewriteId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      sourceText: safeSource,
      status: "failed",
      errorCode: classifyAiError(error),
      createdAt: new Date(),
    });
    throw new Error("AI_REWRITE_FAILED");
  }
}

export function parseRewriteResponse(response: unknown): RewriteOutput {
  if (typeof response === "string") {
    return rewriteOutputSchema.parse(parseJsonText(response));
  }
  if (response && typeof response === "object") {
    const record = response as Record<string, unknown>;
    if (typeof record.response === "string") {
      return rewriteOutputSchema.parse(parseJsonText(record.response));
    }
    if (record.response && typeof record.response === "object") {
      return rewriteOutputSchema.parse(record.response);
    }
    if (typeof record.result === "string") {
      return rewriteOutputSchema.parse(parseJsonText(record.result));
    }
    if (record.result && typeof record.result === "object") {
      return rewriteOutputSchema.parse(record.result);
    }
    const choices = record.choices;
    if (Array.isArray(choices)) {
      const firstChoice = choices[0];
      if (firstChoice && typeof firstChoice === "object") {
        const message = (firstChoice as Record<string, unknown>).message;
        if (message && typeof message === "object") {
          const content = (message as Record<string, unknown>).content;
          if (typeof content === "string") {
            return rewriteOutputSchema.parse(parseJsonText(content));
          }
        }
      }
    }
  }
  throw new Error("AI_RESPONSE_INVALID");
}

function parseJsonText(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return JSON.parse(fenced?.[1] ?? trimmed);
}

function classifyAiError(error: unknown): string {
  if (error instanceof z.ZodError) return "SCHEMA_INVALID";
  if (error instanceof SyntaxError) return "JSON_INVALID";
  if (error instanceof Error && error.message === "AI_TIMEOUT") return "TIMEOUT";
  if (error instanceof Error && error.message === "AI_RESPONSE_INVALID") return "RESPONSE_INVALID";
  return "PROVIDER_ERROR";
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("AI_TIMEOUT")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
