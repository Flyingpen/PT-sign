/**
 * PT 签到 v3 趣味防护增强版
 * 环境变量：
 *   PT_SITE_<SITE>_CK     必须，对应站点 cookie
 *   PT_WEBHOOK_URL        必须，推送地址
 *   PT_WEBHOOK_TYPE       feishu | bark | sct | ding | wx | custom，默认 custom
 *   PT_PROXY              可选
 *   PT_RETRY              重试次数，默认 3
 *   PT_WAF_BYPASS         可选，开启 WAF 绕过机制
 *   PT_EXTRA_HEADERS      可选，额外自定义 header，格式：key1:value1|key2:value2
 */

const axios = require('axios');
const HttpsProxyAgent = require('https-proxy-agent');

const RETRY = Number(process.env.PT_RETRY) || 3;
const PROXY = process.env.PT_PROXY || null;
const WEBHOOK_URL = process.env.PT_WEBHOOK_URL;
const WEBHOOK_TYPE = (process.env.PT_WEBHOOK_TYPE || 'custom').toLowerCase();
const WAF_BYPASS = !!process.env.PT_WAF_BYPASS;
const EXTRA_HEADERS = process.env.PT_EXTRA_HEADERS || '';

if (!WEBHOOK_URL) throw new Error('❌ 未配置 PT_WEBHOOK_URL，快去补上推送地址吧！');

const httpConfig = {
  timeout: 15000,
};
if (PROXY) {
  httpConfig.httpsAgent = new HttpsProxyAgent.HttpsProxyAgent(PROXY);
}
const http = axios.create(httpConfig);

// 趣味化日志输出
function log(msg) {
  console.log(`[小可爱签到机] ${msg}`);
}
function error(msg) {
  console.error(`[小可爱签到机] ${msg}`);
}

// 随机 UA 列表（模拟不同浏览器/设备）
const UA_LIST = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15',
  'Mozilla/5.0 (Linux; Android 11; Mi 9T Pro) AppleWebKit/537.36',
  'Mozilla/5.0 (iPad; CPU OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15',
];

// 随机 IP 生成（伪造 X-Forwarded-For）
function randomIP() {
  return Array(4).fill(0).map(() => Math.floor(Math.random() * 254) + 1).join('.');
}

// 解析自定义 header
function getExtraHeaders() {
  const headers = {};
  if (EXTRA_HEADERS) {
    EXTRA_HEADERS.split('|').forEach(pair => {
      const [k, v] = pair.split(':');
      if (k && v) headers[k.trim()] = v.trim();
    });
  }
  return headers;
}

function randomHeaders(siteKey) {
  const headers = {
    'user-agent': UA_LIST[Math.floor(Math.random() * UA_LIST.length)],
    'referer': `https://${sites[siteKey].host}/`,
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'accept-encoding': 'gzip, deflate, br',
    'x-forwarded-for': randomIP(),
    'x-real-ip': randomIP(),
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'same-origin',
    ...getExtraHeaders()
  };
  return headers;
}

const sites = {
  hdkyl: {
    host: 'www.hdkyl.in',
    url: 'https://www.hdkyl.in/attendance.php',
    // 站点特定的解析规则
    parseReward: (html) => {
      // 示例匹配规则：连续签到3天，获得100魔力值
      const continuousMatch = html.match(/连续签到(\d+)天/);
      const rewardMatch = html.match(/获得(\d+)([^\s<]+)/);
      
      return {
        continuousDays: continuousMatch ? continuousMatch[1] : null,
        reward: rewardMatch ? `${rewardMatch[1]}${rewardMatch[2]}` : null
      };
    }
  },
  carpt: {
    host: 'carpt.net',
    url: 'https://carpt.net/attendance.php',
    parseReward: (html) => {
      // 示例匹配规则：已连续签到5天，奖励：上传量 10GB
      const continuousMatch = html.match(/已连续签到(\d+)天/);
      const rewardMatch = html.match(/奖励[：:]\s*([^\s<]+)/);
      
      return {
        continuousDays: continuousMatch ? continuousMatch[1] : null,
        reward: rewardMatch ? rewardMatch[1] : null
      };
    }
  },
  afun: {
    host: 'www.ptlover.cc',
    url: 'https://www.ptlover.cc/attendance.php',
    parseReward: (html) => {
      // 示例匹配规则：已连续签到5天，奖励：上传量 10GB
      const continuousMatch = html.match(/已连续签到(\d+)天/);
      const rewardMatch = html.match(/奖励[：:]\s*([^\s<]+)/);
      
      return {
        continuousDays: continuousMatch ? continuousMatch[1] : null,
        reward: rewardMatch ? rewardMatch[1] : null
      };
    }
  }
};

/* ========= 推送函数：全局唯一 ========= */
async function push(title, content) {
  let payload;
  switch (WEBHOOK_TYPE) {
    case 'feishu':
      payload = { msg_type: 'text', content: { text: `${title}\n${content}` } };
      break;
    case 'bark':
      payload = { title, body: content };
      break;
    case 'sct':
      payload = { title, desp: content };
      break;
    case 'ding':
      payload = { msgtype: 'text', text: { content: `${title}\n${content}` } };
      break;
    case 'wx':
      payload = { msgtype: 'text', text: { content: `${title}\n${content}` } };
      break;
    default:
      payload = { title, content };
  }
  try {
    const { status, data } = await http.post(WEBHOOK_URL, payload, { timeout: 5000 });
    log(`推送小纸条成功啦！返回码：${status}，内容：${JSON.stringify(data)}`);
  } catch (e) {
    error(`推送小纸条翻车了！错误码：${e.response?.status}，原因：${e.response?.data || e.message}`);
  }
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

  let headers = { cookie, ...randomHeaders(siteKey) };
  log(`${siteKey}：准备开始签到咯！`);

  for (let i = 1; i <= RETRY; i++) {
    if (WAF_BYPASS) {
      // WAF 绕过策略：请求前休眠随机 2~5 秒
      let delay = Math.floor(5000 + Math.random() * 30000);
      log(`正在悄悄等待 ${delay / 1000} 秒，避开雷池小雷达...`);
      await new Promise(r => setTimeout(r, delay));
      // 可随机 content-type
      if (i === 1) headers['content-type'] = ['application/x-www-form-urlencoded', 'application/json'][Math.floor(Math.random() * 2)];
    }

    try {
      const { status, headers: respHeaders, data: html } = await http.get(site.url, { headers });

      if (status === 302 || status === 301) {
        const loc = respHeaders.location || '';
        if (/login\.php|takelogin\.php/i.test(loc)) {
          throw new Error('Cookie 失效，被重定向到登录页');
        }
      }

      if (/今日已签到|签到已得|already signed/i.test(html)) {
        // 尝试解析连续签到信息
        const rewardInfo = site.parseReward ? site.parseReward(html) : {};
        const continuousDays = rewardInfo.continuousDays || '未知';
        const reward = rewardInfo.reward || '未知';
        
        log(`今天已经打过卡啦，摸摸头~（连续签到：${continuousDays}天，奖励：${reward}）`);
        return { 
          site: siteKey, 
          ok: true, 
          reason: '今日已签到',
          continuousDays,
          reward
        };
      }

      const m = html.match(/name="formhash"\s+value="([a-f0-9]{32})"/i);
      if (!m) throw new Error('页面结构变了，找不到 formhash（网站升级啦？）');

      const formhash = m[1];
      const params = new URLSearchParams({ action: 'attendance', formhash });

      // POST 签到
      const postHeaders = { ...headers, 'content-type': 'application/x-www-form-urlencoded' };
      if (WAF_BYPASS) {
        // content-type 伪装
        postHeaders['content-type'] = ['application/x-www-form-urlencoded', 'application/json'][Math.floor(Math.random() * 2)];
        postHeaders['x-forwarded-for'] = randomIP();
        postHeaders['x-real-ip'] = randomIP();
      }

      const { status: st2, data: d2 } = await http.post(site.url, params.toString(), { headers: postHeaders });

      if (d2.includes('成功') || d2.includes('success') || st2 === 302) {
        // 尝试解析奖励信息
        const rewardInfo = site.parseReward ? site.parseReward(d2) : {};
        const continuousDays = rewardInfo.continuousDays || '未知';
        const reward = rewardInfo.reward || '未知';
        
        log(`恭喜你，签到成功！连续签到：${continuousDays}天，获得奖励：${reward}！撒花~`);
        return { 
          site: siteKey, 
          ok: true, 
          reason: '签到成功',
          continuousDays,
          reward
        };
      }
      throw new Error(`签到接口返回异常：${d2.slice(0, 150)}`);
    } catch (err) {
      error(`[${siteKey}] 第 ${i} 次尝试翻车了：${err.message}【原因：${getZhReason(err.message)}】`);
      if (i === RETRY) {
        const msg = `${siteKey}: ❌ ${err。message}【原因：${getZhReason(err。message)}】`;
        await push('PT 签到失败', msg);
        return { site: siteKey, ok: false， reason: err。message };
      }
      await new Promise(r => setTimeout(r， 3000));
    }
  }
}

// BUG 原因中文解释
function getZhReason(msg) {
  if (/Cookie 失效/。test(msg)) return '你的 Cookie 过期啦，需要重新获取';
  if (/formhash/。test(msg)) return '网站页面结构变了，脚本需要升级';
  if (/接口返回异常/.test(msg)) return '服务器返回内容不对，可能网站升级或维护中';
  if (/Cookie 未配置/.test(msg)) return '没有填写站点 Cookie';
  if (/今日已签到/。test(msg)) return '今日已签到，无需重复打卡';
  if (/签到成功/.test(msg)) return '';
  return '未知原因，请查看日志详细信息';
}

/* ========= 主流程 ========= */
(async () => {
  log('可爱的小机器人上线啦，开始为你自动签到！');
  if (PROXY) {
    log(`检测到代理设置，已启用代理: ${PROXY}`);
  } else {
    log('当前未使用代理，直接访问站点。');
  }
  const results = [];
  for (const key of Object.keys(sites)) results.push(await sign(key));

  // 生成包含奖励信息的汇总报告
  const summary = results.map(r => {
    if (r.ok) {
      let msg = `${r.site}: ✅ ${r.reason}`;
      if (r.continuousDays) msg += `\n  🎯 连续签到：${r.continuousDays}天`;
      if (r.reward) msg += `\n  🎁 获得奖励：${r.reward}`;
      return msg;
    } else {
      return `${r.site}: ❌ 签到失败（原因：${getZhReason(r.reason)}）`;
    }
  }).join('\n\n');

  log('\n===== 签到汇总 =====\n' + summary);
  await push('PT 签到结果', summary);
  log('全部任务完成，准备打个盹，明天见！');
})();
