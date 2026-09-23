# Security Policy

This repo is run by people evaluating Anyray, on their own machines, against
their own gateway, using their own production prompts. That means it handles
three things that matter: a client key, real traffic, and a provider bill. This
document says how we handle reports, and — just as important — what this tool
does **not** protect you from.

## Reporting a vulnerability

**Please do not open a public GitHub issue for a security problem.**

- **Email:** security@anyray.ai
- **GitHub Security Advisory:** use *Report a vulnerability* from this
  repository's **Security** tab.

Include where you can:

- the commit sha (`git rev-parse HEAD`)
- Node version and OS
- reproduction steps, or a proof of concept
- your read on the impact

## What to expect

- **Acknowledgement** within **3 business days**.
- **Initial assessment** — severity and reproducibility — within **7 business
  days**.
- **Fix or mitigation timeline** communicated as part of that assessment.
- **Coordinated disclosure**, 90 days by default, shortened for anything
  actively exploited and adjustable at the reporter's request.
- **Credit** in the fix commit unless you would rather not be named.

## What this tool touches

| | |
| --- | --- |
| **Your client key** | Read from `.env`, sent as a bearer token to the gateway URL you configured. Nowhere else. |
| **Your prompts** | Read from `workloads/`, sent to your gateway. Written back into `results.json` and `report.html` along with both answers. `report-shareable.html` (`--redact`) carries neither. |
| **Your provider bill** | Every run makes 2 × `PROOF_REPEATS` real calls per workload. |
| **Nothing else** | No telemetry, no phone-home, no analytics. There are no runtime dependencies, so there is no third-party code in the request path. |

It sends nothing to Anyray beyond the requests that already flow through your
own gateway.

## Keeping your prompts out of git

`.gitignore` excludes `.env`, `workloads/*` (except the shipped
`example-*.json`), `results.json`, `report.html` and `judge.json`. A gitleaks
scan runs on every push and pull request, with rules for Anyray key shapes
(`ark_`, `ark_svc_`, `enl_`, `adt_`).

Check it yourself before you trust it:

```sh
git check-ignore -v .env workloads/your-file.json results.json report.html
git status --short          # your captured workloads must not appear here
```

Two things that are still on you:

- **`workloads/`, `results.json` and `report.html` are real traffic on disk.**
  Gitignored is not encrypted, and `report.html` contains both models' full
  answers. Treat that directory the way you would treat a production log dump.
- **Scrub before you capture, not after.** `SETUP-PROMPT.md` instructs the agent
  to remove credentials, customer identifiers and internal hostnames, but an
  agent's judgement is not a control. Read what it captured.

## Limits — what this does not protect you from

Stated plainly, because a tool that only lists its strengths is not one you
should point at production data.

- **It is not a sandbox.** It sends your prompts to your gateway and your
  provider. If a prompt contains a secret, that secret goes with it.
- **It does not vet your gateway.** It measures whatever the configured URL
  does. Point it at the wrong host and it will faithfully measure that host.
- **A client key in `.env` is a credential in a plaintext file.** That is the
  ordinary shape for local tooling, and it is still a file on a laptop. Use a
  client key, never an admin token — this repo only ever sends ordinary
  inference requests and has no use for more privilege.
- **The fact check is substring survival, not comprehension.** It is biased
  toward reporting damage rather than hiding it, so false alarms are possible.
  One class of false alarm is handled explicitly: if an answer is cut off at
  `PROOF_MAX_TOKENS`, that workload's quality verdict is withheld rather than
  blamed on the model, because the missing fact is our ceiling.
- **The optional judge sends both answers to your model.** `judge.mjs` is
  opt-in; if your answers are sensitive, do not run it.
- **`report.html` is a local file, not a private one.** Nothing stops it being
  emailed onward, and it holds your prompts and both answers. If it needs to
  travel, `node report.mjs --redact` writes a copy with the content removed —
  though your workload ids, gateway host and model name remain, and the file
  says so rather than implying it is fully sanitised.

## Supported versions

This tracks `main`. There are no release branches and no backports; fixes land
on `main` and you re-pull. Given there are no dependencies, the supply-chain
surface is the repo itself plus the Node runtime you already have.

## Out of scope

- The Anyray gateway and optimizer themselves — report those to
  security@anyray.ai, which is the same address, but say which component.
- Vulnerabilities in Node.js or in your provider's API.
- The cost of a run. Spending more than you meant to is a budgeting problem, not
  a vulnerability — though if the tool ever *understates* the call count it
  prints before starting, that is a bug and we want to hear about it.

## Contact

security@anyray.ai
