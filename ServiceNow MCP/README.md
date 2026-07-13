# ServiceNow MCP

A compact [Model Context Protocol](https://modelcontextprotocol.io) server that connects AI assistants (Claude, and any MCP-compatible client) to a ServiceNow instance. Twelve focused tools covering the essentials: Table API CRUD, aggregates, incident lifecycle, CMDB queries, knowledge search, and user lookup.

This is the limited public edition of a larger private toolset by [Vikram Karety](https://octigosol.com/vikram).

## Tools

| Tool | What it does |
|------|--------------|
| `list_records` | Query any table with encoded queries, field selection, and pagination |
| `get_record` | Fetch a single record by sys_id |
| `create_record` | Insert into any table |
| `update_record` | Patch any record by sys_id |
| `delete_record` | Delete a record by sys_id |
| `aggregate_records` | Count records, optionally grouped by a field |
| `create_incident` | Create an incident with common fields |
| `update_incident` | Update by number or sys_id, append comments or work notes |
| `search_knowledge` | Full-text search across published knowledge articles |
| `cmdb_query` | Query configuration items by CI class |
| `get_user` | Look up a user by user_name, email, or sys_id |
| `instance_info` | Build name, version, and the authenticated user |

## Setup

Requires Node.js 18+ and a ServiceNow instance (a free [Personal Developer Instance](https://developer.servicenow.com) works).

```bash
git clone https://github.com/vikram-karety/ServiceNow.git
cd "ServiceNow/ServiceNow MCP"
npm install
npm run build
```

## Configuration

Set three environment variables:

| Variable | Example |
|----------|---------|
| `SN_INSTANCE_URL` | `https://dev12345.service-now.com` |
| `SN_USERNAME` | `admin` |
| `SN_PASSWORD` | your password |

### Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "servicenow": {
      "command": "node",
      "args": ["/path/to/ServiceNow/ServiceNow MCP/dist/index.js"],
      "env": {
        "SN_INSTANCE_URL": "https://dev12345.service-now.com",
        "SN_USERNAME": "admin",
        "SN_PASSWORD": "..."
      }
    }
  }
}
```

## Example prompts

- "Show me the five most recent P1 incidents."
- "How many open incidents per assignment group?"
- "Create an incident: email is down for the Austin office."
- "Find knowledge articles about VPN setup."
- "Which Linux servers are in the CMDB?"

## Notes

- Credentials come only from environment variables. Nothing is stored or logged.
- Writes go through the standard Table API and respect your instance's ACLs.
- MIT licensed.
