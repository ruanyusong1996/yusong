#!/usr/bin/env node
/**
 * 本地一键跑真实浏览器 E2E（test-e2e-cdp.js）
 *
 * 为什么需要它：本环境不允许把服务放后台常驻，所以这里「同进程起服务」——
 * require 一下 server.js 就在同一个进程里把 HTTP 服务跑起来了，
 * 然后自动登录拿两个会话 cookie，再交给 test-e2e-cdp.js 去驱动浏览器。
 *
 * 数据目录：默认用 /tmp/hdj-e2e-data（空的）→ 启动时会自动从代码目录「认领」
 *          一份数据/配置副本，因此测试怎么改都不会动到仓库里的真实文件。
 *
 * 用法：node run-e2e-local.js
 * 可选环境变量：E2E_DATA_DIR / E2E_PORT
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const WORK = process.env.E2E_DATA_DIR || '/tmp/hdj-e2e-data';
const PORT = process.env.E2E_PORT || '5321';

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

  const login = async (role, password) => {
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role, password }),
    });
    const cookie = (r.headers.getSetCookie ? r.headers.getSetCookie() : []).join(';');
    const m = /hdj_sid=([^;]+)/.exec(cookie);
    return m ? m[1] : '';
  };

  process.env.SID = await login('dashboard', 'gonghui123');
  process.env.SID_ADMIN = await login('admin', 'admin123');
  process.env.BASE = BASE;

  // E2E 末尾会还原配置，还原来源就是这份备份
  const backup = '/tmp/hdj-e2e-config-backup.json';
  fs.copyFileSync(path.join(WORK, 'server-config.json'), backup);
  process.env.CFG_BACKUP = backup;

  console.log(`[wrapper] 服务已就绪 ${BASE}，数据目录 ${WORK}`);
  console.log(`[wrapper] 会话已获取 dashboard=${process.env.SID.slice(0, 8)}… admin=${process.env.SID_ADMIN.slice(0, 8)}…\n`);

  require(path.join(ROOT, 'test-e2e-cdp.js'));
})().catch(e => { console.error('[wrapper] 启动失败:', e); process.exit(2); });
