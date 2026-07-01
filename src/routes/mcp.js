// MCP Streamable HTTP transport endpoint. Clients POST JSON-RPC to /mcp and get
// an application/json response (single request/response — no server-initiated
// streaming needed for these tools). A GET returns 405 since we don't open an
// SSE channel. Batched requests (JSON arrays) are supported per the spec.
import { Router } from 'express';
import { handleRpc } from '../mcp.js';

const router = Router();

router.post('/', async (req, res) => {
  const body = req.body;
  try {
    if (Array.isArray(body)) {
      const responses = (await Promise.all(body.map(handleRpc))).filter((r) => r !== null);
      // If every message was a notification, reply 202 with no body.
      if (!responses.length) return res.status(202).end();
      return res.json(responses);
    }
    const response = await handleRpc(body);
    if (response === null) return res.status(202).end(); // notification
    return res.json(response);
  } catch (e) {
    return res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: e.message } });
  }
});

router.get('/', (_req, res) => {
  res
    .status(405)
    .set('Allow', 'POST')
    .json({ error: 'Sluice MCP uses POST JSON-RPC (Streamable HTTP, no SSE channel).' });
});

export default router;
