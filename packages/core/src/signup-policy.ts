export function parseAllowlist(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export function emailAllowed(email: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true;
  const normalized = email.trim().toLowerCase();
  const domain = normalized.split("@")[1];
  return allowlist.some((entry) => {
    if (entry.startsWith("@")) return domain === entry.slice(1);
    return normalized === entry;
  });
}

/** Internal messaging users have no mailbox and cannot authenticate by email. */
export function isMessagingEmail(email: string): boolean {
  return email.trim().toLowerCase().endsWith("@messaging.invalid");
}

/** A successful signup with an explicit null token awaits mailbox proof. */
export function signupRequiresEmailVerification(response: unknown): boolean {
  return Boolean(
    response && typeof response === "object" && "token" in response && response.token === null,
  );
}

/**
 * One text per refusal an auth request can meet, keyed by the server's stable code: Better
 * Auth's own codes, then Tangow's three sign-up refusals. The web and the iPhone both read it;
 * an unknown code keeps the server's message.
 */
export const AUTH_ERROR_TEXT = {
  INVALID_EMAIL_OR_PASSWORD: /*i18n*/ "Wrong email or password.",
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: /*i18n*/ "This email already has an account.",
  REGISTRATION_CLOSED: /*i18n*/ "Sign-ups are closed on this server.",
  EMAIL_NOT_ALLOWED: /*i18n*/ "This email can't sign up on this server.",
  EMAIL_DELIVERY_REQUIRED: /*i18n*/ "Email isn't set up on this server.",
} as const;

export type AuthErrorCode = keyof typeof AUTH_ERROR_TEXT;

export function authErrorText(code: string | undefined): string | undefined {
  return code !== undefined && Object.hasOwn(AUTH_ERROR_TEXT, code)
    ? AUTH_ERROR_TEXT[code as AuthErrorCode]
    : undefined;
}

export function signupsOpen(enabled: string | undefined): boolean {
  if (enabled === undefined) return true;
  return enabled !== "false" && enabled !== "0";
}

export function signupPolicyFromEnv(input: {
  signupsEnabled: string | undefined;
  signupAllowlist: string | undefined;
}): { enabled: boolean; allowlist: string[] } {
  return {
    enabled: signupsOpen(input.signupsEnabled),
    allowlist: parseAllowlist(input.signupAllowlist),
  };
}
