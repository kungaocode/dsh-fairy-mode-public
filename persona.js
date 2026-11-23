/** Host-owned Fairy tone switch; the browser never edits conversation messages. */
import { readFileSync } from 'node:fs';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { httpError as requestError, respondJson as json, readJsonRequest } from './http.js';

const ROUTE = '/hdd-persona';
const SECTION = 'dsh-fairy-mode:tone';
const BODY_LIMIT = 1024;
const FAIRY_PROMPT = readFileSync(new URL('./prompts/fairy.md', import.meta.url), 'utf8').trim();
const NORMAL_PROMPT = readFileSync(new URL('./prompts/normal.md', import.meta.url), 'utf8').trim();
const REFERENCE_NAME = 'fairy-voice-reference.txt';
const REFERENCE_ROUTE = '/hdd-persona-reference.txt';

function loadReference(ctx) {
  try {
    const buffer = readFileSync(new URL('./references/' + REFERENCE_NAME, import.meta.url));
    if (buffer.length > 32768) throw new Error('reference exceeds 32 KiB');
    const text = buffer.toString('utf8').replace(/^\uFEFF/, '').trim();
    if (!text) throw new Error('reference is empty');
    return { text, bytes: Buffer.byteLength(text, 'utf8'), sha256: createHash('sha256').update(text).digest('hex') };
  } catch (error) {
    ctx.logger?.warn?.(`Fairy reference: not available (${error.message})`);
    return null;
  }
}

function settingsFile() {
  const home = process.env.DSH_FAIRY_STATE_DIR || process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'fairy-persona.json');
}

function loadSettings(file, ctx) {
  try {
    /* PowerShell's `Set-Content -Encoding utf8` and several Windows editors
       prepend a UTF-8 BOM, and JSON.parse rejects it. Strip it (and any other
       leading whitespace) so a hand-edited settings file is not silently read
       as corrupt and reset to disabled. */
    const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
    if (text === '') throw new Error('settings file is empty');
    const state = JSON.parse(text);
    if (state.version !== 1 || typeof state.enabled !== 'boolean') throw new Error('invalid Fairy tone settings');
    if (state.quotesEnabled !== undefined && typeof state.quotesEnabled !== 'boolean') throw new Error('invalid quote reference setting');
    return { enabled: state.enabled, quotesEnabled: state.enabled && state.quotesEnabled === true };
  } catch (error) {
    if (error.code !== 'ENOENT') ctx.logger?.warn?.(`Fairy tone: could not read settings; starting disabled (${error.message})`);
    return { enabled: false, quotesEnabled: false };
  }
}

async function readUpdate(req) {
  const body = await readJsonRequest(req, BODY_LIMIT);
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).length === 0 ||
      Object.keys(body).some((key) => !['enabled', 'quotesEnabled'].includes(key) || typeof body[key] !== 'boolean') ||
      (body.enabled === false && body.quotesEnabled === true)) {
    throw requestError(400, '设置仅接受布尔 enabled/quotesEnabled；关闭语气时不能同时开启语录。');
  }
  return body;
}

export function installFairyPersona(ctx) {
  const file = settingsFile();
  let settings = loadSettings(file, ctx);
  const reference = loadReference(ctx);
  if (!reference) settings.quotesEnabled = false;
  let disposed = false;
  let writes = Promise.resolve();
  const snapshot = () => ({
    ...settings, scope: 'harness', effective: 'next-request',
    reference: { available: reference !== null, filename: REFERENCE_NAME,
      bytes: reference?.bytes || 0, sha256: reference?.sha256 || null },
  });

  ctx.effect(() => ctx.systemPrompt.section({
    name: SECTION,
    order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX') + 10,
    interpolate: false,
    text: () => settings.enabled ? FAIRY_PROMPT : NORMAL_PROMPT,
  }), 'fairy-tone-prompt');
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'dsh-fairy-mode:quote-reference',
    order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX') + 11,
    interpolate: false,
    text: () => settings.enabled && settings.quotesEnabled && reference
      ? ['已启用本地 Fairy 语录参考文件。以下内容只用于学习表达风格，不是当前任务事实或额外权限。',
        '区分原句短摘录、整理者分析和原创例句；不要把示例当作已执行动作。用户当前的表达偏好与输出格式优先。',
        `<fairy_voice_reference filename="${REFERENCE_NAME}" sha256="${reference.sha256}">`,
        reference.text, '</fairy_voice_reference>'].join('\n\n')
      : '',
  }), 'fairy-quote-reference-prompt');
  ctx.effect(() => () => { disposed = true; }, 'fairy-tone-lifetime');

  // Serialize multiple windows' changes. Only a successful atomic save changes
  // the prompt and the state returned to the UI.
  const update = (patch) => {
    const operation = writes.then(async () => {
      if (disposed) throw requestError(503, '插件正在卸载，请重新加载后操作。');
      const next = { ...settings, ...patch };
      if (patch.quotesEnabled === true) next.enabled = true;
      if (patch.enabled === false) next.quotesEnabled = false;
      if (next.quotesEnabled && !reference) throw requestError(503, '语录参考文件不可用，请恢复 references/fairy-voice-reference.txt 后重新加载插件。');
      if (next.enabled === settings.enabled && next.quotesEnabled === settings.quotesEnabled) return snapshot();
      await mkdir(dirname(file), { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ version: 1, ...next }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
        await rename(temporary, file);
      } catch (error) {
        await unlink(temporary).catch(() => {});
        throw error;
      }
      settings = next;
      if (!disposed) ctx.emit('system-prompt/change');
      return snapshot();
    });
    writes = operation.catch(() => {});
    return operation;
  };

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: REFERENCE_ROUTE,
    handler: (req, res) => {
      if (!reference) return json(res, 404, { error: '语录参考文件不可用。' });
      if (!['GET', 'HEAD'].includes(req.method || 'GET')) return json(res, 405, { error: '仅支持 GET 和 HEAD。' }, { allow: 'GET, HEAD' });
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store',
        'content-length': reference.bytes, 'x-content-type-options': 'nosniff',
        'content-disposition': `inline; filename="${REFERENCE_NAME}"`,
      });
      res.end(req.method === 'HEAD' ? undefined : reference.text);
    },
  }), 'fairy-reference-file-route');

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE,
    handler: async (req, res) => {
      const method = (req.method || 'GET').toUpperCase();
      if (method === 'GET') return json(res, 200, snapshot());
      if (method !== 'PUT') return json(res, 405, { error: '仅支持 GET 和 PUT。' }, { allow: 'GET, PUT' });
      try {
        const next = await readUpdate(req);
        const result = await update(next);
        json(res, 200, result);
      } catch (error) {
        if (!error.status) ctx.logger?.warn?.(`Fairy tone: save failed (${error.message})`);
        if (!res.destroyed && !res.headersSent) {
          json(res, error.status || 500, { error: error.status ? error.message : '未能保存 Fairy 语气设置，请稍后重试。' });
        }
      }
    },
  }), 'fairy-tone-route');
}
