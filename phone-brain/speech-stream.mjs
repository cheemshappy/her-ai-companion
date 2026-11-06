import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { once } from 'node:events';

/** Relay bytes immediately. Only a complete upstream response becomes a cache entry. */
export async function streamSpeech(res, { request, cacheFile, timeoutMs = 20000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('语音合成超时')), timeoutMs);
  const disconnected = () => { if (!res.writableFinished) controller.abort(); };
  res.on('close', disconnected);
  let reader;
  try {
    const upstream = await request(controller.signal);
    if (!upstream.ok || !upstream.body || !/^(audio\/|application\/octet-stream)/i.test(upstream.headers.get('content-type') || '')) {
      void upstream.body?.cancel().catch(() => {});
      throw new Error('语音服务暂时不可用');
    }
    controller.signal.throwIfAborted();
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'cache-control': 'no-store',
      'access-control-allow-origin': '*', 'x-accel-buffering': 'no' });
    res.flushHeaders();
    const parts = [];
    reader = upstream.body.getReader();
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      controller.signal.throwIfAborted();
      if (done) break;
      if (!value.length) continue;
      length += value.length;
      if (length > 8 * 1024 * 1024) throw new Error('语音数据过大');
      parts.push(Buffer.from(value));
      if (!res.write(value)) await once(res, 'drain', { signal: controller.signal });
    }
    if (!length) throw new Error('语音服务返回了空音频');
    res.end();
    // Different requests for the same sentence never expose a partly written MP3.
    const temporary = cacheFile + '.' + crypto.randomUUID() + '.tmp';
    try {
      await fs.writeFile(temporary, Buffer.concat(parts));
      await fs.rename(temporary, cacheFile);
    } catch { await fs.rm(temporary, { force: true }).catch(() => {}); }
    return { complete: true, bytes: length };
  } catch (error) {
    controller.abort();
    if (!res.destroyed) {
      if (res.headersSent) res.destroy();
      else {
        res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: '语音合成未完成，请稍后再试' }));
      }
    }
    return { complete: false, bytes: 0 };
  } finally {
    clearTimeout(timer);
    res.removeListener('close', disconnected);
    void reader?.cancel().catch(() => {});
  }
}
