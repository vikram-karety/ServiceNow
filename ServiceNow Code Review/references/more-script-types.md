# More script types: UI Actions, Transform Maps, Email, Flow, Data Policy

The other references cover the common artifacts. These are the ones that trip people because their execution model or variable contract is unusual. For each: the context, the variable contract, the traps, and where the canonical shape lives (`authoring-patterns.md`).

## UI Action

**Context:** can be client, server, or both — the single most common confusion. Fields that decide: **Client** (checkbox), **Onclick** (client function name), **Action name** (the `sysparm` value used by `gsftSubmit`), and the **Script** field (server-side body).

- Server-only (Client off): Script runs server-side on click; `current` is the record, `action` controls redirect. This IS the write path (unlike a before rule).
- Client + server: Onclick validates client-side, then `gsftSubmit(null, g_form.getFormElement(), '<action_name>')` re-submits; the Script field runs server-side, guarded by `if (typeof window == 'undefined')`.
- Traps: forgetting the `typeof window` guard (server half runs client-side or vice versa); synchronous deep CMDB walks freezing the form; list vs form UI actions (`g_list` context differs); condition field vs `isVisible` script; a refresh-style action that wipes manually-added related-list rows.

## Transform Map scripts (onStart / onBefore / onAfter / onComplete / field script)

**Context:** server Rhino during an import, one run per source row (onBefore/onAfter/field) or once per run (onStart/onComplete). Special variable contract — this is what people get wrong:

- `source` — the import-set row (staging). `target` — the record being written. `map`, `log`.
- `action` — `'insert'` / `'update'` / `'ignore'` for the current row.
- `ignore = true` — skip this row (do NOT rely on `return` to skip; set `ignore`). `error = true` + `error_message` — fail the row.
- **Coalesce** decides update-vs-insert. A field marked coalesce keys the match; NO coalesce field = always insert = duplicate rows on every re-run. The most common transform bug is a missing/mis-typed coalesce field.
- **The coalesce field MUST be indexed** — it is the single biggest lever on transform throughput. An unindexed coalesce column forces a full-table scan of the (often multi-million-row) target for EVERY source row: one real load crawled at ~34 rows/min and a non-unique BTree index on the coalesce field took it to ~2,000 rows/min (~66×). When reviewing/authoring a transform, confirm the coalesce column (and any matched field like `u_external_id`) has a DB index.
- **Pre-existing duplicate coalesce values in the TARGET break coalescing** — the transform logs "More than one target records exists…" and can't decide which to update, so a naive load inserts MORE duplicates. If you parallelize a large load, partition the work BY THE COALESCE KEY (never by sys_id) so two workers never race the same key; verify zero new dup keys after.
- **Coalescing straight into `cmdb_ci` (or any CI class) bypasses IRE** — the Identification and Reconciliation Engine's dedup/precedence is skipped, producing duplicate/unreconciled CIs. Even some OOB maps do this. CMDB imports must route through IRE (identification rules / `createOrUpdateCI`), not a raw coalesce-into-cmdb_ci map.
- Field maps vs scripts: a scripted field map returns the value (`answer = ...` pattern in some contexts, or set `target.field`); read the specific script type's contract.
- Traps: dot-walking `source` reference fields that aren't populated yet; assuming `target.sys_id` exists in onBefore (it may not until insert); heavy per-row GlideRecord lookups (N+1 across a large import) — batch or cache.

## Notification / email scripts (mail scripts)

**Context:** server Rhino at send time. A `<mail_script>` (or `${mail_script:name}`) outputs via `template.print(...)`, not `return`.

- Variables: `current` (triggering record), `template`, `email`, `email_action`, `event`.
- Notification body `${field}` dot-walks `current`; `${mail_script:name}` invokes a reusable script; these are evaluated at send time so a field blank then prints blank.
- Traps: putting secrets/PII in a notification; assuming `current` fields are set; using `gs.getUser()` (the sender context is not the recipient); building HTML by string concat without escaping user content; a mail script that queries per-recipient in a bulk send (performance).

## Inbound Email Action

**Context:** runs when an inbound message matches (New / Reply / Forward, by type + condition + order). Variables: `email` (`email.body`, `email.body_text`, `email.subject`, `email.from`, `email.recipients`), `email_action`, `current` (created or matched via watermark/subject), `event`, `sys_email`.

- Set fields on `current`, then `current.insert()`/`update()`; check the return.
- Traps: trusting `email.from` for authorization (spoofable — validate against a user record / allowlist); parsing `email.body` with brittle regex; watermark vs recipient matching picking the wrong record; reply loops (an action that emails back on every inbound).

## Flow Designer — custom Action script step / inline script

**Context:** runs inside a flow execution. Contract is `(function execute(inputs, outputs) {...})(inputs, outputs)`.

- ONLY `inputs.*` come in; ONLY `outputs.*` go out. There is no `current`, no `g_form`, no implicit record. A value not written to `outputs` is invisible to later steps.
- Traps: expecting `current`/`gs.getUser()` semantics from a business rule; non-idempotent side effects (Flow retries a failed step — a "create record" step can double-create); long synchronous work in a flow action (timeouts); throwing instead of setting an error output the flow can branch on.

### Authoring/publishing flows over the API
- **Custom Actions can't be Table-API'd:** an insert into `sys_hub_action_type_definition` is blocked and returns null. Author actions in Flow Designer or the Fluent SDK. (I/O model, for reference: inputs = `sys_hub_action_input`, outputs = `sys_hub_action_output`, steps = `sys_hub_action_instance`.)
- **Whole flows CAN be created + published via API:** author with the Fluent SDK (`now-sdk`), then `sn_fd.FlowAPI.publish('<sys_hub_flow sys_id>')` server-side (run it via a run-once `sysauto_script` — see `integrations-deploy.md`). `publish()` compiles the snapshot, sets `active`/`status=published`, registers the trigger, and DECLINES hand-built Table-API flows (they stay draft).
- **A raw `active=true`/`status='published'` field-flip is dead code** — without a compiled snapshot the flow does nothing.
- **Old-platform value-binding caveat:** on pre-Zurich instances `FlowAPI.publish()` compiles a Fluent flow's STRUCTURE but not its input VALUES (they deploy gzip+base64 inside a `<values>` blob with no relational `sys_variable_value` rows to bind), so a triggered flow runs with EMPTY args (blank `log_message`, `table_name`, etc.). Value-binding needs `now-sdk install` hitting `api/now/wfa_fluent/activate_flows`, which only exists on current platforms; use `now-sdk install --reinstall` (plain `update-install` silently no-ops).
- A **REST step inside a custom Action requires IntegrationHub** — without the subscription the OOB REST step-type is unavailable.

## Catalog items (backing tables that lie)

Catalog artifacts don't live where their names suggest — writing against the "obvious" table silently misses:
- Catalog **variables** live on `item_option_new` (not "variables"); their **values** on a request line live on `sc_item_option` joined via `sc_item_option_mtom`; variable **set definitions** on `item_option_new_set`, attached to a catalog item via the `io_set_item` m2m (`sc_cat_item` + `variable_set`).
- A catalog **client script** targets the VARIABLE name (`g_form.getValue('variable_name')`), not a field name, and its "Applies to" (item vs set) + catalog UI type decide where it runs.
- When scripting against a submitted request, read the variables through `sc_item_option`/the MTOM, not by guessing a column on `sc_req_item`.

## UI Action / activation overlap

Activating a custom global UI Action (or any custom artifact) whose table + condition overlaps an out-of-box one can make BOTH fire or the custom one shadow the OOB — verify the condition is narrow enough that it doesn't double-trigger against the platform's own.

## Data Policy / Data Lookup

**Context:** Data Policies enforce mandatory/read-only across ALL channels — form, import, web service, API — unlike UI Policies (form only). Data Lookup rules set field values from a lookup table.

- Traps: a UI Policy used where a Data Policy is needed (import/API bypass the UI Policy); a Data Policy making a field mandatory that an integration can't populate (imports start failing silently); "Use as UI Policy on client" surprising form behavior.

## Application scope & cross-scope access

Every artifact lives in an application scope (global or `x_*`), and scope governs what code can touch what:
- A scoped script reaching another scope's table/Script Include needs BOTH sides to allow it: the target record's **"Accessible from"** = "All application scopes" and (for runtime data) the target application's **cross-scope access privileges** (`sys_scope_privilege`) granting the operation. A missing privilege throws a "Security restricted" / cross-scope error at runtime, not review time.
- `gs.getCurrentScopeName()` / the record's `sys_scope` decide scope; `setWorkflow`, `GlideRecord` on `sys_*` tables, and `eval` are often restricted or unavailable in scoped apps (`gs.log` doesn't emit — use `gs.info`).
- Package-private Script Includes/tables are invisible cross-scope even if you have the sys_id. To run code IN a scope, stamp the executing record into that scope (see `integrations-deploy.md`), don't just reference it.

## Thinner platform areas (know the shape, reach for the right table)

- **SLA / schedules:** SLA definitions (`contract_sla`) attach conditions + a **Schedule** (`cmn_schedule`) so pause/breach math respects business hours; scripting business-time uses `GlideSchedule.duration()`, never raw date subtraction. A "wrong breach time" bug is almost always the schedule/timezone, not the SLA condition.
- **Attachments:** use `GlideSysAttachment` (`.write`, `.getContent`, `.copy`) — attachments are `sys_attachment` + chunked `sys_attachment_doc`, not a field; size/type limits are properties; copying a record does NOT copy its attachments unless you call `.copy`.
- **ATF (Automated Test Framework):** tests are `sys_atf_test` + ordered `sys_atf_test_step`; custom step logic is a step config script with its own `inputs`/`outputs` + assertion contract, run in an isolated rollback transaction. Prefer ATF (as-user, repeatable) over ad-hoc background scripts for verifying ACLs/flows.
- **Legacy Workflow (`wf_workflow`)** still runs where flows haven't replaced it: activities carry scripts with `workflow.scratchpad`, `activity.result`, and `workflow.info/error`; a stuck context sits in `wf_context` (state=executing). Don't author new automation here — but you'll debug it.
- **Client dialogs:** `GlideModal`/`GlideModalV3`/`GlideModalForm`/`GlideOverlay` open UI-Page-backed dialogs from client scripts/UI Actions; the dialog body is a UI Page (Jelly rules apply), and `get()`/`setPreference()` pass data in. `GlideModal` is classic-UI; Service Portal uses `spModal` instead.
- **Domain separation:** on domain-separated instances every query is auto-scoped to the user's domain; `sys_domain`/`sys_overrides` govern visibility, admin work may need `domainImpersonate`, and "records exist but this user can't see them" is often domain, not ACL.
- **ITOM scripting:** Discovery probes/sensors and `MIDServer` Script Includes run on the MID (Rhino too, but different globals — no `gs`); Event Management alert rules and `em_event` transforms are their own script contexts. Flag CMDB writes from these that skip IRE.
- **Scheduled data export:** `scheduled_data_set` / `sys_report` on a schedule export to a file/email; large exports need the export set's chunking, and a report tile ≠ an export.

## Cross-cutting for all of the above

- Classify the context and honor its variable contract before writing or judging a line — the same `current` means different things (or nothing) across these.
- Every one still obeys the four platform questions (empty result, who runs it, what else fires, does it travel) and the silent-no-op discipline.
- Run `sn-lint.js` — it detects most of these as `server` context and applies the reserved-key, boolean-getValue, and query rules; the type-specific contract traps above are manual.
