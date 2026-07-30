import { count, eq, isNotNull, lte, and } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { aiRewrites, clients, user, workspaceMembers, workspaces } from "../db/schema";
import { revokeSearchConsoleConnection } from "./search-console";

export async function purgeDueWorkspaceData(env: Env): Promise<number> {
  const db = drizzle(env.DB);
  const due = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(isNotNull(workspaces.deletionScheduledAt), lte(workspaces.deletionScheduledAt, new Date())))
    .limit(25);

  for (const workspace of due) {
    await revokeSearchConsoleConnection(env, workspace.id);
    const members = await db
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, workspace.id));
    await db.batch([
      db.delete(clients).where(eq(clients.workspaceId, workspace.id)),
      db.delete(aiRewrites).where(eq(aiRewrites.workspaceId, workspace.id)),
      db.delete(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspace.id)),
      db
        .update(workspaces)
        .set({
          name: "Deleted workspace",
          timezone: "UTC",
          deletionScheduledAt: null,
          updatedAt: new Date(),
        })
        .where(eq(workspaces.id, workspace.id)),
    ]);
    for (const member of members) {
      const [{ value: remainingMemberships }] = await db
        .select({ value: count() })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.userId, member.userId));
      if (remainingMemberships === 0) await db.delete(user).where(eq(user.id, member.userId));
    }
    await deleteReportObjects(env.REPORTS, `${workspace.id}/`);
  }
  return due.length;
}

async function deleteReportObjects(bucket: R2Bucket, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1_000 });
    if (page.objects.length) await bucket.delete(page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}
