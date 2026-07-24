import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { clients, subscriptions, workspaceMembers, workspaces } from "../db/schema";

export async function ensureWorkspace(env: Env, user: { id: string; name: string; email: string }) {
  const db = drizzle(env.DB);
  const existing = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      timezone: workspaces.timezone,
      plan: workspaces.plan,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(eq(workspaceMembers.userId, user.id))
    .get();
  if (existing) return existing;

  const now = new Date();
  const workspaceId = crypto.randomUUID();
  await db.batch([
    db.insert(workspaces).values({
      id: workspaceId,
      name: `${user.name || user.email.split("@")[0]}'s studio`,
      timezone: "UTC",
      plan: "starter",
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(workspaceMembers).values({
      id: crypto.randomUUID(),
      workspaceId,
      userId: user.id,
      role: "owner",
      createdAt: now,
    }),
    db.insert(subscriptions).values({
      id: crypto.randomUUID(),
      workspaceId,
      status: "unpaid",
      plan: "starter",
      createdAt: now,
      updatedAt: now,
    }),
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
