# Security: ACLs, roles, and the platform's inverted assumptions

ServiceNow access control fails in the opposite direction from most systems people learn on, and the review must apply the PLATFORM's semantics, not intuition. The other half of this reference is the injection/exposure surfaces unique to SN: client-callable Script Includes, encoded queries, scripted endpoints, and elevated tooling identities.

## ACL semantics — the four inversions

1. **An empty ACL does not grant.** An ACL with no roles, no condition, and no script does NOT open the table — evaluation still needs `answer` to come out true. "Opening up" a table by clearing an ACL's conditions achieves nothing (and the reflexive next move — granting a broad role — over-grants). The explicit form is a script setting `answer = true;`. Review any access change by what it PROVES about the target persona, not what it removed.
2. **ACL matching is exact-table first.** A `task` ACL does not automatically secure `incident` the way people assume; wildcard (`*`) and parent-table ACLs interact through the processing order (specific table.field → specific table.* → parent → wildcard). Tooling that checks "is there an ACL on this table" must match the exact table name — counting a parent's ACL as coverage is how gaps ship.
3. **row-level (`table`) and field-level (`table.field`) ACLs BOTH must pass.** A field ACL is meaningless if the row ACL already denies, and a permissive row ACL doesn't expose a field the field ACL protects. Review them as a pair.
4. **Admin passes everything — except on scoped-app tables.** Any test performed as admin usually proves nothing (admin satisfies every ACL). The exception: on some scoped-application tables (e.g. `sn_grc`/`sn_compliance`) even admin is denied without the app's own role, so an admin-only test can *falsely fail*. Either way the review question for every ACL change stands: "what persona was this verified as, and how?" The only reliable non-admin check is a server-side `GlideImpersonate` harness that impersonates the target user, calls `gr.canRead()`/`canWrite()` (or re-runs the query) and restores identity — an ATF as-user test works too. No answer = finding.
5. **Read ACLs gate list/query visibility — there is no separate `query` operation.** The base ACL operations are create/read/write/delete (plus a few specials like `report_on`, `list_edit`, `edit_ci_relations`, `save_as_template`). Read ACLs are evaluated per-row *during* list and query resolution, so a row that fails its read ACL is silently dropped from lists and can't be resolved directly — but a plain server-side `GlideRecord` (not `GlideRecordSecure`) bypasses that evaluation entirely and returns the hidden rows. Row-level query filtering as a design is done with a **before-query business rule** (see `server-side.md`), not a "query ACL".

## Roles

- **Assess role impact before adding one.** Adding a role to fix one error message also unlocks everything else that role touches. The review wants: what ELSE does this role grant (its ACL memberships, its contained roles — roles nest), and was a narrower role or a new purpose-built role considered? Over-granting is the most common self-inflicted hole. (CWE-269)
- `gs.hasRole('a,b')` = ANY-of, and admin always true. A security gate on a widely-held role is decoration.
- **Inherited/contained roles:** `sn_x` containing `itil` means every check for `itil` passes for `sn_x` holders — trace containment before concluding a check is narrow.

## Injection and exposure surfaces

- **Client-callable Script Includes** are the platform's biggest self-service attack surface: reachable by any authenticated user via `xmlhttp.do`, regardless of which form "uses" them. Every method needs its own role/ACL validation and hostile-input handling of `getParameter` values. The `public` flag extends reach to unauthenticated. (CWE-862)
- **Encoded-query injection:** `addEncodedQuery(userInput)` or string-concatenated encoded queries let callers splice `^OR`/`^NQ` clauses and widen results arbitrarily. Values go through `addQuery(field, op, value)`; encoded strings are developer-authored constants. (CWE-943)
- **Scripted REST endpoints:** check the `requires_acl`/authentication settings on the operation, then check the script AGAIN — an endpoint marked authenticated still needs authorization (which records may THIS user touch). `GlideRecordSecure` inside, explicit role checks, no table/field names taken raw from the request path/body into queries.
- **GlideRecord vs GlideRecordSecure:** plain GlideRecord in any user-serving path (widget server script, scripted REST, processing script, AJAX SI) runs unrestricted and returns rows the user's ACLs would hide. Secure variants or explicit `canRead()` per row.
- **ACL row scripts: compare with `getValue()`, never `current.field === gs.getUserID()`.** `current.field` is a GlideElement, not a string. Strict `===`/`!==` compares object-to-string and NEVER matches, so the ACL returns the wrong boolean for EVERY row (grants or denies the whole table — a data-exposure or lockout). Loose `==` happens to work because Rhino coerces the GlideElement via toString, but relying on that is unclear and fragile. Always `answer = current.getValue('u_owner') == gs.getUserID();`. This GlideElement-vs-string trap is a bug anywhere; in an ACL script it's a security incident.
- **Reflected output:** anything echoing request data into HTML/JSON-in-HTML (UI Pages, widgets via `trustAsHtml`) — see the ui-pages and service-portal references. (CWE-79)
- **`GlideSystem` info leaks:** error messages carrying query internals, sys_ids of records the user can't read, or stack traces to the client.

## Secrets and identity

- No credentials, API keys, or instance passwords in scripts, sys_properties (plaintext), widget options, or system logs. Platform-side: Connection & Credential aliases / credential records; tooling-side: env files parsed by code (never shell-`source`d — `$` inside passwords gets expanded/mangled, yielding intermittent 401s that masquerade as instance flakiness). (CWE-798, CWE-532)
- **Elevated tooling identity leaks:** deploy/fix scripts running as admin create records attributed to admin, may satisfy ACLs the eventual users won't, and can mask missing grants until go-live. Stamp intended `sys_created_by`/`sys_updated_by` on generated XML; verify features as the target persona.
- During review, if a secret value is encountered: report location and class, never quote the value.

## Checklist

- [ ] No change assumes an empty/cleared ACL grants; every grant names the persona it was verified as (non-admin)
- [ ] ACL coverage checks match exact table names; row+field ACLs reviewed as pairs
- [ ] Role additions come with an impact statement (what else the role unlocks, containment traced)
- [ ] Client-callable SIs and scripted REST operations authorize per-method and sanitize per-parameter
- [ ] User-serving server code uses GlideRecordSecure / explicit can* checks
- [ ] No encoded queries built from user input anywhere
- [ ] No plaintext secrets in scripts/properties/logs; env files parsed, not sourced; generated records stamp intended identity
