// 揺れ検知：観測点ごとの平常時の値（ベースライン）からの上昇と、近くの観測点の同時上昇で判定する。
// 強震モニタの観測点は画像内の位置が固定なので、画素番号（point.key）で観測点を追跡する。

import { intensityToClass } from './kmoni.js';

export class ShakeDetector {
  constructor({
    rise = 1.0, // ベースラインからこれだけ上がったら「揺れている」候補
    minIntensity = 0.5, // かつ、この値（震度1相当）以上
    radius = 25, // 同時に揺れている観測点を探す半径（画素。約150km）
    minCluster = 3, // この数以上の観測点がまとまって揺れたら検知
    warmup = 10, // ベースラインが落ち着くまでの秒数
    holdMs = 15000, // 最後に検知してから揺れ検知を解除するまでの時間
  } = {}) {
    Object.assign(this, { rise, minIntensity, radius, minCluster, warmup, holdMs });
    this.reset();
  }

  reset() {
    this.stations = new Map();
    this.event = null;
  }

  /**
   * @param {{key:number,x:number,y:number,i:number}[]} points
   * @param {number} time データ時刻（ms）
   * @returns {{triggered:Set<number>, event:null|object, isNew:boolean}}
   */
  update(points, time) {
    const candidates = [];
    for (const p of points) {
      let st = this.stations.get(p.key);
      if (!st) {
        st = { base: p.i, n: 0 };
        this.stations.set(p.key, st);
      }
      st.n++;
      const isCandidate = st.n > this.warmup && p.i >= this.minIntensity && p.i - st.base >= this.rise;
      // 揺れている間はベースラインをほとんど動かさない
      st.base += (p.i - st.base) * (isCandidate ? 0.002 : 0.05);
      if (isCandidate) candidates.push(p);
    }

    // 近くに他の候補が (minCluster - 1) 個以上ある候補だけを採用する
    const r2 = this.radius * this.radius;
    const confirmed = candidates.filter((p) => {
      let near = 0;
      for (const q of candidates) {
        if (q !== p && (q.x - p.x) ** 2 + (q.y - p.y) ** 2 <= r2 && ++near >= this.minCluster - 1) return true;
      }
      return false;
    });

    let isNew = false;
    if (this.event && time - this.event.lastAt > this.holdMs) this.event = null;
    if (time < (this.event?.lastAt ?? -Infinity)) this.event = null; // 時刻が戻った（再生位置の変更）

    if (confirmed.length) {
      if (!this.event) {
        isNew = true;
        this.event = {
          startedAt: time, lastAt: time, peak: -Infinity,
          x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity,
        };
      }
      const ev = this.event;
      ev.lastAt = time;
      for (const p of confirmed) {
        ev.x0 = Math.min(ev.x0, p.x); ev.y0 = Math.min(ev.y0, p.y);
        ev.x1 = Math.max(ev.x1, p.x); ev.y1 = Math.max(ev.y1, p.y);
      }
    }

    if (this.event) {
      // 検知範囲内の現在の最大値と、検知開始からの最大値
      const ev = this.event;
      const m = this.radius / 2;
      let current = -Infinity;
      for (const p of points) {
        if (p.x >= ev.x0 - m && p.x <= ev.x1 + m && p.y >= ev.y0 - m && p.y <= ev.y1 + m) {
          current = Math.max(current, p.i);
        }
      }
      ev.current = current;
      ev.peak = Math.max(ev.peak, current);
      ev.peakClass = intensityToClass(ev.peak);
      ev.active = time - ev.lastAt <= 3000;
      ev.count = confirmed.length;
    }

    return { triggered: new Set(confirmed.map((p) => p.key)), event: this.event, isNew };
  }
}
