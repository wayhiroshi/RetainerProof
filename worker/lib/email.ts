const RESEND_EMAILS_URL = "https://api.resend.com/emails";

interface EmailEnvironment {
  ENVIRONMENT: string;
  EMAIL_FROM: string;
  EMAIL_REPLY_TO?: string;
  RESEND_API_KEY?: string;
}

interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  idempotencyKey?: string;
}

async function defaultIdempotencyKey(env: EmailEnvironment, message: EmailMessage): Promise<string> {
  const input = [
    env.EMAIL_FROM,
    message.to,
    message.replyTo ?? env.EMAIL_REPLY_TO ?? "",
    message.subject,
    message.text,
  ].join("\n");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `retainerproof/${hash}`;
}

export async function sendTransactionalEmail(
  env: EmailEnvironment,
  message: EmailMessage,
  fetchImpl: typeof fetch = fetch,
): Promise<{ messageId?: string; localPreview?: boolean }> {
  if (env.ENVIRONMENT !== "production") {
    console.log(JSON.stringify({ event: "email_preview", to: message.to, subject: message.subject }));
    return { localPreview: true };
  }

  if (!env.RESEND_API_KEY) {
    throw new Error("EMAIL_PROVIDER_NOT_CONFIGURED");
  }

  const replyTo = message.replyTo ?? (env.EMAIL_REPLY_TO?.trim() || undefined);
  const response = await fetchImpl(RESEND_EMAILS_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
      "idempotency-key": message.idempotencyKey ?? await defaultIdempotencyKey(env, message),
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [message.to],
      ...(replyTo ? { reply_to: replyTo } : {}),
      subject: message.subject,
      html: message.html,
      text: message.text,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }

  const messageId =
    typeof payload === "object" &&
    payload !== null &&
    "id" in payload &&
    typeof payload.id === "string"
      ? payload.id
      : undefined;

  if (!response.ok) {
    throw new Error(`EMAIL_PROVIDER_ERROR_${response.status}`);
  }
  if (!messageId) {
    throw new Error("EMAIL_PROVIDER_INVALID_RESPONSE");
  }

  return { messageId };
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
