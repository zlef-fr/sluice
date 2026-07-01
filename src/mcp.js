// Model Context Protocol server for Sluice — a dependency-free JSON-RPC 2.0
// implementation of the core methods (initialize / tools/list / tools/call).
// It lets any MCP client (Claude, agents, IDEs) discover Sluice's data sources
// and pull open-data feeds as tools. Transport is Streamable HTTP: the client
// POSTs JSON-RPC and gets an application/json response (see routes/mcp.js).
import {
  listSources, getSource, registerSource, refreshNow, feedPayload, feedMeta,
} from './service.js';
import { WRITE_TOKEN } from './config.js';

export const PROTOCOL_VERSION = '2024-11-05';
export const SERVER_INFO = { name: 'sluice', version: '1.0.0' };

// ── tool catalog ──────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'list_sources',
    description:
      'List every data source Sluice manages, with fetch status, item counts and provenance. '
      + 'Start here to discover what open data is available.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => ok({ sources: listSources() }),
  },
  {
    name: 'get_source',
    description: 'Get the full descriptor + fetch status for one source by id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'source id' } },
      required: ['id'],
    },
    handler: async ({ id }) => {
      const s = getSource(id);
      return s ? ok(s) : fail(`unknown source "${id}"`);
    },
  },
  {
    name: 'get_feed',
    description:
      'Fetch the current cached records for a source. Paginated — pass limit/offset. '
      + 'Returns meta plus a window of data (default 50 records to keep responses small).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        limit: { type: 'number', description: 'max records (default 50, max 1000)' },
        offset: { type: 'number', description: 'records to skip (default 0)' },
      },
      required: ['id'],
    },
    handler: async ({ id, limit = 50, offset = 0 }) => {
      const feed = await feedPayload(id);
      if (feed === null) return fail(`unknown source "${id}"`);
      if (!feed.fetchedAt) return fail('feed not fetched yet, retry shortly');
      const lim = Math.max(1, Math.min(1000, Number(limit) || 50));
      const off = Math.max(0, Number(offset) || 0);
      return ok({
        id, fetchedAt: feed.fetchedAt, itemCount: feed.itemCount,
        meta: feed.meta, offset: off, limit: lim,
        data: feed.data.slice(off, off + lim),
      });
    },
  },
  {
    name: 'feed_meta',
    description: 'Get just the computed metadata/stats for a source feed (no records).',
    inputSchema: {
      type: 'object', properties: { id: { type: 'string' } }, required: ['id'],
    },
    handler: async ({ id }) => {
      const m = await feedMeta(id);
      return m ? ok(m) : fail(`unknown source "${id}" or not fetched yet`);
    },
  },
  {
    name: 'search_feed',
    description:
      'Full-text search within a source feed. Matches records whose stringified values '
      + 'contain the query (case-insensitive). Returns up to `limit` matches.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        query: { type: 'string' },
        limit: { type: 'number', description: 'max matches (default 20, max 200)' },
      },
      required: ['id', 'query'],
    },
    handler: async ({ id, query, limit = 20 }) => {
      const feed = await feedPayload(id);
      if (feed === null) return fail(`unknown source "${id}"`);
      if (!feed.fetchedAt) return fail('feed not fetched yet');
      const q = String(query).toLowerCase();
      const lim = Math.max(1, Math.min(200, Number(limit) || 20));
      const matches = [];
      for (const rec of feed.data) {
        if (JSON.stringify(rec).toLowerCase().includes(q)) {
          matches.push(rec);
          if (matches.length >= lim) break;
        }
      }
      return ok({ id, query, matches: matches.length, data: matches });
    },
  },
  {
    name: 'register_source',
    description:
      'Register (or update) a data source. Requires the write token. `descriptor` is a Sluice '
      + 'source descriptor: {id, name, adapter, url|source, transform, refresh, geo?, ...}. '
      + 'Adapters: http-json, http-csv, http-zip-xml, ods-export. Transforms: passthrough, map '
      + '(inline mapping object), fuel-etalab, irve.',
    inputSchema: {
      type: 'object',
      properties: {
        token: { type: 'string', description: 'Sluice write token' },
        descriptor: { type: 'object', description: 'the source descriptor' },
      },
      required: ['token', 'descriptor'],
    },
    handler: async ({ token, descriptor }) => {
      if (!WRITE_TOKEN || token !== WRITE_TOKEN) return fail('invalid write token');
      const r = await registerSource(descriptor, { owner: 'mcp' });
      return r.ok ? ok(r.source) : fail(r.error);
    },
  },
  {
    name: 'refresh_source',
    description: 'Force an immediate re-fetch of a source (requires the write token).',
    inputSchema: {
      type: 'object',
      properties: { token: { type: 'string' }, id: { type: 'string' } },
      required: ['token', 'id'],
    },
    handler: async ({ token, id }) => {
      if (!WRITE_TOKEN || token !== WRITE_TOKEN) return fail('invalid write token');
      const r = await refreshNow(id);
      return r ? ok(r) : fail(`unknown source "${id}"`);
    },
  },
];

const toolsByName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

// ── JSON-RPC dispatch ─────────────────────────────────────────────────────────
// Returns a JSON-RPC response object, or null for notifications (no reply).
export async function handleRpc(msg) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return rpcError(msg?.id ?? null, -32600, 'invalid request');
  }
  const { id, method, params } = msg;
  const isNotification = id === undefined;

  try {
    switch (method) {
      case 'initialize':
        return rpcResult(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions:
            'Sluice manages remote open-data sources. Use list_sources to discover feeds, '
            + 'then get_feed / search_feed to pull records.',
        });

      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null; // notifications get no response

      case 'ping':
        return rpcResult(id, {});

      case 'tools/list':
        return rpcResult(id, {
          tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        });

      case 'tools/call': {
        const tool = toolsByName[params?.name];
        if (!tool) return rpcError(id, -32602, `unknown tool "${params?.name}"`);
        const result = await tool.handler(params.arguments || {});
        return rpcResult(id, result);
      }

      default:
        if (isNotification) return null;
        return rpcError(id, -32601, `method not found: ${method}`);
    }
  } catch (e) {
    return rpcError(id ?? null, -32603, e.message || 'internal error');
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────
function ok(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}
function fail(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}
function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}
function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
