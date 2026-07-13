# Authoring patterns: how to write each artifact RIGHT

This is the positive companion to the review references. When WRITING new code, COMPLETING a stub, or deciding what's MISSING, anchor on these canonical shapes. Each is the shape a platform architect would ship; deviations are what the review references flag. Write to the shape, then self-review against the matching review reference before declaring done.

Rule zero for authoring on this platform: **prove it ran.** The silent-no-op trap that dominates review also dominates authoring — code that compiles to nothing, renders to nothing, or lands in the wrong scope looks identical to success. Every artifact you write needs a way to tell "worked" from "did nothing": a log with a distinctive marker, a verification read-back, or a value the caller checks.

## Business Rule (server, Rhino)

```javascript
(function executeRule(current, previous /*null on insert/async*/) {

    // Condition lives in the CONDITION FIELD, not here. Keep the script to the action.
    // before: mutate current directly; NEVER current.update().
    // after:  react; use GlideRecord on OTHER records or a flow.
    // async:  previous is null; heavy/integration work belongs here or in a flow.

    if (current.priority.nil()) return;               // guard reference/empty before use

    var group = gs.getProperty('x_acme.triage_group'); // portable: property, not sys_id literal
    if (!current.assignment_group.nil() || !group) return;
    current.setValue('assignment_group', group);       // before-rule: assignment is the write

})(current, previous);
```

Choose the WHEN deliberately: **before** for field derivation on the same record; **after** for touching related records; **async** for integrations/recalcs that must not block the save; **display** only to feed `g_scratchpad`. Put the trigger in the condition field so the script doesn't even load off-condition.

## Script Include — plain and client-callable

```javascript
// Plain server utility
var AcmeUtils = Class.create();
AcmeUtils.prototype = {
    initialize: function() {},
    activeCountFor: function(ciSysId) {
        var ga = new GlideAggregate('incident');       // COUNT, never getRowCount
        ga.addQuery('cmdb_ci', ciSysId);
        ga.addQuery('active', true);
        ga.addAggregate('COUNT');
        ga.query();
        return ga.next() ? parseInt(ga.getAggregate('COUNT'), 10) : 0;
    },
    type: 'AcmeUtils'                                    // MUST equal the SI name
};
```

```javascript
// Client-callable: authorize FIRST, validate every parameter, GlideRecordSecure
var AcmeAjax = Class.create();
AcmeAjax.prototype = Object.extendsObject(AbstractAjaxProcessor, {
    getSummary: function() {
        if (!gs.hasRole('itil')) return this._err('forbidden');   // gate before data
        var id = this.getParameter('sysparm_id');
        if (!/^[0-9a-f]{32}$/.test(id + '')) return this._err('bad_id');
        var gr = new GlideRecordSecure('task');                   // caller ACLs still apply
        gr.addQuery('sys_id', id);
        gr.setLimit(1);
        gr.query();
        return gr.next() ? JSON.stringify({ number: gr.getValue('number') }) : this._err('not_found');
    },
    _err: function(code) { return JSON.stringify({ error: code }); },
    type: 'AcmeAjax'
});
```

## Client Script (onChange / onSubmit)

```javascript
function onChange(control, oldValue, newValue, isLoading, isTemplate) {
    if (isLoading || newValue === '') return;            // the mandatory guard
    var ga = new GlideAjax('AcmeAjax');                  // async only
    ga.addParam('sysparm_name', 'getSummary');
    ga.addParam('sysparm_id', newValue);
    ga.getXMLAnswer(function(answer) {                   // callback, never getXMLWait
        var data = JSON.parse(answer || '{}');
        if (!data.error) g_form.setValue('short_description', data.number);
    });
}
```

onSubmit that must validate server-side uses the **two-pass** pattern: first submit returns `false` and fires the async check; the callback sets a flag and re-submits; the handler lets the flagged pass through. A one-pass async onSubmit is decorative — the form already submitted before the answer arrives. Prefer UI Policies for static show/hide/mandatory.

## UI Action (the hybrid trap)

A UI Action can run **client-side**, **server-side**, or **both**. Decide explicitly:
- Server-only (Client unchecked): the script field runs as a server script on click; `current` is the record; do the write, call `action.setRedirectURL(current)`.
- Client + server: check **Client**, set **Onclick** to a function that validates, then calls `gsftSubmit(null, g_form.getFormElement(), '<action_name>')`; the SAME script field runs server-side when `typeof window == 'undefined'`. Guard the two halves:

```javascript
// Onclick (client)
function confirmClose() {
    if (!g_form.getValue('close_notes')) { g_form.addErrorMessage('Close notes required'); return false; }
    gsftSubmit(null, g_form.getFormElement(), 'close_incident'); // action name
}
// Script field (server half) — runs on the resubmit
if (typeof window == 'undefined') closeServerSide();
function closeServerSide() {
    current.state = 7;
    current.update();                                    // in a UI action this IS the write (not a before rule)
    action.setRedirectURL(current);
}
```

Never do a synchronous deep CMDB/relationship walk in a UI Action — it freezes the form for every user; move it async or bound the depth.

## Transform Map scripts

Field/onBefore/onAfter transform scripts have their own contract:
- Variables: `source` (import row), `target` (the record being written), `map`, `log`, `action` (`'insert'`/`'update'`/`'ignore'`), `error`, `ignore`, `status_message`.
- To skip a row: set `ignore = true` — that flag, not `return`, is what actually skips the row. A bare `return` only stops the rest of the current script; it does NOT skip the row on its own, so write `ignore = true; return;` (set the flag, then optionally exit early). To fail a row with a message: `error = true; error_message = '...'`.
- Coalesce is what makes it update-vs-insert; a transform with no coalesce always inserts (dedupe bug). onBefore runs per source row before the write; onAfter after.

```javascript
// onBefore transform script: skip blank keys, normalize
(function transformRow(source, map, log, target) {
    if (source.u_external_id.nil()) { ignore = true; return; }  // ignore, not return-only
    target.u_external_id = source.u_external_id.toString().trim();
})(source, map, log, target);
```

## Notification / email (mail script)

A mail script runs server-side at send time. Available: `current` (the triggering record), `email`, `email_action`, `template`. Output via `template.print(...)`, not `return`.

```javascript
// <mail_script> body
(function runMailScript(current, template, email, email_action, event) {
    template.print('Incident ' + current.getDisplayValue('number') + ' assigned to ' +
                   current.getDisplayValue('assigned_to') + '.');
})(current, template, email, email_action, event);
```

In the notification BODY (not the script), `${field}` dot-walks the triggering record's fields, and `${mail_script:name}` invokes a reusable mail script. Never put secrets in a notification; never assume `current` fields are non-empty at send time.

## Inbound Email Action

Runs when mail matches. Variables: `email` (parsed message: `email.body`, `email.subject`, `email.from`, `email.body_text`), `email_action`, `current` (new or matched record), `event`. Set fields on `current` and `current.update()`/`insert()`. Route by watermark/subject; validate `email.from` before trusting content.

## Flow Designer custom action (script step)

```javascript
(function execute(inputs, outputs) {
    // inputs.* are the declared inputs; set outputs.* for downstream steps.
    var gr = new GlideRecord('incident');
    if (gr.get(inputs.record_id)) outputs.number = gr.getValue('number');
})(inputs, outputs);
```

No `current`, no `g_form`. Everything in and out goes through the declared `inputs`/`outputs` contract; a value you forget to map to `outputs` is invisible downstream. Keep it idempotent — Flow can retry a step.

## Scripted REST resource (inbound)

```javascript
(function process(request, response) {
    if (!gs.hasRole('x_acme.reader')) { response.setStatus(403); return { error: 'forbidden' }; }
    var ALLOWED = { incident: 1, sc_task: 1 };
    var table = request.pathParams.table;
    if (!ALLOWED[table]) { response.setStatus(400); return { error: 'bad_table' }; }
    var gr = new GlideRecordSecure(table);               // caller ACLs enforced
    gr.addActiveQuery();
    gr.setLimit(Math.min(parseInt(request.queryParams.limit, 10) || 100, 1000)); // capped
    gr.query();
    var out = [];
    while (gr.next()) out.push({ sys_id: gr.getUniqueValue(), display: gr.getDisplayValue() });
    return { count: out.length, records: out };          // never return ex.stack to the caller
})(request, response);
```

Authentication is not authorization: even an authenticated endpoint must check roles and use `GlideRecordSecure`. Cap the page size. Log errors server-side; return a generic message + correlation id. Note: `request.queryParams.*` values are String ARRAYS (query params are repeatable), so `queryParams.limit` is `['100']`, not `'100'` — the `parseInt` above works only via single-element Array→String coercion; read it explicitly (`(request.queryParams.limit || [])[0]`) in real code. `pathParams.*` are scalars.

## Service Portal widget

Server script: treat `input` as client-controlled — authorize every branch, use GlideRecordSecure, copy only needed primitives onto `data` (no secrets, no raw GlideRecords). Client controller: AngularJS, bind through `c.data`, debounce `c.server.update()` (it re-runs the whole server script), never `trustAsHtml` a tainted string. Note: `${}` in a widget's HTML template is i18n, and template literals in the widget's client controller are fine (no Jelly there) — the Jelly-strips-`${}` trap is only `sys_ui_page.client_script`.

## UI Page (Jelly)

Keep the three phases straight: `<g:evaluate>`/`${}` are server-side at render (Rhino rules apply — quote reserved keys, ES5); `client_script` ships to the browser (convert template literals to string concat — Jelly eats `${...}`); `processing_script` runs on POST (validate input, re-check authorization, verify the CSRF token). HTML-escape every user-controlled value at the sink; `<g:no_escape>` is a deliberate danger marker.

Canonical skeleton (declare ALL four namespaces — a `<g2:>`/`<j2:>` phase-2 tag renders as literal markup if `xmlns:g2`/`xmlns:j2` is missing, a silent no-op):
```xml
<?xml version="1.0" encoding="utf-8" ?>
<j:jelly trim="false" xmlns:j="jelly:core" xmlns:g="glide" xmlns:j2="null" xmlns:g2="null">
  ...
</j:jelly>
```
No `<g:ui_form>` wrapper unless you need form submission; `direct=false` is the norm.

**Never emit CDATA in a UI Page.** Do not wrap the client script or any body in `<![CDATA[ ... ]]>` — it is disallowed by convention and brittle across ServiceNow's processing/import paths. Keep the markup XML-valid the honest way: escape `&` as `&amp;` and a literal `<` in inline JS (`a < b`) as `&lt;` or rewrite it (`b > a`), and move anything heavy enough to tempt a CDATA wrap into a UI Script / Script Include the page calls instead of inlining it.

## Deploy tooling (Table API, Python/Node)

Verify field names against the dictionary; force scope before scoped POSTs (`X-UserApp-Scope` / current_app pref); default to dry-run, require an explicit apply flag; back up before update; key re-runs on sys_id/unique-name so they're idempotent; low concurrency + backoff; credentials from env (parsed, never shell-sourced); check status AND body and read back critical records.

## ACL

```javascript
// sys_security_acl — Operation: read | Type: record | Table: x_acme_thing
// Script (only if roles/conditions aren't enough); default answer is what the roles/condition decided.
answer = current.getValue('u_owner') == gs.getUserID() || gs.hasRole('x_acme.manager');
```

An empty ACL does NOT grant — `answer` must come out true. Row and field ACLs both must pass. Compare fields with `getValue()` (strict `===` on a GlideElement never matches). Verify as the real non-admin persona (GlideImpersonate / ATF as-user), never as admin. See `security-acl.md`.

## The record config decides whether correct code even runs

The script is half the artifact — the RECORD fields around it gate execution, and a perfect script does nothing if they're wrong. Set them deliberately (and, when debugging "it's not firing", check them first):
- **Business Rule:** Active = true; the right **When** (before/after/async/display); the action boxes (Insert/Update/Delete/**Query**) ticked; condition in the condition field; order.
- **Client / Catalog Client Script:** Active; correct **UI Type** (Desktop / Mobile & Service Portal / All) or it silently won't run where users are; the right event (onLoad/onChange/onSubmit) matching the function; the field (onChange) or item/variable set (catalog).
- **Client-callable Script Include:** **Client callable = true** (else GlideAjax silently returns nothing); `type` equals the name; "Accessible from" scope right for cross-scope callers.
- **Scheduled Job / Script Action:** Active; a trigger/schedule (or an event the Script Action is registered on) — an unscheduled job never fires.
- **UI Action / UI Policy / Data Policy:** Active; table; condition; UI Action's Client/Onclick/Action-name coherent; Data Policy "Use as UI Policy" flag intentional.
- **Scripted REST / ACL:** the operation's Active + Requires-authentication/Requires-ACL; the ACL's Active + Type + Operation + Table.

## The authoring self-check (before you declare done)

- Did I pick the right execution context / when-to-run, and does the code obey that context's rules?
- Can someone tell "it worked" from "it silently did nothing" (log marker / read-back / checked return)?
- Reference/empty guarded (`.nil()`), booleans compared to `'1'`/`'0'`, reserved keys quoted, ES level right for the instance?
- Authorization enforced for the real (non-admin) caller; input validated; nothing user-controlled reaches a query or HTML sink unescaped?
- Does it travel (no hardcoded sys_ids/URLs) and re-run safely (idempotent)?
- Is the RECORD configured so the script actually runs (Active, When/action boxes, UI Type, Client-callable, schedule/trigger)? Great code on a mis-configured record is a silent no-op.
- Then run `sn-lint.js` on it and fix what it flags.
