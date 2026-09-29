import { defineAction, z, type ActionsModule, type Ctx, type Viewer } from "@hatch/space-sdk";
import { and, asc, desc, eq, gt, isNull, like, or } from "drizzle-orm";
import * as schema from "./schema";

const folderShape = z.object({
  id: z.number(),
  name: z.string(),
  photo_count: z.number(),
  created_at: z.string(),
});

const photoShape = z.object({
  id: z.number(),
  folder_id: z.number(),
  folder_name: z.string(),
  url: z.string(),
  filename: z.string(),
  note: z.string(),
  captured_at: z.string(),
  created_at: z.string(),
});

function principalKey(viewer: Viewer): string {
  if (viewer.source === "local") {
    return `local:${viewer.isOwner ? viewer.ownerUserId : viewer.userId}`;
  }
  return `cloudflare:${viewer.isOwner ? viewer.ownerFbid : viewer.viewerFbid}`;
}

async function getAccount(ctx: Ctx) {
  const viewer = ctx.viewer;
  if (!viewer) return null;
  const viewerKey = principalKey(viewer);
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select({ accountKey: schema.deviceLinks.accountKey })
    .from(schema.deviceLinks)
    .where(eq(schema.deviceLinks.viewerKey, viewerKey))
    .limit(1);
  const accountKey = rows[0]?.accountKey ?? viewerKey;
  return {
    viewer,
    viewerKey,
    accountKey,
    linked: accountKey !== viewerKey,
    allowLegacy: viewer.isOwner && accountKey === viewerKey,
  };
}

function requireAccount(account: Awaited<ReturnType<typeof getAccount>>) {
  if (!account) throw new Error("请先在 Muse 中登录后再使用此应用");
  return account;
}

function folderAccess(accountKey: string, allowLegacy: boolean) {
  return allowLegacy
    ? or(eq(schema.folders.ownerKey, accountKey), isNull(schema.folders.ownerKey))
    : eq(schema.folders.ownerKey, accountKey);
}

export const Actions = {
  getSession: defineAction({
    request: z.object({}),
    response: z.object({
      authenticated: z.boolean(),
      linked: z.boolean(),
      can_create_code: z.boolean(),
    }),
    async handler(ctx) {
      const account = await getAccount(ctx);
      return {
        authenticated: account !== null,
        linked: account?.linked ?? false,
        can_create_code: account !== null && !account.linked,
      };
    },
  }),

  createPairing: defineAction({
    request: z.object({}),
    response: z.object({ token: z.string(), expires_at: z.string() }),
    async handler(ctx) {
      const account = requireAccount(await getAccount(ctx));
      if (account.linked) throw new Error("已通过扫码登录的设备不能继续生成登录码");
      const token = `${crypto.randomUUID()}${crypto.randomUUID().replaceAll("-", "")}`;
      const expiresAt = new Date(Date.now() + 5 * 60_000);
      const db = ctx.db<typeof schema>();
      await db.insert(schema.pairingSessions).values({
        token,
        accountKey: account.accountKey,
        createdBy: account.viewerKey,
        expiresAt,
      });
      return { token, expires_at: expiresAt.toISOString() };
    },
  }),

  claimPairing: defineAction({
    request: z.object({ token: z.string().min(30).max(120) }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const account = requireAccount(await getAccount(ctx));
      const db = ctx.db<typeof schema>();
      const claimed = await db
        .update(schema.pairingSessions)
        .set({ consumedAt: new Date() })
        .where(and(
          eq(schema.pairingSessions.token, args.token),
          isNull(schema.pairingSessions.consumedAt),
          gt(schema.pairingSessions.expiresAt, new Date()),
        ))
        .returning({ accountKey: schema.pairingSessions.accountKey });
      const pair = claimed[0];
      if (!pair) throw new Error("登录码无效、已使用或已过期");
      if (pair.accountKey === account.viewerKey) {
        await db.delete(schema.deviceLinks).where(eq(schema.deviceLinks.viewerKey, account.viewerKey));
      } else {
        const existing = await db
          .select({ viewerKey: schema.deviceLinks.viewerKey })
          .from(schema.deviceLinks)
          .where(eq(schema.deviceLinks.viewerKey, account.viewerKey))
          .limit(1);
        if (existing[0]) {
          await db
            .update(schema.deviceLinks)
            .set({ accountKey: pair.accountKey, linkedAt: new Date() })
            .where(eq(schema.deviceLinks.viewerKey, account.viewerKey));
        } else {
          await db.insert(schema.deviceLinks).values({ viewerKey: account.viewerKey, accountKey: pair.accountKey });
        }
      }
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  disconnectPairing: defineAction({
    request: z.object({}),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx): Promise<{ ok: true }> {
      const account = requireAccount(await getAccount(ctx));
      const db = ctx.db<typeof schema>();
      await db.delete(schema.deviceLinks).where(eq(schema.deviceLinks.viewerKey, account.viewerKey));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  listFolders: defineAction({
    request: z.object({}),
    response: z.object({ folders: z.array(folderShape) }),
    async handler(ctx) {
      const account = await getAccount(ctx);
      if (!account) return { folders: [] };
      const db = ctx.db<typeof schema>();
      const access = folderAccess(account.accountKey, account.allowLegacy);
      const [folderRows, photoRows] = await Promise.all([
        db.select().from(schema.folders).where(access).orderBy(desc(schema.folders.id)),
        db
          .select({ folderId: schema.photos.folderId })
          .from(schema.photos)
          .innerJoin(schema.folders, eq(schema.photos.folderId, schema.folders.id))
          .where(access),
      ]);
      const counts = new Map<number, number>();
      for (const row of photoRows) counts.set(row.folderId, (counts.get(row.folderId) ?? 0) + 1);
      return {
        folders: folderRows.map((row) => ({
          id: row.id,
          name: row.name,
          photo_count: counts.get(row.id) ?? 0,
          created_at: row.createdAt.toISOString(),
        })),
      };
    },
  }),

  createFolder: defineAction({
    request: z.object({ name: z.string().trim().min(1).max(40) }),
    response: z.object({ id: z.number(), name: z.string() }),
    async handler(ctx, args) {
      const account = requireAccount(await getAccount(ctx));
      const db = ctx.db<typeof schema>();
      const result = await db
        .insert(schema.folders)
        .values({ name: args.name.trim(), ownerKey: account.accountKey })
        .returning({ id: schema.folders.id, name: schema.folders.name });
      const row = result[0];
      if (!row) throw new Error("文件夹创建失败");
      ctx.invalidateQueries();
      return row;
    },
  }),

  renameFolder: defineAction({
    request: z.object({ id: z.number().int().positive(), name: z.string().trim().min(1).max(40) }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const account = requireAccount(await getAccount(ctx));
      const db = ctx.db<typeof schema>();
      const result = await db
        .update(schema.folders)
        .set({ name: args.name.trim(), ownerKey: account.accountKey })
        .where(and(eq(schema.folders.id, args.id), folderAccess(account.accountKey, account.allowLegacy)))
        .returning({ id: schema.folders.id });
      if (!result[0]) throw new Error("文件夹不存在或无权修改");
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  listPhotos: defineAction({
    request: z.object({ folderId: z.number().int().positive().optional(), search: z.string().max(80).default("") }),
    response: z.object({ photos: z.array(photoShape) }),
    async handler(ctx, args) {
      const account = await getAccount(ctx);
      if (!account) return { photos: [] };
      const db = ctx.db<typeof schema>();
      const search = args.search.trim();
      const conditions = [
        folderAccess(account.accountKey, account.allowLegacy),
        args.folderId ? eq(schema.photos.folderId, args.folderId) : undefined,
        search ? like(schema.photos.note, `%${search}%`) : undefined,
      ].filter((value): value is NonNullable<typeof value> => value !== undefined);
      const rows = await db
        .select({
          id: schema.photos.id,
          folderId: schema.photos.folderId,
          folderName: schema.folders.name,
          blobKey: schema.photos.blobKey,
          filename: schema.photos.filename,
          note: schema.photos.note,
          capturedAt: schema.photos.capturedAt,
          createdAt: schema.photos.createdAt,
        })
        .from(schema.photos)
        .innerJoin(schema.folders, eq(schema.photos.folderId, schema.folders.id))
        .where(and(...conditions))
        .orderBy(desc(schema.photos.capturedAt));
      return {
        photos: await Promise.all(rows.map(async (row) => ({
          id: row.id,
          folder_id: row.folderId,
          folder_name: row.folderName,
          url: await ctx.blobs.getUrl(row.blobKey, { expiresInSeconds: 3600 }),
          filename: row.filename,
          note: row.note,
          captured_at: row.capturedAt.toISOString(),
          created_at: row.createdAt.toISOString(),
        }))),
      };
    },
  }),

  uploadPhoto: defineAction({
    request: z.object({
      folderId: z.number().int().positive(),
      dataBase64: z.string().min(20).max(18_000_000),
      mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
      filename: z.string().min(1).max(100),
      note: z.string().max(120).default(""),
      capturedAt: z.string().datetime(),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const account = requireAccount(await getAccount(ctx));
      const db = ctx.db<typeof schema>();
      const folder = await db
        .select({ id: schema.folders.id })
        .from(schema.folders)
        .where(and(eq(schema.folders.id, args.folderId), folderAccess(account.accountKey, account.allowLegacy)))
        .limit(1);
      if (!folder[0]) throw new Error("所选文件夹不存在或无权访问");
      const extension = args.mimeType === "image/png" ? "png" : args.mimeType === "image/webp" ? "webp" : "jpg";
      const key = `photos/${account.accountKey}/${args.folderId}/${crypto.randomUUID()}.${extension}`;
      const bytes = Buffer.from(args.dataBase64, "base64");
      if (bytes.byteLength > 12_000_000) throw new Error("照片不能超过 12MB");
      await ctx.blobs.put(key, bytes, { contentType: args.mimeType });
      try {
        const result = await db.insert(schema.photos).values({
          folderId: args.folderId,
          blobKey: key,
          filename: args.filename,
          note: args.note.trim(),
          capturedAt: new Date(args.capturedAt),
        }).returning({ id: schema.photos.id });
        const row = result[0];
        if (!row) throw new Error("照片保存失败");
        ctx.invalidateQueries();
        return { id: row.id };
      } catch (error) {
        await ctx.blobs.delete(key);
        throw error;
      }
    },
  }),

  deletePhoto: defineAction({
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const account = requireAccount(await getAccount(ctx));
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select({ blobKey: schema.photos.blobKey })
        .from(schema.photos)
        .innerJoin(schema.folders, eq(schema.photos.folderId, schema.folders.id))
        .where(and(eq(schema.photos.id, args.id), folderAccess(account.accountKey, account.allowLegacy)))
        .limit(1);
      const row = rows[0];
      if (!row) throw new Error("照片不存在或无权删除");
      await db.delete(schema.photos).where(eq(schema.photos.id, args.id));
      await ctx.blobs.delete(row.blobKey);
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  deleteFolder: defineAction({
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const account = requireAccount(await getAccount(ctx));
      const db = ctx.db<typeof schema>();
      const folders = await db
        .select({ id: schema.folders.id })
        .from(schema.folders)
        .where(and(eq(schema.folders.id, args.id), folderAccess(account.accountKey, account.allowLegacy)))
        .limit(1);
      if (!folders[0]) throw new Error("文件夹不存在或无权删除");
      const photos = await db
        .select({ blobKey: schema.photos.blobKey })
        .from(schema.photos)
        .where(eq(schema.photos.folderId, args.id))
        .orderBy(asc(schema.photos.id));
      await db.delete(schema.photos).where(eq(schema.photos.folderId, args.id));
      await db.delete(schema.folders).where(eq(schema.folders.id, args.id));
      await Promise.all(photos.map((row) => ctx.blobs.delete(row.blobKey)));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
} satisfies ActionsModule;
