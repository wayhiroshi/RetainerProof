import { describe, expect, it, vi } from "vitest";
import { sendTransactionalEmail } from "./email";

const productionEnv = {
  ENVIRONMENT: "production",
  EMAIL_FROM: "RetainerProof <retainerproof@notify.aether42.com>",
  EMAIL_REPLY_TO: "support@example.com",
  RESEND_API_KEY: "re_test",
};

const message = {
  to: "client@example.com",
  subject: "Your report is ready",
  html: "<p>View your report.</p>",
  text: "View your report.",
};

describe("sendTransactionalEmail", () => {
  it("uses the Resend API with a stable, non-identifying idempotency key", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: "email_123" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await sendTransactionalEmail(productionEnv, message, fetchMock);
    const [url, init] = fetchMock.mock.calls[0];
    const headers = init?.headers as Record<string, string>;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;

    expect(result).toEqual({ messageId: "email_123" });
    expect(url).toBe("https://api.resend.com/emails");
    expect(headers.authorization).toBe("Bearer re_test");
    expect(headers["idempotency-key"]).toMatch(/^retainerproof\/[a-f0-9]{64}$/);
    expect(headers["idempotency-key"]).not.toContain("client@example.com");
    expect(body).toEqual({
      from: productionEnv.EMAIL_FROM,
      to: ["client@example.com"],
      reply_to: "support@example.com",
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
  });

  it("does not call an external provider outside production", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const consoleMock = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const result = await sendTransactionalEmail(
      { ...productionEnv, ENVIRONMENT: "development", RESEND_API_KEY: undefined },
      message,
      fetchMock,
    );

    expect(result).toEqual({ localPreview: true });
    expect(fetchMock).not.toHaveBeenCalled();
    consoleMock.mockRestore();
  });

  it("rejects production delivery when the secret is missing", async () => {
    await expect(
      sendTransactionalEmail({ ...productionEnv, RESEND_API_KEY: undefined }, message),
    ).rejects.toThrow("EMAIL_PROVIDER_NOT_CONFIGURED");
  });

  it("returns a safe error for a failed provider response", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ message: "Domain is not verified" }), { status: 403 }),
    );

    await expect(sendTransactionalEmail(productionEnv, message, fetchMock)).rejects.toThrow(
      "EMAIL_PROVIDER_ERROR_403",
    );
  });

  it("rejects a successful response without a message id", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("not-json", { status: 200 }),
    );

    await expect(sendTransactionalEmail(productionEnv, message, fetchMock)).rejects.toThrow(
      "EMAIL_PROVIDER_INVALID_RESPONSE",
    );
  });
});
