#!/usr/bin/env node
// リアルタイム震度モニタを起動する（npm start）。中身は lib/server.js。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, DEFAULT_UPSTREAMS } from './lib/server.js';

const port = Number(process.env.PORT) || 8080;
const host = process.env.HOST || '127.0.0.1';
const upstreams = process.env.KMONI_UPSTREAMS ? process.env.KMONI_UPSTREAMS.split(',') : DEFAULT_UPSTREAMS;

// 地震の記録（ARCHIVE=off で無効）
const SCALE = { 1: 10, 2: 20, 3: 30, 4: 40, '5-': 45, '5弱': 45, '5+': 50, '5強': 50, '6-': 55, '6弱': 55, '6+': 60, '6強': 60, 7: 70 };
const minShindo = process.env.ARCHIVE_MIN_SHINDO ?? '3';
const archive = process.env.ARCHIVE === 'off' ? null : {
  dir: path.resolve(process.env.ARCHIVE_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'archive')),
  minScale: SCALE[minShindo] ?? 30,
};

let lastLog = '';
const server = createServer({
  upstreams,
  archive,
  log: (msg) => {
    if (msg !== lastLog) console.warn(`[${new Date().toLocaleTimeString('ja-JP')}] ${msg}`);
    lastLog = msg;
  },
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`ポート ${port} は別のプログラムが使用中です。PORT=8081 のように別のポートを指定してください。`);
  } else {
    console.error(`起動できませんでした: ${err.message}`);
  }
  process.exit(1);
});

server.listen(port, host, () => {
  const shown = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  console.log(`リアルタイム震度モニタ: http://${shown}:${port}/`);
  console.log(`データ取得元: ${upstreams.join(', ')}`);
  if (archive) console.log(`地震の記録: 震度${minShindo}以上を ${archive.dir} に保存します`);
  console.log('終了するには Ctrl+C を押してください。');
});

const stop = () => server.close(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
