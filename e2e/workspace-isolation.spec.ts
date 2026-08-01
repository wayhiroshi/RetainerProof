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
  const searchConnectionA = `search-connection-a-${suffix}`;
  const searchConnectionB = `search-connection-b-${suffix}`;
  const searchPropertyA = `search-property-a-${suffix}`;
  const searchPropertyB = `search-property-b-${suffix}`;
  const searchKeywordA = `search-keyword-a-${suffix}`;
  const searchKeywordB = `search-keyword-b-${suffix}`;
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
    INSERT INTO search_console_connections
      (id,workspace_id,connected_by_user_id,encrypted_refresh_token,scope,connected_at,created_at,updated_at)
      VALUES
      ('${searchConnectionA}','${workspaceA}','${userA}','test-ciphertext-a','https://www.googleapis.com/auth/webmasters.readonly',${now},${now},${now}),
      ('${searchConnectionB}','${workspaceB}','${userB}','test-ciphertext-b','https://www.googleapis.com/auth/webmasters.readonly',${now},${now},${now});
    INSERT INTO search_console_properties
      (id,workspace_id,connection_id,client_id,site_url,permission_level,last_synced_at,created_at,updated_at)
      VALUES
      ('${searchPropertyA}','${workspaceA}','${searchConnectionA}','${clientA}','sc-domain:visible.example','siteOwner',${now},${now},${now}),
      ('${searchPropertyB}','${workspaceB}','${searchConnectionB}','${clientB}','sc-domain:hidden.example','siteOwner',${now},${now},${now});
    INSERT INTO search_console_keywords
      (id,workspace_id,client_id,property_id,keyword,normalized_keyword,enabled,created_at,updated_at)
      VALUES
      ('${searchKeywordA}','${workspaceA}','${clientA}','${searchPropertyA}','website care','website care',1,${now},${now}),
      ('${searchKeywordB}','${workspaceB}','${clientB}','${searchPropertyB}','hidden query','hidden query',1,${now},${now});
    INSERT INTO search_console_daily_metrics
      (id,workspace_id,keyword_id,metric_date,clicks,impressions,ctr,position,fetched_at)
      VALUES
      ('${randomUUID()}','${workspaceA}','${searchKeywordA}','2025-12-15',5,80,0.0625,8.0,${now}),
      ('${randomUUID()}','${workspaceA}','${searchKeywordA}','2026-01-15',10,100,0.1,6.0,${now}),
      ('${randomUUID()}','${workspaceB}','${searchKeywordB}','2026-01-15',999,9999,0.1,1.0,${now});
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

  const localeHeaders = { origin: baseURL ?? "http://localhost:5173" };
  expect((await request.patch(`${baseURL}/api/me/locale`, {
    data: { locale: "ja" },
    headers: localeHeaders,
  })).status()).toBe(200);
  const localizedMe = (await (await request.get(`${baseURL}/api/me`)).json()) as {
    workspace: { uiLocale: string };
  };
  expect(localizedMe.workspace.uiLocale).toBe("ja");

  expect((await request.patch(`${baseURL}/api/clients/${clientA}/report-locale`, {
    data: { locale: "ja" },
    headers: localeHeaders,
  })).status()).toBe(200);
  expect((await request.patch(`${baseURL}/api/clients/${clientB}/report-locale`, {
    data: { locale: "ja" },
    headers: localeHeaders,
  })).status()).toBe(404);
  const localizedClients = (await (await request.get(`${baseURL}/api/clients`)).json()) as {
    clients: Array<{ id: string; reportLocale: string }>;
  };
  expect(localizedClients.clients).toEqual([
    expect.objectContaining({ id: clientA, reportLocale: "ja" }),
  ]);
  const searchConsoleResponse = await request.get(`${baseURL}/api/search-console`);
  expect(searchConsoleResponse.status()).toBe(200);
  const searchConsolePayload = (await searchConsoleResponse.json()) as {
    properties: Array<{ id: string; siteUrl: string }>;
    keywords: Array<{ id: string; keyword: string }>;
  };
  expect(searchConsolePayload.properties).toEqual([
    expect.objectContaining({ id: searchPropertyA, siteUrl: "sc-domain:visible.example" }),
  ]);
  expect(searchConsolePayload.keywords).toEqual([
    expect.objectContaining({ id: searchKeywordA, keyword: "website care" }),
  ]);
  expect((await request.delete(`${baseURL}/api/search-console/properties/${searchPropertyB}`, {
    headers: localeHeaders,
  })).status()).toBe(404);
  expect((await request.delete(`${baseURL}/api/search-console/keywords/${searchKeywordB}`, {
    headers: localeHeaders,
  })).status()).toBe(404);
  expect((await request.post(`${baseURL}/api/search-console/keywords`, {
    data: { clientId: clientA, propertyId: searchPropertyB, keyword: "must not be stored" },
    headers: localeHeaders,
  })).status()).toBe(404);
  expect((await request.post(`${baseURL}/api/search-console/keywords`, {
    data: { clientId: clientA, propertyId: searchPropertyA, keyword: "  WEBSITE   CARE  " },
    headers: localeHeaders,
  })).status()).toBe(409);

  const careItemResponse = await request.post(`${baseURL}/api/clients/${clientA}/maintenance-items`, {
    data: {
      name: "月次セキュリティ確認",
      category: "security",
      frequency: "monthly",
    },
    headers: localeHeaders,
  });
  expect(careItemResponse.status()).toBe(201);
  const careItem = (await careItemResponse.json()) as { id: string };
  expect((await request.post(`${baseURL}/api/clients/${clientB}/maintenance-items`, {
    data: {
      name: "Must not be stored",
      category: "security",
      frequency: "monthly",
    },
    headers: localeHeaders,
  })).status()).toBe(404);

  const evidenceActivityResponse = await request.post(`${baseURL}/api/activities`, {
    data: {
      clientId: clientA,
      maintenanceItemId: careItem.id,
      occurredAt: "2026-01-15T03:00:00.000Z",
      category: "security",
      visibility: "client_visible",
      target: "公開サイト",
      outcomeType: "risk_reduced",
      clientDescription: "公開サイトのセキュリティ設定を確認しました。",
      resultSummary: "既知の問題は見つかりませんでした。",
      verificationMethod: "公開レスポンスと設定記録を照合",
      clientValue: "設定不備による障害リスクを低減しました。",
    },
    headers: localeHeaders,
  });
  expect(evidenceActivityResponse.status()).toBe(201);

  const japaneseDraftResponse = await request.post(`${baseURL}/api/reports/draft`, {
    data: {
      clientId: clientA,
      locale: "ja",
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
    },
    headers: localeHeaders,
  });
  expect(japaneseDraftResponse.status()).toBe(201);
  const japaneseDraft = (await japaneseDraftResponse.json()) as {
    reportId: string;
    snapshot: {
      locale: string;
      period: { label: string };
      executiveSummary: string;
      maintenanceCoverage: Array<{ name: string; status: string; completedCount: number }>;
      searchPerformance: {
        siteUrl: string;
        keywords: Array<{
          keyword: string;
          clicks: number;
          impressions: number;
          averagePosition: number | null;
          previousAveragePosition: number | null;
          positionChange: number | null;
        }>;
      };
      workCompleted: Array<{
        outcomeType: string;
        resultSummary: string;
        verificationMethod: string;
        clientValue: string;
      }>;
      problemsPrevented: Array<{ outcomeType: string }>;
      nextMonthPlan: string;
    };
  };
  expect(japaneseDraft.snapshot.locale).toBe("ja");
  expect(japaneseDraft.snapshot.period.label).toBe("2026年1月");
  expect(japaneseDraft.snapshot.executiveSummary).toContain("定期保守");
  expect(japaneseDraft.snapshot.executiveSummary).toContain("1件");
  expect(japaneseDraft.snapshot.maintenanceCoverage).toEqual([
    expect.objectContaining({ name: "月次セキュリティ確認", status: "completed", completedCount: 1 }),
  ]);
  expect(japaneseDraft.snapshot.searchPerformance).toEqual({
    siteUrl: "sc-domain:visible.example",
    lastSyncedAt: expect.any(String),
    keywords: [
      expect.objectContaining({
        keyword: "website care",
        clicks: 10,
        impressions: 100,
        averagePosition: 6,
        previousAveragePosition: 8,
        positionChange: 2,
      }),
    ],
  });
  expect(japaneseDraft.snapshot.workCompleted).toEqual([
    expect.objectContaining({
      outcomeType: "risk_reduced",
      resultSummary: "既知の問題は見つかりませんでした。",
      verificationMethod: "公開レスポンスと設定記録を照合",
      clientValue: "設定不備による障害リスクを低減しました。",
    }),
  ]);
  expect(japaneseDraft.snapshot.problemsPrevented).toEqual([
    expect.objectContaining({ outcomeType: "risk_reduced" }),
  ]);
  expect(japaneseDraft.snapshot.nextMonthPlan).toContain("月次セキュリティ確認");
  const japaneseDetail = (await (await request.get(`${baseURL}/api/reports/${japaneseDraft.reportId}`)).json()) as {
    snapshot: { locale: string };
  };
  expect(japaneseDetail.snapshot.locale).toBe("ja");

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
      nextMonthPlan: "Attempted overwrite.",
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

  const correction = await request.post(`${baseURL}/api/reports/${reportA}/correction`, {
    headers: { origin: baseURL ?? "http://localhost:5173" },
  });
  expect(correction.status()).toBe(201);
  const correctionPayload = (await correction.json()) as {
    reportId: string;
    revision: number;
    snapshot: { period: { start: string; end: string } };
  };
  expect(correctionPayload.reportId).toBe(reportA);
  expect(correctionPayload.revision).toBe(2);
  expect(correctionPayload.snapshot.period).toMatchObject({
    start: new Date((now - 86400) * 1000).toISOString(),
    end: new Date(now * 1000).toISOString(),
  });
  expect((await request.post(`${baseURL}/api/reports/${reportA}/correction`, {
    headers: { origin: baseURL ?? "http://localhost:5173" },
  })).status()).toBe(409);
  expect((await request.post(`${baseURL}/api/reports/${reportB}/correction`, {
    headers: { origin: baseURL ?? "http://localhost:5173" },
  })).status()).toBe(404);

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
