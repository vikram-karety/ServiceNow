# Service Portal: widgets and page-builder payloads

A widget is two programs stapled together: a **server script** (Rhino — everything in `references/server-side.md` applies) and a **client controller** (AngularJS in the browser). The trust boundary between them is the `input` object, and the platform will happily let you build a widget where the server trusts the client completely. Page-composition records (`sp_page`/`sp_row`/`sp_column`/`sp_instance`) have their own trap: field names that LIE — the Table API silently drops unknown fields, so a wrong name half-builds a layout with no error.

## Widget server script

- Runs on load AND on every `c.server.update()` / `c.server.get()`. The `input` object is **client-controlled**: any user who can load the page can send arbitrary `input` to this script. Every branch keyed on `input` must validate and authorize server-side — `input.action == 'delete'` guarded only by whether the client showed a button is an authorization bypass. High. (CWE-862)
- Use `GlideRecordSecure` (or explicit `canRead()`/`canWrite()` checks) for record access on behalf of the user; plain GlideRecord in a widget runs with full snc-internal rights and leaks rows ACLs would hide.
- `$sp` API (`$sp.getRecord()`, `$sp.getParameter()`, `$sp.getValues()`) — parameters come from the URL: hostile. A widget that takes `table` and `sys_id` from the URL and queries without an allowlist is an IDOR/enumeration surface. (CWE-639)
- Everything placed on `data` is serialized to the browser. No secrets, no full GlideRecords (they don't serialize — copy primitives onto `data` field by field), and don't ship whole tables when the client needs five fields.
- Widget options (`options.x`) arrive as strings — `options.max_items + 1` concatenates.

## Client controller

- AngularJS: bind through `$scope`/`c.data`, don't touch the DOM directly (no `document.`, no jQuery selectors into other widgets' markup). DOM work belongs in a directive or the widget's own template.
- Every `c.server.update()` re-runs the ENTIRE server script — a controller calling it on every keystroke is a self-inflicted DoS. Debounce, or use `c.server.get({action:...})` with narrow branches.
- `spUtil.recordWatch($scope, table, filter, cb)` pushes live updates — check the filter is as narrow as the ACLs the user actually has; recordWatch bypassing what the user could query is an information leak.
- Angular expressions render escaped by default; `ng-bind-html` / `$sce.trustAsHtml` on server-derived or user-derived strings is the XSS marker to flag. (CWE-79)
- Embedded widgets / events: `$rootScope.$broadcast` couplings between widgets are invisible dependencies — name them in the review.
- **`${}` in widget HTML templates is i18n interpolation** — the platform processes it as a message translation tag, so raw `${...}` in template markup gets eaten or translated, not rendered. In the client controller JS it's plain browser JS (no Jelly, template literals are fine there); the Jelly-strips-`${}` trap belongs to `sys_ui_page`, not widgets.

## Page-builder payloads (sp_page / sp_row / sp_column / sp_instance)

Deploy scripts that compose portal pages via the Table API hit four documented traps:

1. **`sp_row` parent field is `sp_container`, not `container`.** Wrong name = silently dropped = row orphaned at top level or missing.
2. **`sp_column` width field is `size`, not `size_x`.** Silently dropped = column defaults, layout collapses.
3. **`sp_page` IDs convert hyphens to underscores on save** (`my-page` becomes `my_page`). Tooling that creates then queries back by the submitted ID "fails" against a page that exists — verify-by-converted-ID or by sys_id.
4. **Name-based lookups on sp_* tables silently match out-of-box records** (there are 2018-era OOTB pages/widgets with generic names). A builder that finds-or-creates by name can adopt and then "update" a stock record. Key on sys_id captured at create time, or a distinctive prefix, and read back what you created.

Also: `sp_instance` links widget-to-column via `sp_column` reference and carries `widget_parameters` as a JSON string (validate it parses); portal/theme/page associations (`sp_portal.homepage`) are references that fail silently when the target sys_id is wrong.

## Widget CSS traps (silent layout loss)

Service Portal processes `sp_widget.css` before serving it, and two behaviors silently drop rules with no error:

- **`backdrop-filter` nukes the whole rule.** SN's CSS sanitizer drops the ENTIRE rule that contains `backdrop-filter` (or `-webkit-backdrop-filter`), not just that one property — so the `display:flex`, `height`, etc. in the same rule vanish too, while sibling rules survive. Symptom: one "glass" class silently does nothing and you lose half an hour on "why doesn't display:flex work". Strip `backdrop-filter` before deploy; use a solid background.
- **The `.v<widget_sys_id>` auto-prefix + stray comments.** SP prepends `.v<sys_id>` to every selector to isolate the widget instance; if your scoped/generated CSS leaves a `/* comment */` in the output, the prefix pass can produce a malformed selector and the rule is dropped silently. Strip CSS comments before the scope walker runs, and verify the rendered selector.
- **Bootstrap wrapper caps width.** SP wraps every `sp_container` in a Bootstrap `.container` (~1170px max) plus `.row`/`.col-md-12` padding, so a widget can't span full width on a wide screen. Set `bootstrap_alt = true` on the `sp_container` (also available on `sp_row`/`sp_column`) to drop the wrapper.

## Checklist

- [ ] Every `input`-keyed server branch validates and authorizes independently of the client UI
- [ ] Record access uses GlideRecordSecure or explicit can* checks; URL-derived table/sys_id parameters are allowlisted
- [ ] `data` carries only what the template needs; no secrets; no raw GlideRecords
- [ ] Controller: no DOM reach-arounds, debounced server round trips, no `trustAsHtml` on tainted strings
- [ ] recordWatch filters match the user's real read rights
- [ ] Payloads use `sp_container` (sp_row), `size` (sp_column), `sp_column` (sp_instance's column ref) — never `container`/`size_x`/`column`; page-ID hyphen conversion handled; created records verified by sys_id read-back, never adopted by name match
- [ ] Widget CSS has no `backdrop-filter`, no stray comments in scoped output; full-width widgets set `bootstrap_alt`
- [ ] Builder scripts are idempotent (re-run updates, doesn't duplicate instances/rows/columns)
