# UI Pages, Jelly, and UI Macros

A UI Page is three programs in one record: Jelly XML evaluated **server-side at render time** (two phases), a `client_script` shipped to the browser, and an optional `processing_script` that runs server-side on POST. Most UI Page bugs come from code written for one phase being evaluated (or eaten) by another.

## The phase model — where most bugs live

- **Phase 1 Jelly** (`${}` and `<j:>` tags) is interpolated server-side when the page renders. **Anything that looks like `${...}` in the HTML or client_script is consumed by Jelly** — including JavaScript template literals. A `` `Hello ${name}` `` in client_script reaches the browser as `` `Hello ` `` (or breaks outright). This is the single most common UI Page defect in generated code. Fix at build time: convert every template literal in client_script/html payloads to string concatenation before deploy. Grep for backticks and `${` in any payload destined for `sys_ui_page`. High.
- **Phase 2 Jelly** (`$[...]`, `<j2:>`) evaluates after phase 1 — used for values that depend on phase-1 output. Mixed-phase code that assumes ordering the other way renders literal markup.
- **`<g:evaluate>`** runs server-side Rhino: everything in `references/server-side.md` applies inside it (reserved keys, ES5, GlideRecord discipline). The `jelly="true"` attribute exposes the `jelly` variable context; `object="true"` keeps a returned object addressable — check the attributes match how the variable is consumed.
- Variables cross from Jelly to browser only by being **printed into the page**. Check the escaping at every such crossing (next section).

## Security

- **Reflected XSS is the default failure mode.** Any request parameter or record value printed into HTML must be escaped: `${JS:...}` for JS-string contexts, `<g:no_escape>` is an explicit danger marker (flag every use), and raw `RP.getParameterValue('x')` echoed into markup is an injection. (CWE-79)
- **Processing scripts are unauthenticated-adjacent endpoints.** They run on POST with the session's identity but developers forget they're reachable directly. Validate every `sysparm_*`, re-check authorization server-side (roles/ACLs — do not trust that only the page's buttons post here), and prefer `GlideRecordSecure` for reads/writes on behalf of the user.
- **CSRF:** POSTs from the page must carry the session token (`g_ck` / `sysparm_ck`) and the processing script should reject without it.
- UI Pages marked **public** (direct, no login) get the full hostile-input treatment.

## Transport and encoding traps

- **"Content is not allowed in prolog" on import** = invisible characters (BOM, smart quotes, NBSP) ahead of the XML declaration — the classic cause is copying XHTML out of a browser view. Source page bodies from files (`pbcopy < file.xhtml` when clipboarding); never from rendered browser content.
- **No CDATA in UI Pages (standing convention).** Do NOT wrap script bodies or content in `<![CDATA[ ... ]]>`. CDATA is brittle across ServiceNow's processing/import paths and is disallowed here — flag any `<![CDATA[` in a UI Page as a defect to remove (when authoring, never emit it). Make the markup XML-valid the honest way instead (next bullet). When completing or fixing a page, strip CDATA and re-escape rather than leaning on it.
- **Stay XML-valid without CDATA.** Since CDATA is off the table, the `<`/`&` characters that would break XML parsing must be handled directly: `&` becomes `&amp;`, a literal `<` in inline JS (`if (a < b)`) becomes `&lt;` or is rewritten to avoid the bare `<` (e.g. `b > a`), and heavier client logic belongs in a UI Script / Script Include the page references rather than inline. A page that passed once and fails after an edit usually grew a bare `&` or `<` that CDATA would have masked — fix the escaping, don't add CDATA back.
- **Only the 5 XML built-in entities exist.** `&amp; &lt; &gt; &quot; &apos;` are defined; every OTHER named entity (`&nbsp; &mdash; &middot; &rsquo; &copy; ...`) is an *undefined entity reference* in XHTML/Jelly and fails the page to parse. Use the literal Unicode character or a numeric reference instead — `&#160;` (nbsp), `&#8212;` (em dash), `&#8226;` (bullet).
- **No minimized boolean HTML attributes.** Because the page is parsed as XML, a valueless attribute (`<input checked>`, `<option selected>`, `disabled`, `readonly`, `multiple`, `required`) is a well-formedness error. Write the `attr="attr"` form: `checked="checked"`, `disabled="disabled"`.
- Jelly whitespace/comment behavior: `<!-- -->` comments are stripped server-side; `//` comments in inline JS can eat the rest of a line after minification-style concatenation — prefer `/* */` in embedded scripts.

## UI Macros and UI Actions

- UI Macros are Jelly fragments with the same phase rules; they additionally inherit the calling context's variables — name collisions with the host page are silent.
- UI Action **client-side + server-side hybrids** (`Client` checked with an `Action name`, using `gsftSubmit`) need the client function to guard double-submission and the server branch to re-validate; the pattern where the client half calls `gsftSubmit(null, g_form.getFormElement(), 'action_name')` and the server half runs the same script field is easy to get subtly wrong — verify both halves were reviewed under their own context rules.
- Synchronous heavy work (deep CMDB/relationship walks, multi-level queries) inside a UI Action's server script blocks the form transaction for every clicking user. Bound the depth, batch it, or move it async. Refresh-style actions that rebuild a related list must preserve manually-added rows (filter the delete pass on origin) — wiping user-entered data is silent data loss.

## Checklist

- [ ] No JS template literals / `${` survive in `client_script` or `html` payloads bound for the instance (build step converts them; verify build OUTPUT)
- [ ] Phase-1 vs phase-2 Jelly usage is deliberate; `<g:evaluate>` bodies pass the server-side checklist
- [ ] Every request parameter or record value printed into the page is escaped for its context; every `<g:no_escape>` justified
- [ ] Processing script validates input, enforces authorization itself, and checks the CSRF token
- [ ] Page body sourced from files, not browser copies; XML entities valid (`&amp;`, `&lt;`); NO CDATA — markup is XML-valid through escaping, not CDATA wrapping
- [ ] Hybrid UI Actions reviewed as two programs; no synchronous deep traversals in form-transaction paths; related-list rebuilds preserve manual rows
