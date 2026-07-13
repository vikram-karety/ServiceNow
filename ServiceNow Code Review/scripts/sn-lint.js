#!/usr/bin/env node
/*
 * sn-lint.js — deterministic scanner for ServiceNow silent-failure traps.
 * Zero dependencies. Usage:
 *   node sn-lint.js <file-or-dir> [more paths...] [--json]
 * Exit codes: 2 = Critical findings, 1 = High findings, 0 = clean/Medium/Low.
 *
 * This is a floor, not a review: rules marked (heuristic) need human
 * confirmation before being reported as findings.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const EXTS = new Set(['.js', '.py', '.xml', '.xhtml', '.json', '.jelly', '.html', '.css', '.scss']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'backups', '__pycache__', 'reviews']);
const SEV_ORDER = { Critical: 0, High: 1, Medium: 2, Low: 3 };

function walk(p, out) {
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    if (SKIP_DIRS.has(path.basename(p))) return;
    for (const e of fs.readdirSync(p)) walk(path.join(p, e), out);
  } else if (EXTS.has(path.extname(p).toLowerCase())) {
    out.push(p);
  }
}

function detectContexts(content, ext) {
  const ctx = new Set();
  if (/\b(gs\.(info|warn|error|log|sleep|getUser|hasRole|getProperty|addInfoMessage|eventQueue|now|include)|current\.|previous\.|GlideAggregate|GlideDateTime|GlideSystem|Class\.create|AbstractAjaxProcessor|GlideRecordSecure)\b/.test(content)) ctx.add('server');
  if (/\bnew\s+GlideRecord\s*\(/.test(content)) ctx.add('gliderecord');
  if (/\b(g_form|g_user|g_scratchpad|GlideAjax|function\s+onLoad|function\s+onChange|function\s+onSubmit|function\s+onCellEdit)\b/.test(content)) ctx.add('client');
  if (/<j:|<j2:|<g:|<g2:|sys_ui_page|RP\.getParameterValue|jelly/.test(content) || ext === '.xhtml' || ext === '.jelly') ctx.add('uipage');
  if (/\b(sp_widget|sp_page|sp_row|sp_column|sp_instance|\$sp\.|spUtil|c\.server\.)/.test(content)) ctx.add('portal');
  if (/\/api\/now\/|requests\.(get|post|put|patch|delete|Session)|X-UserApp-Scope|RESTMessageV2|fetch\s*\(|axios/.test(content)) ctx.add('deploy');
  if (ext === '.xml') ctx.add('xml');
  // GlideRecord with no other server signal in a client file = client-side GlideRecord
  if (ctx.has('gliderecord') && !ctx.has('server')) ctx.add(ctx.has('client') ? 'client-gr' : 'server');
  if (ctx.has('gliderecord') && ctx.has('server')) ctx.add('server');
  return ctx;
}

// Java keywords + ECMAScript reserved words: all fail Rhino compilation as UNQUOTED object keys
// in classic/global scope (the whole script then emits nothing). 'default' is omitted here only
// to avoid colliding with switch `default:` labels — it is covered in server-side.md's grep/prose.
const RESERVED = 'class|char|byte|int|long|float|double|enum|goto|native|boolean|short|final|package|interface|implements|protected|public|private|static|throws|transient|volatile|synchronized|abstract|import|extends|super|new|delete|typeof|void|instanceof|in|do|else|for|if|while|switch|function|var|return|throw|try|catch|finally|break|continue|case|this|null|true|false';

function isComment(line, ext) {
  const t = line.trim();
  // In CSS/SCSS, '#' is an id selector and '*' is the universal selector — not comment markers.
  if (ext === '.css' || ext === '.scss') return t.startsWith('/*') || t.startsWith('//') || t.startsWith('*/');
  return t.startsWith('//') || t.startsWith('#') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('<!--');
}

// Line rules: {id, sev, when(ctx, ext), re, msg, heuristic}
const LINE_RULES = [
  {
    id: 'sn-reserved-key', sev: 'Critical',
    when: c => c.has('server') || c.has('uipage'),
    re: new RegExp('(^\\s*|[{,]\\s*)(' + RESERVED + ')\\s*:(?!:)'),
    msg: "Unquoted reserved word used as object key — Rhino fails to COMPILE the whole script and emits empty output with no error. Quote the key (e.g. \"class\":) or rename it."
  },
  {
    id: 'sn-template-literal', sev: 'High',
    when: (c, ext, content) => (c.has('uipage') && /client_script|sys_ui_page/.test(content)) || ext === '.xhtml',
    re: /`[^`]*\$\{/,
    msg: 'JS template literal in a UI-Page-adjacent payload. It is a real defect ONLY inside sys_ui_page.client_script or a Jelly-processed block — Jelly strips every ${...} at render. It is FINE in a Service Portal widget client_script (Angular, no Jelly) and in Node/Python deploy code. Confirm the enclosing block before reporting; convert to string concatenation only for the Jelly-processed case.', heuristic: true
  },
  {
    id: 'sn-boolean-getvalue', sev: 'High', when: c => c.has('server'),
    re: /getValue\s*\([^)]*\)\s*[=!]=+\s*['"](true|false)['"]|['"](true|false)['"]\s*[=!]=+\s*getValue\s*\(/,
    msg: "Boolean field compared to 'true'/'false' via getValue() — glide_boolean getValue() returns '1'/'0', so this branch is ALWAYS false (silent logic bug). Compare to '1'/'0', or use the field truthiness (if (gr.field)). Only getDisplayValue() yields 'true'/'false'."
  },
  {
    id: 'sn-uipage-cdata', sev: 'Medium', when: (c, ext, content) => c.has('uipage') || ext === '.xhtml' || /<j2?:jelly|<g2?:/.test(content),
    re: /<!\[CDATA\[/,
    msg: 'CDATA in a UI Page — disallowed by convention and brittle across ServiceNow processing/import paths. Remove it and keep the markup XML-valid by escaping (& as &amp;, literal < as &lt; or rewritten), moving heavy JS into a UI Script / Script Include.'
  },
  {
    id: 'sn-no-escape', sev: 'High', when: (c, ext, content) => c.has('uipage') || ext === '.xhtml' || /<g2?:no_escape/.test(content),
    re: /<g2?:no_escape\b/,
    msg: 'Jelly <g:no_escape> emits its content WITHOUT HTML escaping — a reflected-XSS sink if any part is user-controlled (request params, record values). Justify it or escape at the sink. (CWE-79)'
  },
  {
    id: 'sn-getrowcount', sev: 'Medium', when: c => c.has('server'),
    re: /\.getRowCount\s*\(/,
    msg: 'getRowCount() materializes the full result set. Use GlideAggregate COUNT for counts, setLimit(1)+hasNext() for existence.'
  },
  {
    id: 'sn-current-update', sev: 'High', when: c => c.has('server'),
    re: /\bcurrent\.update\s*\(/,
    msg: 'current.update() is a defect ONLY when `current` is the business-rule record: in a before rule the platform saves it anyway (double-write, can recurse); in an after rule it re-triggers the rule stack. It is FINE when `current` is just a GlideRecord your script named "current" (Script Include, scheduled/background job) — verify which before reporting.', heuristic: true
  },
  {
    id: 'sn-setworkflow-false', sev: 'Medium', when: c => c.has('server'),
    re: /\.setWorkflow\s*\(\s*false\s*\)/,
    msg: 'setWorkflow(false) disables ALL other business rules, flows, notifications, SLAs and (with autoSysFields) audit. Needs a justification comment stating blast radius.'
  },
  {
    id: 'sn-eval', sev: 'High', when: c => c.has('server') || c.has('client'),
    re: /\beval\s*\(|\bGlideEvaluator\b|new\s+Function\s*\(/,
    msg: 'Dynamic code evaluation — injection surface and unreviewable control flow. Replace with direct calls or a dispatch table.'
  },
  {
    id: 'sn-hardcoded-sysid', sev: 'Medium', when: () => true,
    re: /['"][0-9a-f]{32}['"]/,
    test: line => !/sys_created_by|sha|hash|uuid|guid/i.test(line),
    msg: 'Hardcoded 32-hex sys_id — garbage on any other instance. Resolve by name/key, a property, or carry the referenced record.', heuristic: true, capPerFile: 8
  },
  {
    id: 'sn-getxmlwait', sev: 'High', when: c => c.has('client'),
    re: /\.getXMLWait\s*\(/,
    msg: 'Synchronous GlideAjax (getXMLWait) freezes the whole form and is unsupported in Portal/scoped apps. Use getXMLAnswer(callback).'
  },
  {
    id: 'sn-getreference-sync', sev: 'Medium', when: c => c.has('client'),
    re: /g_form\.getReference\s*\(([^()]*)\)/,
    test: (line, m) => !m[1].includes(','),
    msg: 'g_form.getReference without a callback is a synchronous round trip. Pass a callback, or use g_scratchpad via a display BR.', heuristic: true
  },
  {
    id: 'sn-client-gliderecord', sev: 'High', when: c => c.has('client-gr'),
    re: /new\s+GlideRecord\s*\(/,
    msg: 'GlideRecord in client-side code — synchronous per-query round trips in classic UI, unavailable in Portal/Workspace. Use async GlideAjax or g_scratchpad.'
  },
  {
    id: 'sn-dom-in-client', sev: 'Low', when: (c, ext, content) => c.has('client') && !c.has('uipage'),
    re: /\bdocument\.|\bgel\s*\(|\bwindow\.(?!(?:location|setTimeout|setInterval|clearTimeout|clearInterval|requestAnimationFrame|cancelAnimationFrame|addEventListener|removeEventListener|scrollTo|scrollBy)\b)/,
    msg: 'Direct DOM access in a client script — breaks in Service Portal/Workspace and across upgrades. Use g_form APIs, or move DOM work into a widget/UI Page.', heuristic: true
  },
  {
    id: 'sn-encodedquery-concat', sev: 'High', when: c => c.has('server'),
    re: /addEncodedQuery\s*\([^)]*(\+|\$\{)/,
    msg: 'addEncodedQuery built by concatenation — encoded-query injection (^OR splicing widens results). Pass user values through addQuery(field, op, value).'
  },
  {
    id: 'sn-gs-log', sev: 'Low', when: c => c.has('server'),
    re: /\bgs\.log\s*\(/,
    msg: 'gs.log() does not work in scoped apps — use gs.info/warn/error. Also check it is not inside a per-row loop.'
  },
  {
    id: 'sn-gs-sleep', sev: 'Medium', when: c => c.has('server'),
    re: /\bgs\.sleep\s*\(/,
    msg: 'gs.sleep() blocks the thread/transaction — never in user-facing paths; in jobs prefer event-driven waits or rescheduling.'
  },
  {
    id: 'sn-hardcoded-cred', sev: 'Critical', when: () => true,
    re: /(password|passwd|pwd|api[_-]?key|apikey|client_secret|secret|auth[_-]?token)\s*[:=]\s*['"][^'"]{6,}['"]|setBasicAuth\s*\(\s*['"]/i,
    test: line => !/process\.env|os\.environ|getenv|getProperty|config\[|settings\.|example|sample|placeholder|your[_-]|xxx|\*\*\*|<[a-z_]+>|\{\{|\$\{|%[a-z_]+%|replace[_-]?me|change[_-]?me|redacted|dummy|todo/i.test(line),
    msg: 'Hardcoded credential/secret literal. Source from env/secret store (parsed, never shell-sourced — $ in passwords gets mangled) or a credential alias; never log it.'
  },
  {
    id: 'sn-cred-fallback', sev: 'Critical', when: () => true,
    re: /(password|passwd|pwd|secret|token|api[_-]?key)[^\n]*(os\.environ|process\.env|getenv)[^\n]*(\|\||\bor\b)\s*['"][^'"]{4,}['"]/i,
    msg: 'Env-var credential with a hardcoded fallback — the literal ships in the repo and silently takes over when the env var is missing. Fail hard when the env var is absent instead.'
  },
  {
    id: 'sn-sp-container', sev: 'Medium',
    when: (c, ext, content) => /sp_row/.test(content),
    re: /['"]container['"]\s*[:=]/,
    msg: "sp_row's parent field is 'sp_container', not 'container' — the Table API silently drops unknown fields and the layout half-builds."
  },
  {
    id: 'sn-sp-size-x', sev: 'Medium',
    when: (c, ext, content) => /sp_column/.test(content),
    re: /['"]?size_x['"]?\s*[:=]/,
    msg: "sp_column's width field is 'size', not 'size_x' — silently dropped by the Table API."
  },
  {
    id: 'sn-sp-page-hyphen', sev: 'Medium',
    when: (c, ext, content) => /sp_page/.test(content),
    re: /sp_page.{0,80}['"]id['"]\s*[:=]\s*['"][a-z0-9_]*-[a-z0-9_-]*['"]|['"]id['"]\s*[:=]\s*['"][a-z0-9_]*-[a-z0-9_-]*['"].{0,80}sp_page/,
    msg: 'sp_page IDs convert hyphens to underscores on save — query back by the converted ID or by sys_id, or the verify step fails against a page that exists.', heuristic: true
  },
  {
    id: 'sn-sp-instance-column', sev: 'Medium',
    when: (c, ext, content) => /sp_instance/.test(content),
    re: /['"]column['"]\s*[:=]/,
    msg: "sp_instance's column-reference field is 'sp_column', not 'column' — silently dropped by the Table API (same lie as sp_row's 'container')."
  },
  {
    id: 'sn-sp-backdrop-filter', sev: 'Medium',
    when: (c, ext, content) => c.has('portal') || ext === '.css' || ext === '.scss' || /sp_widget|sp_css|widget.*css/i.test(content),
    re: /(-webkit-)?backdrop-filter\s*:/,
    msg: "Service Portal's CSS sanitizer drops the ENTIRE rule containing backdrop-filter (not just the property) — the rule's other declarations (display/height/etc.) silently vanish. Strip backdrop-filter before deploy; use a solid background."
  },
  {
    id: 'sn-uipage-named-entity', sev: 'Medium',
    when: (c, ext, content) => c.has('uipage') || ext === '.xhtml',
    re: /&([a-zA-Z][a-zA-Z0-9]*);/,
    test: (line, m) => ['amp', 'lt', 'gt', 'quot', 'apos'].indexOf(m[1]) < 0,
    msg: 'Named HTML entity in a UI Page — only the 5 XML built-ins (&amp; &lt; &gt; &quot; &apos;) are defined in XHTML/Jelly; others (&nbsp; &mdash; &middot; &rsquo; ...) are an undefined-entity parse error. Use the literal Unicode char or a numeric reference (&#160;, &#8212;).'
  },
  {
    id: 'sn-uipage-bool-attr', sev: 'Low',
    when: (c, ext, content) => c.has('uipage') || ext === '.xhtml',
    re: /\s(checked|selected|disabled|readonly|multiple|required|autofocus)(?=[\s/>])/,
    test: (line) => /<[a-zA-Z]/.test(line),
    msg: 'Minimized boolean HTML attribute in a UI Page — XHTML is XML, so a valueless attribute is a well-formedness error. Use the attr="attr" form (checked="checked", disabled="disabled").', heuristic: true
  },
  {
    id: 'sn-encoded-null-operator', sev: 'Medium', when: c => c.has('server') || c.has('deploy'),
    re: /=NULL(\^|['"]|&|$)|\bRELATIVE(LT|GT|EE|LE|GE)@/,
    msg: 'Encoded-query operator trap — "=NULL" does not match empty fields (use ISEMPTY/ISNOTEMPTY), and RELATIVELT@dayofweek@ is a window, not "older than N days" (use field<javascript:gs.daysAgoStart(N)). Both compile fine and return the wrong set with no error.'
  },
  {
    id: 'sn-pa-scores-table', sev: 'Medium', when: c => c.has('server') || c.has('deploy'),
    re: /['"/]pa_scores(?!_l)['"/^\s)]/,
    msg: "PA collected scores live in 'pa_scores_l1', not 'pa_scores' (level-0 is empty). Also filter by 'indicator.sys_id=', not a plain 'indicator=' (silently ignored)."
  },
  {
    id: 'sn-pa-external-collect', sev: 'Medium', when: c => c.has('server') || c.has('deploy'),
    re: /PAExternalCollectionCheck\s*\(\s*\)\s*\.collectIndicator/,
    msg: "Wrong PA collection API — PAExternalCollectionCheck().collectIndicator() is external-source-only and NPEs. Collect via a sysauto_pa job + pa_job_indicators rows + gs.executeNow(jobGR)."
  },
  {
    id: 'sn-acl-userid-compare', sev: 'High', when: c => c.has('server'),
    re: /current\.[a-zA-Z_]\w*\s*[=!]==\s*gs\.get(User(ID)?|UserName)\s*\(/,
    msg: 'Strict === / !== between current.<field> (a GlideElement) and gs.getUserID()/getUserName() NEVER matches (object vs string) — in a row-level ACL script this makes the ACL evaluate identically for EVERY row (grants or denies all). Use current.getValue(\'field\') == gs.getUserID().'
  },
  {
    id: 'sn-scoped-updateset-rest', sev: 'High', when: c => c.has('deploy') || c.has('server'),
    re: /setCurrentApplicationId\s*\(|sys_update_set.{0,60}(post|insert)|(post|insert).{0,60}sys_update_set/i,
    msg: 'Scoped update sets cannot be created/selected over REST (session binds to global) and setCurrentApplicationId THROWS in background scripts. Use Studio, the Default update set, or the X-UserApp-Scope header.', heuristic: true
  },
  {
    id: 'sn-deletemultiple', sev: 'Medium', when: c => c.has('server'),
    re: /\.(deleteMultiple|updateMultiple)\s*\(/,
    msg: 'deleteMultiple/updateMultiple — verify the query cannot run unfiltered, and state whether business rules/audit should fire (they behave differently than per-row loops).'
  }
];

// File-level rules: {id, sev, check(content, ctx, ext) -> message|null}
const FILE_RULES = [
  {
    id: 'sn-scope-on-create', sev: 'Medium',
    check: (content, ctx) => {
      if (!ctx.has('deploy')) return null;
      const posts = /\/api\/now\/table\//.test(content) && /(\.post\s*\(|method\s*[:=]\s*['"]POST|requests\.post)/i.test(content);
      if (posts && !/X-UserApp-Scope|current_app|sys_user_preference/.test(content)) {
        return 'Table API POSTs found with no scope forcing (X-UserApp-Scope header or apps.current_app preference). Records land in the SESSION\'s current scope, not the payload\'s — verify intended scope. (heuristic)';
      }
      return null;
    }
  },
  {
    id: 'sn-missing-sentinel', sev: 'Medium',
    check: (content, ctx) => {
      if (!/sys\.scripts\.do|sys_scripts|background\s*script/i.test(content) || !ctx.has('deploy')) return null;
      if (!/sentinel|___|RESULT_JSON|DONE_MARKER/i.test(content)) {
        return 'Background-script execution with no output sentinel check — a Rhino compile failure returns empty output that is indistinguishable from success. Print a marker and THROW when it is missing. (heuristic)';
      }
      return null;
    }
  },
  {
    id: 'sn-xml-identity', sev: 'Medium',
    check: (content, ctx, ext) => {
      if (ext !== '.xml' || !/<unload|<sys_ui_page|<sys_script/i.test(content)) return null;
      if (!/sys_created_by/.test(content)) {
        return 'Generated record XML without sys_created_by/sys_updated_by stamped — imports get attributed to whoever loads them, wrecking the audit trail.';
      }
      return null;
    }
  },
  {
    id: 'sn-processing-unauth-write', sev: 'High',
    check: (content, ctx) => {
      if (!/request\.(getParameter|pathParams|queryParams)/.test(content)) return null;
      if (!/\.(deleteRecord|update|insert|deleteMultiple|updateMultiple)\s*\(/.test(content)) return null;
      if (/hasRole|canDelete|canWrite|canCreate|GlideRecordSecure|getRoles|isMemberOf|sysparm_ck|g_ck|getSessionToken/.test(content)) return null;
      return 'State-changing GlideRecord write driven by request input (processing script / scripted REST) with no visible authorization or CSRF-token check — any caller who can POST can trigger it on a client-supplied sys_id. Enforce roles/ACLs (GlideRecordSecure, gs.hasRole) and verify the session token. (heuristic — verify) (CWE-862)';
    }
  },
  {
    id: 'sn-tableapi-protected-write', sev: 'High',
    check: (content, ctx) => {
      if (!ctx.has('deploy')) return null;
      if (!/sys_security_acl|sys_variable_value/.test(content)) return null;
      if (!/(\.post|\.patch|\.put|requests\.(post|patch|put)|method\s*[:=]\s*['"](POST|PATCH|PUT))/i.test(content)) return null;
      return 'Table-API write to sys_security_acl / sys_variable_value — these require the elevated security_admin role which a normal REST session lacks, so the write fails with "ACL Exception / security constraints". Run the insert/update from a server-side script executing as system (a run-once sysauto_script) instead.';
    }
  },
  {
    id: 'sn-flow-raw-activate', sev: 'High',
    check: (content) => {
      const insertsAction = /sys_hub_action_type_definition/.test(content) && /(\.post|insert|requests\.post|method\s*[:=]\s*['"]POST)/i.test(content);
      const flipsFlow = /sys_hub_flow/.test(content) && /(['"]active['"]\s*[:=]\s*(true|['"]true)|['"]status['"]\s*[:=]\s*['"]published)/.test(content);
      if (!insertsAction && !flipsFlow) return null;
      return 'Authoring/activating a Flow via raw Table-API writes does not work — inserting a custom Action (sys_hub_action_type_definition) is blocked and returns null, and setting sys_hub_flow.active/status without a compiled snapshot yields a structurally broken flow that does nothing. Author with the Fluent SDK and publish via sn_fd.FlowAPI.publish(sysId) server-side; see references/more-script-types.md.';
    }
  },
  {
    id: 'sn-client-callable-norole', sev: 'High',
    check: (content, ctx) => {
      if (!/AbstractAjaxProcessor/.test(content)) return null;
      if (!/hasRole|canRead|canWrite|canCreate|canDelete|getRoles|GlideRecordSecure|isMemberOf/.test(content)) {
        return 'Client-callable Script Include (AbstractAjaxProcessor) with no role/ACL validation found in the file — reachable by ANY authenticated user via xmlhttp.do. Every public method must authorize itself. (heuristic — verify)';
      }
      return null;
    }
  },
  {
    id: 'sn-onchange-guard', sev: 'Low',
    check: (content, ctx) => {
      if (!ctx.has('client')) return null;
      const m = content.match(/function\s+onChange\s*\([^)]*\)\s*\{([\s\S]{0,300})/);
      if (m && !/isLoading/.test(m[1])) {
        return 'onChange handler without the isLoading/newValue guard — it will run its logic on every form load. Start with: if (isLoading || newValue === \'\') return;';
      }
      return null;
    }
  }
];

function lintFile(file) {
  const content = fs.readFileSync(file, 'utf8');
  const ext = path.extname(file).toLowerCase();
  const ctx = detectContexts(content, ext);
  const findings = [];
  const lines = content.split(/\r?\n/);
  const capCount = {};

  // Precompute continuation lines inside /* ... */ block comments so commented-out code isn't scanned.
  const blockLines = new Set();
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i];
    if (inBlock) { blockLines.add(i); if (t.includes('*/')) inBlock = false; continue; }
    const open = t.lastIndexOf('/*');
    if (open >= 0 && t.indexOf('*/', open + 2) < 0) inBlock = true;
  }

  for (const rule of LINE_RULES) {
    if (!rule.when(ctx, ext, content)) continue;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (isComment(line, ext) || blockLines.has(i)) continue;
      const m = rule.re.exec(line);
      if (!m) continue;
      if (rule.test && !rule.test(line, m)) continue;
      const key = rule.id + file;
      capCount[key] = (capCount[key] || 0) + 1;
      if (rule.capPerFile && capCount[key] > rule.capPerFile) continue;
      findings.push({
        file, line: i + 1, rule: rule.id, severity: rule.sev,
        message: rule.msg + (rule.heuristic ? ' (heuristic — verify)' : ''),
        excerpt: line.trim().slice(0, 160)
      });
    }
  }
  for (const rule of FILE_RULES) {
    const msg = rule.check(content, ctx, ext);
    if (msg) findings.push({ file, line: 0, rule: rule.id, severity: rule.sev, message: msg, excerpt: '' });
  }
  return { findings, contexts: [...ctx].filter(c => c !== 'gliderecord' && c !== 'client-gr') };
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const paths = args.filter(a => !a.startsWith('--'));
  if (!paths.length) {
    console.error('usage: node sn-lint.js <file-or-dir> [...] [--json]');
    process.exit(64);
  }
  const files = [];
  for (const p of paths) {
    if (!fs.existsSync(p)) { console.error('not found: ' + p); process.exit(66); }
    walk(path.resolve(p), files);
  }
  let all = [];
  const fileCtx = {};
  for (const f of files) {
    try {
      const { findings, contexts } = lintFile(f);
      all = all.concat(findings);
      fileCtx[f] = contexts;
    } catch (e) { console.error('skip ' + f + ': ' + e.message); }
  }
  all.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || a.file.localeCompare(b.file) || a.line - b.line);
  const counts = { Critical: 0, High: 0, Medium: 0, Low: 0 };
  for (const f of all) counts[f.severity]++;

  if (json) {
    console.log(JSON.stringify({ summary: { files: files.length, findings: all.length, ...counts }, contexts: fileCtx, findings: all }, null, 2));
  } else {
    console.log(`sn-lint: ${all.length} finding(s) in ${files.length} file(s) — Critical:${counts.Critical} High:${counts.High} Medium:${counts.Medium} Low:${counts.Low}\n`);
    let cur = '';
    for (const f of all) {
      if (f.file !== cur) { cur = f.file; console.log(cur + '  [' + (fileCtx[f.file] || []).join(', ') + ']'); }
      console.log(`  ${String(f.line).padStart(4)}  ${f.severity.padEnd(8)} ${f.rule.padEnd(26)} ${f.message}`);
      if (f.excerpt) console.log(`        > ${f.excerpt}`);
    }
    if (!all.length) console.log('clean.');
  }
  process.exit(counts.Critical ? 2 : counts.High ? 1 : 0);
}

main();
