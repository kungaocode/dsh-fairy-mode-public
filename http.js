/** Shared same-origin JSON helpers for the Fairy controls. */
export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

export function respondJson(res, status, payload, extraHeaders = {}) {
  if (res.destroyed || res.headersSent) return;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

export async function readJsonRequest(req, limit = 4096) {
  if (req.headers['x-fairy-request'] !== '1' ||
      req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw httpError(415, '需要 application/json 和 X-Fairy-Request 请求头。');
  }
  if (req.headers['sec-fetch-site'] === 'cross-site') throw httpError(403, '不接受跨站请求。');
  if (req.headers.origin) {
    let origin;
    try { origin = new URL(req.headers.origin); } catch { throw httpError(403, '无效的请求来源。'); }
    if (origin.host !== req.headers.host) throw httpError(403, '请求来源与当前 Harness 不匹配。');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > limit) throw httpError(413, '请求内容过大。');
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
    throw httpError(400, '请求内容必须是有效的 JSON。');
  }
}
