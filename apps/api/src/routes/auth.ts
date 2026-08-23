import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Prisma } from "@yishu/db";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { generateUid } from "../lib/uid.js";
import { createUserWithUidRetry, MAX_UID_RETRY } from "../lib/register.js";
import { generateRefreshToken, hashRefreshToken } from "../lib/tokens.js";
import { toUserPublicView } from "../lib/user-view.js";
import { loginSchema, refreshSchema, registerSchema } from "../schemas/auth.js";

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/** 提取唯一约束冲突涉及的字段名（兼容 Prisma 7 driver adapter 结构）。 */
function uniqueConstraintFields(err: unknown): string[] {
  const meta = (
    err as {
      meta?: {
        target?: unknown;
        driverAdapterError?: { cause?: { constraint?: { fields?: string[] } } };
      };
    }
  ).meta;
  if (Array.isArray(meta?.target)) {
    return meta.target as string[];
  }
  const fields = meta?.driverAdapterError?.cause?.constraint?.fields;
  return Array.isArray(fields) ? fields : [];
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // 注册（对应规范 §5）
  app.post("/auth/register", async (req, reply) => {
    const body = registerSchema.parse(req.body);
    const passwordHash = await hashPassword(body.password);

    // UID 碰撞自动重试（规范 §4.2）；account 冲突明确报错。
    const result = await createUserWithUidRetry({
      uidGenerator: generateUid,
      maxRetries: MAX_UID_RETRY,
      create: async (uid) => {
        try {
          const user = await req.server.prisma.user.create({
            data: {
              uid,
              account: body.account,
              passwordHash,
              nickname: body.nickname,
              province: body.province,
              city: body.city,
              district: body.district,
            },
          });
          return { kind: "created" as const, user };
        } catch (err) {
          if (isUniqueViolation(err)) {
            const fields = uniqueConstraintFields(err);
            if (fields.includes("account")) {
              return { kind: "account_conflict" as const };
            }
            return { kind: "collision" as const };
          }
          throw err;
        }
      },
    });

    if (result.kind === "account_conflict") {
      return reply.code(409).send({ error: "account_already_exists" });
    }
    if (result.kind === "collision") {
      return reply.code(500).send({ error: "uid_generation_failed" });
    }

    const user = result.user;
    if (!user) {
      return reply.code(500).send({ error: "uid_generation_failed" });
    }
    const tokens = await issueTokens(app, user);
    return reply.code(201).send({
      user: toUserPublicView(user),
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    });
  });

  // 登录（对应规范 §5）
  app.post("/auth/login", async (req, reply) => {
    const body = loginSchema.parse(req.body);
    const user = await req.server.prisma.user.findUnique({
      where: { account: body.account },
    });
    if (!user || !(await verifyPassword(body.password, user.passwordHash))) {
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    const tokens = await issueTokens(app, user);
    return reply.send({
      user: toUserPublicView(user),
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    });
  });

  // 刷新 Access Token（对应规范 §5）
  app.post("/auth/refresh", async (req, reply) => {
    const body = refreshSchema.parse(req.body);
    const tokenHash = hashRefreshToken(body.refreshToken);
    const record = await req.server.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!record || record.revokedAt !== null || record.expiresAt.getTime() <= Date.now()) {
      return reply.code(401).send({ error: "invalid_refresh_token" });
    }

    // Access Token sub 使用对外 UID（不泄露 internal id）
    const accessToken = app.jwt.sign(
      { sub: record.user.uid },
      { expiresIn: req.server.config.JWT_EXPIRES_IN_SECONDS }
    );
    return reply.send({ accessToken });
  });

  // 注销（撤销 Refresh Token，对应规范 §5）
  app.post("/auth/logout", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = refreshSchema.parse(req.body);
    const tokenHash = hashRefreshToken(body.refreshToken);
    await req.server.prisma.refreshToken.updateMany({
      where: { tokenHash },
      data: { revokedAt: new Date() },
    });
    return reply.send({ ok: true });
  });
}

/** 为用户签发 Access + Refresh Token。
 * Access Token 的 sub 为对外 UID；Refresh Token 持久化时关联 internal id（仅数据库内部）。
 */
async function issueTokens(
  app: FastifyInstance,
  user: { uid: string; id: { toString(): string } }
): Promise<{ accessToken: string; refreshToken: string }> {
  const accessToken = app.jwt.sign(
    { sub: user.uid },
    { expiresIn: app.config.JWT_EXPIRES_IN_SECONDS }
  );

  const refreshToken = generateRefreshToken();
  const expiresAt = new Date(Date.now() + app.config.REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000);
  await app.prisma.refreshToken.create({
    data: {
      userId: BigInt(user.id.toString()),
      tokenHash: hashRefreshToken(refreshToken),
      expiresAt,
    },
  });

  return { accessToken, refreshToken };
}
