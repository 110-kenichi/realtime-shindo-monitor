#!/usr/bin/env node
// 模擬の強震モニタにつないでアプリを起動する（強震モニタに接続できない環境での画面確認用）。
//   npm run dev:mock  →  http://localhost:8080/
import { startMockUpstream } from './mock-upstream.js';
import { createServer } from '../server.js';

const mock = await startMockUpstream({ port: Number(process.env.MOCK_PORT) || 8090 });
const port = Number(process.env.PORT) || 8080;
const host = process.env.HOST || '127.0.0.1';
createServer({ upstreams: [mock.url] }).listen(port, host, () => {
  console.log(`リアルタイム震度モニタ（模擬データ）: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/`);
  console.log(`模擬の強震モニタ: ${mock.url}（観測点 ${mock.stations.length} 点、20秒後から3分ごとに模擬地震）`);
});
