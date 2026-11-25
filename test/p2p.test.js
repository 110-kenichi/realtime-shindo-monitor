import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeQuake, parseP2pEew, tsunamiText } from '../public/js/p2p.js';

const scalePrompt = {
  code: 551,
  earthquake: { time: '2026/11/24 01:12:00', maxScale: 30, domesticTsunami: 'Checking', hypocenter: { name: '', latitude: -200, longitude: -200, depth: -1, magnitude: -1 } },
  issue: { type: 'ScalePrompt', time: '2026/11/24 01:13:30' },
  points: [{ pref: '熊本県', addr: '天草・芦北', isArea: true, scale: 30 }],
};
const destination = {
  code: 551,
  earthquake: { time: '2026/11/24 01:12:00', maxScale: -1, domesticTsunami: 'None', hypocenter: { name: '熊本県天草・芦北地方', latitude: 32.4, longitude: 130.4, depth: 10, magnitude: 3.9 } },
  issue: { type: 'Destination', time: '2026/11/24 01:14:10' },
  points: [],
};
const detail = {
  code: 551,
  earthquake: { time: '2026/11/24 01:12:00', maxScale: 30, domesticTsunami: 'None', hypocenter: { name: '熊本県天草・芦北地方', latitude: 32.4, longitude: 130.4, depth: 10, magnitude: 3.9 } },
  issue: { type: 'DetailScale', time: '2026/11/24 01:16:00' },
  points: [
    { pref: '熊本県', addr: '芦北町芦北', isArea: false, scale: 30 },
    { pref: '熊本県', addr: '水俣市牧ノ内', isArea: false, scale: 20 },
  ],
};

test('同じ地震の発表（震度速報 → 震源情報 → 各地の震度）を 1 件にまとめる', () => {
  let q = mergeQuake(null, scalePrompt);
  assert.equal(q.name, '');
  assert.equal(q.maxScale, 30);
  assert.equal(q.tsunami, 'Checking');
  q = mergeQuake(q, destination);
  assert.equal(q.name, '熊本県天草・芦北地方');
  assert.equal(q.magnitude, 3.9);
  assert.equal(q.maxScale, 30, '震源情報の maxScale=-1 で上書きしない');
  assert.equal(q.tsunami, 'None');
  assert.equal(q.points.length, 1, '空の観測点リストで上書きしない');
  q = mergeQuake(q, detail);
  assert.equal(q.points.length, 2);
  assert.equal(q.type, 'DetailScale');
  assert.equal(q.time, Date.UTC(2026, 10, 23, 16, 12, 0));
  assert.equal(tsunamiText(q.tsunami), 'この地震による津波の心配はありません');
});

test('発表順が前後しても新しい情報を優先する', () => {
  let q = mergeQuake(null, detail);
  q = mergeQuake(q, scalePrompt);
  assert.equal(q.name, '熊本県天草・芦北地方');
  assert.equal(q.tsunami, 'None', '古い「調査中」で上書きしない');
  assert.equal(q.type, 'DetailScale');
  assert.equal(q.points.length, 2);
});

test('P2P地震情報の緊急地震速報（警報）を解釈できる', () => {
  const e = parseP2pEew({
    code: 556, cancelled: false,
    areas: [{ arrivalTime: '2026/11/19 02:22:28', kindCode: '19', name: '熊本県天草・芦北', pref: '熊本', scaleFrom: 45, scaleTo: 99 }],
    earthquake: { arrivalTime: '2026/11/19 02:22:25', condition: '仮定震源要素', hypocenter: { depth: 10, latitude: 32.3, longitude: 130.5, magnitude: 1, name: '熊本県天草・芦北地方', reduceName: '熊本県' }, originTime: '2026/11/19 02:22:24' },
    issue: { eventId: '20261119022225', serial: '1', time: '2026/11/19 02:22:30' },
  });
  assert.equal(e.id, '20261119022225');
  assert.equal(e.serial, 1);
  assert.equal(e.isWarning, true);
  assert.equal(e.region, '熊本県天草・芦北地方');
  assert.equal(e.areas[0].name, '熊本県天草・芦北');
  assert.equal(e.originTime, Date.UTC(2026, 10, 18, 17, 22, 24));
});
