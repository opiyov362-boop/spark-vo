// Spark Vo server: serves the app and proxies chat to the Anthropic API.
// Your API key stays here (ANTHROPIC_API_KEY env var), never in the app.
const http = require('http'), fs = require('fs'), path = require('path');
const KEY = process.env.ANTHROPIC_API_KEY, PORT = process.env.PORT || 3000;
const LIMIT = +process.env.RATE_LIMIT || 40; // requests per IP per 10 minutes
const MODELS = { quick: 'claude-haiku-5-5', default: 'claude-sonnet-5-5', complex: 'claude-opus-5-5' };
const SYS = 'You are Spark Vo, a helpful, honest, friendly AI assistant in a mobile chat app. Lead with the answer, then brief reasoning. Use Markdown when it helps. Use the calculator for non-trivial math and the date tool for anything about today. Say plainly when you are unsure.';
const TOOLS = [
  { name: 'calculator', description: 'Evaluate an arithmetic expression. Supports + - * / % ^ ( ) sqrt sin cos tan log abs floor ceil round min max pow pi.', input_schema: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] } },
  { name: 'current_datetime', description: 'Get the current UTC date and time.', input_schema: { type: 'object', properties: {} } }
];
const MF = /\b(sqrt|sin|cos|tan|log|abs|floor|ceil|round|min|max|pow|pi)\b/g;
function runTool(name, inp) {
  try {
    if (name === 'current_datetime') return new Date().toUTCString();
    const ex = String(inp.expression || '').replace(/\^/g, '**');
    if (/[^0-9+\-*\/%().,\s]/.test(ex.replace(MF, ''))) return 'Error: unsupported characters';
    return String(Function('"use strict";return (' + ex.replace(MF, m => m === 'pi' ? 'Math.PI' : 'Math.' + m) + ')')());
  } catch (e) { return 'Error: ' + e.message; }
}
async function callAPI(messages, model, res) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 2000, system: SYS, tools: TOOLS, messages, stream: true })
  });
  if (!r.ok) throw new Error('API ' + r.status);
  const blocks = []; let cur = null, stop = null, buf = ''; const dec = new TextDecoder();
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const ev = buf.slice(0, i); buf = buf.slice(i + 2);
      const line = ev.split('\n').find(l => l.startsWith('data:')); if (!line) continue;
      let d; try { d = JSON.parse(line.slice(5)); } catch { continue; }
      if (d.type === 'content_block_start') {
        const b = d.content_block;
        cur = b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, json: '' } : { type: 'text', text: '' };
        blocks.push(cur);
      } else if (d.type === 'content_block_delta' && cur) {
        if (d.delta.type === 'text_delta') { cur.text += d.delta.text; res.write(d.delta.text); }
        else if (d.delta.type === 'input_json_delta') cur.json += d.delta.partial_json;
      } else if (d.type === 'message_delta') stop = d.delta.stop_reason;
    }
  }
  return { blocks, stop };
}
const hits = new Map();
function limited(ip) {
  const now = Date.now(), h = hits.get(ip) || { n: 0, t: now };
  if (now - h.t > 600000) { h.n = 0; h.t = now; }
  h.n++; hits.set(ip, h); return h.n > LIMIT;
}
async function chat(req, res) {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  if (limited(ip)) { res.writeHead(429); return res.end('Too many requests'); }
  if (!KEY) { res.writeHead(500); return res.end('Server has no ANTHROPIC_API_KEY'); }
  let body = ''; let size = 0;
  for await (const c of req) { size += c.length; if (size > 8e6) { res.writeHead(413); return res.end(); } body += c; }
  let p; try { p = JSON.parse(body); } catch { res.writeHead(400); return res.end(); }
  let msgs = (Array.isArray(p.messages) ? p.messages : []).slice(-30)
    .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map(m => ({ role: m.role, content: m.content.slice(0, 60000) }));
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') { res.writeHead(400); return res.end(); }
  const okT = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  const imgs = (Array.isArray(p.images) ? p.images : []).filter(i => okT.includes(i.media_type) && typeof i.data === 'string').slice(0, 3);
  if (imgs.length) {
    const last = msgs[msgs.length - 1];
    last.content = imgs.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.media_type, data: i.data } })).concat([{ type: 'text', text: last.content }]);
  }
  const model = MODELS[p.tier] || MODELS.default;
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
  try {
    for (let round = 0; round < 5; round++) {
      const { blocks, stop } = await callAPI(msgs, model, res);
      if (stop !== 'tool_use') break;
      const content = blocks.filter(b => b.type === 'tool_use' || b.text).map(b => b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, input: JSON.parse(b.json || '{}') } : { type: 'text', text: b.text });
      const results = content.filter(b => b.type === 'tool_use').map(b => ({ type: 'tool_result', tool_use_id: b.id, content: runTool(b.name, b.input) }));
      msgs.push({ role: 'assistant', content }, { role: 'user', content: results });
    }
  } catch (e) { res.write('\n\nSorry, the AI service is unavailable right now.'); }
  res.end();
}
const TYPES = { '.html': 'text/html', '.json': 'application/json', '.js': 'text/javascript', '.png': 'image/png' };
const FILES = ['index.html', 'manifest.json', 'sw.js', 'icon-192.png', 'icon-512.png', 'assetlinks.json'];
http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/chat') return chat(req, res);
  let u = req.url.split('?')[0];
  let name = u === '/' ? 'index.html' : u === '/.well-known/assetlinks.json' ? 'assetlinks.json' : u.slice(1);
  if (!FILES.includes(name)) { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(path.join(__dirname, name), (e, d) => {
    if (e) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(name)] || 'application/octet-stream' }); res.end(d);
  });
}).listen(PORT, () => console.log('Spark Vo running on http://localhost:' + PORT));
