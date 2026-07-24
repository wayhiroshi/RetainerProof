import { z } from "zod";

const ipV4Part = z.coerce.number().int().min(0).max(255);

export class UnsafeUrlError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "UnsafeUrlError";
  }
}

export async function assertPublicHttpUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError("INVALID_URL");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new UnsafeUrlError("UNSUPPORTED_PROTOCOL");
  if (url.username || url.password) throw new UnsafeUrlError("CREDENTIALS_NOT_ALLOWED");
  if (url.port && !["80", "443"].includes(url.port)) throw new UnsafeUrlError("PORT_NOT_ALLOWED");

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new UnsafeUrlError("PRIVATE_HOST");
  }

  if (isPrivateIp(hostname)) throw new UnsafeUrlError("PRIVATE_IP");
  if (!isIpLiteral(hostname)) await assertDnsIsPublic(hostname);
  return url;
}

export function isPrivateIp(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (normalized.includes(":")) {
    if (normalized.startsWith("::ffff:")) {
      const mapped = normalized.slice("::ffff:".length);
      if (mapped.includes(".")) return isPrivateIp(mapped);
      const [high, low] = mapped.split(":").map((part) => Number.parseInt(part || "0", 16));
      if (Number.isFinite(high) && Number.isFinite(low)) {
        return isPrivateIp(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
      }
    }
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb")
    );
  }
  const parts = normalized.split(".");
  if (parts.length !== 4 || parts.some((part) => !ipV4Part.safeParse(part).success)) return false;
  const [a, b] = parts.map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isIpLiteral(hostname: string): boolean {
  return hostname.includes(":") || hostname.split(".").length === 4;
}

async function assertDnsIsPublic(hostname: string): Promise<void> {
  const records = await Promise.all([resolveDns(hostname, "A"), resolveDns(hostname, "AAAA")]);
  const addresses = records.flat();
  if (addresses.length === 0) throw new UnsafeUrlError("DNS_NOT_FOUND");
  if (addresses.some(isPrivateIp)) throw new UnsafeUrlError("PRIVATE_DNS_RESULT");
}

async function resolveDns(hostname: string, type: "A" | "AAAA"): Promise<string[]> {
  const endpoint = new URL("https://cloudflare-dns.com/dns-query");
  endpoint.searchParams.set("name", hostname);
  endpoint.searchParams.set("type", type);
  const response = await fetch(endpoint, {
    headers: { Accept: "application/dns-json" },
    signal: AbortSignal.timeout(4_000),
  });
  if (!response.ok) return [];
  const body = (await response.json()) as { Answer?: Array<{ type: number; data: string }> };
  const expected = type === "A" ? 1 : 28;
  return (body.Answer ?? []).filter((answer) => answer.type === expected).map((answer) => answer.data);
}
