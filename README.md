# PT 签到 v5（雷池 SafeLine WAF 兼容版）

一个专为 PT 站点设计的自动化签到脚本，部署于青龙面板，支持多站点、多渠道推送，**内置雷池（SafeLine）WAF 人机验证自动挑战**，无需浏览器、无需验证码，纯 HTTP 请求即可完成签到。

## 🌟 功能特点

- 🚀 **多站点支持**：同时管理多个 PT 站点的签到任务
- 🛡️ **雷池 SafeLine 自动挑战**：
  - 自动识别 HTTP 468 / 挑战页（`SafeLineChallenge`）
  - 自动完成 `issue → PoW 本地算题 → verify` 挑战流程，无需浏览器
  - 自动保存并回传 WAF 下发的 `sl-session` / `sl-challenge-jwt` 等 Cookie
- 🍪 **完整 Cookie 罐**：响应中的 `Set-Cookie` 全程保持，登录态不丢
- 📢 **多渠道推送**：支持飞书、Bark、Server酱、钉钉、微信和自定义推送
- 🔄 **智能重试**：可配置重试次数，提高签到成功率
- 🌐 **代理支持**：支持 HTTP/HTTPS 代理访问
- 📋 **详细日志**：趣味化日志输出 + 签到结果汇总推送

## 📦 青龙面板部署教程

### 方式一：订阅拉取（推荐）

1. 登录青龙面板
2. 进入「脚本管理」→「订阅管理」→ 右上角「创建订阅」
3. 填写：
   - 名称：`PT-sign`
   - 链接：`https://github.com/Flyingpen/PT-sign.git`
   - 定时规则：`0 30 7 * * *`（每天 7:30 自动更新脚本，可自行调整）
   - 文件类型：`js`
4. 点击「运行一次」，订阅完成后脚本会出现在「脚本管理」中
5. 之后每次更新脚本，只需在订阅上点「运行一次」即可拉取最新版

### 方式二：手动创建

1. 打开本仓库的 [`PT-sign-V5.js`](./PT-sign-V5.js)，完整复制内容
2. 登录青龙面板，进入「脚本管理」→ 右上角「+」新建
3. 文件名填 `PT-sign-V5.js`，粘贴脚本内容，保存

### 安装依赖

无论哪种方式，都需要先安装依赖（**只需安装一次**）：

1. 青龙面板进入「依赖管理」→「NodeJs」→ 右上角「创建依赖」
2. 类型选 `NodeJs`，名称填：`axios https-proxy-agent`
3. 提交，等待安装完成（显示「安装成功」即可）

> ⚠️ 如果不装依赖直接运行，会报 `Cannot find module 'axios'` 错误。

## ⚙️ 环境变量配置

进入「环境变量」→ 右上角「创建变量」，按需添加：

### 1. 必填变量

| 变量名 | 示例值 | 说明 |
|--------|--------|------|
| `PT_WEBHOOK_URL` | `https://open.feishu.cn/open-apis/bot/v2/hook/xxx` | 推送地址（见下方推送配置） |
| `PT_SITE_HDKYL_CK` | `c_secure_uid=xxx; c_secure_pass=xxx; ...` | hdkyl 站点 Cookie（获取方法见下文） |

### 2. 可选变量

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `PT_WEBHOOK_TYPE` | `custom` | 推送类型：`feishu` / `bark` / `sct` / `ding` / `wx` / `custom` |
| `PT_PROXY` | 无 | HTTP(S) 代理，如 `http://127.0.0.1:7890` |
| `PT_RETRY` | `3` | 失败重试次数 |
| `PT_TIMEOUT` | `20000` | 请求超时（毫秒） |
| `PT_SAFELINE` | `1` | 雷池自动挑战开关，设为 `0` 关闭 |
| `PT_EXTRA_HEADERS` | 无 | 额外请求头，格式：`key1:value1\|key2:value2` |
| `PT_DEBUG` | 无 | 设为 `1` 输出调试日志（排查问题用） |
| `PT_SITE_HDKYL_URL` | 内置地址 | 覆盖站点签到页地址 |

### 3. 设置定时任务

进入「定时任务」→「创建任务」：

- 命令：`task PT-sign-V5.js`
- 定时规则：`30 8 * * *`（每天 08:30 执行一次，签到任务建议每天一次即可）

手动点一次「运行」，日志出现「签到成功」或「今日已签到」即为部署成功。

## 🍪 Cookie 获取教程

以 hdkyl 为例：

1. 电脑浏览器登录 [www.hdkyl.in](https://www.hdkyl.in)
2. 按 `F12` 打开开发者工具，切到「网络 / Network」标签
3. 刷新页面，在请求列表中点击第一个请求（`attendance.php` 或域名）
4. 在右侧「请求标头 / Request Headers」里找到 `Cookie:` 一行
5. **完整复制**整个值（包括 `c_secure_uid`、`c_secure_pass` 等所有字段）
6. 粘贴到环境变量 `PT_SITE_HDKYL_CK` 的值中保存

> 💡 **雷池站点提示**：如果日志提示「雷池挑战已通过但站点未放行」，说明站点把验证绑定到了浏览器指纹。请用浏览器正常访问一次站点完成人机验证，然后把**包含 `sl-challenge-jwt` 的完整 Cookie** 复制到环境变量即可。

### 添加其他 PT 站点

编辑 `PT-sign-V5.js` 中的 `sites` 对象：

```javascript
const sites = {
  // 已有站点...
  newpt: {
    host: 'newpt.com',
    url: 'https://newpt.com/attendance.php',
    parseReward: (html) => parseAttendanceDetails(html, '魔力值')
  }
};
```

然后添加环境变量 `PT_SITE_NEWPT_CK=<该站 Cookie>` 即可。变量名规则：`PT_SITE_` + 大写站点 key + `_CK`。

## 📢 推送配置示例

| 渠道 | `PT_WEBHOOK_TYPE` | `PT_WEBHOOK_URL` 示例 |
|------|-------------------|----------------------|
| 飞书机器人 | `feishu` | `https://open.feishu.cn/open-apis/bot/v2/hook/xxxx` |
| Bark（iOS） | `bark` | `https://api.day.app/你的Key` |
| Server酱 | `sct` | `https://sctapi.ftqq.com/SCTxxxx.send` |
| 钉钉机器人 | `ding` | `https://oapi.dingtalk.com/robot/send?access_token=xxxx` |
| 企业微信 | `wx` | `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxx` |
| 自定义 | `custom`（默认） | 任意 URL，POST `{title, content}` JSON |

## 📋 运行日志示例

```
[小可爱签到机] 可爱的小机器人上线啦，开始为你自动签到！
[小可爱签到机] 🛡️ 雷池 SafeLine 自动挑战已启用
[小可爱签到机] hdkyl：准备开始签到咯！
[小可爱签到机] hdkyl：检测到雷池 SafeLine 挑战页（HTTP 468），正在自动答题...
[小可爱签到机] 今天已经打过卡啦，摸摸头~
[小可爱签到机] 📊 解析结果 - 连续签到：4天，奖励：累计95魔力值

===== 签到汇总 =====
hdkyl: ✅ 今日已签到
  🎯 连续签到：4天
  🎁 获得奖励：累计95魔力值
```

## ⚠️ 注意事项

1. **Cookie 安全**：Cookie 包含敏感信息，请勿泄露；定期更新（建议每月一次）
2. **站点兼容性**：需要站点使用 `attendance.php` + `formhash` 表单结构（NexusPHP 程序）
3. **雷池高级模式**：若站点开启了滑块验证（level 2）或文件上传类高级挑战，纯 HTTP 脚本无法通过，需人工过验证后更新 Cookie
4. **推送限制**：飞书机器人每分钟最多 20 条；Bark 免费版每天有次数限制

## 🐛 常见问题（FAQ）

| 问题 | 解决方案 |
|------|----------|
| `Cannot find module 'axios'` | 未装依赖，见上文「安装依赖」步骤 |
| 签到失败：Cookie 未配置 | 检查环境变量名是否正确（大写站点名） |
| 签到失败：Cookie 失效 | 重新获取站点 Cookie |
| 雷池挑战失败（issue/verify 未通过） | 站点升级了挑战算法，等待脚本更新 |
| 雷池挑战通过但站点未放行 | 用浏览器访问一次站点，导出含 `sl-challenge-jwt` 的完整 Cookie |
| 签到失败：找不到 formhash | 站点可能已更新，提 Issue 反馈 |
| 推送失败 | 检查 `PT_WEBHOOK_URL` 是否正确配置 |
| 签到超时 | 检查网络连接，或调大 `PT_TIMEOUT` |

## 📝 更新日志

### v5.0 雷池兼容版（相对 v4）
- ✅ **修复致命语法错误**：v4 `getZhReason()` 中三处全角句号导致整个脚本无法运行
- ✅ 新增雷池 SafeLine 自动挑战（1:1 复刻浏览器 challenge.js 流程：挑战页 token → 云端 issue → PoW → verify → jwt 重放）
- ✅ 新增 Cookie 罐：保存/回传服务端下发的所有 `Set-Cookie`
- ✅ 移除伪造 `X-Forwarded-For` / `X-Real-IP`（自曝 bot 特征）
- ✅ 统一完整 Chrome 请求头，POST content-type 固定 urlencoded
- ✅ 手动跟随重定向，通过 `login.php` 跳转判定 Cookie 失效

### v4.0 / v3.0（历史）
- 多站点支持、多渠道推送、趣味化日志（详见 git 历史）

---

> 💡 **提示**：首次运行建议手动执行一次，检查日志输出是否正常，再设置定时任务。觉得有用的话，点个 Star ⭐ 支持一下吧！
