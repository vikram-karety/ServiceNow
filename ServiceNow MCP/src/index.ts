#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const INSTANCE =
  process.env.SN_INSTANCE_URL || process.env.SN_INSTANCE || "";
const USERNAME = process.env.SN_USERNAME || process.env.SN_USER || "";
const PASSWORD = process.env.SN_PASSWORD || process.env.SN_PASS || "";

if (!INSTANCE || !USERNAME || !PASSWORD) {
  console.error(
    "Missing configuration. Set SN_INSTANCE_URL, SN_USERNAME, and SN_PASSWORD."
  );
  process.exit(1);
}

const BASE = INSTANCE.replace(/\/$/, "").startsWith("http")
  ? INSTANCE.replace(/\/$/, "")
  : `https://${INSTANCE.replace(/\/$/, "")}`;
const AUTH = "Basic " + Buffer.from(`${USERNAME}:${PASSWORD}`).toString("base64");

async function snRequest(
  method: string,
  path: string,
  body?: unknown,
  params?: Record<string, string | number | boolean | undefined>
): Promise<any> {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: AUTH,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      detail = JSON.parse(text)?.error?.message ?? text;
    } catch {
      /* keep raw text */
    }
    throw new Error(`ServiceNow ${res.status} ${res.statusText}: ${detail}`);
  }
  if (res.status === 204 || text === "") return { result: null };
  return JSON.parse(text);
}

const TOOLS = [
  {
    name: "list_records",
    description:
      "List records from any ServiceNow table with an encoded query, field selection, and pagination.",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Table name, e.g. incident" },
        query: {
          type: "string",
          description:
            "Encoded query, e.g. active=true^priority=1^ORDERBYDESCsys_created_on",
        },
        fields: {
          type: "string",
          description: "Comma-separated field list, e.g. number,short_description,state",
        },
        limit: { type: "number", description: "Max records (default 10, max 100)" },
        offset: { type: "number", description: "Pagination offset" },
        display_value: {
          type: "boolean",
          description: "Return display values instead of raw values",
        },
      },
      required: ["table"],
    },
  },
  {
    name: "get_record",
    description: "Get a single record by sys_id from any ServiceNow table.",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string" },
        sys_id: { type: "string" },
        fields: { type: "string", description: "Comma-separated field list" },
        display_value: { type: "boolean" },
      },
      required: ["table", "sys_id"],
    },
  },
  {
    name: "create_record",
    description: "Create a record in any ServiceNow table.",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string" },
        data: { type: "object", description: "Field/value pairs" },
      },
      required: ["table", "data"],
    },
  },
  {
    name: "update_record",
    description: "Update a record by sys_id in any ServiceNow table.",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string" },
        sys_id: { type: "string" },
        data: { type: "object", description: "Field/value pairs to set" },
      },
      required: ["table", "sys_id", "data"],
    },
  },
  {
    name: "delete_record",
    description: "Delete a record by sys_id from any ServiceNow table.",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string" },
        sys_id: { type: "string" },
      },
      required: ["table", "sys_id"],
    },
  },
  {
    name: "aggregate_records",
    description:
      "Count records in a table, optionally grouped by a field, using the Aggregate API.",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string" },
        query: { type: "string", description: "Encoded query filter" },
        group_by: { type: "string", description: "Field to group counts by" },
      },
      required: ["table"],
    },
  },
  {
    name: "create_incident",
    description: "Create an incident with common fields.",
    inputSchema: {
      type: "object",
      properties: {
        short_description: { type: "string" },
        description: { type: "string" },
        caller_id: { type: "string", description: "Caller sys_id or user_name" },
        urgency: { type: "string", description: "1, 2, or 3" },
        impact: { type: "string", description: "1, 2, or 3" },
        assignment_group: { type: "string", description: "Group name or sys_id" },
        category: { type: "string" },
      },
      required: ["short_description"],
    },
  },
  {
    name: "update_incident",
    description:
      "Update an incident by number or sys_id: state, notes, assignment, or any field.",
    inputSchema: {
      type: "object",
      properties: {
        incident: { type: "string", description: "Incident number (INC...) or sys_id" },
        data: { type: "object", description: "Field/value pairs to set" },
        work_note: { type: "string", description: "Work note to append" },
        comment: { type: "string", description: "Customer-visible comment to append" },
      },
      required: ["incident"],
    },
  },
  {
    name: "search_knowledge",
    description: "Search published knowledge articles by text.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Search text" },
        limit: { type: "number", description: "Max articles (default 5)" },
      },
      required: ["text"],
    },
  },
  {
    name: "cmdb_query",
    description:
      "Query CMDB configuration items by class with an encoded query.",
    inputSchema: {
      type: "object",
      properties: {
        class_name: {
          type: "string",
          description: "CI class table, e.g. cmdb_ci_server (default cmdb_ci)",
        },
        query: { type: "string", description: "Encoded query filter" },
        fields: { type: "string", description: "Comma-separated field list" },
        limit: { type: "number", description: "Max records (default 10)" },
      },
    },
  },
  {
    name: "get_user",
    description: "Look up a user by user_name, email, or sys_id.",
    inputSchema: {
      type: "object",
      properties: {
        user: { type: "string", description: "user_name, email, or sys_id" },
      },
      required: ["user"],
    },
  },
  {
    name: "instance_info",
    description:
      "Basic instance details: build name, version, and the authenticated user.",
    inputSchema: { type: "object", properties: {} },
  },
];

function text(data: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(data, null, 2) },
    ],
  };
}

async function resolveIncidentSysId(incident: string): Promise<string> {
  if (/^[0-9a-f]{32}$/i.test(incident)) return incident;
  const res = await snRequest("GET", "/api/now/table/incident", undefined, {
    sysparm_query: `number=${incident}`,
    sysparm_fields: "sys_id",
    sysparm_limit: 1,
  });
  const sysId = res.result?.[0]?.sys_id;
  if (!sysId) throw new Error(`Incident not found: ${incident}`);
  return sysId;
}

async function handleTool(name: string, args: any): Promise<any> {
  switch (name) {
    case "list_records": {
      const res = await snRequest("GET", `/api/now/table/${args.table}`, undefined, {
        sysparm_query: args.query,
        sysparm_fields: args.fields,
        sysparm_limit: Math.min(args.limit ?? 10, 100),
        sysparm_offset: args.offset,
        sysparm_display_value: args.display_value ? "true" : undefined,
      });
      return text(res.result);
    }
    case "get_record": {
      const res = await snRequest(
        "GET",
        `/api/now/table/${args.table}/${args.sys_id}`,
        undefined,
        {
          sysparm_fields: args.fields,
          sysparm_display_value: args.display_value ? "true" : undefined,
        }
      );
      return text(res.result);
    }
    case "create_record": {
      const res = await snRequest("POST", `/api/now/table/${args.table}`, args.data);
      return text(res.result);
    }
    case "update_record": {
      const res = await snRequest(
        "PATCH",
        `/api/now/table/${args.table}/${args.sys_id}`,
        args.data
      );
      return text(res.result);
    }
    case "delete_record": {
      await snRequest("DELETE", `/api/now/table/${args.table}/${args.sys_id}`);
      return text({ deleted: true, table: args.table, sys_id: args.sys_id });
    }
    case "aggregate_records": {
      const res = await snRequest("GET", `/api/now/stats/${args.table}`, undefined, {
        sysparm_query: args.query,
        sysparm_count: "true",
        sysparm_group_by: args.group_by,
      });
      return text(res.result);
    }
    case "create_incident": {
      const data: Record<string, string> = {
        short_description: args.short_description,
      };
      for (const f of [
        "description",
        "caller_id",
        "urgency",
        "impact",
        "assignment_group",
        "category",
      ]) {
        if (args[f]) data[f] = args[f];
      }
      const res = await snRequest("POST", "/api/now/table/incident", data);
      return text(res.result);
    }
    case "update_incident": {
      const sysId = await resolveIncidentSysId(args.incident);
      const data: Record<string, string> = { ...(args.data ?? {}) };
      if (args.work_note) data.work_notes = args.work_note;
      if (args.comment) data.comments = args.comment;
      const res = await snRequest(
        "PATCH",
        `/api/now/table/incident/${sysId}`,
        data
      );
      return text(res.result);
    }
    case "search_knowledge": {
      const res = await snRequest("GET", "/api/now/table/kb_knowledge", undefined, {
        sysparm_query: `workflow_state=published^123TEXTQUERY321=${args.text}`,
        sysparm_fields: "number,short_description,sys_id,sys_view_count,kb_knowledge_base",
        sysparm_limit: args.limit ?? 5,
        sysparm_display_value: "true",
      });
      return text(res.result);
    }
    case "cmdb_query": {
      const res = await snRequest(
        "GET",
        `/api/now/table/${args.class_name ?? "cmdb_ci"}`,
        undefined,
        {
          sysparm_query: args.query,
          sysparm_fields:
            args.fields ?? "name,sys_class_name,sys_id,operational_status",
          sysparm_limit: args.limit ?? 10,
          sysparm_display_value: "true",
        }
      );
      return text(res.result);
    }
    case "get_user": {
      const u = String(args.user);
      const query = /^[0-9a-f]{32}$/i.test(u)
        ? `sys_id=${u}`
        : u.includes("@")
          ? `email=${u}`
          : `user_name=${u}`;
      const res = await snRequest("GET", "/api/now/table/sys_user", undefined, {
        sysparm_query: query,
        sysparm_fields: "sys_id,user_name,name,email,title,department,active",
        sysparm_limit: 1,
        sysparm_display_value: "true",
      });
      return text(res.result);
    }
    case "instance_info": {
      const props = await snRequest("GET", "/api/now/table/sys_properties", undefined, {
        sysparm_query: "nameINglide.buildname,glide.war,glide.builddate",
        sysparm_fields: "name,value",
        sysparm_limit: 3,
      });
      return text({ instance: BASE, user: USERNAME, properties: props.result });
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

const server = new Server(
  { name: "servicenow-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    return await handleTool(request.params.name, request.params.arguments ?? {});
  } catch (err: any) {
    return {
      content: [{ type: "text" as const, text: `Error: ${err.message ?? err}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("servicenow-mcp running on stdio");
