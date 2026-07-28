import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import Stripe from "stripe";

test("one workspace cannot read or write another workspace data", async ({ browser, baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Database mutation runs once.");
  const suffix = randomUUID();
  const userA = `user-a-${suffix}`;
  const userB = `user-b-${suffix}`;
  const workspaceA = `workspace-a-${suffix}`;
  const workspaceB = `workspace-b-${suffix}`;
  const clientA = `client-a-${suffix}`;
  const clientB = `client-b-${suffix}`;
  const reportB = `report-b-${suffix}`;
  const reportA = `report-a-${suffix}`;
  const shareTokenA = `share-a-${suffix}`;
  const shareTokenHashA = createHash("sha256").update(shareTokenA).digest("base64url");
  const magicTokenA = `magic-a-${suffix}`;
  const magicIdentifierA = createHash("sha256").update(magicTokenA).digest("base64url");
  const emailA = `a-${suffix}@example.com`;
  const magicValueA = JSON.stringify({ email: emailA, name: "Workspace A" }).replaceAll("'", "''");
  const now = Math.floor(Date.now() / 1_000);
  const later = now + 30 * 24 * 60 * 60;
  const snapshotA = JSON.stringify({
    appName: "RetainerProof",
    client: { name: "Visible Client" },
    period: { start: new Date((now - 86400) * 1000).toISOString(), end: new Date(now * 1000).toISOString(), label: "Test period" },
    executiveSummary: "A finalized report.",
    currentHealth: { passed: 1, total: 1, averageResponseMs: 120, status: "Healthy" },
    workCompleted: [],
    problemsPrevented: [],
    recommendations: [],
    closingMessage: "Everything was reviewed.",
    generatedAt: new Date(now * 1000).toISOString(),
  }).replaceAll("'", "''");

  executeLocalSql(`
    INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES
      ('${userA}','Workspace A','${emailA}',1,${now},${now}),
      ('${userB}','Workspace B','b-${suffix}@example.com',1,${now},${now});
    INSERT INTO verification (id,identifier,value,expires_at,created_at,updated_at)
      VALUES ('${randomUUID()}','${magicIdentifierA}','${magicValueA}',${later},${now},${now});
    INSERT INTO workspaces (id,name,timezone,plan,created_at,updated_at) VALUES
      ('${workspaceA}','Workspace A','UTC','starter',${now},${now}),
      ('${workspaceB}','Workspace B','UTC','starter',${now},${now});
    INSERT INTO workspace_members (id,workspace_id,user_id,role,created_at) VALUES
      ('${randomUUID()}','${workspaceA}','${userA}','owner',${now}),
      ('${randomUUID()}','${workspaceB}','${userB}','owner',${now});
    INSERT INTO subscriptions (id,workspace_id,status,plan,created_at,updated_at) VALUES
      ('${randomUUID()}','${workspaceA}','unpaid','starter',${now},${now}),
      ('${randomUUID()}','${workspaceB}','active','starter',${now},${now});
    INSERT INTO clients (id,workspace_id,name,status,created_at,updated_at) VALUES
      ('${clientA}','${workspaceA}','Visible Client','active',${now},${now}),
      ('${clientB}','${workspaceB}','Hidden Client','active',${now},${now});
    INSERT INTO reports (id,workspace_id,client_id,period_start,period_end,status,current_revision,created_at,updated_at)
      VALUES
      ('${reportB}','${workspaceB}','${clientB}',${now - 86400},${now},'draft',1,${now},${now}),
      ('${reportA}','${workspaceA}','${clientA}',${now - 86400},${now},'finalized',1,${now},${now});
    UPDATE reports SET share_token_hash='${shareTokenHashA}',finalized_at=${now} WHERE id='${reportA}';
    INSERT INTO report_revisions (id,workspace_id,report_id,revision,snapshot_json,created_at)
      VALUES
      ('${randomUUID()}','${workspaceB}','${reportB}',1,'{}',${now}),
      ('${randomUUID()}','${workspaceA}','${reportA}',1,'${snapshotA}',${now});
  `);

  const context = await browser.newContext();
  const request = context.request;
  const verifyUrl = new URL("/api/auth/magic-link/verify", baseURL);
  verifyUrl.searchParams.set("token", magicTokenA);
  verifyUrl.searchParams.set("callbackURL", "/app");
  verifyUrl.searchParams.set("errorCallbackURL", "/login");
  const verificationResponse = await request.get(verifyUrl.toString(), { maxRedirects: 0 });
  expect(verificationResponse.status()).toBe(302);
  expect(verificationResponse.headers().location).toBe(`${baseURL}/app`);

  const webhookPayload = JSON.stringify({
    id: `evt_${suffix}`,
    object: "event",
    api_version: "2025-03-31.basil",
    created: now,
    data: {
      object: {
        id: `cs_${suffix}`,
        object: "checkout.session",
        client_reference_id: workspaceA,
        customer: `cus_${suffix}`,
        subscription: `sub_${suffix}`,
        payment_status: "paid",
        metadata: { workspaceId: workspaceA, plan: "starter" },
      },
    },
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type: "checkout.session.completed",
  });
  const stripeSignature = Stripe.webhooks.generateTestHeaderString({
    payload: webhookPayload,
    secret: "whsec_not_configured",
  });
  for (let delivery = 0; delivery < 2; delivery += 1) {
    const webhookResponse = await request.post(`${baseURL}/api/billing/webhook`, {
      data: webhookPayload,
      headers: {
        "content-type": "application/json",
        "stripe-signature": stripeSignature,
      },
    });
    expect(webhookResponse.status()).toBe(200);
  }

  const meResponse = await request.get(`${baseURL}/api/me`);
  expect(meResponse.status()).toBe(200);
  const mePayload = (await meResponse.json()) as { subscription: { status: string } };
  expect(mePayload.subscription.status).toBe("active");

  const clientResponse = await request.get(`${baseURL}/api/clients`);
  expect(clientResponse.status()).toBe(200);
  const clientPayload = (await clientResponse.json()) as { clients: Array<{ id: string; name: string }> };
  expect(clientPayload.clients.map((client) => client.id)).toEqual([clientA]);
  expect(clientPayload.clients.some((client) => client.name === "Hidden Client")).toBe(false);

  const crossWorkspaceWrite = await request.post(`${baseURL}/api/activities`, {
    data: {
      clientId: clientB,
      category: "updates",
      visibility: "client_visible",
      clientDescription: "This must not be stored.",
    },
    headers: { origin: baseURL ?? "http://localhost:5173" },
  });
  expect(crossWorkspaceWrite.status()).toBeGreaterThanOrEqual(400);

  const crossWorkspaceReport = await request.get(`${baseURL}/api/reports/${reportB}`);
  expect(crossWorkspaceReport.status()).toBe(404);

  const immutableEdit = await request.put(`${baseURL}/api/reports/${reportA}`, {
    data: {
      executiveSummary: "Attempted overwrite.",
      workCompleted: [],
      problemsPrevented: [],
      recommendations: [],
      closingMessage: "Attempted overwrite.",
    },
    headers: { origin: baseURL ?? "http://localhost:5173" },
  });
  expect(immutableEdit.status()).toBe(409);

  const publicBeforeRevoke = await request.get(`${baseURL}/api/public/reports/${shareTokenA}`);
  expect(publicBeforeRevoke.status()).toBe(200);
  const guessedToken = await request.get(`${baseURL}/api/public/reports/${shareTokenA}-wrong`);
  expect(guessedToken.status()).toBe(404);

  const revoke = await request.post(`${baseURL}/api/reports/${reportA}/revoke`, {
    headers: { origin: baseURL ?? "http://localhost:5173" },
  });
  expect(revoke.status()).toBe(200);
  const publicAfterRevoke = await request.get(`${baseURL}/api/public/reports/${shareTokenA}`);
  expect(publicAfterRevoke.status()).toBe(404);

  const asyncFailurePayload = JSON.stringify({
    id: `evt_async_failed_${suffix}`,
    object: "event",
    api_version: "2026-06-24.dahlia",
    created: now,
    data: {
      object: {
        id: `cs_async_failed_${suffix}`,
        object: "checkout.session",
        client_reference_id: workspaceA,
        customer: `cus_${suffix}`,
        subscription: `sub_${suffix}`,
        payment_status: "unpaid",
        metadata: { workspaceId: workspaceA, plan: "starter" },
      },
    },
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type: "checkout.session.async_payment_failed",
  });
  const asyncFailureSignature = Stripe.webhooks.generateTestHeaderString({
    payload: asyncFailurePayload,
    secret: "whsec_not_configured",
  });
  const asyncFailureWebhook = await request.post(`${baseURL}/api/billing/webhook`, {
    data: asyncFailurePayload,
    headers: {
      "content-type": "application/json",
      "stripe-signature": asyncFailureSignature,
    },
  });
  expect(asyncFailureWebhook.status()).toBe(200);
  expect((await request.get(`${baseURL}/api/clients`)).status()).toBe(402);

  for (const [status, expectedAccess] of [["past_due", 200], ["canceled", 402]] as const) {
    const subscriptionPayload = JSON.stringify({
      id: `evt_${status}_${suffix}`,
      object: "event",
      created: now,
      data: {
        object: {
          id: `sub_${suffix}`,
          object: "subscription",
          status,
          metadata: { workspaceId: workspaceA, plan: "starter" },
          items: {
            data: [{ current_period_end: later }],
          },
        },
      },
      livemode: false,
      pending_webhooks: 1,
      request: null,
      type: "customer.subscription.updated",
    });
    const subscriptionSignature = Stripe.webhooks.generateTestHeaderString({
      payload: subscriptionPayload,
      secret: "whsec_not_configured",
    });
    const subscriptionWebhook = await request.post(`${baseURL}/api/billing/webhook`, {
      data: subscriptionPayload,
      headers: {
        "content-type": "application/json",
        "stripe-signature": subscriptionSignature,
      },
    });
    expect(subscriptionWebhook.status()).toBe(200);
    const statusResponse = await request.get(`${baseURL}/api/me`);
    const statusPayload = (await statusResponse.json()) as { subscription: { status: string } };
    expect(statusPayload.subscription.status).toBe(status);
    expect((await request.get(`${baseURL}/api/clients`)).status()).toBe(expectedAccess);
  }

  await context.close();
});

function executeLocalSql(sql: string): void {
  execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "retainerproof-local", "--local", "--command", sql.replace(/\s+/g, " ").trim()],
    { cwd: process.cwd(), stdio: "ignore" },
  );
}
