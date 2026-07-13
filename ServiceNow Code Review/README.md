# ServiceNow Code Review

An AI coding assistant skill for full-lifecycle ServiceNow engineering: **write, review, complete, debug, and find-missing** code across every ServiceNow script type. It gives the AI a platform architect's discipline: classify the execution context, run a deterministic linter, ask the right platform questions, and hunt the silent no-op (code that compiles to nothing, lands in the wrong scope, or matches the wrong record with no error).

## Install

Works with AI coding assistants that support the open skills format (a folder with a `SKILL.md`, discovered from `~/.claude/skills`).

```bash
git clone https://github.com/vikram-karety/ServiceNow.git
mkdir -p ~/.claude/skills
cp -R "ServiceNow/ServiceNow Code Review" ~/.claude/skills/servicenow-code-review
```

That is the whole install. The assistant discovers the skill automatically in your next session.

## Use

Just ask, in any project:

- "Review this business rule" or paste any ServiceNow script and ask what is wrong with it
- "Write a client script that hides the field when state is closed"
- "My business rule is not firing" or "the widget renders blank"
- "Finish this script include" or "what is missing from this ACL setup"

The skill routes to the right mode automatically:

| Mode | For | Anchored on |
|------|-----|-------------|
| **review** (default) | "review / audit / harden this" | context references with severity verdicts |
| **author** | "write / scaffold an X that does Y" | `references/authoring-patterns.md` |
| **complete** | "finish this stub" | pattern recognition against canonical shapes |
| **debug** | "it's broken / not firing / blank / slow" | `references/debugging.md` symptom playbook |
| **find-missing** | "what's missing / is this complete" | completeness checklists |

## Script types covered

Business Rules, Script Includes, Client and Catalog Scripts, UI Policies, UI Actions, Scheduled Jobs, background and fix scripts, Transform Maps, Notification and email scripts, Inbound Email Actions, Flow Designer actions (including authoring and publishing via API), Data Policies, UI Pages (Jelly), UI Macros, Service Portal widgets, Scripted REST APIs, ACLs, Performance Analytics and PAR dashboards, and Table API deploy tooling.

## The standalone linter

The skill ships a zero-dependency linter you can run standalone, in CI or by hand:

```bash
node scripts/sn-lint.js path/to/code [--json]
```

Forty deterministic rules target the platform's silent-failure traps: Rhino reserved-word object keys that make a script compile to nothing, Jelly stripping `${...}` out of UI Page client scripts, boolean `getValue()` misuse, scope-on-create surprises, query injection, hardcoded sys_ids, and more. Exit code 2 means a Critical finding, 1 means High, 0 is clean.

## What is inside

- `SKILL.md` — the mode router, context classifier, linter step, and per-mode output format
- `references/server-side.md` — Business Rules, Script Includes, GlideRecord discipline, background scripts
- `references/client-side.md` — client scripts, UI policies, synchronous-call bans, handler contracts
- `references/ui-pages-jelly.md` — Jelly phases, `${}` stripping, XSS, processing scripts
- `references/service-portal.md` — widget trust boundary, sp_* payload traps
- `references/security-acl.md` — ACL semantics, roles, injection surfaces
- `references/integrations-deploy.md` — Scripted REST, Table API write-path audit, update sets
- `references/authoring-patterns.md` — canonical correct templates per artifact
- `references/debugging.md` — symptom to hypothesis to root cause
- `references/more-script-types.md` — UI Actions, Transform Maps, email scripts, Flow actions, Data Policies
- `references/performance-analytics.md` — classic PA and Platform Analytics build-via-REST
- `scripts/sn-lint.js` — the linter

## Why it exists

ServiceNow's hardest bugs are the quiet ones: the script that runs and does nothing, the record that saves into the wrong scope, the template literal a Jelly page silently ate. This skill encodes those hard-won lessons so any developer using an AI assistant gets them on day one. Built by [Vikram Karety](https://octigosol.com/vikram) from real enterprise delivery experience.

MIT licensed, like the rest of this repository.
