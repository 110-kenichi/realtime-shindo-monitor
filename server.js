#!/usr/bin/env node
// リアルタイム震度モニタを起動する（npm start）。中身は lib/server.js。
import { createServer, DEFAULT_UPSTREAMS } from './lib/server.js';

const port = Number(process.env.PORT) || 8080;
const host = process.env.HOST || '127.0.0.1';
const upstreams = process.env.KMONI_UPSTREAMS ? process.env.KMONI_UPSTREAMS.split(',') : DEFAULT_UPSTREAMS;

let lastLog = '';
const server = createServer({
  upstreams,
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
  console.log('終了するには Ctrl+C を押してください。');
});

const stop = () => server.close(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
