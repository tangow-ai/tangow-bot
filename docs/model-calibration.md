# Calibrate category models

This internal tool compares model connections and thinking levels through Rakazo's deployed API. It uses synthetic tasks in an isolated benchmark account. It does not update another account's model settings or add a calibration interface.

## Inspect the development campaign

```sh
pnpm test:model-calibration --list
pnpm test:model-calibration --config packages/testkit/src/evals/model-calibration/examples/development.json --output test-report/model-calibration/development.json
```

Without `--live`, the command makes no provider calls and opens no database. The report keeps every planned task as `not-run`. The example compares three models at two thinking levels on six development scenarios: 36 tasks. A task may make several model calls.

The model IDs are explicit candidates, not assertions that a deployment serves them. The live preflight checks the deployed catalog and thinking levels. Models absent from that catalog are not silently substituted. `auto` is reserved for the validation arm and cannot name a candidate.

## Run against an isolated account

Provision a dedicated account and its model connections before running. Do not use the deployment owner or an account containing personal workflows. The tool does not copy credentials or create authentication sessions. Use a short-lived authenticated session admitted by the deployment's policy, then revoke it after the campaign.

Keep a private, owner-readable session file outside the repository:

```json
{
  "userId": "synthetic-benchmark-user",
  "spaceId": "synthetic-benchmark-space",
  "token": "PRIVATE_SESSION_TOKEN",
  "baseUrl": "http://127.0.0.1:3100",
  "origin": "https://rakazo.example.test",
  "connections": { "codex": "PRIVATE_BENCHMARK_CREDENTIAL_ID" }
}
```

Run on the application server with its existing `DATABASE_URL`, a matching source revision and the private session file. Never print the environment, connection secrets or session file. For exact connection selection, the benchmark account must have only one model credential per tested provider; its ID must match the connection alias in this file. The tool sends the explicit space header on every API call.

```sh
pnpm test:model-calibration --config packages/testkit/src/evals/model-calibration/examples/development.json --session /private/path/session.json --live --output test-report/model-calibration/development.json
```

Set task, token, tool and timeout limits in the configuration before execution. The example caps the campaign at 36 attempted tasks and two million observed tokens, with 15 observed tool calls and 180 seconds per task. A task with several turns shares these limits. In-flight inference can overshoot the observed token ceiling before cancellation reaches the server. Later turns and tasks do not start after a detected limit. Unknown usage stops the campaign rather than resetting its budget.

The tool archives each test bot and waits for its worker attempts to be released before continuing. Cleanup failure stops the campaign. SIGINT and SIGTERM request cancellation; a forcibly killed process cannot finish cleanup. After an interrupted process, inspect the dedicated account's runs and workers before restarting. Reports are replaced atomically and keep unattempted slots visible. Start a new report for a new campaign; this version does not resume partial campaigns or combine them as if they were one run.

## Read the evidence before choosing

Each trial separates content correctness, requested format and critical errors. It records full task time and per-turn time, excluding bot setup and cleanup, and includes setup conversation turns. Local calculation tasks require an observed successful tool call; this does not prove that the tool produced the final value.

The report retains failures, missing trials, actual recorded model selections, model-call counts, tool counts and persisted token usage. Cost, cache counters and per-call timings remain `null` where persistence does not expose them. Cached tokens are already included in input tokens. Tokens are neither money nor subscription quota.

Recommendations are provisional. They require complete observations, correct content, no critical errors and matching recorded models. Format-only differences remain separate. Fast uses task latency. Everyday uses measured cost per successful task when complete cost is available; otherwise it explicitly cannot claim a monetary optimum. Complex does not prefer a larger model when observed quality does not distinguish it. A single development pass requests repetition; close results remain undecided. Five repeats measure variability, not general quality or a reliable p95.

One configuration can serve several categories. Do not require three different model names.

## Freeze a profile before opening validation cases

Choose the profile using development evidence only. Keep the nine validation scenarios in `holdout.ts` out of development tuning. The CLI imports them only for the explicit validation phase. If validation results lead to another optimization, use a new validation set before claiming improvement.

Record the SHA-256 of the exact development report and the selected configuration IDs in a profile:

```json
{
  "developmentSha256": "SHA256_OF_EXACT_DEVELOPMENT_REPORT",
  "baselineId": "luna-low",
  "categories": { "fast": "luna-low", "everyday": "luna-low", "complex": "sol-medium" }
}
```

These IDs illustrate the file shape; they are not calibration results. The command checks that the frozen model, thinking level and connection alias still match the development report. Retain the same private connection mapping during validation.

Create a separate validation config with the same candidates and an explicit budget covering the intended 90 tasks and observed tokens. Validation defaults to five repeats: nine scenarios × two arms × five repeats. Its Auto arm has no bot model override. Only the isolated benchmark account's routing is temporarily configured, then restored.

```sh
pnpm test:model-calibration --phase validation --config /private/path/validation-config.json --profile /private/path/profile.json --development-report test-report/model-calibration/development.json --session /private/path/session.json --live --output test-report/model-calibration/validation.json
```

Validation reports Auto and the fixed baseline by case and category, with paired latency differences only for valid pairs. It does not choose a new profile from validation results. Keep sample counts and ranges with any conclusion. Revalidate when the model, connection, prompt or agent loop changes materially.

## Verify the tool without provider calls

```sh
pnpm exec vitest run packages/testkit/src/evals/model-calibration
pnpm --filter @rakazo/testkit check
```

The tests use deterministic synthetic responses and a loopback HTTP server for the transport boundary. No provider credentials are needed.
