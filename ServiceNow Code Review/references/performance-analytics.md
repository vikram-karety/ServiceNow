# Performance Analytics & dashboards (build-via-REST and review)

PA is a builder domain full of tables and fields whose names lie — a wrong one is silently ignored (0 rows, no error) and you debug a "data problem" that is really a wrong-table query. Two distinct models: **classic PA** (`pa_dashboards`) and **Platform Analytics / PAR** (Next Experience, `par_dashboard`). They do not interoperate the way people assume.

## Classic PA — the field-lies

- **Collected scores live in `pa_scores_l1`, not `pa_scores`** (the level-0 table is empty). Query them by `indicator.sys_id=<x>` or `indicator.nameSTARTSWITH...` — a plain `indicator=<x>` equals-filter returns 0 and is silently ignored. Never `ORDERBY sys_created_on` on a score table (no such column).
- **`pa_tabs` has NO `dashboard` field** — writes/filters to it are silently dropped. Dashboard↔tab is the m2m `pa_m2m_dashboard_tabs` (`dashboard`, `tab`, `order`, `home`).
- **Formula indicators need DOUBLE brackets:** `( [[compA]] / [[compB]] ) * 100`. A single `[ ]` fails `SNC.PAFormula.isValid()` and the BR aborts. Formula indicators are computed live and are NOT collected by jobs.
- **Choice codes:** `pa_indicators.type` 1=Automated / 2=Formula; `aggregate` 1=Count / 2=Sum / 3=Avg / 5=Max / 6=Count Distinct; `unit` → `pa_units`.
- **Widgets render only with CONTINUOUS score history.** A single current-day score leaves "Latest Score" tiles on a perpetual spinner. Fix by back-dating the collection range (`score_relative_start='30'`, `score_relative_end='0'`, daily interval).
- Deleting a `pa_breakdowns` cascade-deletes any `pa_widgets` referencing it.

## Classic PA — score collection (the ONLY correct API)

Create a `sysauto_pa` job, add `pa_job_indicators` rows (`collect_indicator=true`), then `gs.executeNow(jobGR)`. `SNC.PAExternalCollectionCheck().collectIndicator()` is the WRONG API (external-source only; NPEs otherwise). After a PA builder creates indicators/breakdowns, it must trigger and verify collection — an indicator with no collected scores renders as an empty dashboard that looks like a data problem.

Render chain (for debugging a blank dashboard): `pa_dashboards` → `pa_m2m_dashboard_tabs` → `pa_tabs` (`canvas_page` → `sys_grid_canvas`) → `sys_grid_canvas_pane` (12-col grid, `portal_widget` → `sys_portal`) → `sys_portal` → `sys_portal_preferences` (`renderer=com.snc.pa.ui.RenderPerformanceAnalytics`).

## Report tile on a classic dashboard

A report tile is a `sys_portal` + `sys_portal_preferences` pair (`renderer='com.glide.ui.portal.RenderReport'`, `sys_id=<report>`). Create the `sys_report` (type/table/`field`=group-by/`aggregate`=COUNT) where `filter` holds the encoded query PLUS `^GROUPBY<field>` (bar/pie) or `^TRENDBY<datefield>,date` (trend), and set **`user=GLOBAL`** — blank/user-scoped makes it private and invisible to others. Place via `sys_grid_canvas_pane` on the 12-col grid.

## Platform Analytics / PAR (Next Experience) — a different model

A classic `pa_dashboards` build NEVER appears in the Next Experience workspace (only via the `$pa_dashboard.do` direct link) because the workspace reads **`par_dashboard`**. Key differences:

- **Visibility** comes from `par_dashboard_permission` rows (an owner row), NOT `visible_to`. Migrate classic→PAR with `new SNC.MigrationServiceScriptable().migrateDashboard('<pa_dashboards sysid>')` run from a `sysauto_script` whose **`run_as=<admin user sysid>`** so the migration creates the owner permission row.
- **Grid is 48-col** (classic is 12).
- **Widget binding:** `par_dashboard_widget.component` (a `sys_ux_macroponent`) + `component_props` JSON where `dataSources[0].uuid.indicator` is the real `pa_indicator` binding. PAR report tiles reference no `sys_report` — the migration rebuilds each report as a self-contained widget (`table` + `filterQuery` + `groupBy` + COUNT metric in `component_props`).
- **Two silent traps:** (1) a tile title lives in BOTH `par_dashboard_widget.component_props.headerTitle` AND `par_dashboard_canvas.layout[].component_props.headerTitle` (the renderer reads the canvas layout JSON) — patch both. (2) `par_dashboard_widget.canvas` is writable only at INSERT; a PATCH to move a tile to another tab silently no-ops — you must DELETE and re-POST on the target tab's canvas.
- Via API only the single-score macroponent instantiates; bar/rich-text macroponents stay empty (add in the Edit UI); geometry/sizing edits via API don't render (use Edit mode), though `headerTitle` text edits via API do.

## Reusable PA-dashboard-via-REST recipe

Because ACL/PA writes need system context, build PA dashboards from a run-once `sysauto_script` (see `integrations-deploy.md`), and make the builder idempotent — every indicator, breakdown, tab, widget placement, and m2m row keyed on sys_id or a unique name, or re-runs litter the instance.

## Checklist

- [ ] Scores read from `pa_scores_l1` via `indicator.sys_id=`, never `pa_scores` or a plain `indicator=` filter
- [ ] Dashboard↔tab via `pa_m2m_dashboard_tabs`, never a `pa_tabs.dashboard` field
- [ ] Formula indicators use `[[...]]`; collection triggered via `sysauto_pa` + `pa_job_indicators` + `gs.executeNow` (not `PAExternalCollectionCheck`)
- [ ] Score history is continuous (back-dated range) so widgets don't spin
- [ ] Report tiles set `sys_report.user=GLOBAL`; PAR builds target `par_dashboard`, set `par_dashboard_permission`, and DELETE+re-POST (not PATCH) to move `par_dashboard_widget.canvas`
- [ ] Builder runs in system context and is idempotent across every child record type
