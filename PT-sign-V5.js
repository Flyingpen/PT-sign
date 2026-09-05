/**
 * PT 签到 v5（雷池 SafeLine WAF 兼容版）
 * 相比 v4 的关键修复：
 *   1. 修复 getZhReason() 中全角句号「。」导致的语法错误（v4 根本无法运行）
 *   2. 新增 Cookie 罐：保存并回传服务器下发的所有 Set-Cookie（含雷池 sl-session 等）
 *   3. 新增雷池 SafeLine 自动挑战：检测 468/挑战页 → issue → 本地 PoW 计算 → verify → 携带 jwt 重放
 *   4. 移除伪造的 x-forwarded-for / x-real-ip（对 WAF 是自曝 bot 特征）
 *   5. 统一使用完整、自洽的 Chrome 请求头（不再随机换 UA、不再缺 accept 等）
 *   6. POST 的 content-type 固定为 application/x-www-form-urlencoded（v4 有 50% 概率随机成 json 导致必败）
 *   7. axios 关闭自动重定向，改用手动跟随：302 到 login.php/takelogin.php 才判定 Cookie 失效
 *   8. formhash 正则放宽（8~32 位字母数字，兼容不同站点）
 *   9. POST 请求补齐 origin / referer / sec-fetch-* 头
 *
 * 环境变量：
 *   PT_SITE_<SITE>_CK     必须，对应站点 cookie（如 PT_SITE_HDKYL_CK）
 *   PT_SITE_<SITE>_URL    可选，覆盖站点签到页地址
 *   PT_WEBHOOK_URL        必须，推送地址
 *   PT_WEBHOOK_TYPE       feishu | bark | sct | ding | wx | custom，默认 custom
 *   PT_PROXY              可选，如 http://127.0.0.1:7890
 *   PT_RETRY              重试次数，默认 3
 *   PT_TIMEOUT            请求超时毫秒，默认 20000
 *   PT_SAFELINE           是否启用雷池自动挑战，默认 1（设为 0 关闭）
 *   PT_EXTRA_HEADERS      可选，额外 header，格式：key1:value1|key2:value2
 *   PT_DEBUG              可选，开启调试模式，输出 HTML 内容
 */

const axios = require('axios');
const crypto = require('crypto');

let HttpsProxyAgent = null;
try {
  HttpsProxyAgent = require('https-proxy-agent');
} catch (_) { /* 未安装代理库时忽略，仅在使用 PT_PROXY 时报错 */ }

const RETRY = Number(process.env.PT_RETRY) || 3;
const PROXY = process.env.PT_PROXY || null;
const WEBHOOK_URL = process.env.PT_WEBHOOK_URL;
const WEBHOOK_TYPE = (process.env.PT_WEBHOOK_TYPE || 'custom').toLowerCase();
const SAFELINE = process.env.PT_SAFELINE !== '0';
const EXTRA_HEADERS = process.env.PT_EXTRA_HEADERS || '';
const DEBUG = !!process.env.PT_DEBUG;
const TIMEOUT = Number(process.env.PT_TIMEOUT) || 20000;

if (!WEBHOOK_URL) throw new Error('❌ 未配置 PT_WEBHOOK_URL，快去补上推送地址吧！');

/* ========= 日志 ========= */
function log(msg) { console.log(`[小可爱签到机] ${msg}`); }
function error(msg) { console.error(`[小可爱签到机] ${msg}`); }
function debug(msg) { if (DEBUG) console.log(`[🔍调试] ${msg}`); }

/* ========= 统一浏览器指纹（整个进程保持一致，避免多请求指纹打架）========= */
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function getExtraHeaders() {
  const headers = {};
  if (EXTRA_HEADERS) {
    EXTRA_HEADERS.split('|').forEach(pair => {
      const idx = pair.indexOf(':');
      if (idx > 0) headers[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
    });
  }
  return headers;
}

/* 浏览器导航级请求头（GET 页面用） */
function navHeaders(referer) {
  const h = {
    'user-agent': BROWSER_UA,
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'sec-ch-ua': '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'same-origin',
    'sec-fetch-user': '?1',
    'upgrade-insecure-requests': '1',
    ...getExtraHeaders()
  };
  if (referer) h['referer'] = referer;
  return h;
}

/* ========= Cookie 罐 ========= */
class CookieJar {
  constructor() { this.map = new Map(); } // name -> value
  /** 吸收响应中的 set-cookie */
  absorb(resp) {
    const list = resp.headers && resp.headers['set-cookie'];
    if (!Array.isArray(list)) return;
    for (const c of list) {
      const pair = c.split(';')[0];
      const idx = pair.indexOf('=');
      if (idx <= 0) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      // 空值或明确过期则删除
      if (!value || /expires=Thu,\s*01\s+Jan\s+1970/i.test(c) || /max-age=0/i.test(c)) this.map.delete(name);
      else this.map.set(name, value);
    }
  }
  set(name, value) { this.map.set(name, value); }
  get(name) { return this.map.get(name); }
  header() { return [...this.map.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
}

/* ========= HTTP 客户端 ========= */
const httpConfig = { timeout: TIMEOUT, validateStatus: () => true, maxRedirects: 0 };
if (PROXY) {
  if (!HttpsProxyAgent) throw new Error('使用了 PT_PROXY 但未安装 https-proxy-agent，请执行 npm i https-proxy-agent');
  httpConfig.httpsAgent = new HttpsProxyAgent.HttpsProxyAgent(PROXY);
}
const http = axios.create(httpConfig);
// webhook 允许默认重定向
const webhookHttp = PROXY ? axios.create({ timeout: 8000, httpsAgent: new HttpsProxyAgent.HttpsProxyAgent(PROXY) }) : axios.create({ timeout: 8000 });

/** GET 页面：自动带 cookie、吸收 set-cookie、手动跟随重定向、识别登录跳转 */
async function siteGet(url, jar, depth = 0) {
  const resp = await http.get(url, { headers: { ...navHeaders(depth ? url : undefined), cookie: jar.header() } });
  jar.absorb(resp);
  if ([301, 302, 303, 307, 308].includes(resp.status)) {
    const loc = resp.headers.location || '';
    if (!loc) throw new Error(`重定向 ${resp.status} 缺少 Location`);
    if (/login\.php|takelogin\.php|takeconfirm/i.test(loc)) {
      const err = new Error(`Cookie 失效：被重定向到 ${loc}`);
      err.code = 'COOKIE_INVALID';
      throw err;
    }
    if (depth >= 5) throw new Error('重定向次数过多');
    return siteGet(new URL(loc, url).toString(), jar, depth + 1);
  }
  return resp;
}

/** POST 表单：urlencoded、补 origin/referer，手动跟随重定向 */
async function sitePost(url, jar, body) {
  const u = new URL(url);
  const headers = {
    ...navHeaders(url),
    'content-type': 'application/x-www-form-urlencoded', // 固定！表单提交就是它
    'origin': u.origin,
    'sec-fetch-site': 'same-origin',
    cookie: jar.header()
  };
  const resp = await http.post(url, body, { headers });
  jar.absorb(resp);
  if ([301, 302, 303, 307, 308].includes(resp.status)) {
    const loc = resp.headers.location || '';
    if (/login\.php|takelogin\.php/i.test(loc)) {
      const err = new Error(`Cookie 失效：提交后被重定向到 ${loc}`);
      err.code = 'COOKIE_INVALID';
      throw err;
    }
    // 跟随重定向拿到最终页面
    const final = await siteGet(new URL(loc, url).toString(), jar);
    return { status: resp.status, data: final.data, redirected: true };
  }
  return { status: resp.status, data: resp.data, redirected: false };
}

/* ========= 雷池 SafeLine 挑战 ========= */
// SafeLineChallenge 下发的算题（逆自 chaitin calc.js 的纯 JS 回退实现）
function safelineCalc(e) {
  let t = 1;
  const n = e.reduce((a, b) => a + b, 0);
  let r = (6 + e.length + n) % 6 + 6;
  for (let o = r; o--;) t *= 6;
  if (t < 6666) t *= e.length;
  if (t > 0x3f940aa) t = Math.floor(t / e.length);
  for (let o = 0; o < e.length; o++) {
    t += Math.pow(e[o], 3);
    t ^= o;
    t ^= e[o] + o;
  }
  const out = [];
  for (; t > 0;) { out.unshift(63 & t); t >>= 6; }
  return out;
}

function isSafeLineChallenge(html, status) {
  if (status === 468) return true;
  if (typeof html !== 'string') return false;
  return html.includes('SafeLineChallenge(') || html.includes('/.safeline/challenge') || html.includes('id="sl-box"');
}

/**
 * 自动完成雷池挑战（1:1 复刻浏览器 challenge.js 流程）：
 *   1. 从挑战页 HTML 提取内嵌 token（SafeLineChallenge("xxx") 参数）作为 client_id
 *   2. 向云端 challenge.rivers.chaitin.cn 发 issue（浏览器 credentials:"omit"，不带 cookie）
 *   3. 本地 PoW 算题（与官方 calc.wasm 结果一致的 JS 回退实现）
 *   4. verify 通过后把 jwt 写入 cookie 罐（等价于浏览器 document.cookie + reload）
 * 成功返回 true；失败返回 false（并写明日志）
 */
async function solveSafeLine(siteUrl, jar, tag, challengeHtml) {
  const u = new URL(siteUrl);
  const apiHeaders = {
    'user-agent': BROWSER_UA,
    'accept': '*/*',
    'content-type': 'application/json',
    'origin': u.origin,
    'referer': siteUrl
    // 浏览器 issue/verify 请求是 credentials:"omit"，不携带任何 cookie
  };

  // client_id：必须用挑战页内嵌 token（用 sl-session 或随机值会导致 jwt 绑定错误，站点不放行）
  const tokenMatch = typeof challengeHtml === 'string' && challengeHtml.match(/SafeLineChallenge\("([^"]+)"/);
  const clientId = tokenMatch ? tokenMatch[1] : null;
  if (!clientId) {
    debug(`[${tag}] 挑战页中未找到 SafeLineChallenge("token")，无法获取 client_id`);
    return false;
  }

  debug(`[${tag}] issue 请求 client_id=${clientId}`);
  const issue = await http.post('https://challenge.rivers.chaitin.cn/challenge/v2/api/issue',
    { client_id: clientId, level: 1 },   // 注意：level 必须是数字，字符串会被判 invalid request
    { headers: apiHeaders });
  const issueBody = typeof issue.data === 'string' ? safeJson(issue.data) : issue.data;
  if (issue.status !== 200 || !issueBody || issueBody.code !== 200 || !issueBody.data) {
    debug(`[${tag}] issue 失败: ${issue.status} ${JSON.stringify(issueBody).slice(0, 200)}`);
    return false;
  }

  const result = safelineCalc(issueBody.data.data);
  debug(`[${tag}] PoW 计算完成，result 长度 ${result.length}`);

  const client = {
    userAgent: BROWSER_UA,
    platform: 'Win32',
    language: 'zh-CN,zh',
    vendor: 'Google Inc.',
    screen: [1920, 1080],
    visitorId: '',      // 浏览器端指纹加载是异步的，正常通过时往往还是空串
    score: 0,
    target: []
  };
  const verify = await http.post('https://challenge.rivers.chaitin.cn/challenge/v2/api/verify',
    { issue_id: issueBody.data.issue_id, result, serials: [], client },
    { headers: apiHeaders });
  const verifyBody = typeof verify.data === 'string' ? safeJson(verify.data) : verify.data;
  if (verify.status !== 200 || !verifyBody || verifyBody.code !== 200 || !(verifyBody.data && verifyBody.data.verified)) {
    debug(`[${tag}] verify 失败: ${verify.status} ${JSON.stringify(verifyBody).slice(0, 200)}`);
    return false;
  }

  jar.set('sl-challenge-jwt', verifyBody.data.jwt);
  jar.set('sl-challenge-server', 'cloud');
  debug(`[${tag}] 挑战通过，jwt 已写入 cookie 罐（长度 ${verifyBody.data.jwt.length}）`);
  return true;
}

function safeJson(s) { try { return JSON.parse(s); } catch (_) { return null; } }

/* ========= 页面解析（保留 v4 逻辑）========= */
function extractRelevantText(html, keyword) {
  const lines = html.split('\n');
  const relevantLines = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.includes(keyword) || /签到|连续|奖励|魔力|上传|下载|积分|喵饼|table|td/i.test(line)) {
      const start = Math.max(0, i - 2);
      const end = Math.min(lines.length, i + 3);
      relevantLines.push(...lines.slice(start, end));
      i = end;
    }
  }
  return relevantLines.join('\n');
}

function parseAttendanceDetails(html, currencyName = '魔力值') {
  debug('==================== 开始解析签到详情 ====================');
  let continuousDays = null;
  let reward = null;
  let todayReward = null;

  const navMatch = html.match(/\[签到已得(\d+(?:\.\d+)?)[,，]\s*补签卡[：:]\s*(\d+)\]/i);
  if (navMatch) {
    reward = `累计${navMatch[1]}${currencyName}`;
    debug(`✅ 从导航栏匹配到签到信息: 累计${navMatch[1]}${currencyName} (补签卡: ${navMatch[2]})`);
  }

  const patterns = {
    continuous: [
      /连续签到[：:\s]*(\d+)\s*天/i,
      /已连续签到[：:\s]*(\d+)\s*天/i,
      /连续\s*(\d+)\s*天签到/i,
      /(\d+)\s*天连续签到/i,
      /continuous[:\s]*(\d+)\s*day/i,
      /<td[^>]*>连续签到天数<\/td>\s*<td[^>]*>(\d+)/i,
      /<td[^>]*>连续[：:]*<\/td>\s*<td[^>]*>(\d+)/i,
      /连续签到.*?(\d+).*?天/is,
    ],
    todayReward: [
      /今[日天].*?获得[：:\s]*(\d+\.?\d*)\s*(魔力值|积分|喵饼|GB|MB)/i,
      /本次签到.*?[：:\s]*(\d+\.?\d*)\s*(魔力值|积分|喵饼|GB|MB)/i,
      /签到成功.*?[+]\s*(\d+\.?\d*)\s*(魔力值|积分|喵饼)/i,
      /<td[^>]*>今日[签奖].*?<\/td>\s*<td[^>]*>(\d+\.?\d*)\s*(魔力值|积分|喵饼)/i,
    ]
  };

  for (const pattern of patterns.continuous) {
    const match = html.match(pattern);
    if (match && match[1] && parseInt(match[1]) > 0) {
      continuousDays = match[1];
      debug(`✅ 匹配到连续签到天数: ${continuousDays}天`);
      break;
    }
  }

  for (const pattern of patterns.todayReward) {
    const match = html.match(pattern);
    if (match && match[1]) {
      todayReward = `${match[1]}${match[2] || currencyName}`;
      debug(`✅ 匹配到今日奖励: ${todayReward}`);
      break;
    }
  }

  if (!continuousDays) {
    const tableRows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
    for (const row of tableRows) {
      const text = row.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (/连续/i.test(text)) {
        const numMatch = text.match(/(\d+)/);
        if (numMatch && parseInt(numMatch[1]) > 0 && parseInt(numMatch[1]) < 10000) {
          continuousDays = numMatch[1];
          debug(`✅ 从表格行提取到连续天数: ${continuousDays}天`);
          break;
        }
      }
    }
  }

  if (!continuousDays && DEBUG) {
    debug('========== 未找到连续签到天数，输出相关 HTML 片段 ==========');
    debug(extractRelevantText(html, '签到').slice(0, 1500));
    debug('==========================================================');
  }

  if (!continuousDays) debug('⚠️ 未匹配到连续签到天数');
  if (!todayReward && !reward) debug('⚠️ 未匹配到奖励信息');

  debug('==================== 签到详情解析结束 ====================');
  return { continuousDays, reward: todayReward || reward };
}

/* ========= 站点配置 ========= */
const sites = {
  hdkyl: {
    host: 'www.hdkyl.in',
    url: 'https://www.hdkyl.in/attendance.php',
    parseReward: (html) => parseAttendanceDetails(html, '魔力值')
  },
  carpt: {
    host: 'carpt.net',
    url: 'https://carpt.net/attendance.php',
    parseReward: (html) => parseAttendanceDetails(html, '魔力值')
  },
  afun: {
    host: 'www.ptlover.cc',
    url: 'https://www.ptlover.cc/attendance.php',
    parseReward: (html) => parseAttendanceDetails(html, '喵饼')
  }
};
// 允许用 PT_SITE_<KEY>_URL 覆盖站点地址
for (const key of Object.keys(sites)) {
  const over = process.env[`PT_SITE_${key.toUpperCase()}_URL`];
  if (over) sites[key].url = over;
}

/* ========= 推送 ========= */
async function push(title, content) {
  let payload;
  switch (WEBHOOK_TYPE) {
    case 'feishu': payload = { msg_type: 'text', content: { text: `${title}\n${content}` } }; break;
    case 'bark': payload = { title, body: content }; break;
    case 'sct': payload = { title, desp: content }; break;
    case 'ding':
    case 'wx': payload = { msgtype: 'text', text: { content: `${title}\n${content}` } }; break;
    default: payload = { title, content };
  }
  try {
    const { status, data } = await webhookHttp.post(WEBHOOK_URL, payload);
    log(`推送小纸条成功啦！返回码：${status}，内容：${JSON.stringify(data)}`);
  } catch (e) {
    error(`推送小纸条翻车了！错误码：${e.response?.status}，原因：${e.response?.data || e.message}`);
  }
}

/* ========= 失败原因中文解释（v4 的全角句号语法错误已修复）========= */
function getZhReason(msg) {
  if (/Cookie 失效/.test(msg)) return '你的 Cookie 过期啦，需要重新获取';
  if (/雷池|SafeLine|挑战/.test(msg)) return '站点开了雷池 WAF 人机验证，脚本自动挑战未通过，需手动用浏览器访问一次并更新 Cookie（需包含 sl-challenge-jwt）';
  if (/formhash/.test(msg)) return '网站页面结构变了，脚本需要升级';
  if (/接口返回异常/.test(msg)) return '服务器返回内容不对，可能网站升级或维护中';
  if (/Cookie 未配置/.test(msg)) return '没有填写站点 Cookie';
  if (/今日已签到/.test(msg)) return '今日已签到，无需重复打卡';
  if (/签到成功/.test(msg)) return '';
  if (/超时|timeout/i.test(msg)) return '网络请求超时，检查网络或代理';
  if (/403|429/.test(msg)) return '被 WAF 拦截或限流，稍后再试或降低频率';
  return '未知原因，请查看日志详细信息';
}

/* ========= 签到逻辑 ========= */
async function sign(siteKey) {
  const site = sites[siteKey];
  const cookie = process.env[`PT_SITE_${siteKey.toUpperCase()}_CK`]?.trim();
  if (!cookie) {
    const msg = `${siteKey}: ❌ Cookie 没找到，快去面板里补上吧！`;
    error(msg);
    await push('PT 签到失败', msg + '【原因：缺少站点 Cookie，无法模拟你出现在网站上】');
    return { site: siteKey, ok: false, reason: 'Cookie 未配置' };
  }

  log(`${siteKey}：准备开始签到咯！`);

  for (let i = 1; i <= RETRY; i++) {
    // 每次重试用全新 cookie 罐：用户 cookie 打底
    const jar = new CookieJar();
    for (const pair of cookie.split(';')) {
      const idx = pair.indexOf('=');
      if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }

    try {
      /* --- 第 1 步：GET 签到页 --- */
      let resp = await siteGet(site.url, jar);

      /* --- 第 2 步：雷池挑战处理 --- */
      if (SAFELINE && isSafeLineChallenge(resp.data, resp.status)) {
        log(`${siteKey}：检测到雷池 SafeLine 挑战页（HTTP ${resp.status}），正在自动答题...`);
        const solved = await solveSafeLine(site.url, jar, siteKey, resp.data);
        if (solved) {
          resp = await siteGet(site.url, jar);
          if (isSafeLineChallenge(resp.data, resp.status)) {
            throw new Error('雷池挑战已通过但站点未放行：该站可能把验证绑定到浏览器指纹，请用浏览器手动访问一次站点，导出完整 Cookie（需包含 sl-challenge-jwt）后更新 PT_SITE_' + siteKey.toUpperCase() + '_CK');
          }
        } else {
          throw new Error('雷池 SafeLine 自动挑战失败（issue/verify 未通过），站点可能升级了挑战算法');
        }
      }

      if (resp.status === 403 || resp.status === 429) {
        throw new Error(`HTTP ${resp.status}：被 WAF 拦截或限流`);
      }

      const html = typeof resp.data === 'string' ? resp.data : String(resp.data);

      if (DEBUG) {
        debug('========================================');
        debug(`站点: ${siteKey}  状态: ${resp.status}  HTML 长度: ${html.length}`);
        debug(html.slice(0, 3000));
        debug('========================================');
      }

      /* --- 第 3 步：登录态检测（页面内容判断，比 v4 的死代码 302 判断可靠）--- */
      if (/takelogin\.php|name="loginform"|请先登录|您尚未登录/i.test(html) && !/formhash/i.test(html)) {
        throw new Error('Cookie 失效：页面显示未登录状态');
      }

      /* --- 第 4 步：已签到检测 --- */
      if (/今日已签到|签到已得|您今天已经签到|already signed/i.test(html)) {
        log('今天已经打过卡啦，摸摸头~');
        const rewardInfo = site.parseReward ? site.parseReward(html) : {};
        const continuousDays = rewardInfo.continuousDays || null;
        const reward = rewardInfo.reward || null;
        if (!continuousDays && !reward) {
          log(`⚠️ 警告：未能解析到签到信息，请开启调试模式 (PT_DEBUG=1) 查看详情`);
        }
        log(`📊 解析结果 - 连续签到：${continuousDays || '未获取'}天，奖励：${reward || '未获取'}`);
        return { site: siteKey, ok: true, reason: '今日已签到', continuousDays, reward };
      }

      /* --- 第 5 步：提取 formhash（放宽正则）--- */
      const m = html.match(/name=["']formhash["'][^>]*value=["']([a-zA-Z0-9]{6,32})["']/i)
        || html.match(/value=["']([a-zA-Z0-9]{6,32})["'][^>]*name=["']formhash["']/i)
        || html.match(/formhash=([a-zA-Z0-9]{6,32})/i);
      if (!m) throw new Error('页面结构变了，找不到 formhash（网站升级啦？）');
      const formhash = m[1];
      debug(`formhash = ${formhash}`);

      /* --- 第 6 步：POST 签到 --- */
      const params = new URLSearchParams({ action: 'attendance', formhash });
      const post = await sitePost(site.url, jar, params.toString());
      const postText = typeof post.data === 'string' ? post.data : String(post.data);

      if (DEBUG) {
        debug(`POST 状态: ${post.status}（redirected=${post.redirected}）响应长度: ${postText.length}`);
        debug(postText.slice(0, 3000));
      }

      /* --- 第 7 步：分析结果 --- */
      const successInPost = /签到成功|打卡成功|att成功|success/i.test(postText);
      const failInPost = /非法提交|formhash.*错误|签到失败|密码错误|不要重复提交/i.test(postText);

      if (successInPost || post.redirected) {
        // POST 成功后回读签到页拿详细信息
        let rewardInfo = site.parseReward ? site.parseReward(postText) : {};
        if (!rewardInfo.continuousDays && !rewardInfo.reward) {
          debug('POST 响应缺少信息，重新 GET 获取完整数据...');
          try {
            await new Promise(r => setTimeout(r, 1000));
            const refresh = await siteGet(site.url, jar);
            rewardInfo = site.parseReward ? site.parseReward(typeof refresh.data === 'string' ? refresh.data : String(refresh.data)) : {};
          } catch (e) {
            debug(`重新获取失败: ${e.message}`);
          }
        }
        const continuousDays = rewardInfo.continuousDays || null;
        const reward = rewardInfo.reward || null;
        const reason = successInPost ? '签到成功' : '签到成功（302 跳转确认）';
        log(`恭喜你，签到成功！连续签到：${continuousDays || '未获取'}天，获得奖励：${reward || '未获取'}！撒花~`);
        return { site: siteKey, ok: true, reason, continuousDays, reward };
      }

      if (failInPost) {
        throw new Error(`签到接口返回异常：${postText.replace(/<[^>]+>/g, ' ').slice(0, 150)}`);
      }

      // POST 后页面若直接变成"已签到"也算成功
      if (/今日已签到|签到已得/i.test(postText)) {
        const rewardInfo = site.parseReward ? site.parseReward(postText) : {};
        log('签到完成（页面显示已签到）~');
        return { site: siteKey, ok: true, reason: '今日已签到', continuousDays: rewardInfo.continuousDays || null, reward: rewardInfo.reward || null };
      }

      throw new Error(`签到接口返回异常：无法识别响应内容：${postText.replace(/<[^>]+>/g, ' ').slice(0, 120)}`);
    } catch (err) {
      const reason = getZhReason(err.message || String(err));
      error(`[${siteKey}] 第 ${i} 次尝试翻车了：${err.message}【原因：${reason}】`);
      if (i === RETRY) {
        await push('PT 签到失败', `${siteKey}: ❌ ${err.message}【原因：${reason}】`);
        return { site: siteKey, ok: false, reason: err.message || String(err) };
      }
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

/* ========= 主流程 ========= */
(async () => {
  log('可爱的小机器人上线啦，开始为你自动签到！');
  if (DEBUG) log('🔍 调试模式已启用，将输出详细信息');
  if (SAFELINE) log('🛡️ 雷池 SafeLine 自动挑战已启用（PT_SAFELINE=0 可关闭）');
  if (PROXY) log(`检测到代理设置，已启用代理: ${PROXY}`);
  else log('当前未使用代理，直接访问站点。');

  const results = [];
  for (const key of Object.keys(sites)) results.push(await sign(key));

  const summary = results.map(r => {
    if (r.ok) {
      let msg = `${r.site}: ✅ ${r.reason}`;
      if (r.continuousDays) msg += `\n  🎯 连续签到：${r.continuousDays}天`;
      if (r.reward) msg += `\n  🎁 获得奖励：${r.reward}`;
      return msg;
    }
    return `${r.site}: ❌ 签到失败（原因：${getZhReason(r.reason)}）`;
  }).join('\n\n');

  log('\n===== 签到汇总 =====\n' + summary);
  await push('PT 签到结果', summary);
  log('全部任务完成，准备打个盹，明天见！');
})();
