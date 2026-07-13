---
name: servicenow-code-review
description: Full-lifecycle ServiceNow engineering assistant to write, review, complete, debug, and find missing code across every ServiceNow script type — Business Rules, Script Includes, Client and Catalog Scripts, UI Policies, UI Actions, Scheduled Jobs, background/fix scripts, Transform Maps, Notification/email scripts, Inbound Email Actions, Flow actions, UI Pages (Jelly), Service Portal widgets, Scripted REST APIs, ACLs, and Performance Analytics dashboards. Bundles a deterministic linter for silent-failure traps (Rhino reserved-word keys, Jelly template stripping, boolean getValue, scope-on-create, query injection), canonical authoring patterns, and a symptom-first debugging playbook. Use whenever the user asks to write, author, scaffold, review, audit, complete, finish, fix, debug, or troubleshoot ANY ServiceNow or Glide code, asks why a business rule, client script, widget, UI page, or job is not working, or wants best-practice guidance — even a bare "write a business rule that..." or "my script is not firing".
---

# ServiceNow engineering: write, review, complete, debug, find-missing

Work ServiceNow code the way a platform architect would, and always keep the platform's defining trap in mind: the **silent no-op**. Broken code here rarely throws — it compiles to nothing (Rhino reserved keys), renders to nothing (Jelly eats `${}`), lands in the wrong scope, matches the wrong record, or silently drops a misspelled field. "It ran and printed nothing" usually means it never ran at all. Whatever you are doing — writing, reviewing, fixing — prove the code actually ran and acted on the right data.

## Step 0: Pick the mode

Detect what the user wants and follow that mode's workflow. When unstated, default to **review**.

| Mode | Trigger | Workflow |
|---|---|---|
| **review** | "review / audit / check / harden this" | Steps 1→2→3→4 below (the default) |
| **author** | "write / build / scaffold an X that does Y" | Step 1 (context) → author from `references/authoring-patterns.md` → Step 2 (lint your output) → author self-check |
| **complete** | "finish / complete this stub", partial code | Step 1 → identify the intended pattern in `authoring-patterns.md` → complete to that shape → Step 2 |
| **debug** | "it's broken / not firing / blank / errors / slow / not saving" | `references/debugging.md`: symptom → make the silence talk → hypothesis → root cause → fix + confirm |
| **find-missing** | "what's missing / what did I forget / is this complete" | Step 1 → run the completeness lens: each matched reference's own checklist plus Step 3's four questions, read as "what SHOULD be here and isn't" |

All modes share Step 1 (classify by context), Step 2 (lint), and the four platform questions (Step 3). Authoring, completion, and find-missing all lean on `references/authoring-patterns.md` for the canonical correct shape; debugging leans on `references/debugging.md`.

## Step 1: Classify by execution context

Every judgment depends on execution context. The same line can be correct in one context and fatal in another (`document.getElementById` is fine in a UI Page, banned in a Service Portal client script; a template literal is fine in a widget's Angular controller, fatal inside a `sys_ui_page.client_script`). Identify the context(s) and read the matching reference(s) — each carries a METHOD and checklist, not just smells:

| Context | Signals | Reference |
|---|---|---|
| Server Rhino (BR, Script Include, background/fix script, Script Action, scheduled job) | `current.`, `previous.`, `gs.`, `GlideRecord`, `GlideAggregate`, `Class.create` | `references/server-side.md` |
| Client browser JS (Client Script, Catalog Client Script, UI Policy script) | `g_form`, `g_user`, `g_scratchpad`, `GlideAjax`, `onLoad`/`onChange`/`onSubmit` | `references/client-side.md` |
| UI Page / Jelly / UI Macro | `<j:`, `<g:`, `sys_ui_page`, `.xhtml`, processing scripts, `RP.getParameterValue` | `references/ui-pages-jelly.md` |
| Service Portal widget / page builder | `sp_widget`, `sp_page`, `$sp`, `spUtil`, `c.server`, `data.`+`input.` | `references/service-portal.md` |
| Scripted REST / integration / deploy tooling | `/api/now/`, `RESTMessageV2`, `sys_ws_operation`, `requests.`, `fetch(` | `references/integrations-deploy.md` |
| ACL / role / security artifact | `sys_security_acl`, ACL scripts setting `answer`, role grants, client-callable SI | `references/security-acl.md` |
| UI Action, Transform Map, Notification/mail script, Inbound Email Action, Flow action, Data Policy | `gsftSubmit`, `action.setRedirect`; `source`/`target`/`ignore`/`error`; `template.print`, `<mail_script>`; `email.body`; `(function execute(inputs, outputs)` | `references/more-script-types.md` |
| Performance Analytics / dashboards (classic + PAR), report tiles | `pa_dashboards`, `pa_indicators`, `pa_scores_l1`, `sysauto_pa`, `[[indicator]]`, `par_dashboard`, `sys_report` | `references/performance-analytics.md` |

A widget bundles two contexts (Rhino server + Angular client) — handle each half under its own rules.

## Step 2: Run the linter

```bash
node <skill-path>/scripts/sn-lint.js <file-or-dir> [--json]
```

It detects context per file and flags mechanical silent-failure traps (reserved-word keys, boolean `getValue`, template literals in UI-page payloads, `getRowCount`, `getXMLWait`, client-side GlideRecord, encoded-query concatenation, `<g:no_escape>`, unauthorized request-driven writes, hardcoded sys_ids/credentials, `sp_*` field-name lies, scope-on-create gaps, and more). Exit 2 = Critical, 1 = High. Run it on code you **wrote** as well as code you review — it is your first reader.

The linter is a floor, not the whole job. It can't see logic, ACL semantics, cross-function N+1 shapes, or whether a `setWorkflow(false)` is justified. Where a rule is marked heuristic, verify before reporting — a false positive spent on the user is trust you don't get back. For generated/templated server JS, also run `node --check` (catches most Rhino-fatal syntax); passing Node parse doesn't prove Rhino compatibility, so check the ES-feature level against the target instance.

## Step 3: The four platform questions

Ask these of every artifact — whether you're writing it or judging it:

1. **What happens on the empty result?** If a query matches zero rows or the script fails to compile, what does the caller/user see — and is it distinguishable from success? Give tooling-consumed scripts an output sentinel the consumer checks.
2. **Who is running this, really?** Session identity decides scope-on-create, ACL evaluation, `gs.getUser()`. Code exercised only as admin proves nothing about the non-admin experience; elevated identities leak privilege into what they create.
3. **What else fires when this runs?** Every write cascades: business rules, flows, notifications, SLAs, audit. `setWorkflow(false)` silences all of it and needs a stated justification. An innocent `current.update()` in a before rule can recurse.
4. **Does this travel?** Hardcoded sys_ids, instance URLs, and scope assumptions die in the next instance. Anything moving via update set/XML must resolve by name/key or carry its references.

## Step 4: Output per mode

**review / find-missing** — findings use `[SN-###]` ids, ordered by severity, written to `<target>/reviews/SN_REVIEW_<YYYY-MM-DD>.md` and summarized in chat:

```markdown
# ServiceNow Review — <target> — <date>
Verdict: SHIP | SHIP WITH FIXES | DO NOT SHIP
Contexts: <from Step 1>

## Findings
| ID | Sev | Where | Finding | Fix |
|----|-----|-------|---------|-----|

## What was checked and found clean
## Lint output
```

Severity: **Critical** = silent data corruption / compile-to-nothing / exploitable injection on a reachable path. **High** = wrong behavior that ships silently (Jelly-stripped literal, scope-on-create miss, client-callable SI with no role check, `current.update()` in a before rule, unauthorized request-driven write). **Medium** = perf/robustness debt at scale (`getRowCount`, N+1, missing `setLimit`/`.nil()`). **Low** = convention/portability. Any Critical → DO NOT SHIP; any High → SHIP WITH FIXES at best. For find-missing, frame each item as the absent thing ("no authorization check", "no error branch", "missing coalesce field") rather than a defect in existing code.

**author / complete** — deliver the code plus a short rationale: which context and when-to-run you chose and why, the correctness/security guards you included, and the one-line proof-of-execution (log marker / read-back / checked return). Then state the lint result. Run the **authoring self-check** at the end of `references/authoring-patterns.md` before declaring done. Do not invent Glide APIs — if you name one (`GlideAggregate` `COUNT`, `getXMLAnswer`, `GlideRecordSecure`, `setRedirectURL`), it must exist.

**debug** — state the root cause in one sentence (what happened, in which context, to which data), give the minimal correct fix, and say how to CONFIRM it (the marker now logs / the read-back shows the value / impersonation now succeeds). Flag siblings of the same bug class elsewhere. Follow `references/debugging.md`.

## Scope discipline

- Do what the user pointed at. For one artifact, don't audit the repo — but pull in what it directly depends on (a called Script Include, the deploy script that pushes it) when the bug class crosses the boundary.
- If it targets a customer instance (not a PDI), treat it as production: raise scrutiny on write paths, dry-run gates, backups, idempotency.
- Secrets encountered: report the finding, never echo the value.
- For a whole-repo, multi-lens audit with scoring and modes, hand off to `omni-review` with its servicenow pack; this skill is the artifact-level specialist.
