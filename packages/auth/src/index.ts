import type { TransactionalEmail, TransactionalEmailProvider } from "@tangow/adapter-kit";
import type { AuthErrorCode } from "@tangow/core";
import {
  decodeAttachmentBase64,
  emailAllowed,
  isMessagingEmail,
  parseAllowlist,
  signupPolicyFromEnv,
} from "@tangow/core";
import { bootstrapUserSpace, type PrismaClient } from "@tangow/db";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { bearer, organization } from "better-auth/plugins";

export interface AuthEnv {
  secret: string;
  baseURL: string;
  webOrigin: string;
  signupsEnabled: string | undefined;
  signupAllowlist: string | undefined;
  extraOrigins?: string[];
  email?: TransactionalEmailProvider;
  onEmailError?: (error: unknown) => void;
  /** Runs before the user is deleted with the organizations only they belong to, and their spaces. */
  beforeDeleteUser?: (
    userId: string,
    removed: { personalOrganizationIds: string[] },
  ) => Promise<void>;
}

export async function resolveSignupPolicy(
  prisma: Pick<PrismaClient, "deploymentSettings">,
  env: Pick<AuthEnv, "signupsEnabled" | "signupAllowlist">,
): Promise<{ enabled: boolean; allowlist: string[] }> {
  const settings = await prisma.deploymentSettings.findUnique({
    where: { id: "default" },
    select: { signupsEnabled: true, signupAllowlist: true, signupPolicyInitialized: true },
  });
  if (settings?.signupPolicyInitialized) {
    return {
      enabled: settings.signupsEnabled,
      allowlist: parseAllowlist(settings.signupAllowlist),
    };
  }
  return signupPolicyFromEnv(env);
}

// `user.image` is a self-service field on a public endpoint and it rides in every
// get-session response, so only small self-contained raster data URLs are allowed.
// The allowlist rejects `data:image/svg+xml` (scriptable) and http(s) URLs, which
// would make a self-hosted deployment fetch third-party images and leak the
// viewer's IP on every render.
const PROFILE_IMAGE_PREFIXES = [
  "data:image/png;base64,",
  "data:image/jpeg;base64,",
  "data:image/webp;base64,",
];
const PROFILE_IMAGE_MAX_LENGTH = 32 * 1024;

export function assertProfileImage(image: unknown): void {
  if (image === null || image === undefined || image === "") return;
  if (typeof image !== "string" || image.length > PROFILE_IMAGE_MAX_LENGTH) {
    throw new APIError("BAD_REQUEST", { message: "Profile photo must be under 32 KB" });
  }
  const prefix = PROFILE_IMAGE_PREFIXES.find((candidate) => image.startsWith(candidate));
  if (!prefix) {
    throw new APIError("BAD_REQUEST", {
      message: "Profile photo must be a PNG, JPEG, or WebP data URL",
    });
  }
  try {
    decodeAttachmentBase64(image.slice(prefix.length));
  } catch {
    throw new APIError("BAD_REQUEST", { message: "Profile photo is not valid base64" });
  }
}

function signupRefusal(code: AuthErrorCode, message: string) {
  return new APIError("BAD_REQUEST", { code, message });
}

export function createAuth(prisma: PrismaClient, env: AuthEnv) {
  return betterAuth({
    appName: "Tangow",
    secret: env.secret,
    baseURL: env.baseURL,
    trustedOrigins: buildTrustedOrigins(env),
    database: prismaAdapter(prisma, { provider: "postgresql" }),
    emailAndPassword: {
      enabled: true,
      // Signup policy is mutable deployment state, so the request hook below
      // enforces it instead of freezing an environment value at process start.
      disableSignUp: false,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 60 * 60,
      sendResetPassword: env.email
        ? async ({ user, url }) => {
            // Keep the response timing generic. Production providers track and retry the promise,
            // while the composition root drains accepted delivery during graceful shutdown.
            void env.email
              ?.send(passwordResetEmail(user, url))
              .catch((error) => env.onEmailError?.(error));
          }
        : undefined,
    },
    emailVerification: {
      sendOnSignIn: true,
      autoSignInAfterVerification: false,
      sendVerificationEmail: env.email
        ? async ({ user, url }) => {
            const verificationUrl = new URL(url);
            verificationUrl.searchParams.set(
              "callbackURL",
              new URL("/sign-in", env.webOrigin).href,
            );
            await env.email!.send(verificationEmail(user.email, verificationUrl.href));
          }
        : undefined,
    },
    user: {
      deleteUser: {
        enabled: true,
        beforeDelete: async (user) => {
          const memberships = await prisma.member.findMany({
            where: { userId: user.id },
            select: {
              organizationId: true,
              organization: { select: { members: { select: { userId: true, role: true } } } },
            },
          });
          // People invited to a Space join its organization as plain members,
          // so an organization is personal when this user is its only owner.
          const personalOrganizationIds = memberships
            .filter(({ organization }) =>
              organization.members.every(
                (member) => member.userId === user.id || member.role !== "owner",
              ),
            )
            .map(({ organizationId }) => organizationId);
          await env.beforeDeleteUser?.(user.id, { personalOrganizationIds });

          await prisma.$transaction([
            prisma.deploymentSettings.updateMany({
              where: { ownerUserId: user.id },
              data: { ownerUserId: null },
            }),
            // Messaging identities are deliberately FK-free, so clear them
            // here or the unique address would point at a deleted bot forever.
            prisma.messagingIdentity.deleteMany({
              where: { userId: user.id },
            }),
            prisma.organization.deleteMany({
              where: { id: { in: personalOrganizationIds } },
            }),
          ]);
        },
      },
    },
    plugins: [
      bearer(),
      organization({
        allowUserToCreateOrganization: false,
        creatorRole: "owner",
      }),
    ],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        for (const value of [ctx.body?.email, ctx.body?.newEmail]) {
          if (typeof value === "string" && isMessagingEmail(value)) {
            throw new APIError("BAD_REQUEST", { message: "Email is not available" });
          }
        }
        let policy =
          ctx.path === "/sign-up/email" || ctx.path === "/sign-in/email"
            ? await resolveSignupPolicy(prisma, env)
            : undefined;
        if (ctx.path === "/sign-up/email") {
          if (!policy?.enabled) {
            throw signupRefusal("REGISTRATION_CLOSED", "Registration is closed");
          }
          if (!emailAllowed(String(ctx.body?.email ?? ""), policy.allowlist)) {
            throw signupRefusal("EMAIL_NOT_ALLOWED", "Email is not allowed to register");
          }
          if (policy.allowlist.length > 0 && !env.email) {
            throw signupRefusal("EMAIL_DELIVERY_REQUIRED", "Registration requires email delivery");
          }
        }
        // Return a request-local override; mutating the shared auth options
        // would leak a concurrent request's policy into another signup.
        return {
          context: {
            context: {
              ...(policy
                ? {
                    options: {
                      emailAndPassword: { requireEmailVerification: policy.allowlist.length > 0 },
                    },
                  }
                : {}),
              internalAdapter: {
                ...ctx.context.internalAdapter,
                // Authorize at lookup: bearer conversion happens after before
                // hooks, and auth mutations also read sessions through here.
                findSession: async (token: string) => {
                  const session = await ctx.context.internalAdapter.findSession(token);
                  if (!session || isMessagingEmail(session.user.email)) return null;
                  if (session.user.emailVerified) return session;
                  policy ??= await resolveSignupPolicy(prisma, env);
                  return policy.allowlist.length === 0 ? session : null;
                },
              },
            },
          },
        };
      }),
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session, ctx) => {
            // The auth adapter can still be inside the signup transaction.
            const user = await ctx?.context.internalAdapter.findUserById(session.userId);
            const policy = await resolveSignupPolicy(prisma, env);
            if (
              !user ||
              isMessagingEmail(user.email) ||
              (!user.emailVerified && policy.allowlist.length > 0)
            ) {
              throw new APIError("FORBIDDEN", { message: "Email verification required" });
            }
            // Unverified signup must not provision resources or claim the
            // deployment owner. Bootstrap only at the first admitted session.
            const membership = await prisma.spaceMember.findFirst({ where: { userId: user.id } });
            if (!membership) {
              if (!policy.enabled || !emailAllowed(user.email, policy.allowlist)) {
                throw new APIError("FORBIDDEN", { message: "Registration is closed" });
              }
              await bootstrapUserSpace(prisma, user, env);
            }
          },
        },
      },
      user: {
        create: {
          before: async (user) => {
            if (isMessagingEmail(user.email)) {
              throw new APIError("BAD_REQUEST", { message: "Email is not available" });
            }
            assertProfileImage(user.image);
          },
        },
        update: {
          before: async (user) => {
            if (user.email && isMessagingEmail(user.email)) {
              throw new APIError("BAD_REQUEST", { message: "Email is not available" });
            }
            assertProfileImage(user.image);
          },
        },
      },
    },
  });
}

export function verificationEmail(email: string, url: string): TransactionalEmail {
  return {
    to: email,
    subject: "Verify your Tangow email",
    text: `Verify your email, then return to Tangow to sign in:\n\n${url}\n\nThis link expires in one hour. If you did not register, ignore this email.`,
    html: `<p><a href="${escapeHtml(url)}">Verify email</a>, then return to Tangow to sign in.</p><p>This link expires in one hour. If you did not register, ignore this email.</p>`,
  };
}

export function passwordResetEmail(
  user: { id: string; email: string; name: string },
  resetUrl: string,
): TransactionalEmail {
  const name = user.name.trim() || "there";
  const safeName = escapeHtml(name);
  const safeUrl = escapeHtml(resetUrl);
  return {
    to: user.email,
    subject: "Reset your Tangow password",
    text: [
      `Hi ${name},`,
      "",
      "Reset your Tangow password using this link:",
      resetUrl,
      "",
      "This link expires in one hour. If you did not request this, you can ignore this email.",
    ].join("\n"),
    html: `<p>Hi ${safeName},</p><p>Reset your Tangow password:</p><p><a href="${safeUrl}">Reset password</a></p><p>This link expires in one hour. If you did not request this, you can ignore this email.</p>`,
  };
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}

export type Auth = ReturnType<typeof createAuth>;

/** Assemble Better Auth trustedOrigins, adding localhost↔127.0.0.1 twins for loopback. */
export function buildTrustedOrigins(env: Pick<AuthEnv, "webOrigin" | "baseURL" | "extraOrigins">) {
  const configured = [env.webOrigin, env.baseURL, ...(env.extraOrigins ?? [])];
  const twins = [env.webOrigin, env.baseURL].flatMap(loopbackTwinOrigins);
  return [...new Set([...configured, ...twins])];
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

/** Same-scheme/port localhost and 127.0.0.1 variants when `origin` is loopback. */
function loopbackTwinOrigins(origin: string): string[] {
  try {
    const url = new URL(origin);
    if (!isLoopbackHost(url.hostname)) return [];
    const twins: string[] = [];
    for (const host of ["localhost", "127.0.0.1"] as const) {
      if (host === url.hostname) continue;
      const twin = new URL(origin);
      twin.hostname = host;
      twins.push(twin.origin);
    }
    return twins;
  } catch {
    return [];
  }
}

/** Space membership goes through the app; these endpoints would leak member emails and bypass it. */
export function isBlockedAuthPath(path: string): boolean {
  return path.startsWith("/organization/");
}
