import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  clients,
  subscriptions,
  workspaceMembers,
  workspaceProvisioning,
  workspaces,
} from "../db/schema";

export async function ensureWorkspace(env: Env, user: { id: string; name: string; email: string }) {
  const db = drizzle(env.DB);
  const canonical = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      timezone: workspaces.timezone,
      plan: workspaces.plan,
    })
    .from(workspaceProvisioning)
    .innerJoin(workspaces, eq(workspaces.id, workspaceProvisioning.workspaceId))
    .where(eq(workspaceProvisioning.userId, user.id))
    .get();
  if (canonical) return canonical;

  const existing = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      timezone: workspaces.timezone,
      plan: workspaces.plan,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
    .innerJoin(subscriptions, eq(subscriptions.workspaceId, workspaces.id))
    .where(eq(workspaceMembers.userId, user.id))
    .orderBy(
      sql`CASE WHEN ${subscriptions.status} IN ('active', 'trialing', 'past_due') THEN 0 ELSE 1 END`,
      workspaces.createdAt,
    )
    .get();
  if (existing) {
    await db
      .insert(workspaceProvisioning)
      .values({
        userId: user.id,
        workspaceId: existing.id,
        createdAt: new Date(),
      })
      .onConflictDoNothing();
    return existing;
  }

  const now = new Date();
  await db
    .insert(workspaceProvisioning)
    .values({
      userId: user.id,
      workspaceId: crypto.randomUUID(),
      createdAt: now,
    })
    .onConflictDoNothing();
  const provisioned = await db
    .select({ workspaceId: workspaceProvisioning.workspaceId })
    .from(workspaceProvisioning)
    .where(eq(workspaceProvisioning.userId, user.id))
    .get();
  if (!provisioned) throw new Error("WORKSPACE_PROVISION_FAILED");
  const workspaceId = provisioned.workspaceId;
  await db.batch([
    db.insert(workspaces).values({
      id: workspaceId,
      name: `${user.name || user.email.split("@")[0]}'s studio`,
      timezone: "UTC",
      plan: "starter",
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing(),
    db.insert(workspaceMembers).values({
      id: crypto.randomUUID(),
      workspaceId,
      userId: user.id,
      role: "owner",
      createdAt: now,
    }).onConflictDoNothing(),
    db.insert(subscriptions).values({
      id: crypto.randomUUID(),
      workspaceId,
      status: "unpaid",
      plan: "starter",
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing(),
  ]);
  const created = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).get();
  if (!created) throw new Error("WORKSPACE_CREATE_FAILED");
  return created;
}

export async function assertClientBelongsToWorkspace(env: Env, workspaceId: string, clientId: string) {
  const db = drizzle(env.DB);
  const client = await db
    .select()
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.workspaceId, workspaceId)))
    .get();
  if (!client) throw new Error("CLIENT_NOT_FOUND");
  return client;
}
