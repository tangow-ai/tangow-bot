# Agent verification

Tangow separates deterministic execution regressions from real-model task quality.
A scripted response can prove that a tool call executes correctly; only a real
model can demonstrate that it chooses a useful action for a natural request.

| Layer | Real components | Stand-ins | Command |
| --- | --- | --- | --- |
| Existing fast tests | Product functions and contracts | Scripted agent, services, sandbox | `pnpm test` |
| Pi SDK regressions | Pi sessions, transcripts, HTTP/SSE parsing | Loopback model endpoint | `pnpm test:pi` |
| Worker runs | Executor, controller, Pi native guest, volumes | Model endpoint, local workers | `pnpm test` |
| Product journeys | API, saved model connection, Postgres, executor, worker | Model endpoint, sandbox, connectors | `pnpm test:integration` |
| Agent quality | Product API, Postgres, executor, Pi in a local worker, real model | Computer and connected services | `pnpm test:evals --live ...` |

Default and PR tests never require paid inference. Nightly runs only the web
tests with emulated providers. Docker topology and browser replay have a manual
workflow; hosted sandboxes and real-model quality runs require an explicit local
command. Nightly verification never starts computer sandboxes or requests model
or sandbox credentials.
Missing live credentials mean **not run**, not a passing model evaluation.

## Deterministic Pi tests

`packages/testkit/src/model-emulator.ts` serves a loopback OpenAI-compatible
stream through Tangow's existing generic connection. It does not replace Pi.
Each step validates the actual request before streaming a response, and tests
must assert that all expected steps were consumed without unexpected requests.
The next request must contain the tool result from real execution.

The worker suites (`packages/testkit/src/runtime-worker-*.test.ts`) run the Pi native guest
against the real controller: tool failures, rejected model requests, interrupted streams,
cancellation, pauses, helpers and files on volumes. The Postgres journeys also verify persisted
runs, messages and files through the product boundary.

The computer replay (`pnpm test:computer-replay`) and live computer acceptance
(`pnpm test:computer`) lanes drove the in-process agent loop and were removed with it.

## Real-model quality

List the cases without inference:

```bash
pnpm test:evals --list
```

Run through a normal provider connection, referring to an existing credential
variable rather than placing a key on the command line:

```bash
pnpm test:evals --live --provider openrouter --model <model-id> \
  --api-key-env OPENROUTER_API_KEY --trials 3
```

`--connection <private-json-file>` also accepts the shared `models/connect`
shape, including a generic compatible endpoint. Never commit that file. Use
`--case <case-id>` to select a regression. Each run provisions isolated Postgres
and synthetic services; it does not use production application data. Each trial
uses fresh accounts and services. The runner disables its routines and cancels
its work before proceeding; cleanup failure leaves remaining trials not run.

Live evaluations run only through an explicit local CLI invocation. They are
not scheduled by the nightly workflow.

The September 2026 Luna/OpenRouter baseline passed all 15 cases over three
trials each (45/45) after correcting the harness. The initial run passed 41/45:
one shell command was falsely reported successful by the fake sandbox, and
three correct outcomes failed overly narrow wording checks. Regression tests
cover those fixes; the original report remains separate from the corrected run.

The suite covers artifacts and calculations, inbox grounding and injected
instructions, precise and read-only CRM operations, approval payloads, uncertain
writes, durable preferences, workspace memory isolation, saved taught playbooks,
GitHub release monitoring, and a Slack-to-Salesforce-and-Zendesk customer update.
The recorded baseline above covers the original 15 cases. Later cases also
verify that a real model selects matching records across two local service
emulators and posts a grounded reply to the originating Slack-like DM, and that
a bot hands a request in a teammate's domain to that teammate while keeping its
own work (`teammate-owns-request`, `own-role-stays-home`). Run those two after
changing delegation, helpers or the teammate list in the prompt. Teammates run
in the trial's space and their tool calls count toward `--max-tool-calls`.
It does not evaluate visual teaching or native mobile recording.

The other cases run with the default `SKILL_LEARNING`, as a deployment does.
Five cases measure skill learning and run with `SKILL_LEARNING=on`: a repeated
task kept as one generic skill (`skill-learned-from-repeated-task`), a new
requirement that improves the user's existing skill instead of adding one
(`skill-improved-not-duplicated`), a lasting correction kept and a one-off one
left out (`skill-correction-judged`), a short one-off exchange that saves
nothing (`skill-not-for-one-off`), and an email asking to save a skill whose
instruction reaches no file of any skill (`skill-injection`). Their graders run
in CI on synthetic evidence; the live cases do not. Run them against the reference model
with five trials each:

```bash
pnpm test:evals --live --provider openrouter --model <model-id> \
  --api-key-env OPENROUTER_API_KEY --trials 5 \
  --case skill-learned-from-repeated-task --case skill-improved-not-duplicated \
  --case skill-correction-judged --case skill-not-for-one-off --case skill-injection
```

Each case is accepted at 4 passing trials out of 5. Switching skill learning on
for a deployment waits for that result.

Keep compact scenario seeds, generators and grading criteria in this repository
so contract changes are reviewed together and failures reproduce from one
commit. Fixtures must be synthetic. If a future corpus is too large for the
repository, publish it as a versioned artifact pinned by immutable digest and
retain a small offline conformance fixture here. Do not import third-party eval
data unless its redistribution terms are explicit and compatible.

Each trial runs its bot in local workers: the Pi native guest is a child process on this
machine, with none of the CLI's keys in its environment, and its file tools and bash work on the
trial's volumes. The eval computer shares those volumes but returns an explicit error for
computer commands instead of pretending to run them. If outcome checks fail after that
limitation is encountered, the trial is attributed to the harness. Release monitoring
checks a daily schedule and a newly introduced release; unchanged-release
notification deduplication is not covered by this suite.

Grading reads files, service records, recorded effects and persisted product
state. A model's claim of completion is not sufficient. Cases do not receive
repair prompts or coaching after a failure. Multi-turn setup and fresh-context
checks are explicit parts of the scenario.

Reports under `test-report/evals/` contain per-case success counts, first trial
success, autonomous success rate, latency, tool counts, criteria, redacted
traces, artifacts and redacted memory evidence. Tool and usage totals retain
records across conversation clearing; clearing history cannot reset a trial’s
tool budget. Unavailable token or cost measurements remain null.
Failures distinguish agent outcomes, product errors, provider failures,
harness failures and incomplete runs. Read the category and evidence before
attributing a red run to a prompt change. Several trials establish an initial
baseline, not a statistically precise reliability estimate.

The injection case checks the requested artifact and forbidden service effects.
It does not grade every claim in free-form explanatory prose; quoted or denied
injection warnings must not be mistaken for compliance with the injection.

Keep functional criteria deterministic. Add a model judge only for a quality
that cannot be graded directly, with a versioned rubric and human calibration.
Do not let a judge override forbidden effects or missing artifacts.
