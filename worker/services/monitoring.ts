import { and, eq, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { connect as connectTls } from "node:tls";
import { checkRuns, clients, managedAssets, user, workspaceMembers } from "../db/schema";
import { escapeHtml, sendTransactionalEmail } from "../lib/email";
import { assertPublicHttpUrl, UnsafeUrlError } from "../lib/url-security";

export interface MonitorMessage {
  workspaceId: string;
  assetId: string;
  attempt: number;
}

interface CheckResult {
  target: string;
  status: "passed" | "failed";
  statusCode: number | null;
  responseMs: number | null;
  tlsExpiresAt: Date | null;
  errorCode: string | null;
}

export async function enqueueDueChecks(env: Env): Promise<number> {
  const db = drizzle(env.DB);
  const due = await db
    .select({ id: managedAssets.id, workspaceId: managedAssets.workspaceId })
    .from(managedAssets)
    .where(and(eq(managedAssets.enabled, true), lte(managedAssets.nextCheckAt, new Date())))
    .limit(100);
  await Promise.all(
    due.map((asset) =>
      env.MONITOR_QUEUE.send({
        workspaceId: asset.workspaceId,
        assetId: asset.id,
        attempt: 1,
      } satisfies MonitorMessage),
    ),
  );
  return due.length;
}

export async function processMonitorMessage(env: Env, message: MonitorMessage): Promise<void> {
  const db = drizzle(env.DB);
  const asset = await db
    .select()
    .from(managedAssets)
    .where(and(eq(managedAssets.id, message.assetId), eq(managedAssets.workspaceId, message.workspaceId)))
    .get();
  if (!asset || !asset.enabled) return;

  const critical = safeJsonStringArray(asset.criticalUrlsJson).slice(0, 3);
  const targets = [asset.url, ...critical];
  const results = await Promise.all(targets.map(checkTarget));
  const checkedAt = new Date();

  await Promise.all(
    results.map((result) =>
      db.insert(checkRuns).values({
        id: crypto.randomUUID(),
        workspaceId: asset.workspaceId,
        assetId: asset.id,
        target: result.target,
        status: result.status,
        statusCode: result.statusCode,
        responseMs: result.responseMs,
        tlsExpiresAt: result.tlsExpiresAt,
        errorCode: result.errorCode,
        attempt: message.attempt,
        checkedAt,
      }).run(),
    ),
  );

  const failed = results.some((result) => result.status === "failed");
  if (failed && message.attempt === 1) {
    await env.MONITOR_QUEUE.send({ ...message, attempt: 2 }, { delaySeconds: 300 });
    return;
  }

  if (failed && message.attempt === 2) {
    const owner = await db
      .select({ email: user.email, clientName: clients.name })
      .from(workspaceMembers)
      .innerJoin(user, eq(user.id, workspaceMembers.userId))
      .innerJoin(clients, eq(clients.id, asset.clientId))
      .where(and(eq(workspaceMembers.workspaceId, asset.workspaceId), eq(workspaceMembers.role, "owner")))
      .get();
    if (owner) {
      const failures = results
        .filter((result) => result.status === "failed")
        .map((result) => `${result.target} (${result.errorCode ?? "unreachable"})`);
      try {
        await sendTransactionalEmail(env, {
          to: owner.email,
          subject: `${owner.clientName}: website check needs attention`,
          html: `<p>Two consecutive public website checks failed for ${escapeHtml(owner.clientName)}.</p><ul>${failures.map((failure) => `<li>${escapeHtml(failure)}</li>`).join("")}</ul><p>Please verify the site directly before contacting the client.</p>`,
          text: `Two consecutive public website checks failed for ${owner.clientName}.\n\n${failures.join("\n")}\n\nPlease verify the site directly before contacting the client.`,
        });
      } catch {
        console.error(JSON.stringify({ event: "monitor_alert_email_failed", workspaceId: asset.workspaceId, assetId: asset.id }));
      }
    }
  }

  await db
    .update(managedAssets)
    .set({
      nextCheckAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      updatedAt: new Date(),
    })
    .where(and(eq(managedAssets.id, asset.id), eq(managedAssets.workspaceId, asset.workspaceId)));

  console.log(
    JSON.stringify({
      event: "monitor_complete",
      workspaceId: asset.workspaceId,
      assetId: asset.id,
      attempt: message.attempt,
      failed,
    }),
  );
}

export async function checkTarget(rawUrl: string): Promise<CheckResult> {
  const started = Date.now();
  try {
    let current = await assertPublicHttpUrl(rawUrl);
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      const response = await fetch(current, {
        method: "GET",
        redirect: "manual",
        headers: {
          "User-Agent": "RetainerProof-Monitor/1.0",
          Range: "bytes=0-8191",
          Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
        },
        signal: AbortSignal.timeout(10_000),
      });
      await response.body?.cancel();
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new UnsafeUrlError("REDIRECT_WITHOUT_LOCATION");
        current = await assertPublicHttpUrl(new URL(location, current).toString());
        continue;
      }
      const tlsExpiresAt = await inspectTlsExpiry(current);
      return {
        target: rawUrl,
        status: response.ok ? "passed" : "failed",
        statusCode: response.status,
        responseMs: Date.now() - started,
        tlsExpiresAt,
        errorCode: response.ok ? null : `HTTP_${response.status}`,
      };
    }
    throw new UnsafeUrlError("TOO_MANY_REDIRECTS");
  } catch (error) {
    const code =
      error instanceof UnsafeUrlError
        ? error.code
        : error instanceof Error && error.name === "TimeoutError"
          ? "TIMEOUT"
          : "NETWORK_ERROR";
    return {
      target: rawUrl,
      status: "failed",
      statusCode: null,
      responseMs: Date.now() - started,
      tlsExpiresAt: null,
      errorCode: code,
    };
  }
}

async function inspectTlsExpiry(url: URL): Promise<Date | null> {
  if (url.protocol !== "https:") return null;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: Date | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const socket = connectTls(
        {
          host: url.hostname,
          port: url.port ? Number(url.port) : 443,
          servername: url.hostname,
          rejectUnauthorized: true,
        },
        () => {
          const certificate = socket.getPeerCertificate();
          const expiresAt = certificate.valid_to ? new Date(certificate.valid_to) : null;
          socket.destroy();
          finish(expiresAt && !Number.isNaN(expiresAt.getTime()) ? expiresAt : null);
        },
      );
      socket.setTimeout(8_000, () => socket.destroy(new Error("TLS_TIMEOUT")));
      socket.once("error", () => finish(null));
      socket.once("close", () => finish(null));
    } catch {
      finish(null);
    }
  });
}

function safeJsonStringArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
