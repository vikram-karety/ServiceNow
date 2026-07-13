# ServiceNow

ServiceNow engineering by [Vikram Karety](https://octigosol.com/vikram): open tooling that brings AI to the Now Platform and platform discipline to AI.

## Projects

### [ServiceNow MCP](ServiceNow%20MCP/)

A compact Model Context Protocol server that connects AI assistants (Claude, and any MCP-compatible client) to a ServiceNow instance. Twelve focused tools covering the essentials: Table API CRUD, aggregates, incident lifecycle, CMDB queries, knowledge search, and user lookup.

- Credentials from environment variables only; nothing stored or logged
- Every write goes through the standard Table API, so instance ACLs always apply
- Runs against any instance, including a free Personal Developer Instance

```bash
cd "ServiceNow MCP" && npm install && npm run build
```

Full setup, configuration, and example prompts: [ServiceNow MCP/README.md](ServiceNow%20MCP/README.md)

### [ServiceNow Code Review](ServiceNow%20Code%20Review/)

A Claude Code skill for full-lifecycle ServiceNow engineering: write, review, complete, debug, and find-missing code across every ServiceNow script type, from Business Rules and Client Scripts to UI Pages, Service Portal widgets, Scripted REST, ACLs, and Performance Analytics.

- Auto-routes between review, author, complete, debug, and find-missing modes
- Hunts the platform's silent no-ops: code that compiles to nothing, wrong-scope saves, Jelly-eaten template literals
- Ships a standalone zero-dependency linter with 40 deterministic rules, usable in CI without Claude

```bash
cp -R "ServiceNow Code Review" ~/.claude/skills/servicenow-code-review
```

Install, usage, and the full reference layout: [ServiceNow Code Review/README.md](ServiceNow%20Code%20Review/README.md)

## License

MIT for everything in this repository.
