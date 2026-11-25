// 通知音（Web Audio で合成するので音声ファイルは不要）。
// ブラウザの制限で、ユーザーが一度画面を操作するまで音は鳴らせない。

let ctx = null;

export function unlockAudio() {
  ctx ??= new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
}

function tone(freq, start, dur, { type = 'sine', gain = 0.18 } = {}) {
  const t0 = ctx.currentTime + start;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

const PATTERNS = {
  // 揺れ検知：軽いチャイム
  shake: () => { tone(880, 0, 0.35); tone(1175, 0.18, 0.5); },
  // 揺れが強まった（震度3相当以上）
  strong: () => { for (let k = 0; k < 3; k++) tone(988, k * 0.22, 0.18, { type: 'square', gain: 0.08 }); },
  // 地震情報の受信
  info: () => { tone(660, 0, 0.3); tone(880, 0.15, 0.4); },
  // 緊急地震速報（予報）
  eew: () => { for (let k = 0; k < 2; k++) { tone(1046, k * 0.5, 0.2, { type: 'triangle', gain: 0.2 }); tone(1318, k * 0.5 + 0.22, 0.25, { type: 'triangle', gain: 0.2 }); } },
  // 緊急地震速報（警報）
  warning: () => { for (let k = 0; k < 4; k++) { tone(1318, k * 0.4, 0.17, { type: 'sawtooth', gain: 0.09 }); tone(988, k * 0.4 + 0.2, 0.17, { type: 'sawtooth', gain: 0.09 }); } },
};

export function play(name) {
  if (!ctx || ctx.state !== 'running') return;
  PATTERNS[name]?.();
}
