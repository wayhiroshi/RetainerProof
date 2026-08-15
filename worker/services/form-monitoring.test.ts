import { describe, expect, it } from "vitest";
import { checkFormPresence, detectFormEvidence } from "./form-monitoring";

const cf7Html = `<!doctype html><html><head>
  <script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>
</head><body>
  <form class="wpcf7-form">
    <input name="name" required />
    <div class="cf-turnstile" data-sitekey="public-site-key"></div>
    <button type="submit">Send</button>
  </form>
</body></html>`;

describe("form presence evidence", () => {
  it("recognizes Contact Form 7 and Turnstile markers without submitting", () => {
    expect(detectFormEvidence(cf7Html, "contact_form_7")).toEqual({
      formPresent: true,
      turnstileScriptPresent: true,
      turnstileWidgetPresent: true,
      submitControlPresent: true,
      requiredFieldsPresent: true,
    });
  });

  it("fails safely when a required Turnstile widget marker is missing", async () => {
    const result = await checkFormPresence(
      "https://example.com/contact",
      { formType: "contact_form_7", requireTurnstile: true },
      async () => new Response(
        cf7Html.replace("cf-turnstile", "challenge-placeholder").replace("data-sitekey", "data-widget"),
        {
        headers: { "content-type": "text/html" },
        },
      ),
    );
    expect(result.passed).toBe(false);
    expect(result.errorCode).toBe("TURNSTILE_WIDGET_NOT_FOUND");
  });

  it("rejects oversized HTML without reading or storing the body", async () => {
    const result = await checkFormPresence(
      "https://example.com/contact",
      { formType: "generic", requireTurnstile: false },
      async () => new Response("small", { headers: { "content-length": String(256 * 1024 + 1) } }),
    );
    expect(result.passed).toBe(false);
    expect(result.errorCode).toBe("FORM_RESPONSE_TOO_LARGE");
  });

  it("revalidates redirect targets and blocks private addresses", async () => {
    const result = await checkFormPresence(
      "https://example.com/contact",
      { formType: "generic", requireTurnstile: false },
      async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }),
    );
    expect(result.passed).toBe(false);
    expect(result.errorCode).toBe("PRIVATE_IP");
  });

  it("passes a generic form with required and submit controls", async () => {
    let request: RequestInit | undefined;
    const result = await checkFormPresence(
      "https://example.com/contact",
      { formType: "generic", requireTurnstile: false },
      async (_url, init) => {
        request = init;
        return new Response('<form><input required><input type="submit"></form>');
      },
    );
    expect(result.passed).toBe(true);
    expect(result.pageReachable).toBe(true);
    expect(request).toMatchObject({ method: "GET", redirect: "manual" });
    expect(new Headers(request?.headers).get("range")).toBe("bytes=0-262143");
    expect(request?.body).toBeUndefined();
  });
});
