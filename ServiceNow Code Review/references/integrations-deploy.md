# Integrations and deploy tooling: Scripted REST, Table API scripts, update sets, XML

Two directions to review: **inbound** (Scripted REST APIs the instance exposes) and **outbound tooling** (local Python/Node scripts that build and push records via `/api/now/*`). Deploy tooling deserves production-grade scrutiny even when it looks like a throwaway script — it writes to a live instance, and its failure mode is a half-applied deployment nobody notices.

## Scripted REST APIs (inbound)

- Operation settings first: authentication required? `requires_acl`? Then the script: authentication is not authorization — check WHICH records this caller may touch (roles, GlideRecordSecure, per-record can* checks).
- Path/query/body parameters are hostile: no raw table names or encoded queries from the request into GlideRecord; validate types; bound page sizes (`sysparm_limit` caps).
- Error contract: consistent status codes + JSON error body; no stack traces or internal sys_ids leaked; 404 vs 403 chosen deliberately (403 on unreadable records enumerates existence).
- Versioning: breaking changes go in a new version path, not edits to `v1` in place.
- Long work: REST handlers run in the semaphore-limited API pool — heavy processing belongs in an async job the handler enqueues, returning 202 + a tracking id.

## Table API deploy tooling (outbound) — the write-path audit

Trace ONE write end-to-end; the discipline you find there holds for the rest of the repo. Checkpoints in order:

1. **Payload field names verified against the real table dictionary.** The Table API silently ignores unknown fields — a typo'd field name half-creates the record with no error. (`sp_container` not `container`, `size` not `size_x` — see service-portal.md.)
2. **Scope forced before the POST — and you CANNOT fix it afterward.** Records land in the calling session's **current application** (`apps.current_app` user preference), NOT the payload's `sys_scope`. A post-hoc PATCH of `sys_scope` returns HTTP 200 with a success body but silently does NOT change the scope — developers reflexively try exactly this and it fails invisibly. The only fix is forcing scope BEFORE the insert: GET the current user, read `sys_user_preference` where `name=apps.current_app`, PATCH it to `global` (or the target scope) if wrong, THEN insert. Only INSERT/POST is affected; PATCH of an existing record is not, so update-only deploy scripts don't need it. High.
3. **No scoped-update-set creation over REST.** The REST session binds to global; you cannot create/select a scoped update set via the Table API, and `setCurrentApplicationId()` THROWS in background scripts. Legal routes: Studio, the Default update set, or `X-UserApp-Scope` for record-level scoping. A deploy path attempting it is dead code that looks alive.
4. **Status AND body checked; sys_id captured.** The Table API can return 201 with a silently-adjusted record. Critical records get a verification read-back (fetch what you created, compare the fields that matter).
5. **Backup before update.** Fetch and persist the prior record state (e.g. `deploy/backups/`) before any PUT/PATCH, so a bad push is revertable without instance-side archaeology.
6. **Idempotent re-runs.** Keyed on sys_id or a unique-name query: insert-if-absent else update. Multi-record builders (dashboards, portal pages) must dedupe EVERY child record type, or each re-run litters the instance.
7. **Dry-run is the default.** Tooling pointed at a live instance reports what WOULD change on a bare invocation; mutation requires an explicit `--apply`-style flag. Non-negotiable for customer instances.

## Transport discipline

- **Rate limits are real:** dev and customer instances throttle aggressively. Sequential or low-concurrency writes, backoff on 429/503, retries only on idempotent calls. A parallel push storm leaves a half-applied state and can get the account blocked mid-deploy.
- Pagination: `sysparm_offset` drifts under concurrent writes — for large exports, keyset-paginate on `sys_created_on`/sys_id watermarks. `sysparm_fields` + `sysparm_exclude_reference_link=true` to shrink payloads; remember `sysparm_display_value` changes the VALUE format, not just adds to it.
- Credentials from env/secret store (`~/.servicenow/.env` pattern), loaded by a parser — never shell-`source`d (a `$` inside the password gets expanded; the truncated credential yields intermittent 401s that look like instance flakiness). Never echoed into logs or errors. (CWE-798/532)
- Background-script execution channels (`sys.scripts.do`-style runners): the response wraps output in session HTML — the tool must extract a sentinel-delimited payload (`RESULT_JSON:` prefix / `___DONE___`) and THROW when the sentinel is missing. Empty output = compile failure, not "nothing to do" (see server-side.md reserved-key trap).

## Running server-side code over REST (the elevated-exec channel)

Several deploy tasks (writing ACLs, building PA dashboards, calling scoped OOB strategies) can only be done from server-side code running as system. The channels are not equal:

- **`/sys.scripts.do` returns EMPTY over curl** (effectively dead headlessly), and on hardened instances is auto-mode-classifier-blocked. The reliable route: **POST a `sysauto_script` with `run_type='once'` and a `run_start` already in the past**; the next scheduler tick executes it in system context. There is no synchronous return — confirm success by reading back a distinctive `gs.info('BUILD_MARKER ...')` sentinel from `syslog`.
- **The script can be silently saved EMPTY.** On hardened instances a Table-API write to `sysauto_script.script` is stripped to empty (anti-injection) with no error, and `sys_index` reads return 403. A robust tool READS BACK `sysauto_script.script` after writing; if empty, it falls back to the Background Scripts UI / a Fix Script rather than assuming the runner fired.
- **`X-UserApp-Scope` does NOT stamp a record into a scope for EXECUTION** — it forces `global` on writes, but a run-once `sysauto_script` still lands global. To run code in a target scope (e.g. reach a `package_private` `sn_grc.IndicatorStrategy`), briefly set the running user's `apps.current_app` preference to that scope, insert+run the script (now stamped `sys_scope=sn_grc`), then restore the preference.
- **Protected tables reject the basic-auth Table API.** Writing `sys_security_acl` or `sys_variable_value` over REST fails with "ACL Exception / security constraints" — they need the elevated `security_admin` role the UI grants interactively, which a normal REST session lacks. Do the insert/update from a server-side script running as system (the run-once `sysauto_script` above), which bypasses it.

## Installing apps and plugins

- **Store apps are not plugins.** CSM, GRC/IRM, and most product suites are records in `sys_remote_app`, so `plugin/{id}/activate` returns "Plugin ID is not valid" for them. Install via `POST /api/sn_cicd/app_repo/install?scope=<scope>&version=<latest_version>` (auto-resolves dependencies, returns a progress id to poll at `/api/sn_cicd/progress/{id}`). Only real plugins (`sys_plugins`, e.g. `com.sn_customerservice` core) use `plugin/{id}/activate`. ServiceNow SERIALIZES installs — don't parallelize; poll progress.

## Flow Designer over the API

- You CAN create and publish a whole flow via API, but NOT by hand-writing records. Authoring a custom Action via Table-API insert into `sys_hub_action_type_definition` is **blocked (returns null)**, and flipping `sys_hub_flow.active=true`/`status='published'` directly yields a structurally broken flow (no compiled snapshot) that does nothing. Correct path: author with the ServiceNow Fluent SDK (`now-sdk`), then call `sn_fd.FlowAPI.publish('<sys_hub_flow sys_id>')` server-side (via the run-once `sysauto_script` runner) — it compiles the snapshot, sets `active`/`status`, and registers the trigger. See `more-script-types.md` for the value-binding caveat on older platforms.

## Update sets and generated XML

- State the travel plan: does this change need to reach another instance? If yes — is it actually captured (tracked table, correct scope, completed update set), or being pushed record-by-record via XML/API on both sides?
- Generated unload/import XML: stamp `sys_created_by` AND `sys_updated_by` to the intended service account (unstamped records attribute changes to whoever imports — audit fiction on customer instances); keep generated sys_ids stable across re-runs so re-imports update rather than duplicate; references travel by sys_id — carry referenced records or resolve by key on arrival.
- Data vs config: update sets capture config (sys_metadata tables) only. Tooling that expects an update set to carry data rows (users, groups, records) is wrong by design.

## Outbound REST from the instance (RESTMessageV2 etc.)

- Timeouts set explicitly (default is generous enough to hang a transaction); calls from sync business rules are a form-freeze bug — move to async.
- MID server selection stated where required; credentials via alias, not inline `setBasicAuth` literals.
- Response handling: check `getStatusCode()` AND parse errors; log correlation ids, not full payloads.
- **Auth belongs to the platform, not your code.** Basic auth → a Basic-auth **credential** + **connection alias** (`sys_connection`/`sys_alias`), referenced by the REST Message — never inline `setBasicAuth('user','pass')` literals. OAuth 2.0 → an `oauth_entity` (+ profile) and an OAuth authentication profile on the REST Message so the platform fetches/refreshes and stores tokens in `oauth_credential`; programmatic flows use `sn_auth.GlideOAuthClient`, not a hand-rolled token cache. Mutual TLS / client certs → a **protocol profile** + the cert in the keystore, selected on the REST Message — not a cert path in script. Flag any hand-rolled token refresh, inline credentials, or `Authorization: Bearer <literal>` header.

## Update set discipline

- **Only config travels; data does not.** Update sets capture `sys_metadata`-derived records (BRs, SIs, ACLs, UI pages, dictionary, etc.) — NOT data rows (users, groups, catalog *values*, actual records). A change that expects an update set to carry data is wrong by design; move data via import/XML.
- Some things don't capture even though they're config: scoped-app records outside the tracked set, certain system properties, and anything created while the wrong update set (or Default) was current. Verify the change landed in the intended set, not Default.
- Cross-instance: collisions are resolved by **last-committed-wins** on preview; review the preview for skipped/collided rows before commit, and know the **backout** unwinds only what the set tracked (data side-effects a BR caused stay). Batch update sets (Madrid+) let you order dependent sets — parent before child.

## Checklist

- [ ] Inbound endpoints authorize per-record, validate parameters, bound page sizes, and keep a stable error contract
- [ ] One write path traced end-to-end passes all seven checkpoints; deviations reported per checkpoint
- [ ] Scope forced on every scoped-artifact POST; no REST-created scoped update sets; no `setCurrentApplicationId` in background scripts
- [ ] Dry-run default, explicit apply, backups before update, idempotent re-runs
- [ ] Low concurrency + backoff; keyset pagination for big pulls; credentials parsed from env and never logged
- [ ] Background-script runners enforce output sentinels and throw on absence
- [ ] Generated XML stamps identity, keeps stable sys_ids, and carries/resolves its references
