import { defineAction, z, type ActionsModule } from "@hatch/space-sdk";
import { and, asc, desc, eq, like } from "drizzle-orm";
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

export const Actions = {
  listFolders: defineAction({
    request: z.object({}),
    response: z.object({ folders: z.array(folderShape) }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const [folderRows, photoRows] = await Promise.all([
        db.select().from(schema.folders).orderBy(desc(schema.folders.id)),
        db.select({ folderId: schema.photos.folderId }).from(schema.photos),
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
      const db = ctx.db<typeof schema>();
      const result = await db.insert(schema.folders).values({ name: args.name.trim() }).returning({ id: schema.folders.id, name: schema.folders.name });
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
      const db = ctx.db<typeof schema>();
      await db.update(schema.folders).set({ name: args.name.trim() }).where(eq(schema.folders.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  listPhotos: defineAction({
    request: z.object({ folderId: z.number().int().positive().optional(), search: z.string().max(80).default("") }),
    response: z.object({ photos: z.array(photoShape) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const query = db
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
        .innerJoin(schema.folders, eq(schema.photos.folderId, schema.folders.id));
      const search = args.search.trim();
      const conditions = [args.folderId ? eq(schema.photos.folderId, args.folderId) : undefined, search ? like(schema.photos.note, `%${search}%`) : undefined].filter((value): value is NonNullable<typeof value> => value !== undefined);
      const rows = conditions.length === 0
        ? await query.orderBy(desc(schema.photos.capturedAt))
        : await query.where(conditions.length === 1 ? conditions[0] : and(...conditions)).orderBy(desc(schema.photos.capturedAt));
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
      const db = ctx.db<typeof schema>();
      const folder = await db.select({ id: schema.folders.id }).from(schema.folders).where(eq(schema.folders.id, args.folderId)).limit(1);
      if (!folder[0]) throw new Error("所选文件夹不存在");
      const extension = args.mimeType === "image/png" ? "png" : args.mimeType === "image/webp" ? "webp" : "jpg";
      const key = `photos/${args.folderId}/${crypto.randomUUID()}.${extension}`;
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
      const db = ctx.db<typeof schema>();
      const rows = await db.select({ blobKey: schema.photos.blobKey }).from(schema.photos).where(eq(schema.photos.id, args.id)).limit(1);
      const row = rows[0];
      if (row) {
        await db.delete(schema.photos).where(eq(schema.photos.id, args.id));
        await ctx.blobs.delete(row.blobKey);
      }
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  deleteFolder: defineAction({
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const photos = await db.select({ blobKey: schema.photos.blobKey }).from(schema.photos).where(eq(schema.photos.folderId, args.id)).orderBy(asc(schema.photos.id));
      await db.delete(schema.photos).where(eq(schema.photos.folderId, args.id));
      await db.delete(schema.folders).where(eq(schema.folders.id, args.id));
      await Promise.all(photos.map((row) => ctx.blobs.delete(row.blobKey)));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
} satisfies ActionsModule;
