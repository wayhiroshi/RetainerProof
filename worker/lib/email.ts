function parseSender(value: string): string | { email: string; name: string } {
  const match = value.match(/^(.*?)\s*<([^>]+)>$/);
  if (!match) return value.trim();
  return { name: match[1]?.trim() || "RetainerProof", email: match[2].trim() };
}

export async function sendTransactionalEmail(
  env: Env,
  message: { to: string; subject: string; html: string; text: string; replyTo?: string },
): Promise<{ messageId?: string; localPreview?: boolean }> {
  if (env.ENVIRONMENT !== "production") {
    console.log(JSON.stringify({ event: "email_preview", to: message.to, subject: message.subject }));
    return { localPreview: true };
  }

  const response = await env.EMAIL.send({
    to: message.to,
    from: parseSender(env.EMAIL_FROM),
    replyTo: message.replyTo,
    subject: message.subject,
    html: message.html,
    text: message.text,
  });
  return { messageId: response.messageId };
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
