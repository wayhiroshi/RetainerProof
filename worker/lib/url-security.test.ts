import { describe, expect, it } from "vitest";
import { assertPublicHttpUrl, isPrivateIp, UnsafeUrlError } from "./url-security";

describe("isPrivateIp", () => {
  it.each(["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.4", "169.254.169.254", "::1", "fd00::1", "::ffff:10.0.0.1", "::ffff:a00:1"])(
    "rejects %s",
    (value) => expect(isPrivateIp(value)).toBe(true),
  );

  it.each(["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"])("allows %s", (value) =>
    expect(isPrivateIp(value)).toBe(false),
  );
});

describe("assertPublicHttpUrl", () => {
  it.each([
    ["http://localhost", "PRIVATE_HOST"],
    ["http://127.0.0.1", "PRIVATE_IP"],
    ["http://169.254.169.254/latest/meta-data", "PRIVATE_IP"],
    ["http://user:password@example.com", "CREDENTIALS_NOT_ALLOWED"],
    ["ftp://example.com", "UNSUPPORTED_PROTOCOL"],
    ["https://example.com:8443", "PORT_NOT_ALLOWED"],
  ])("rejects %s", async (url, code) => {
    await expect(assertPublicHttpUrl(url)).rejects.toEqual(expect.objectContaining<Partial<UnsafeUrlError>>({ code }));
  });

  it("normalizes disguised IPv4 literals before checking", async () => {
    await expect(assertPublicHttpUrl("http://2130706433")).rejects.toEqual(
      expect.objectContaining<Partial<UnsafeUrlError>>({ code: "PRIVATE_IP" }),
    );
  });
});
