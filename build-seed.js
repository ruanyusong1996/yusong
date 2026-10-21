/* 把浏览器用的 seed-*.js 转成服务端读的 seed-*.json。
 *
 * 为什么需要：看板离线（file:// 双击打开）时读的是 seed-data.js / seed-config.js；
 * 服务端（server.js）读的是 seed-data.json / seed-config.json。两份必须一致，
 * 否则改了 JS 而 JSON 没跟上，就会出现「本地好使、线上没变化」。
 *
 * 用法：node build-seed.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;
const JOBS = [
  { js: 'seed-data.js', json: 'seed-data.json', global: 'SEED_DATA' },
  { js: 'seed-config.js', json: 'seed-config.json', global: 'SEED_CONFIG' },
];

function extract(jsPath, globalName) {
  const src = fs.readFileSync(jsPath, 'utf8');
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: jsPath });
  const val = sandbox.window[globalName];
  if (val === undefined) throw new Error(`${jsPath} 里没找到 window.${globalName}`);
  return val;
}

JOBS.forEach(({ js, json, global: g }) => {
  const jsPath = path.join(ROOT, js);
  const jsonPath = path.join(ROOT, json);
  const val = extract(jsPath, g);
  fs.writeFileSync(jsonPath, JSON.stringify(val, null, 2) + '\n', 'utf8');
  const keys = Object.keys(val).length;
  console.log(`[build-seed] ${js} → ${json}  (顶层 ${keys} 项, ${(fs.statSync(jsonPath).size / 1024).toFixed(1)} KB)`);
});
