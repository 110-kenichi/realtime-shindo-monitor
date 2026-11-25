// 地震の記録：強震モニタは過去のデータを短い期間しか残さないため、
// P2P地震情報で一定以上の震度の地震が発表されたら、その前後のデータを取得してディスクに保存する。
// 保存したデータは、強震モニタから消えた後も中継サーバーが代わりに返す。

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { formatKmoniTime, parseJst } from '../public/js/kmoni.js';

export const ARCHIVE_KINDS = ['jma_s', 'jma_b', 'ps', 'est', 'eew'];
const TS_RE = /^\d{14}$/;

export class Archive {
  /**
   * @param {object} o
   * @param {string} o.dir 保存先フォルダ
   * @param {(kind:string, ts:string)=>Promise<{status:number, body:Buffer}>} o.fetchKmoni 強震モニタから取得する関数
   * @param {number} [o.minScale] 保存する最小の震度（P2P地震情報の震度コード。30 = 震度3）
   */
  constructor({
    dir,
    fetchKmoni,
    minScale = 30,
    beforeSec = 30, // 発生時刻（P2P地震情報では分単位）の何秒前から保存するか
    afterSec = 240, // 何秒後まで保存するか
    kinds = ['jma_s', 'jma_b'],
    p2pUrl = 'https://api.p2pquake.net/v2/history?codes=551&limit=40',
    pollMs = 60_000,
    maxAgeMs = 45 * 60_000, // これより古い地震は強震モニタから消えている可能性が高いので取りに行かない
    now = () => Date.now(),
    log = () => {},
  }) {
    Object.assign(this, { dir, fetchKmoni, minScale, beforeSec, afterSec, kinds, p2pUrl, pollMs, maxAgeMs, now, log });
    this.items = [];
    this.busy = false;
    this.skipped = new Set();
  }

  async init() {
    await mkdir(this.dir, { recursive: true });
    try {
      const list = JSON.parse(await readFile(this.indexPath(), 'utf8'));
      if (Array.isArray(list)) this.items = list;
    } catch { /* まだ記録が無い */ }
    return this;
  }

  indexPath() {
    return path.join(this.dir, 'index.json');
  }

  filePath(kind, ts) {
    return path.join(this.dir, ts.slice(0, 8), `${ts}.${kind}`);
  }

  list() {
    return [...this.items].sort((a, b) => b.time - a.time);
  }

  /** 保存したデータを読む。無ければ null */
  async read(kind, ts) {
    if (!ARCHIVE_KINDS.includes(kind) || !TS_RE.test(ts)) return null;
    try {
      return await readFile(this.filePath(kind, ts));
    } catch {
      return null;
    }
  }

  start() {
    const run = () => this.poll().catch((err) => this.log(`地震の記録に失敗しました: ${err?.message ?? err}`));
    run();
    this.timer = setInterval(run, this.pollMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }

  /** P2P地震情報を確認し、保存すべき地震があれば保存する */
  async poll() {
    if (this.busy) return;
    this.busy = true;
    try {
      const res = await fetch(this.p2pUrl, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`P2P地震情報 HTTP ${res.status}`);
      for (const q of groupQuakes(await res.json())) {
        if (q.foreign || q.maxScale < this.minScale || !Number.isFinite(q.time)) continue;
        if (this.items.some((it) => it.key === q.key) || this.skipped.has(q.key)) continue;
        const now = this.now();
        if (now - q.time > this.maxAgeMs) {
          this.skipped.add(q.key);
          continue;
        }
        if (now < q.time + (this.afterSec + 15) * 1000) continue; // 揺れが収まってから取りに行く
        await this.save(q);
      }
    } finally {
      this.busy = false;
    }
  }

  async save(q) {
    const start = q.time - this.beforeSec * 1000;
    const end = q.time + this.afterSec * 1000;
    this.log(`地震を記録しています: ${q.name || '震源調査中'}（${formatKmoniTime(q.time)}）`);
    let frames = 0;
    for (let t = start; t <= end; t += 1000) {
      const ts = formatKmoniTime(t);
      let got = false;
      for (const kind of this.kinds) {
        const r = await this.fetchKmoni(kind, ts).catch(() => null);
        if (r?.status === 200) {
          await this.write(kind, ts, r.body);
          if (kind === this.kinds[0]) got = true;
        }
      }
      if (!got) continue;
      frames++;
      const eew = await this.fetchKmoni('eew', ts).catch(() => null);
      if (eew?.status === 200 && /"report_id"\s*:\s*"[^"]+"/.test(eew.body.toString('utf8'))) {
        await this.write('eew', ts, eew.body);
        for (const kind of ['ps', 'est']) {
          const r = await this.fetchKmoni(kind, ts).catch(() => null);
          if (r?.status === 200) await this.write(kind, ts, r.body);
        }
      }
    }
    if (!frames) {
      this.skipped.add(q.key);
      this.log(`地震を記録できませんでした（強震モニタにデータがありません）: ${formatKmoniTime(q.time)}`);
      return null;
    }
    const item = {
      key: q.key, time: q.time, name: q.name, magnitude: q.magnitude, depth: q.depth, maxScale: q.maxScale,
      start, end, frames, savedAt: this.now(),
    };
    this.items.push(item);
    const tmp = `${this.indexPath()}.tmp`;
    await writeFile(tmp, JSON.stringify(this.list(), null, 1));
    await rename(tmp, this.indexPath());
    this.log(`地震を記録しました: ${q.name || '震源調査中'}（${frames} 秒分）`);
    return item;
  }

  async write(kind, ts, body) {
    const file = this.filePath(kind, ts);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body);
  }
}

/** P2P地震情報の発表（同じ地震に複数ある）を地震ごとにまとめる */
export function groupQuakes(list) {
  const map = new Map();
  for (const msg of Array.isArray(list) ? list : []) {
    const eq = msg?.earthquake;
    if (msg?.code !== 551 || !eq?.time) continue;
    const q = map.get(eq.time) ?? {
      key: eq.time, time: parseJst(eq.time), name: '', magnitude: null, depth: null, maxScale: -1, foreign: false,
    };
    if (eq.hypocenter?.name) {
      q.name = eq.hypocenter.name;
      q.magnitude = eq.hypocenter.magnitude >= 0 ? eq.hypocenter.magnitude : null;
      q.depth = eq.hypocenter.depth >= 0 ? eq.hypocenter.depth : null;
    }
    q.maxScale = Math.max(q.maxScale, eq.maxScale ?? -1);
    if (msg.issue?.type === 'Foreign') q.foreign = true;
    map.set(eq.time, q);
  }
  return [...map.values()];
}
