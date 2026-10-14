#!/usr/bin/env node
/**
 * 本地一键跑后端集成测试（test-auth-config.sh）
 *
 * 同进程起服务（本环境不允许后台常驻），再用异步 spawn 跑 bash 脚本——
 * 必须是「异步」spawn：spawnSync 会阻塞事件循环，同进程里的服务就没法响应请求了。
 *
 * 数据目录：默认 /tmp/hdj-auth-data（空目录 → 启动时自动从代码目录认领一份副本），
 *          测试怎么改密码、怎么改配置都不会动到仓库文件。
 *
 * 用法：node run-auth-test-local.js
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const WORK = process.env.AUTH_TEST_DATA_DIR || '/tmp/hdj-auth-data';
const PORT = process.env.AUTH_TEST_PORT || '5322';

(async () => {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });

  process.env.DATA_DIR = WORK;
  process.env.PORT = String(PORT);
  process.env.LOG_REQUESTS = '0';
  require(path.join(ROOT, 'server.js'));

  const BASE = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 120));
  }
  console.log(`[wrapper] 服务已就绪 ${BASE}，数据目录 ${WORK}\n`);

  // test-auth-config.sh 末尾要用它还原看板配置
  fs.copyFileSync(path.join(WORK, 'server-config.json'), '/tmp/config-backup.json');

  const status = await new Promise(resolve => {
    const p = spawn('bash', [path.join(ROOT, 'test-auth-config.sh')], {
      stdio: 'inherit',
      cwd: ROOT,
      env: { ...process.env, BASE, no_proxy: '127.0.0.1,localhost', NO_PROXY: '127.0.0.1,localhost' },
    });
    p.on('exit', code => resolve(code === null ? 1 : code));
  });
  process.exit(status);
})().catch(e => { console.error('[wrapper] 启动失败:', e); process.exit(2); });
