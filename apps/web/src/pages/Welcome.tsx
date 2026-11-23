import { Trans } from "@lingui/react/macro";
import { buttonVariants, cn } from "@tangow/ui-web";
import { Link } from "react-router-dom";
import { OnboardingScreen, welcomeScene } from "./onboarding-screen";

export function WelcomePage() {
  return (
    <div className="contents" data-tangow-surface="welcome">
      <OnboardingScreen
        onSubmit={(event) => event.preventDefault()}
        poster
        title={
          <Trans>
            Mold a bot.
            <br />
            Give it a job.
          </Trans>
        }
        scene={welcomeScene}
        actions={
          <>
            <Link to="/sign-up" className={cn(buttonVariants({ size: "full" }), "no-underline")}>
              <Trans>Sign up</Trans>
            </Link>
            <Link to="/sign-in">
              <Trans>Sign in</Trans>
            </Link>
          </>
        }
      />
    </div>
  );
}
