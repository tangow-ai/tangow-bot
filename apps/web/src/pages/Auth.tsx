import { Trans, useLingui } from "@lingui/react/macro";
import {
  authErrorText,
  readBoundedJsonResponse,
  signupRequiresEmailVerification,
} from "@tangow/core";
import { Button, buttonVariants, cn, FloatingField } from "@tangow/ui-web";
import { Eye, EyeOff } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { authClient } from "../lib/auth";
import { clearSpaceSelection } from "../lib/rpc";
import { OnboardingScreen, paveScene, signupScene } from "./onboarding-screen";

type AuthMode = "in" | "up" | "forgot";
type PasswordResetCapabilities = { passwordReset: boolean; resetUrl: string | null };
type AuthError = { text: string; code?: string };

const AUTH_CAPABILITIES_TIMEOUT_MS = 8_000;
const MAX_AUTH_CAPABILITIES_RESPONSE_BYTES = 64 * 1024;
const SENT_MS = 2_000;

export function AuthPage({ mode }: { mode: AuthMode }) {
  const { t, i18n } = useLingui();
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<AuthError | null>(null);
  const [pending, setPending] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const [verificationSent, setVerificationSent] = useState(false);
  // Signup triggers a session refresh that remounts the anonymous auth page, so the
  // address waiting for its link rides in the history entry rather than in state.
  const pendingEmail: unknown = location.state?.email;
  const checkEmail =
    searchParams.get("verify") === "email" && typeof pendingEmail === "string"
      ? pendingEmail
      : null;

  // undefined while the capabilities request is in flight; null when it failed.
  const [reset, setReset] = useState<PasswordResetCapabilities | null>();

  useEffect(() => {
    if (!verificationSent) return;
    const timer = setTimeout(() => setVerificationSent(false), SENT_MS);
    return () => clearTimeout(timer);
  }, [verificationSent]);

  useEffect(() => {
    if (mode === "up") return;
    let active = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AUTH_CAPABILITIES_TIMEOUT_MS);
    void fetch("/api/auth/capabilities", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load authentication capabilities");
        return readBoundedJsonResponse<PasswordResetCapabilities>(
          response,
          MAX_AUTH_CAPABILITIES_RESPONSE_BYTES,
          controller.signal,
        );
      })
      .then((capabilities) => {
        if (active) setReset(capabilities);
      })
      .catch(() => {
        if (active) setReset(null);
      })
      .finally(() => clearTimeout(timer));
    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [mode]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      if (checkEmail) {
        const result = await authClient.sendVerificationEmail({ email: checkEmail });
        if (result.error) setError(authError(result.error));
        else setVerificationSent(true);
        return;
      }
      if (mode === "forgot") {
        if (!reset?.passwordReset || !reset.resetUrl) {
          setError({ text: t`Password recovery is not configured for this server` });
          return;
        }
        const result = await authClient.requestPasswordReset({
          email: email.trim(),
          redirectTo: reset.resetUrl,
        });
        if (result.error) {
          setError({ text: result.error.message ?? t`Could not send reset email` });
          return;
        }
        setResetSent(true);
        return;
      }
      const result =
        mode === "up"
          ? await authClient.signUp.email({
              email,
              password,
              name: name || email.split("@")[0] || "User",
            })
          : await authClient.signIn.email({ email, password });
      if (result.error) {
        setError(authError(result.error));
        return;
      }
      if (mode === "up" && signupRequiresEmailVerification(result.data)) {
        setSearchParams({ verify: "email" }, { state: { email } });
        return;
      }
      clearSpaceSelection();
      // The session refetch that follows sign-in/sign-up lets the route redirect; navigating
      // first would reach a guarded route without a user and flash the sign-in page.
    } catch {
      setError({ text: t`Couldn't reach the server.` });
    } finally {
      setPending(false);
    }
  }

  function authError({ code, message }: { code?: string; message?: string }): AuthError {
    const text = authErrorText(code);
    return { code, text: text ? i18n._(text) : (message ?? t`Could not continue`) };
  }

  const passwordToggle = (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={() => setShowPassword((shown) => !shown)}
      aria-label={showPassword ? t`Hide password` : t`Show password`}
      aria-pressed={showPassword}
      className="absolute inset-y-0 end-2 my-auto text-muted-foreground"
    >
      {showPassword ? <EyeOff /> : <Eye />}
    </Button>
  );

  if (mode === "in") {
    return (
      <OnboardingScreen
        onSubmit={submit}
        title={<Trans>Got the key?</Trans>}
        scene={paveScene}
        actions={
          <>
            <Button type="submit" size="full" disabled={pending} aria-busy={pending}>
              <Trans>Sign in</Trans>
            </Button>
            {reset?.passwordReset ? (
              <Link to="/forgot-password">
                <Trans>Forgot password?</Trans>
              </Link>
            ) : null}
            <p>
              <Trans>Don’t have an account?</Trans>{" "}
              <Link to="/sign-up">
                <Trans>Sign up</Trans>
              </Link>
            </p>
          </>
        }
      >
        <FloatingField
          id="email"
          name="email"
          label={<Trans>Email</Trans>}
          autoComplete="username"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <FloatingField
          id="current-password"
          name="password"
          label={<Trans>Password</Trans>}
          autoComplete="current-password"
          type={showPassword ? "text" : "password"}
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={error?.text}
          invalid={error?.code === "INVALID_EMAIL_OR_PASSWORD"}
        >
          {passwordToggle}
        </FloatingField>
      </OnboardingScreen>
    );
  }

  if (mode === "forgot") {
    const sentTo = email.trim();
    return (
      <OnboardingScreen
        onSubmit={submit}
        title={resetSent ? <Trans>A new key is on its way.</Trans> : <Trans>Lost the key?</Trans>}
        scene={paveScene}
        actions={
          <>
            {resetSent ? null : (
              <Button
                type="submit"
                size="full"
                disabled={pending || reset === undefined}
                aria-busy={pending}
              >
                <Trans>Send reset link</Trans>
              </Button>
            )}
            <Link to="/sign-in">
              <Trans>Back to sign in</Trans>
            </Link>
          </>
        }
      >
        {resetSent ? (
          <p role="status">
            <Trans>If {sentTo} has an account, the link is in its inbox.</Trans>
          </p>
        ) : (
          <FloatingField
            id="email"
            name="email"
            label={<Trans>Email</Trans>}
            autoComplete="username"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={error?.text}
          />
        )}
      </OnboardingScreen>
    );
  }

  if (checkEmail) {
    return (
      <OnboardingScreen
        onSubmit={submit}
        title={
          <Trans>
            Check your email.
            <br />
            The clay will keep.
          </Trans>
        }
        scene={signupScene}
        actions={
          <>
            <Button
              type="submit"
              variant="outline"
              size="full"
              disabled={pending || verificationSent}
              aria-busy={pending}
            >
              {verificationSent ? <Trans>Sent</Trans> : <Trans>Send again</Trans>}
            </Button>
            <Link to="/sign-up" onClick={() => setError(null)}>
              <Trans>Use another email</Trans>
            </Link>
          </>
        }
      >
        <p>
          <Trans>
            Open the link sent to <span className="text-foreground">{checkEmail}</span>.
          </Trans>
        </p>
        {error ? <p role="alert">{error.text}</p> : null}
      </OnboardingScreen>
    );
  }

  const emailRejected =
    error?.code === "EMAIL_NOT_ALLOWED" || error?.code === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL";
  return (
    <OnboardingScreen
      onSubmit={submit}
      title={<Trans>Grab some clay.</Trans>}
      scene={signupScene}
      actions={
        <>
          <Button type="submit" size="full" disabled={pending} aria-busy={pending}>
            <Trans>Create account</Trans>
          </Button>
          <p>
            <Trans>Already have an account?</Trans>{" "}
            <Link to="/sign-in">
              <Trans>Sign in</Trans>
            </Link>
          </p>
        </>
      }
    >
      <FloatingField
        id="name"
        name="name"
        label={<Trans>Name</Trans>}
        autoComplete="name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <FloatingField
        id="email"
        name="email"
        label={<Trans>Email</Trans>}
        autoComplete="username"
        type="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        invalid={emailRejected}
      />
      <FloatingField
        id="new-password"
        name="password"
        label={<Trans>Password</Trans>}
        autoComplete="new-password"
        type={showPassword ? "text" : "password"}
        required
        minLength={8}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        error={error?.text}
      >
        {passwordToggle}
      </FloatingField>
    </OnboardingScreen>
  );
}

type ResetStep = "form" | "expired" | "done";

export function PasswordResetPage() {
  const { t } = useLingui();
  const [params] = useSearchParams();
  const token = params.get("token");
  const [step, setStep] = useState<ResetStep>(params.get("error") || !token ? "expired" : "form");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [mismatch, setMismatch] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!token) return;
    const mismatched = password !== confirmation;
    setMismatch(mismatched);
    if (mismatched) {
      setError(t`Passwords do not match`);
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await authClient.resetPassword({ newPassword: password, token });
      if (result.error?.code === "INVALID_TOKEN") setStep("expired");
      else if (result.error) setError(result.error.message ?? t`Could not reset password`);
      else setStep("done");
    } catch {
      setError(t`Couldn't reach the server.`);
    } finally {
      setPending(false);
    }
  }

  const actions =
    step === "done" ? (
      <Link to="/sign-in">
        <Trans>Sign in</Trans>
      </Link>
    ) : step === "expired" ? (
      <>
        <Link
          to="/forgot-password"
          className={cn(buttonVariants({ size: "full" }), "no-underline")}
        >
          <Trans>Send a new link</Trans>
        </Link>
        <Link to="/sign-in">
          <Trans>Back to sign in</Trans>
        </Link>
      </>
    ) : (
      <>
        <Button type="submit" size="full" disabled={pending} aria-busy={pending}>
          <Trans>Reset password</Trans>
        </Button>
        <Link to="/sign-in">
          <Trans>Back to sign in</Trans>
        </Link>
      </>
    );

  return (
    <OnboardingScreen
      onSubmit={submit}
      title={<Trans>Reset your password</Trans>}
      scene={paveScene}
      actions={actions}
    >
      {step === "done" ? (
        <p role="status">
          <Trans>Password updated</Trans>
        </p>
      ) : step === "expired" ? (
        <p role="alert">
          <Trans>This link has expired or was already used.</Trans>
        </p>
      ) : (
        <>
          <FloatingField
            id="new-password"
            name="new-password"
            label={<Trans>New password</Trans>}
            autoComplete="new-password"
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <FloatingField
            id="confirm-password"
            name="confirm-password"
            label={<Trans>Confirm password</Trans>}
            autoComplete="new-password"
            type="password"
            required
            minLength={8}
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
            error={error}
            invalid={mismatch}
          />
        </>
      )}
    </OnboardingScreen>
  );
}
