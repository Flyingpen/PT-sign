

# PT 签到 v3 趣味防护增强版

一个专为 PT 站点设计的自动化签到脚本，部署于青龙面板，具备趣味防护机制和多种推送方式。

## 🌟 功能特点

- 🚀 **多站点支持**：同时管理多个 PT 站点的签到任务
- 🛡️ **趣味防护机制**：
  - 随机 User-Agent 模拟不同设备
  - 随机 IP 伪造（X-Forwarded-For）
  - WAF 绕过策略（随机延迟 + 请求头伪装）
- 📢 **多渠道推送**：支持飞书、Bark、Server酱、钉钉、微信和自定义推送
- 🔄 **智能重试**：可配置重试次数，提高签到成功率
- 🌐 **代理支持**：支持 HTTP/HTTPS 代理访问
- 📋 **详细日志**：趣味化日志输出 + 签到结果汇总推送

## 📦 部署流程

### 1. 环境准备
确保已安装以下依赖：
```bash
npm install axios https-proxy-agent
```

### 2. 创建脚本
1. 登录青龙面板
2. 进入「脚本管理」→「新建脚本」
3. 将 `pt_sign.txt` 内容粘贴到脚本编辑器
4. 保存脚本（建议命名为 `pt_sign.js`）

### 3. 配置环境变量
在「环境变量」中添加以下配置（详见下方环境变量说明）

### 4. 运行脚本
1. 在脚本列表中选择刚创建的脚本
2. 点击「运行」或设置定时任务（建议每天 08:00 执行）

## ⚙️ 环境变量设置

| 变量名 | 必填 | 说明 | 示例 |
|--------|------|------|------|
| `PT_WEBHOOK_URL` | ✅ | 推送地址 | `https://open.feishu.cn/open-apis/bot/v2/hook/xxx` |
| `PT_WEBHOOK_TYPE` | ❌ | 推送类型（默认 custom） | `feishu`/`bark`/`sct`/`ding`/`wx`/`custom` |
| `PT_PROXY` | ❌ | 代理地址 | `http://127.0.0.1:7890` |
| `PT_RETRY` | ❌ | 重试次数（默认 3） | `5` |
| `PT_WAF_BYPASS` | ❌ | 开启 WAF 绕过（任意值） | `1` |
| `PT_EXTRA_HEADERS` | ❌ | 自定义请求头 | `x-token:abc123|x-secret:456` |
| `PT_SITE_<站点>_CK` | ✅ | 站点 Cookie | `PT_SITE_HDKYL_CK=xxx` |

### 推送配置示例
```bash
# 飞书机器人
PT_WEBHOOK_TYPE=feishu
PT_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/xxx

# Bark 推送
PT_WEBHOOK_TYPE=bark
PT_WEBHOOK_URL=https://api.day.app/yourkey/

# Server酱
PT_WEBHOOK_TYPE=sct
PT_WEBHOOK_URL=https://sctapi.ftqq.com/SCTxxx.send
```

## 🌐 站点管理

### 添加新站点
1. **修改脚本中的 `sites` 对象**：
   ```javascript
   const sites = {
     // 已有站点...
     newpt: {
       host: 'newpt.com',
       url: 'https://newpt.com/attendance.php'
     }
   };
   ```
2. **添加对应环境变量**：
   ```bash
   PT_SITE_NEWPT_CK=your_cookie_here
   ```

### 删除站点
1. 从 `sites` 对象中移除站点配置
2. 删除对应的环境变量

### Cookie 获取方法
1. 浏览器登录目标站点
2. 按 F12 打开开发者工具
3. 刷新页面 → Network → 找到主页请求
4. 复制请求头中的 `Cookie` 字段值

## 🔧 高级配置

### WAF 绕过机制
当站点启用 WAF 防护时，可开启此功能：
```bash
PT_WAF_BYPASS=1  # 开启后会增加随机延迟和请求头伪装
```

### 自定义请求头
```bash
PT_EXTRA_HEADERS=x-token:abc123|x-secret:456
```

### 代理设置
```bash
PT_PROXY=http://127.0.0.1:7890
```

## 📋 运行日志示例
```
[小可爱签到机] 可爱的小机器人上线啦，开始为你自动签到！
[小可爱签到机] 当前未使用代理，直接访问站点。
[小可爱签到机] hdkyl：准备开始签到咯！
[小可爱签到机] 正在悄悄等待 8.3 秒，避开雷池小雷达...
[小可爱签到机] 恭喜你，签到成功！撒花~
[小可爱签到机] carpt：准备开始签到咯！
[小可爱签到机] 今天已经打过卡啦，摸摸头~

===== 签到汇总 =====
hdkyl: ✅ 签到成功
carpt: ✅ 签到成功
```

## ⚠️ 注意事项

1. **Cookie 安全**：
   - Cookie 包含敏感信息，请勿泄露
   - 定期更新 Cookie（建议每月更新一次）

2. **站点兼容性**：
   - 目前仅支持使用 `attendance.php` 的站点
   - 需要站点有 `formhash` 参数

3. **推送限制**：
   - 飞书机器人每分钟最多发送 20 条消息
   - Bark 免费版每天有推送次数限制

4. **WAF 绕过**：
   - 开启后会显著增加签到时间（随机延迟 2-35 秒）
   - 仅在遇到 WAF 拦截时开启

## 🐛 常见问题

| 问题 | 解决方案 |
|------|----------|
| 签到失败：Cookie 未配置 | 检查环境变量名是否正确（大写站点名） |
| 签到失败：Cookie 失效 | 重新获取站点 Cookie |
| 签到失败：找不到 formhash | 站点可能已更新，需要适配脚本 |
| 推送失败 | 检查 `PT_WEBHOOK_URL` 是否正确配置 |
| 签到超时 | 检查网络连接或增加 `timeout` 值 |

## 📝 更新日志

### v3.0 趣味防护增强版
- 新增随机 UA/IP 生成机制
- 新增 WAF 绕过策略
- 优化推送格式和错误提示
- 增加趣味化日志输出
- 支持自定义请求头

---

> 💡 **提示**：首次运行建议手动执行一次，检查日志输出是否正常，再设置定时任务。
