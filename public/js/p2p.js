// P2P地震情報 API（https://www.p2pquake.net/develop/json_api_v2/）から
// 気象庁の地震情報（震度・震源）と緊急地震速報（警報）を受け取る。CORS 対応なのでブラウザから直接使う。

import { parseJst } from './kmoni.js';

const API = 'https://api.p2pquake.net/v2';
const WS_URL = 'wss://api.p2pquake.net/v2/ws';

const TSUNAMI_TEXT = {
  None: 'この地震による津波の心配はありません',
  Unknown: '',
  Checking: '津波の有無を調査中',
  NonEffective: '若干の海面変動（被害の心配なし）',
  Watch: '津波注意報',
  Warning: '津波警報等を発表中',
};

export function tsunamiText(code) {
  return TSUNAMI_TEXT[code] ?? '';
}

/** 同じ地震の複数の発表（震度速報・震源情報・各地の震度）を 1 件にまとめる */
export function mergeQuake(prev, msg) {
  const eq = msg.earthquake ?? {};
  const hypo = eq.hypocenter ?? {};
  const q = prev ?? {
    key: eq.time,
    time: parseJst(eq.time),
    name: '',
    latitude: null,
    longitude: null,
    depth: null,
    magnitude: null,
    maxScale: -1,
    tsunami: 'Unknown',
    points: [],
    type: '',
    issuedAt: 0,
    foreign: false,
  };
  const issued = parseJst(msg.issue?.time);
  if (hypo.name) {
    Object.assign(q, {
      name: hypo.name,
      latitude: hypo.latitude > -200 ? hypo.latitude : null,
      longitude: hypo.longitude > -200 ? hypo.longitude : null,
      depth: hypo.depth >= 0 ? hypo.depth : null,
      magnitude: hypo.magnitude >= 0 ? hypo.magnitude : null,
    });
  }
  if (eq.maxScale > q.maxScale) q.maxScale = eq.maxScale;
  if (eq.domesticTsunami && eq.domesticTsunami !== 'Unknown' && (!prev || issued >= q.issuedAt)) {
    q.tsunami = eq.domesticTsunami;
  }
  if (Array.isArray(msg.points) && msg.points.length >= q.points.length) q.points = msg.points;
  if (msg.issue?.type === 'Foreign') q.foreign = true;
  if (!prev || issued >= q.issuedAt) {
    q.type = msg.issue?.type ?? q.type;
    q.issuedAt = issued;
  }
  return q;
}

/** P2P地震情報の緊急地震速報（警報）→ 画面表示用の形 */
export function parseP2pEew(msg) {
  const eq = msg.earthquake ?? {};
  const hypo = eq.hypocenter ?? {};
  const num = (v, min) => (typeof v === 'number' && v >= min ? v : null);
  return {
    source: 'p2p',
    id: String(msg.issue?.eventId ?? msg.id),
    serial: parseInt(msg.issue?.serial, 10) || null,
    isFinal: false,
    isCancel: !!msg.cancelled,
    isTraining: !!msg.test,
    isWarning: true,
    region: hypo.name || '',
    latitude: num(hypo.latitude, -90),
    longitude: num(hypo.longitude, -180),
    depth: num(hypo.depth, 0),
    magnitude: num(hypo.magnitude, 0),
    maxClass: null,
    maxText: '',
    originTime: parseJst(eq.originTime),
    reportTime: parseJst(msg.issue?.time),
    condition: eq.condition || '',
    areas: (msg.areas ?? []).map((a) => ({
      name: a.name, pref: a.pref, scaleFrom: a.scaleFrom, scaleTo: a.scaleTo,
      arrivalTime: parseJst(a.arrivalTime),
    })),
  };
}

export class P2PClient {
  constructor({ onQuakes, onEew, onStatus } = {}) {
    this.onQuakes = onQuakes ?? (() => {});
    this.onEew = onEew ?? (() => {});
    this.onStatus = onStatus ?? (() => {});
    this.quakes = new Map();
    this.retry = 0;
    this.seen = new Set();
  }

  start() {
    this.loadHistory();
    this.connect();
  }

  async loadHistory() {
    try {
      const res = await fetch(`${API}/history?codes=551&limit=80`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const list = await res.json();
      for (const msg of list.slice().reverse()) this.handle(msg, { initial: true });
      this.emitQuakes(null);
    } catch (err) {
      console.warn('P2P地震情報の履歴を取得できません', err);
      this.onStatus('error');
    }
  }

  connect() {
    if (typeof WebSocket === 'undefined') return;
    this.onStatus('connecting');
    const ws = new WebSocket(WS_URL);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.onStatus('open');
    };
    ws.onmessage = (e) => {
      try {
        this.handle(JSON.parse(e.data), { initial: false });
      } catch (err) {
        console.warn('P2P地震情報の受信データを解釈できません', err);
      }
    };
    ws.onclose = () => {
      this.onStatus('closed');
      const delay = Math.min(60_000, 2000 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => ws.close();
  }

  handle(msg, { initial }) {
    const id = msg._id ?? msg.id;
    if (id) {
      if (this.seen.has(id)) return;
      this.seen.add(id);
    }
    if (msg.code === 551 && msg.earthquake?.time) {
      const key = msg.earthquake.time;
      const prev = this.quakes.get(key);
      this.quakes.set(key, mergeQuake(prev, msg));
      if (!initial) this.emitQuakes(key, !prev);
    } else if (msg.code === 556 && !initial) {
      this.onEew(parseP2pEew(msg));
    }
  }

  emitQuakes(updatedKey, isNew = false) {
    const list = [...this.quakes.values()].sort((a, b) => b.time - a.time);
    // 古いものは捨てる（長時間開いたままでも増え続けないように）
    for (const q of list.slice(50)) this.quakes.delete(q.key);
    if (this.seen.size > 5000) this.seen.clear();
    this.onQuakes(list.slice(0, 30), updatedKey ? this.quakes.get(updatedKey) : null, isNew);
  }
}
