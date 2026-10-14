#!/bin/bash
# 后端鉴权 + 配置接口 集成测试
# 注意：本机环境设置了 HTTP_PROXY/HTTPS_PROXY，访问 127.0.0.1 必须 --noproxy '*'
BASE=${BASE:-http://127.0.0.1:5300}
J=/tmp/cookies.txt
JA=/tmp/cookies-admin.txt
PASS=0; FAIL=0
export no_proxy='127.0.0.1,localhost' NO_PROXY='127.0.0.1,localhost'

cur()  { curl -s --noproxy '*' "$@"; }
code() { curl -s --noproxy '*' -o /dev/null -w "%{http_code}" "$@"; }

t() { # $1 描述 $2 实际 $3 期望
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "  ✓ $1  ($2)";
  else FAIL=$((FAIL+1)); echo "  ❌ $1  实际=$2 期望=$3"; fi
}

echo "【0】健康检查"
t "GET /api/health 200" "$(code $BASE/api/health)" "200"

echo "【1】未登录时的门禁"
t "GET / 应重定向到登录页" "$(code -I $BASE/)" "302"
t "GET /admin.html 应重定向" "$(code -I $BASE/admin.html)" "302"
t "GET /api/data 应 401" "$(code $BASE/api/data)" "401"
t "GET /api/config 应 401" "$(code $BASE/api/config)" "401"
t "GET /api/stream 应 401" "$(code $BASE/api/stream)" "401"
t "PUT /api/data 应 401" "$(code -X PUT -H 'Content-Type: application/json' -d '{}' $BASE/api/data)" "401"
t "GET /login.html 公开" "$(code $BASE/login.html)" "200"
t "静态 styles.css 公开" "$(code $BASE/styles.css)" "200"
t "app.js 未登录不可取" "$(code $BASE/app.js)" "302"

echo "【2】看板密码登录（默认 gonghui123）"
t "错误密码应 401" "$(code -X POST -H 'Content-Type: application/json' -d '{"role":"dashboard","password":"wrong"}' $BASE/api/auth/login)" "401"
t "正确密码应 200" "$(code -c $J -X POST -H 'Content-Type: application/json' -d '{"role":"dashboard","password":"gonghui123"}' $BASE/api/auth/login)" "200"
t "看板会话可为 dashboard" "$(cur -b $J $BASE/api/auth/status | grep -o '"dashboard":true' | head -1)" '"dashboard":true'
t "看板会话不可为 admin" "$(cur -b $J $BASE/api/auth/status | grep -o '"admin":false' | head -1)" '"admin":false'
t "看板可读数据" "$(code -b $J $BASE/api/data)" "200"
t "看板可读配置" "$(code -b $J $BASE/api/config)" "200"
t "看板不可写数据(401)" "$(code -b $J -X PUT -H 'Content-Type: application/json' -d '{}' $BASE/api/data)" "401"
t "看板不可改配置(401)" "$(code -b $J -X PUT -H 'Content-Type: application/json' -d '{}' $BASE/api/config)" "401"
t "看板访问 admin.html 重定向" "$(code -b $J -I $BASE/admin.html)" "302"
t "看板可取 app.js" "$(code -b $J $BASE/app.js)" "200"

echo "【3】后台密码登录（默认 admin123）"
t "后台会话登录" "$(code -c $JA -X POST -H 'Content-Type: application/json' -d '{"role":"admin","password":"admin123"}' $BASE/api/auth/login)" "200"
t "后台可访问 admin.html" "$(code -b $JA $BASE/admin.html)" "200"
t "后台可读数据" "$(code -b $JA $BASE/api/data)" "200"
t "后台可读配置" "$(code -b $JA $BASE/api/config)" "200"

echo "【4】配置写入"
CFG=$(cur -b $JA $BASE/api/config)
echo "$CFG" | python3 -c "
import json,sys
c=json.load(sys.stdin)
c['text']['pageTitle']='集成测试标题'
json.dump(c, open('/tmp/cfg-new.json','w'), ensure_ascii=False)
print('  指标数:', len(c['metrics']), '| 模块数:', len(c['modules']), '| 图表数:', len(c['charts']), '| 统计表数:', len(c['tables']))
"
t "PUT 配置 200" "$(code -b $JA -X PUT -H 'Content-Type: application/json' --data-binary @/tmp/cfg-new.json $BASE/api/config)" "200"
t "配置已生效" "$(cur -b $JA $BASE/api/config | python3 -c 'import json,sys;print(json.load(sys.stdin)["text"]["pageTitle"])')" "集成测试标题"
t "非法配置(缺 modules) 应 400" "$(code -b $JA -X PUT -H 'Content-Type: application/json' -d '{"a":1}' $BASE/api/config)" "400"

echo "【4b】配置兜底收敛（复现「图表全黑」那个线上故障）"
# 故障：后台把图表色板数组存成了字符串 "#4DD8FF,#5FE0FF,…"，
# ECharts 逐字符取色拿到 '#' → addColorStop 抛异常 → 所有图表渲染成黑色。
# 现在服务端必须无条件把这类配置收敛成可渲染的形态。
python3 - <<'PY'
import json
c = json.load(open('/tmp/cfg-new.json'))
c['theme']['palette'] = '#4DD8FF,#5FE0FF,#3B82F6,#10B981,#F59E0B,#EF4444,#8B5CF6,#EC4899'
json.dump(c, open('/tmp/cfg-bad-palette.json','w'), ensure_ascii=False)
PY
t "色板为字符串时仍接受保存(200)" "$(code -b $JA -X PUT -H 'Content-Type: application/json' --data-binary @/tmp/cfg-bad-palette.json $BASE/api/config)" "200"
t "落盘后色板已变成数组(8)" \
  "$(cur -b $JA $BASE/api/config | python3 -c 'import json,sys;p=json.load(sys.stdin)["theme"]["palette"];print("数组%d"%len(p) if isinstance(p,list) else type(p).__name__)')" \
  "数组8"
t "接口回传了自动修正说明" \
  "$(cur -b $JA -X PUT -H 'Content-Type: application/json' --data-binary @/tmp/cfg-bad-palette.json $BASE/api/config | python3 -c 'import json,sys;print(len(json.load(sys.stdin).get("warnings",[]))>0)')" \
  "True"

python3 - <<'PY'
import json
c = json.load(open('/tmp/cfg-new.json'))
c['theme']['palette'] = '#4DD8FF, 不是颜色, ,#10B981,999'
c['modules'][0]['columns'][0]['width'] = 99          # 越界列宽
c['modules'][0]['columns'] = c['modules'][0]['columns'][:1]
c['modules'][0]['columns'][0]['blocks'] = [{"id":"b-x","type":"metrics","visible":True,"metricIds":["org-total","不存在的指标"]}]
json.dump(c, open('/tmp/cfg-bad-more.json','w'), ensure_ascii=False)
PY
t "脏值配置仍接受保存(200)" "$(code -b $JA -X PUT -H 'Content-Type: application/json' --data-binary @/tmp/cfg-bad-more.json $BASE/api/config)" "200"
t "非法颜色已被剔除(只剩 2 个)" \
  "$(cur -b $JA $BASE/api/config | python3 -c 'import json,sys;print(len(json.load(sys.stdin)["theme"]["palette"]))')" \
  "2"
t "越界列宽已回退为 12" \
  "$(cur -b $JA $BASE/api/config | python3 -c 'import json,sys;print(json.load(sys.stdin)["modules"][0]["columns"][0]["width"])')" \
  "12"
t "悬空指标引用被点名警告" \
  "$(cur -b $JA -X PUT -H 'Content-Type: application/json' --data-binary @/tmp/cfg-bad-more.json $BASE/api/config | python3 -c 'import json,sys;ws=json.load(sys.stdin).get("warnings",[]);print(1 if any("不存在的指标" in w for w in ws) else 0)')" \
  "1"
t "非法色板(数字类型)也会回退默认 8 色" \
  "$(python3 -c "
import json
c=json.load(open('/tmp/cfg-new.json')); c['theme']['palette']=123
json.dump(c, open('/tmp/cfg-bad-type.json','w'), ensure_ascii=False)
" && cur -b $JA -X PUT -H 'Content-Type: application/json' --data-binary @/tmp/cfg-bad-type.json $BASE/api/config > /dev/null && \
     cur -b $JA $BASE/api/config | python3 -c 'import json,sys;p=json.load(sys.stdin)["theme"]["palette"];print(len(p) if isinstance(p,list) else "非数组")')" \
  "8"
# 还原成正常配置，避免影响后续用例
cur -b $JA -X PUT -H 'Content-Type: application/json' --data-binary @/tmp/cfg-new.json $BASE/api/config > /dev/null

echo "【5】数据写入权限"
cur -b $JA $BASE/api/data > /tmp/data-current.json
t "后台 PUT 数据 200" "$(code -b $JA -X PUT -H 'Content-Type: application/json' --data-binary @/tmp/data-current.json $BASE/api/data)" "200"

echo "【6】修改密码（改密码需先验证当前后台密码；改密后其它会话被踢）"
t "错误当前后台密码 应 403" "$(code -b $JA -X POST -H 'Content-Type: application/json' -d '{"role":"dashboard","current":"bad","next":"newpass1"}' $BASE/api/auth/password)" "403"
t "新密码过短 应 400" "$(code -b $JA -X POST -H 'Content-Type: application/json' -d '{"role":"dashboard","current":"admin123","next":"123"}' $BASE/api/auth/password)" "400"
t "改看板密码 200" "$(code -b $JA -X POST -H 'Content-Type: application/json' -d '{"role":"dashboard","current":"admin123","next":"viewpass9"}' $BASE/api/auth/password)" "200"
t "旧看板密码失效" "$(code -X POST -H 'Content-Type: application/json' -d '{"role":"dashboard","password":"gonghui123"}' $BASE/api/auth/login)" "401"
t "新看板密码可用" "$(code -X POST -H 'Content-Type: application/json' -d '{"role":"dashboard","password":"viewpass9"}' $BASE/api/auth/login)" "200"
t "其他人会话已被踢下线" "$(code -b $J $BASE/api/data)" "401"

echo "【7】改回原密码 & 改后台密码"
t "改回看板密码" "$(code -b $JA -X POST -H 'Content-Type: application/json' -d '{"role":"dashboard","current":"admin123","next":"gonghui123"}' $BASE/api/auth/password)" "200"
t "改后台密码" "$(code -b $JA -X POST -H 'Content-Type: application/json' -d '{"role":"admin","current":"admin123","next":"admin2026"}' $BASE/api/auth/password)" "200"
t "旧后台密码失效" "$(code -X POST -H 'Content-Type: application/json' -d '{"role":"admin","password":"admin123"}' $BASE/api/auth/login)" "401"
t "新后台密码可用" "$(code -X POST -H 'Content-Type: application/json' -d '{"role":"admin","password":"admin2026"}' $BASE/api/auth/login)" "200"
t "改回后台默认密码" "$(code -b $JA -X POST -H 'Content-Type: application/json' -d '{"role":"admin","current":"admin2026","next":"admin123"}' $BASE/api/auth/password)" "200"
t "改回后默认后台密码可用" "$(code -X POST -H 'Content-Type: application/json' -d '{"role":"admin","password":"admin123"}' $BASE/api/auth/login)" "200"

echo "【8】退出登录"
t "登出 200" "$(code -b $JA -X POST $BASE/api/auth/logout)" "200"
t "登出后 admin.html 重定向" "$(code -b $JA -I $BASE/admin.html)" "302"

echo "【9】还原测试前的看板配置"
code -c $J  -X POST -H 'Content-Type: application/json' -d '{"role":"dashboard","password":"gonghui123"}' $BASE/api/auth/login > /dev/null
code -c $JA -X POST -H 'Content-Type: application/json' -d '{"role":"admin","password":"admin123"}'   $BASE/api/auth/login > /dev/null
t "还原配置 200" "$(code -b $JA -X PUT -H 'Content-Type: application/json' --data-binary @/tmp/config-backup.json $BASE/api/config)" "200"
t "配置已还原" "$(cur -b $J $BASE/api/config | python3 -c 'import json,sys;print(json.load(sys.stdin)["text"]["pageTitle"])')" "海底捞集团工会工作数据看板"

echo "【10】敏感文件不可被直接下载（静态白名单）"
for f in server-data.json server-config.json server-auth.json server.js package.json README.md DEPLOY_GUIDE.md seed-data.json seed-config.json test-e2e-cdp.js backups/; do
  t "未登录 GET /$f → 404" "$(code $BASE/$f)" "404"
done
t "看板会话 GET /server-data.json → 404" "$(code -b $J $BASE/server-data.json)" "404"
t "后台会话 GET /server-auth.json → 404" "$(code -b $JA $BASE/server-auth.json)" "404"
t "login.html 仍公开" "$(code $BASE/login.html)" "200"
t "styles.css 仍公开" "$(code $BASE/styles.css)" "200"
t "admin.css 仍公开" "$(code $BASE/admin.css)" "200"
t "lib/echarts.min.js 仍公开" "$(code $BASE/lib/echarts.min.js)" "200"

echo "【11】存储诊断 / 备份恢复 / 防误清空"
t "health 含 persistent 标记" "$(cur $BASE/api/health | grep -o '"persistent":true' | head -1)" '"persistent":true'
t "health 含 storageMode" "$(cur $BASE/api/health | grep -c '"storageMode"')" "1"
t "未登录读 /api/storage 应 401" "$(code $BASE/api/storage)" "401"
t "看板会话读 /api/storage 应 401" "$(code -b $J $BASE/api/storage)" "401"
t "后台可读 /api/storage" "$(code -b $JA $BASE/api/storage)" "200"
t "storage 报告数据目录来源=env" "$(cur -b $JA $BASE/api/storage | grep -c '"dataDirSource":"env"')" "1"
t "storage 报告行数 > 0" "$(cur -b $JA $BASE/api/storage | python3 -c 'import json,sys;print("yes" if json.load(sys.stdin)["rows"]>0 else "no")')" "yes"
t "PUT 空数据 → 400" "$(code -b $JA -X PUT -H 'Content-Type: application/json' -d '{}' $BASE/api/data)" "400"
t "PUT 仅 _meta → 400" "$(code -b $JA -X PUT -H 'Content-Type: application/json' -d '{"_meta":{}}' $BASE/api/data)" "400"
t "看板会话不能手动备份(401)" "$(code -b $J -X POST -H 'Content-Type: application/json' -d '{"kind":"data"}' $BASE/api/backups)" "401"
t "手动备份 200" "$(code -b $JA -X POST -H 'Content-Type: application/json' -d '{"kind":"data"}' $BASE/api/backups)" "200"
t "备份列表 200" "$(code -b $JA $BASE/api/backups)" "200"
t "备份列表非空" "$(cur -b $JA $BASE/api/backups | python3 -c 'import json,sys;print("yes" if json.load(sys.stdin)["count"]>=1 else "no")')" "yes"
t "非法备份名 → 400" "$(code -b $JA -X POST -H 'Content-Type: application/json' -d '{"name":"../etc/passwd"}' $BASE/api/backups/restore)" "400"
t "不存在的备份 → 404" "$(code -b $JA -X POST -H 'Content-Type: application/json' -d '{"name":"server-data.19700101-000000.json"}' $BASE/api/backups/restore)" "404"
BK=$(cur -b $JA $BASE/api/backups | python3 -c 'import json,sys;print(json.load(sys.stdin)["backups"][0]["name"])')
t "恢复第一份备份 200" "$(code -b $JA -X POST -H 'Content-Type: application/json' -d "{\"name\":\"$BK\"}" $BASE/api/backups/restore)" "200"
t "恢复后数据仍可读" "$(code -b $JA $BASE/api/data)" "200"

echo
echo "==============================="
echo " 通过 $PASS 项 / 失败 $FAIL 项"
echo "==============================="
exit $([ $FAIL -eq 0 ] && echo 0 || echo 1)
