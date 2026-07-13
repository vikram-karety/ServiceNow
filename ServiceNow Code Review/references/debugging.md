# Debugging: symptom → hypothesis → root cause

Debugging enters from the opposite end of review: you have a SYMPTOM ("it's not firing", "the page is blank", "nothing gets saved") and must find the cause. On ServiceNow the cause is usually a **silent failure** — the code didn't error, it just didn't run, ran in the wrong context, or ran against the wrong data. So the first move is almost never "read the code"; it's **make the silence talk**: add a distinctive log marker and confirm whether the code executed at all, then bisect.

## Method

1. **Reproduce and localize the layer.** Which context is even involved — server (BR/SI/job), client (form JS), Jelly (UI page render), portal (widget), integration (REST)? A "form is broken" symptom could be a client script, a UI policy, a data policy, or a UI action.
2. **Confirm execution before logic.** Add `gs.info('ACME_MARK_1 ' + <key>)` (server) or `console.log`/`g_form.addInfoMessage` (client) at the top. If the marker never appears, the problem is upstream (condition, context, compile, ACL) — not the logic you were about to read. This single step resolves most "it's not firing" cases.
3. **Form one hypothesis at a time from the symptom table below**, test it, discard or confirm. Don't shotgun edits.
4. **Fix the root cause, not the symptom.** "Add a null check" that hides a query returning nothing is a symptom patch; find why it's empty.

## Where to look (server-side has almost no stack traces)

- Background scripts / `gs.info`/`warn`/`error` → **System Logs > All** (or `syslog` list), filter by your marker.
- Client → browser console + `g_form` messages; set the session to debug UI where available.
- Business rule / query behavior → **Session Debug** (Debug Business Rule, Debug Security/ACL, Debug Log to session) surfaces which rules fired and which ACLs decided.
- Transaction cost → the transaction log / slow-query log.
- A compile failure in server Rhino produces **empty output with no error** — the log marker test is the only way to see it.

## Symptom → likely causes

### "My business rule / script isn't firing"
- Condition not met (check the condition FIELD, and `current.operation()` vs when — before/after/async/display).
- Wrong **when**: expecting `previous` in async (it's null) or on insert (null).
- The script has a reserved-word key (`class:` unquoted) or an ES6 construct → the WHOLE rule compiled to nothing. Grep it; run `node --check`; add the marker — if the marker never logs, this is it.
- `setWorkflow(false)` upstream suppressed the rule stack.
- Order: another rule aborted the action (`setAbortAction(true)`) or changed the field first.
- Runs but does nothing visible: it's an **after** rule mutating `current` (not persisted) instead of **before**, or a **before** rule calling `current.update()` and recursing.

### "Nothing gets saved / the value doesn't stick"
- `current.update()` in a before rule (double-write/recursion) or, conversely, mutating `current` in an **after** rule (never persisted — needs before).
- `gr.update()`/`insert()` vetoed by an ACL or another BR and the return value was never checked (returns null/empty).
- Writing to a field that a data policy / UI policy makes read-only, or a dictionary override blocks.
- Setting a reference field by display value instead of sys_id.

### "The query returns nothing (or everything)"
- A conditional `addQuery` that was skipped → no filters → whole table (or an update loop → corruption).
- Boolean compared as `getValue('active') == 'true'` — always false; use `'1'`/`'0'` or `gr.active`.
- Dot-walk on an empty reference yields `''`, so the comparison "passes" with wrong data — guard `.nil()`.
- Encoded query with a typo'd field is ignored silently and widens the match.
- Running as a user whose ACLs hide the rows (GlideRecordSecure or a low-priv session).

### "The UI Page / widget renders blank or broken"
- UI Page: a reserved-word key or ES6 in `<g:evaluate>` compiled the block to nothing, so variables are undefined downstream. Add a literal marker in the Jelly and see if it renders.
- Template literal in `sys_ui_page.client_script` — Jelly ate the `${...}`; the shipped JS is broken. (Fine in a widget's Angular controller.)
- Widget: `data` field never set on the server (or set from a raw GlideRecord that didn't serialize); `c.server.update()` re-runs the whole server script and reset state; an Angular expression error halts the digest — check the browser console.
- Portal client script using `document`/jQuery that only works in classic UI.

### "The form freezes / is slow"
- Synchronous client call: `getXMLWait`, callback-less `getReference`, or client-side `GlideRecord`.
- A UI action / BR doing a synchronous deep CMDB walk or an N+1 GlideRecord loop.
- `getRowCount()` on a large table; missing `setLimit`.

### "Access denied / user sees nothing (or too much)"
- Empty/cleared ACL does NOT grant — clearing conditions to "open up" a table denies it.
- Row ACL and field ACL both must pass; a permissive field ACL can't override a denying row ACL.
- Tested as admin (passes everything) but the real persona has no role — impersonate to reproduce.
- Client-callable Script Include / Scripted REST returning rows the caller's ACLs should hide: plain GlideRecord instead of GlideRecordSecure.

### "Intermittent 401s / the integration flakes"
- Password with `$` shell-sourced and mangled (truncated credential) — parse the env file, don't `source` it.
- Rate limiting (429/503) under concurrent writes — lower concurrency, back off.
- Scoped-update-set-over-REST or `setCurrentApplicationId` in a background script (throws / binds to global).

### "The notification / email didn't send (or sent blank)"
- Notification inactive, condition/When-to-send not met, or the event it subscribes to never fired (check the Event Registry + that something calls `gs.eventQueue`).
- "Send to event creator" excluded the only recipient; the recipient field was empty at send time.
- A `${field}` / `${mail_script:x}` printed blank because `current`'s field was empty when the notification evaluated, or the mail script used `template.print` incorrectly (or `return`ed instead).
- Email sending disabled instance-wide (`glide.email.smtp.active`), or the record is in a domain the sender can't see.

### "The transform / import didn't populate rows (or duplicated them)"
- No/mis-typed **coalesce** field → every row inserts (dups) or nothing matches; a client-script-derived field is empty because import bypasses client scripts (see `more-script-types.md`).
- `ignore`/`error` not set (a bare `return` doesn't skip); onBefore assumed `target.sys_id` exists (it may not until insert); the coalesce field isn't indexed → the import "hangs" (full scan per row).

### "The flow didn't run (or ran with empty values)"
- Trigger condition not met, flow inactive/draft (no compiled snapshot — a raw `active=true` flip does nothing), or it was hand-built via Table API (declined by publish).
- Runs but action args are blank → on older platforms a Fluent flow's input VALUES didn't bind (see `more-script-types.md`); an output not mapped is invisible downstream.

### "Records land somewhere I can't find them"
- Scope-on-create: Table API POST landed in the session's current app, not the payload scope.
- Name-based lookup silently matched an out-of-box record (sp_* tables especially).

## Producing the fix

State the root cause in one sentence (what actually happened, in which context, to which data), then give the minimal correct fix and how to CONFIRM it (the marker now logs / the read-back shows the value / impersonation now succeeds). If the same class of bug is likely elsewhere (a copy-pasted deploy path, another boolean compare), say so. Then run `sn-lint.js` to catch siblings mechanically.
