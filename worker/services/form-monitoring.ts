import { and, eq, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { formCheckRuns, formMonitors, user, workspaceMembers } from "../db/schema";
import { escapeHtml, sendTransactionalEmail } from "../lib/email";
import { assertPublicHttpUrl, UnsafeUrlError } from "../lib/url-security";

const MAX_HTML_BYTES = 256 * 1024;
const MAX_REDIRECTS = 3;
const PRESENCE_TIMEOUT_MS = 10_000;

export interface FormPresenceMessage {
  type: "form_presence_check";
  workspaceId: string;
  monitorId: string;
  attempt: 1 | 2;
}

export interface FormPresenceResult {
  passed: boolean;
  pageReachable: boolean;
  formPresent: boolean;
  turnstileScriptPresent: boolean;
  turnstileWidgetPresent: boolean;
  submitControlPresent: boolean;
  requiredFieldsPresent: boolean;
  statusCode: number | null;
  durationMs: number;
  errorCode: string | null;
}

export async function enqueueDueFormPresenceChecks(env: Env): Promise<number> {
  const db = drizzle(env.DB);
  const due = await db
    .select({
      id: formMonitors.id,
      workspaceId: formMonitors.workspaceId,
      intervalHours: formMonitors.intervalHours,
    })
    .from(formMonitors)
    .where(and(eq(formMonitors.enabled, true), lte(formMonitors.nextPresenceCheckAt, new Date())))
    .limit(100);

  await Promise.all(due.map(async (monitor) => {
    await env.MONITOR_QUEUE.send({
      type: "form_presence_check",
      workspaceId: monitor.workspaceId,
      monitorId: monitor.id,
      attempt: 1,
    } satisfies FormPresenceMessage);
    await db
      .update(formMonitors)
      .set({
        nextPresenceCheckAt: new Date(Date.now() + monitor.intervalHours * 60 * 60 * 1_000),
        updatedAt: new Date(),
      })
      .where(and(eq(formMonitors.id, monitor.id), eq(formMonitors.workspaceId, monitor.workspaceId)));
  }));
  return due.length;
}

export async function createDueSubmissionTasks(env: Env): Promise<number> {
  const db = drizzle(env.DB);
  const due = await db
    .select()
    .from(formMonitors)
    .where(and(eq(formMonitors.enabled, true), lte(formMonitors.nextSubmissionCheckAt, new Date())))
    .limit(100);

  for (const monitor of due) {
    const runId = crypto.randomUUID();
    const now = new Date();
    await db.batch([
      db.insert(formCheckRuns).values({
        id: runId,
        workspaceId: monitor.workspaceId,
        monitorId: monitor.id,
        mode: "submission",
        trigger: "scheduled_submission",
        status: "pending",
        createdAt: now,
        updatedAt: now,
      }),
      db
        .update(formMonitors)
        .set({ nextSubmissionCheckAt: nextMonthlyDate(now), updatedAt: now })
        .where(and(eq(formMonitors.id, monitor.id), eq(formMonitors.workspaceId, monitor.workspaceId))),
    ]);

    try {
      await sendSubmissionReminder(env, monitor.workspaceId, monitor.name, runId);
    } catch {
      console.error(JSON.stringify({
        event: "form_submission_reminder_failed",
        monitorId: monitor.id,
        provider: "resend",
      }));
    }
  }
  return due.length;
}

export async function sendSubmissionFailureAlert(
  env: Env,
  workspaceId: string,
  monitorId: string,
  monitorName: string,
  failedCheckpoints: string[],
) {
  const owner = await ownerForWorkspace(env, workspaceId);
  if (!owner) return;
  const labels = failedCheckpoints.slice(0, 4).join(", ");
  await sendTransactionalEmail(env, {
    to: owner.email,
    subject: `${monitorName}: supervised form test needs attention`,
    html: `<p>The supervised form test for <strong>${escapeHtml(monitorName)}</strong> recorded one or more failed checkpoints.</p><p>Checkpoints: ${escapeHtml(labels)}</p><p>Review the form and mail flow without storing submitted data in RetainerProof.</p>`,
    text: `The supervised form test for ${monitorName} recorded one or more failed checkpoints.\n\nCheckpoints: ${labels}\n\nReview the form and mail flow without storing submitted data in RetainerProof.`,
    idempotencyKey: `form-submission-failed/${monitorId}/${labels}`,
  });
}

export async function processFormPresenceMessage(env: Env, message: FormPresenceMessage): Promise<void> {
  const db = drizzle(env.DB);
  const monitor = await db
    .select()
    .from(formMonitors)
    .where(and(eq(formMonitors.id, message.monitorId), eq(formMonitors.workspaceId, message.workspaceId)))
    .get();
  if (!monitor || !monitor.enabled) return;

  const startedAt = new Date();
  const result = await checkFormPresence(monitor.url, {
    formType: monitor.formType,
    requireTurnstile: monitor.requireTurnstile,
  });
  const completedAt = new Date();
  await db.insert(formCheckRuns).values({
    id: crypto.randomUUID(),
    workspaceId: monitor.workspaceId,
    monitorId: monitor.id,
    mode: "presence",
    trigger: "scheduled_presence",
    status: result.passed ? "passed" : "failed",
    attempt: message.attempt,
    pageReachable: result.pageReachable,
    formPresent: result.formPresent,
    turnstileScriptPresent: result.turnstileScriptPresent,
    turnstileWidgetPresent: result.turnstileWidgetPresent,
    submitControlPresent: result.submitControlPresent,
    requiredFieldsPresent: result.requiredFieldsPresent,
    statusCode: result.statusCode,
    durationMs: result.durationMs,
    errorCode: result.errorCode,
    startedAt,
    completedAt,
    createdAt: completedAt,
    updatedAt: completedAt,
  });

  console.log(JSON.stringify({
    event: "form_presence_check",
    monitorId: monitor.id,
    outcome: result.passed ? "passed" : "failed",
    reason: result.errorCode ?? "healthy",
    status: result.statusCode ?? 0,
    durationMs: result.durationMs,
    attempt: message.attempt,
  }));

  if (!result.passed && message.attempt === 1) {
    await env.MONITOR_QUEUE.send({ ...message, attempt: 2 }, { delaySeconds: 300 });
    return;
  }

  if (!result.passed) {
    if (!monitor.incidentOpenedAt) {
      await sendPresenceAlert(env, monitor.workspaceId, monitor.id, monitor.name, result.errorCode ?? "FORM_CHECK_FAILED");
      await db
        .update(formMonitors)
        .set({ incidentOpenedAt: completedAt, updatedAt: completedAt })
        .where(and(eq(formMonitors.id, monitor.id), eq(formMonitors.workspaceId, monitor.workspaceId)));
    }
    return;
  }

  if (monitor.incidentOpenedAt) {
    await sendPresenceRecovery(env, monitor.workspaceId, monitor.id, monitor.name);
  }
  await db
    .update(formMonitors)
    .set({
      lastPresencePassedAt: completedAt,
      incidentOpenedAt: null,
      ...(monitor.incidentOpenedAt ? { lastRecoveredAt: completedAt } : {}),
      updatedAt: completedAt,
    })
    .where(and(eq(formMonitors.id, monitor.id), eq(formMonitors.workspaceId, monitor.workspaceId)));
}

export async function checkFormPresence(
  rawUrl: string,
  profile: { formType: "contact_form_7" | "generic"; requireTurnstile: boolean },
  fetchImpl: typeof fetch = fetch,
): Promise<FormPresenceResult> {
  const started = Date.now();
  try {
    let current = await assertPublicHttpUrl(rawUrl);
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      const response = await fetchImpl(current, {
        method: "GET",
        redirect: "manual",
        headers: {
          Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
          Range: `bytes=0-${MAX_HTML_BYTES - 1}`,
          "User-Agent": "RetainerProof-Form-Observer/1.0",
        },
        signal: AbortSignal.timeout(PRESENCE_TIMEOUT_MS),
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location) throw new UnsafeUrlError("REDIRECT_WITHOUT_LOCATION");
        current = await assertPublicHttpUrl(new URL(location, current).toString());
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        return failedPresence(Date.now() - started, `HTTP_${response.status}`, response.status);
      }
      const html = await readBoundedText(response, MAX_HTML_BYTES);
      const evidence = detectFormEvidence(html, profile.formType);
      const passed = evidence.formPresent && evidence.submitControlPresent && evidence.requiredFieldsPresent && (
        !profile.requireTurnstile || (evidence.turnstileScriptPresent && evidence.turnstileWidgetPresent)
      );
      return {
        passed,
        pageReachable: true,
        ...evidence,
        statusCode: response.status,
        durationMs: Date.now() - started,
        errorCode: passed ? null : classifyEvidenceFailure(evidence, profile.requireTurnstile),
      };
    }
    throw new UnsafeUrlError("TOO_MANY_REDIRECTS");
  } catch (error) {
    const code = error instanceof UnsafeUrlError
      ? error.code
      : error instanceof Error && error.message === "FORM_RESPONSE_TOO_LARGE"
        ? "FORM_RESPONSE_TOO_LARGE"
        : error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
          ? "TIMEOUT"
          : "NETWORK_ERROR";
    return failedPresence(Date.now() - started, code, null);
  }
}

export function detectFormEvidence(html: string, formType: "contact_form_7" | "generic") {
  const normalized = html.toLowerCase();
  const genericForm = /<form(?:\s|>)/i.test(html);
  const contactForm7 = normalized.includes("wpcf7-form") || normalized.includes("data-wpcf7-id");
  return {
    formPresent: formType === "contact_form_7" ? contactForm7 : genericForm,
    turnstileScriptPresent:
      normalized.includes("challenges.cloudflare.com/turnstile") ||
      normalized.includes("turnstile/v0/api.js"),
    turnstileWidgetPresent:
      normalized.includes("cf-turnstile") ||
      /data-sitekey\s*=/.test(normalized),
    submitControlPresent:
      /<(?:button|input)[^>]*\btype\s*=\s*["']?submit\b/i.test(html) ||
      /<button[^>]*>[^<]*(?:send|submit|送信)/i.test(html),
    requiredFieldsPresent:
      /<(?:input|textarea|select)[^>]*(?:\brequired\b|aria-required\s*=\s*["']true["'])/i.test(html) ||
      normalized.includes("wpcf7-validates-as-required"),
  };
}

function classifyEvidenceFailure(
  evidence: ReturnType<typeof detectFormEvidence>,
  requireTurnstile: boolean,
): string {
  if (!evidence.formPresent) return "FORM_NOT_FOUND";
  if (!evidence.submitControlPresent) return "SUBMIT_CONTROL_NOT_FOUND";
  if (!evidence.requiredFieldsPresent) return "REQUIRED_FIELDS_NOT_FOUND";
  if (requireTurnstile && !evidence.turnstileScriptPresent) return "TURNSTILE_SCRIPT_NOT_FOUND";
  if (requireTurnstile && !evidence.turnstileWidgetPresent) return "TURNSTILE_WIDGET_NOT_FOUND";
  return "FORM_CHECK_FAILED";
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (declaredLength > maxBytes) {
    await response.body?.cancel();
    throw new Error("FORM_RESPONSE_TOO_LARGE");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) throw new Error("FORM_RESPONSE_TOO_LARGE");
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function failedPresence(durationMs: number, errorCode: string, statusCode: number | null): FormPresenceResult {
  return {
    passed: false,
    pageReachable: false,
    formPresent: false,
    turnstileScriptPresent: false,
    turnstileWidgetPresent: false,
    submitControlPresent: false,
    requiredFieldsPresent: false,
    statusCode,
    durationMs,
    errorCode,
  };
}

function nextMonthlyDate(from: Date): Date {
  const next = new Date(from);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
}

async function ownerForWorkspace(env: Env, workspaceId: string) {
  return drizzle(env.DB)
    .select({ email: user.email })
    .from(workspaceMembers)
    .innerJoin(user, eq(user.id, workspaceMembers.userId))
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, "owner")))
    .get();
}

async function sendPresenceAlert(
  env: Env,
  workspaceId: string,
  monitorId: string,
  monitorName: string,
  reason: string,
) {
  const owner = await ownerForWorkspace(env, workspaceId);
  if (!owner) return;
  await sendTransactionalEmail(env, {
    to: owner.email,
    subject: `${monitorName}: form check needs attention`,
    html: `<p>Two consecutive non-submitting form checks failed for <strong>${escapeHtml(monitorName)}</strong>.</p><p>Reason: ${escapeHtml(reason)}</p><p>Open RetainerProof and verify the form manually before contacting the client.</p>`,
    text: `Two consecutive non-submitting form checks failed for ${monitorName}.\n\nReason: ${reason}\n\nOpen RetainerProof and verify the form manually before contacting the client.`,
    idempotencyKey: `form-presence-alert/${monitorId}/${reason}`,
  });
}

async function sendPresenceRecovery(env: Env, workspaceId: string, monitorId: string, monitorName: string) {
  const owner = await ownerForWorkspace(env, workspaceId);
  if (!owner) return;
  await sendTransactionalEmail(env, {
    to: owner.email,
    subject: `${monitorName}: form check recovered`,
    html: `<p>The latest non-submitting check passed for <strong>${escapeHtml(monitorName)}</strong>.</p><p>This confirms the public form markers are visible again; it does not confirm email delivery.</p>`,
    text: `The latest non-submitting check passed for ${monitorName}.\n\nThis confirms the public form markers are visible again; it does not confirm email delivery.`,
    idempotencyKey: `form-presence-recovery/${monitorId}`,
  });
}

async function sendSubmissionReminder(env: Env, workspaceId: string, monitorName: string, runId: string) {
  const owner = await ownerForWorkspace(env, workspaceId);
  if (!owner) return;
  await sendTransactionalEmail(env, {
    to: owner.email,
    subject: `${monitorName}: supervised form test is due`,
    html: `<p>A supervised real-submission check is due for <strong>${escapeHtml(monitorName)}</strong>.</p><p>Test ID: ${escapeHtml(runId)}</p><p>Use dedicated test data outside RetainerProof and complete Turnstile normally. Record only checkpoint states and times.</p>`,
    text: `A supervised real-submission check is due for ${monitorName}.\n\nTest ID: ${runId}\n\nUse dedicated test data outside RetainerProof and complete Turnstile normally. Record only checkpoint states and times.`,
    idempotencyKey: `form-submission-reminder/${runId}`,
  });
}
