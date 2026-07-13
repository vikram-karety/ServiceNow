# Server-side Rhino: Business Rules, Script Includes, background scripts, jobs

The server runtime is Rhino, not Node. It fails differently: a compile error produces **empty output with zero diagnostics**, writes can be vetoed without exceptions, and every script runs inside a transaction where slow code blocks a real user's form save. Review method: read each script asking "what does the platform do around this code", not just "what does this code do".

## Method

1. **Grep for unquoted reserved-word keys before reading anything else.** Rhino treats Java keywords used as unquoted object keys as a COMPILE error for the whole script; the script then emits nothing and callers proceed as if it succeeded:
   ```
   grep -nE '(^|[{,[:space:]])(class|char|byte|int|enum|new|delete|typeof|in|for|if|do|else|while|switch|case|default|return|throw|try|catch|finally|break|continue|function|var|this|null|true|false|void|instanceof)[[:space:]]*:' <files>
   ```
   Not just Java keywords — the ECMAScript reserved words bite too: `{ default: x }`, `{ new: y }`, `{ return: z }`, `{ delete: w }`, `{ in: a }` all fail to compile in classic Rhino. (The bundled linter flags all of these except `default`, which it omits to avoid colliding with switch `default:` labels — so grep for `default:` yourself.) The fix is quoting the key (`"class":`, `"default":`) or renaming. Any script consumed by tooling also needs an output sentinel the consumer checks.
2. **Check ES-feature level.** Older/global-scope Rhino is ES5: `let`/`const`, arrow functions, template literals, default params, spread, and optional chaining are all compile errors in classic contexts. Scoped apps on newer releases can opt into the ES12 engine per app — verify what the target runs before flagging OR before passing modern syntax.
3. **Trace the write cascade of every mutation.** For each `update()`, `insert()`, `deleteRecord()`, `deleteMultiple()`, `updateMultiple()`: which business rules, flows, notifications, SLAs, and audit entries fire? Is that intended? Is recursion possible (a BR on table X updating table X)?
4. **Cost every query at production scale**, not PDI scale. Assume `task` has millions of rows, `sys_audit` more.

## Business Rules

- **Before rules mutate `current` directly and never call `current.update()`.** The platform saves `current` after the rule; an explicit `update()` inside a before rule double-writes, re-triggers rules, and can recurse. In after rules, `current.update()` is also almost always wrong (use before, or a flow). If you see it, it's High.
- **`current.setAbortAction(true)` only works in before rules.** In after/async it silently does nothing.
- **Condition belongs in the condition builder / condition field**, not as a script-body early return. A scripted early-return still pays the rule dispatch on every DB operation of that table; the condition field short-circuits before the script loads. Flag rules with empty conditions on high-volume tables.
- **`previous` is null in async rules and on insert.** Any `previous.` access must be guarded by operation. `current.operation()` tells you which.
- **Order matters.** A rule that reads a value another rule sets needs an explicit order relationship; flag rules that depend on default-order luck (two rules at order 100 touching the same fields).
- **Cross-table field mirror = infinite ping-pong.** Two tables kept in sync by two `after` rules (A's update fires B's rule which updates A which re-fires A's rule) loop until the platform's recursion guard aborts — distinct from same-table recursion. Guard each side: write only when the value actually differs (`if (target.getValue('u_status') != current.getValue('u_zayo_sub_status')) target.update();`), or use a session/scratchpad flag the mirror checks to break the cycle.
- **Display BRs** are the only legitimate way to feed `g_scratchpad`. Data placed there is visible to the client — no secrets.
- **Async vs after:** anything that doesn't need to happen inside the user's transaction (integrations, recalculations, notifications-adjacent work) belongs in async or a flow. Sync rules doing outbound REST calls freeze the form save — High.
- **`setWorkflow(false)`** disables ALL other business rules, workflows, flows, notifications, SLAs, and (with `autoSysFields(false)`) audit. Sometimes correct (mass data fixes), never free: it also skips the data-integrity rules other teams wrote. Requires a justification comment and a stated blast radius; otherwise Medium, High if on a task-family table.

## GlideRecord discipline

- **Existence/count checks:** `gr.getRowCount()` materializes the full result set. Use `setLimit(1)` + `gr.hasNext()` for existence, `GlideAggregate` with `COUNT` for counts. Medium, High inside a loop.
- **N+1 loops:** a `GlideRecord` query inside a `while (gr.next())` of another query is the platform's most common performance bug. Fix with a single encoded query (`IN` on collected sys_ids), `GlideAggregate` grouping, or dot-walked fields on the outer query.
- **Unbounded queries:** every query on a table that can be large gets `setLimit()` unless the loop is genuinely meant to process all rows — and then it should be in a scheduled job/batch, not a UI-path script.
- **Conditional filters:** an `addQuery` inside an `if` that can skip means the query can run with NO filters — the whole table. If a write/delete loop follows, that's Critical (one code path = mass corruption).
- **`addEncodedQuery` with concatenated user input is query injection.** `^` splicing lets a caller widen the query (`...^ORsys_idISNOTEMPTY` returns everything). User-supplied VALUES go through `addQuery(field, op, value)` (parameterized); encoded strings are for developer-authored filters only. High, Critical if reachable from a client-callable interface. (CWE-943)
- **GlideElement vs string:** `gr.field` returns a GlideElement, not a string. `==` comparisons and using it as an object key can misbehave; use `gr.getValue('field')` / `gr.getUniqueValue()` or `toString()`. Watch for storing `gr.field` in an array inside a loop — every element ends up referencing the LAST row's value.
- **`getValue('field_that_does_not_exist')` returns `''`, not an error** — the read-side twin of the Table-API "unknown field silently dropped" trap. A guard, dedupe, or comparison keyed on a mistyped or nonexistent column is permanently DEAD CODE that never fires (worse than no guard — it looks like protection). Real case: `task_cmdb_ci_service` has no `ci_item` column (its CI field is `cmdb_ci_service`), so `if (gr.getValue('ci_item')) skip()` never skips. Verify every field name against the dictionary before keying logic on it.
- **Encoded-query operator traps (compile fine, return the wrong set silently):** query empty/non-empty fields with `ISEMPTY`/`ISNOTEMPTY` — `field=NULL` and `field=''` do NOT reliably match empty. Express "older than N days" as `field<javascript:gs.daysAgoStart(N)`, NOT `RELATIVELT@dayofweek@N` (a different window). A typo'd field name in an encoded query is ignored and widens the match.
- **Boolean `getValue()` returns `'0'`/`'1'`, never `'true'`/`'false'`.** `gr.getValue('active') == 'true'` is ALWAYS false — a silent logic bug that makes the branch dead and the count/flag wrong with no error. Only `getDisplayValue()` yields `'true'`/`'false'`. Compare booleans as `getValue(...) == '1'`, or use `gr.field.toString() == 'true'` deliberately, or just `if (gr.active)`. This is one of the platform's most common silent-wrong-result traps; grep any `getValue(...) == 'true'`/`'false'` on a boolean field.
- **Aggregates/queries over the current table inside a before rule count `current` itself on UPDATE.** On before-update the row already exists in the DB, so a `GlideAggregate`/`GlideRecord` counting "other" active records on the same key includes `current` (off-by-one); on before-insert it does not, so the behavior is inconsistent between operations. When you mean "sibling" records, exclude self: `agg.addQuery('sys_id', '!=', current.getValue('sys_id'))`.
- **`.nil()` guards:** dot-walking an empty reference yields `''`, not an exception — comparisons silently pass with wrong data. Check `.nil()` before trusting dereferenced values.
- **Journal fields** (`work_notes`, `comments`): set via `gr.work_notes = '...'` before update; `getValue()` on them returns only the latest entry — use `getJournalEntry()`.
- **`gr.next()` vs `gr._next()`:** tables with a column literally named `next` (or `update`) shadow the method — use `_next()`/`_update()` there.
- **Insert/update return values:** `insert()` returns the sys_id or null; ACLs and other BRs can veto with no exception. Unchecked writes are silent failures.

## Date/time (GlideDateTime, GlideDate, schedules)

- **Storage is GMT; display is session timezone. Never round-trip a display value into a `GlideDateTime`.** For a `glide_date_time` field, `gr.getValue('when')` and `gdt.getValue()` return the internal GMT value; `getDisplayValue()` renders it in the running user's TZ. `new GlideDateTime(str)` / `setValue(str)` PARSE their argument as GMT — so feeding a display-value string (already TZ-shifted) back into a GlideDateTime drifts the record by the offset (hours), silently. Move times as GMT strings or GlideDateTime objects, format only at the very end.
- **Don't string-compare dates.** Comparing `getValue('due')` strings works by luck for same-format GMT values but breaks across formats/DST; use `GlideDateTime` objects and `.before()`/`.after()`/`compareTo()`, or `.getNumericValue()`.
- **`GlideDate` vs `GlideDateTime`:** a `glide_date` field has no time/TZ — using `GlideDateTime` on it re-introduces a TZ and an off-by-one-day at midnight boundaries. Match the class to the field type.
- Duration math: `gdt.addSeconds()/addDaysUTC()/subtract(gdt1, gdt2)` (returns a `GlideDuration`); business-hours math needs a **Schedule** (`new GlideSchedule(scheduleSysId)` `.duration()/.add()`), not raw arithmetic. Don't hand-roll "N business days".

## GlideQuery (modern query API)

GlideQuery (Orlando+, `global.GlideQuery` in scoped) is a fluent wrapper whose failure semantics **invert** the GlideRecord rules above — don't blindly apply the silent-empty checks to it:
- **Fails FAST on a bad field** (throws at build time) instead of silently ignoring it — the opposite of an encoded query's silent widen. That's a feature; catch or let it surface.
- Returns real values / `Optional`, not GlideElements, so the boolean-`getValue` and GlideElement-vs-string traps don't apply. `.get()`/`.getBy()` return `Optional`; `.select().toArray()` materializes.
- Still honors ACLs only if you opt in — plain GlideQuery runs unrestricted like GlideRecord; there's no `GlideQuerySecure`, so for user-facing reads either check access explicitly or use GlideRecordSecure.

## Row-level security via a before-query business rule

To hide rows a user shouldn't even see in lists (not just a form), the platform pattern is a **before-query business rule** that adds a `current.addQuery(...)` / `addEncodedQuery(...)` restriction (often gated by `!gs.hasRole('admin')`). This is the real "query ACL" — there is no `query` ACL operation. Review such rules for: the `gs.hasRole` bypass being correct, the added query not being defeatable, and the rule not accidentally hiding rows from integrations/admin. A missing before-query rule is why a "secured" table still lists everything.

## Script Includes

- **`Class.create()` + `prototype` + matching `type:` property** is the idiom; the `type` string must equal the Script Include name or instantiation breaks in odd ways.
- **Client-callable = public attack surface.** An SI extending `AbstractAjaxProcessor` (or flagged client-callable) is reachable by any user who can load a form, regardless of what UI calls it. EVERY public function must validate roles/ACLs itself (`gs.hasRole(...)`, `GlideRecordSecure`, explicit checks) and treat all `getParameter` input as hostile. No role check in a client-callable SI = High minimum. There is no per-SI "public" flag on `sys_script_include`: `client_callable` controls who-can-call-from-a-form and the "Accessible from" (`access`) field is cross-scope visibility, not authentication. Unauthenticated reach happens only when the SI is invoked from a public surface (a page registered in `sys_public` / a public Scripted REST), so trace the caller before assuming anonymous exposure.
- **`gs.hasRole('x,y')`** returns true if the user has ANY listed role, and always true for admin. Fine for gating, but flag security decisions built on a role that half the org holds.
- **Don't return GlideRecords from SI functions across scope boundaries** — return primitives/objects; cross-scope GlideRecord access is governed by app access settings and fails at runtime, not review time.

## Background / fix scripts and scheduled jobs

- Everything above applies, plus: they run as the executing user (often admin) with no second chance. Look for: a dry-run mode or counting pass before the write pass, `setWorkflow`/`autoSysFields` decisions stated, batching (`setLimit` + loop with sys_id watermark) for large tables, and an output sentinel (`___DONE___` / `RESULT_JSON:` prefix) that the calling tool THROWS on when missing.
- `gs.sleep()` in anything user-facing or high-frequency: Medium.
- **Logging:** `gs.log()` doesn't work in scoped apps — use `gs.info/warn/error`. Logging inside a per-row loop on a big table is its own performance bug. Never log secrets or full payloads containing PII.
- Scheduled jobs that assume completion under the node's transaction quota: long jobs need chunking or they get killed mid-write.

## Checklist

- [ ] No unquoted reserved-word object keys in any server-bound JS (grep, don't trust reading)
- [ ] ES-feature level matches the target instance/engine; `node --check` passes on generated JS
- [ ] No `current.update()` in before/after rules; no unguarded `previous` in async/insert paths
- [ ] Rule conditions in the condition field; async used for out-of-transaction work; no outbound REST in sync rules
- [ ] Every `setWorkflow(false)` justified in a comment with blast radius
- [ ] No `getRowCount()` for counts/existence; no N+1 query loops; `setLimit` on large-table lookups
- [ ] No conditional-filter query followed by a write loop; no `addEncodedQuery` built from user input
- [ ] `getValue()`/`toString()` where strings are needed; `.nil()` before trusting dot-walks; boolean fields compared to `'1'`/`'0'` (never `'true'`), and before-rule self-counts exclude `current`
- [ ] Client-callable Script Includes validate roles and sanitize every parameter; not public unless intended
- [ ] Writes check their return values; batch scripts have sentinels, dry-run, and chunking
- [ ] `gs.info` family in scoped apps; no secrets/PII in logs; no hardcoded sys_ids without justification
