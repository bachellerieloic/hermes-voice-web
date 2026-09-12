// In-process stand-in for the Hermes Agent API server: streams scripted SSE chat completions.
import { createServer } from 'node:http';

const chunk = (delta) => `data: ${JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', model: 'hermes-agent', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;
const finish = () => `data: ${JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', model: 'hermes-agent', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;
const tool = (name, status) => `event: hermes.tool.progress\ndata: ${JSON.stringify({ object: 'hermes.tool.progress', tool_name: name, status })}\n\n`;

export async function startFakeHermes({ apiKey = 'test-hermes-key' } = {}) {
  const requests = [];
  const scripts = [];

  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404);
      return res.end();
    }
    if (req.headers.authorization !== `Bearer ${apiKey}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end('{"error":"unauthorized"}');
    }
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const record = { headers: req.headers, body: JSON.parse(body), aborted: false, finished: false };
      requests.push(record);
      const steps = scripts.shift() ?? [{ delay: 1, text: 'Okay.' }];
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Hermes-Session-Id': req.headers['x-hermes-session-id'] ?? '' });
      res.on('close', () => { record.aborted = !record.finished; });
      let index = 0;
      const next = () => {
        if (record.aborted) return;
        if (index >= steps.length) {
          record.finished = true;
          res.end(finish());
          return;
        }
        const step = steps[index];
        index += 1;
        setTimeout(() => {
          if (record.aborted) return;
          if (step.tool) res.write(tool(step.tool.name, step.tool.status));
          else res.write(chunk({ role: 'assistant', content: step.text }));
          next();
        }, step.delay ?? 1);
      };
      next();
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    apiKey,
    requests,
    script(steps) { scripts.push(steps); },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      server.closeAllConnections?.();
    },
  };
}
