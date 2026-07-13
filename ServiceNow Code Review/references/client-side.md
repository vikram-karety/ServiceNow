# Client-side: Client Scripts, Catalog Client Scripts, UI Policies

Client scripts run in three very different hosts — classic UI (desktop forms), Service Portal, and mobile/Workspace — and the platform reuses the SAME script across them unless told otherwise. The defining bug class here is "works on the desktop form, silently broken in Portal/Workspace", plus anything synchronous that freezes the form for real users.

## Method

1. **Establish which UIs the script runs in** (the "UI Type" field: Desktop / Mobile & Service Portal / All). A script using DOM access or synchronous calls might be "working" only because nobody opened that form in Workspace yet.
2. **Hunt synchronous calls first** — they're the highest-impact client bugs and grep-able.
3. **Then check each handler's contract** (onLoad/onChange/onSubmit/onCellEdit have different signatures and return semantics).

## Hard rules

- **No `GlideRecord` in client scripts.** It's technically loadable in classic UI and does a synchronous round trip per query; it's unavailable in Portal/Workspace. Server data access goes through GlideAjax (async), `g_scratchpad` (fed by a display BR), or `getReference` with a callback. Client-side GlideRecord = High.
- **No `getXMLWait()`.** Synchronous AJAX freezes the entire form and is unsupported in Portal/scoped contexts. Use `ga.getXMLAnswer(callback)`. High.
- **`g_form.getReference('field')` without a callback is synchronous.** Pass the callback: `g_form.getReference('caller_id', function(ref) {...})`. Also consider whether one dot-walked value via `g_scratchpad` would avoid the round trip entirely. Medium.
- **No direct DOM access** (`document.`, `gel()`, `$()`/jQuery, `window.`) in client scripts or UI policy scripts — breaks in Portal/Workspace where fields aren't the DOM elements classic UI renders, and survives platform upgrades poorly. If DOM work is genuinely needed, it belongs in a widget or UI Page that owns its markup. Low–Medium by blast radius.
- **onChange scripts start with the guard:**
  ```js
  if (isLoading || newValue === '') return;
  ```
  Without `isLoading`, the script fires on every form load and "change" logic runs on open. Without the empty check, clearing the field runs logic against `''`. If the script intentionally handles load or clear, it should say so in a comment.
- **onSubmit + async validation is a trap.** `onSubmit` must return synchronously; an async GlideAjax answer arrives after the form already submitted. The working pattern: first submission returns `false` and fires the async check; the callback sets a flag and re-triggers submit; the handler lets the flagged pass through. If you see async work in onSubmit without this two-pass shape, the validation is decorative. High.
- **`g_form.setValue(refField, sysId)` on a reference field needs the display value third argument** — otherwise the client does an extra synchronous round trip to resolve it (and Portal may show the raw sys_id).

## Idiom and placement

- **UI Policies beat client scripts for static show/hide/mandatory/readonly.** They're declarative, ordered, reversible ("Reverse if false"), and run without custom JS. A client script that only does `setDisplay`/`setMandatory` on fixed conditions should be a UI Policy. Low.
- **`g_scratchpad` needs a display Business Rule** — flag client code reading `g_scratchpad.x` with no display BR in the reviewed set; that's a silent `undefined`. And scratchpad content reaches the browser: no secrets.
- **Catalog client scripts:** variable names, not field names (`g_form.getValue('variable_name')`); "Applies to" (item/set) and catalog UI type determine where it runs; `g_form.getDisplayBox` tricks from forms often don't port. Check the **Isolate script** flag when the script needs `window`/DOM libs — isolation strips them.
- **onCellEdit** has its own signature (`sysIDs, table, oldValues, newValue, callback`) and MUST call the callback with true/false — a missing callback call hangs the list edit.
- **Messages:** user-facing strings through `gs.getMessage`/`getMessage` for i18n, `g_form.addErrorMessage` vs `g_form.showFieldMsg` chosen deliberately.
- **Client script type field must match the function** (an onChange-type record wrapping an onLoad function runs never or wrong).

## Checklist

- [ ] No GlideRecord, `getXMLWait`, or callback-less `getReference` anywhere client-side
- [ ] No DOM access (`document`, `gel`, jQuery, `window`) in scripts that run in Portal/Workspace
- [ ] Every onChange has the `isLoading`/`newValue` guard or a comment saying why not
- [ ] onSubmit async validation uses the flag-and-resubmit pattern (or is server-side where it belongs)
- [ ] Static field behavior in UI Policies, not imperative client scripts
- [ ] `g_scratchpad` reads have a display BR feeding them; nothing sensitive in scratchpad
- [ ] Reference setValue calls carry the display value; catalog scripts target variable names and the right UI type
- [ ] Validation that matters for integrity ALSO exists server-side (client checks are UX, not security — anything only enforced in `onSubmit` is bypassable via list edit, API, or import)

## Client-side field DERIVATION only runs on the interactive form

A client script / catalog client script / onChange GlideAjax that auto-populates a field runs ONLY when a human is on the form. Bulk XML import, Table API, web-service, and Import Set loads bypass it entirely — so a mandatory field the client script would have filled is left silently EMPTY, and you get half-loaded records with no error. Real case: a client script that calls `SoftwareModelAPI.getSoftwareModelFromProductDefinition` to populate a mandatory `software_model` was skipped on XML import → 11 of 12 records imported with an empty model. When bulk-loading into a table whose fields are normally derived client-side, replicate that logic server-side during the load (call the same Script Include/GlideAjax from a transform or before rule, or compute the value into the payload) — never assume interactive-form derivations fire on API/import. This is the derivation cousin of the UI-Policy-vs-Data-Policy bypass (see `more-script-types.md`).
