/**
 * PT 签到 v4 完整信息版
 * 环境变量：
 *   PT_SITE_<SITE>_CK     必须，对应站点 cookie
 *   PT_WEBHOOK_URL        必须，推送地址
 *   PT_WEBHOOK_TYPE       feishu | bark | sct | ding | wx | custom，默认 custom
 *   PT_PROXY              可选
 *   PT_RETRY              重试次数，默认 3
 *   PT_WAF_BYPASS         可选，开启 WAF 绕过机制
 *   PT_EXTRA_HEADERS      可选，额外自定义 header，格式：key1:value1|key2:value2
 *   PT_DEBUG              可选，开启调试模式，输出 HTML 内容
 */

const axios = require('axios');
const HttpsProxyAgent = require('https-proxy-agent');

const RETRY = Number(process.env.PT_RETRY) || 3;
const PROXY = process.env.PT_PROXY || null;
const WEBHOOK_URL = process.env.PT_WEBHOOK_URL;
const WEBHOOK_TYPE = (process.env.PT_WEBHOOK_TYPE || 'custom').toLowerCase();
const WAF_BYPASS = !!process.env.PT_WAF_BYPASS;
const EXTRA_HEADERS = process.env.PT_EXTRA_HEADERS || '';
const DEBUG = !!process.env.PT_DEBUG;

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
function debug(msg) {
  console.log(`[🔍调试] ${msg}`);
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

// 智能提取文本片段（用于调试）
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

// 通用解析函数：解析签到页面的详细信息
function parseAttendanceDetails(html, currencyName = '魔力值') {
  debug('==================== 开始解析签到详情 ====================');
  
  let continuousDays = null;
  let reward = null;
  let todayReward = null;
  
  // 1. 从导航栏提取累计签到次数
  const navMatch = html.match(/\[签到已得(\d+(?:\.\d+)?)[,，]\s*补签卡[：:]\s*(\d+)\]/i);
  if (navMatch) {
    reward = `累计${navMatch[1]}${currencyName}`;
    debug(`✅ 从导航栏匹配到签到信息: 累计${navMatch[1]}${currencyName} (补签卡: ${navMatch[2]})`);
  }
  
  // 2. 尝试从页面主体内容提取连续签到天数
  const patterns = {
    continuous: [
      // 各种可能的连续签到格式
      /连续签到[：:\s]*(\d+)\s*天/i,
      /已连续签到[：:\s]*(\d+)\s*天/i,
      /连续\s*(\d+)\s*天签到/i,
      /(\d+)\s*天连续签到/i,
      /continuous[:\s]*(\d+)\s*day/i,
      // 表格中的格式
      /<td[^>]*>连续签到天数<\/td>\s*<td[^>]*>(\d+)/i,
      /<td[^>]*>连续[：:]*<\/td>\s*<td[^>]*>(\d+)/i,
      /连续签到.*?(\d+).*?天/is,
    ],
    todayReward: [
      // 今日签到奖励
      /今[日天].*?获得[：:\s]*(\d+\.?\d*)\s*(魔力值|积分|喵饼|GB|MB)/i,
      /本次签到.*?[：:\s]*(\d+\.?\d*)\s*(魔力值|积分|喵饼|GB|MB)/i,
      /签到成功.*?[+]\s*(\d+\.?\d*)\s*(魔力值|积分|喵饼)/i,
      /<td[^>]*>今日[签奖].*?<\/td>\s*<td[^>]*>(\d+\.?\d*)\s*(魔力值|积分|喵饼)/i,
    ]
  };
  
  // 匹配连续签到天数
  for (const pattern of patterns.continuous) {
    const match = html.match(pattern);
    if (match && match[1] && parseInt(match[1]) > 0) {
      continuousDays = match[1];
      debug(`✅ 匹配到连续签到天数: ${continuousDays}天 (规则: ${pattern})`);
      break;
    }
  }
  
  // 匹配今日奖励
  for (const pattern of patterns.todayReward) {
    const match = html.match(pattern);
    if (match && match[1]) {
      todayReward = `${match[1]}${match[2] || currencyName}`;
      debug(`✅ 匹配到今日奖励: ${todayReward} (规则: ${pattern})`);
      break;
    }
  }
  
  // 3. 如果找不到连续天数，尝试从表格行中提取
  if (!continuousDays) {
    debug('尝试从 HTML 表格中提取连续签到信息...');
    
    // 提取所有 <tr> 标签内容
    const tableRows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
    for (const row of tableRows) {
      // 清理 HTML 标签，保留文本
      const text = row.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      debug(`表格行内容: ${text.slice(0, 100)}`);
      
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
  
  // 4. 如果还是找不到，输出完整的签到相关内容供分析
  if (!continuousDays && DEBUG) {
    debug('========== 未找到连续签到天数，输出相关 HTML 片段 ==========');
    const relevantText = extractRelevantText(html, '签到');
    debug(relevantText.slice(0, 1500));
    debug('==========================================================');
  }
  
  if (!continuousDays) debug('⚠️ 未匹配到连续签到天数');
  if (!todayReward && !reward) debug('⚠️ 未匹配到奖励信息');
  
  debug('==================== 签到详情解析结束 ====================');
  
  return { 
    continuousDays, 
    reward: todayReward || reward // 优先显示今日奖励，其次是累计奖励
  };
}

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
      let delay = Math.floor(5000 + Math.random() * 30000);
      log(`正在悄悄等待 ${delay / 1000} 秒，避开雷池小雷达...`);
      await new Promise(r => setTimeout(r, delay));
      if (i === 1) headers['content-type'] = ['application/x-www-form-urlencoded', 'application/json'][Math.floor(Math.random() * 2)];
    }

    try {
      const { status, headers: respHeaders, data: html } = await http.get(site.url, { headers });

      if (DEBUG) {
        debug('========================================');
        debug(`站点: ${siteKey}`);
        debug('完整 HTML 长度: ' + html.length + ' 字符');
        debug('前 3000 字符:');
        debug(html.slice(0, 3000));
        debug('========================================');
      }

      if (status === 302 || status === 301) {
        const loc = respHeaders.location || '';
        if (/login\.php|takelogin\.php/i.test(loc)) {
          throw new Error('Cookie 失效，被重定向到登录页');
        }
      }

      // 检查是否已签到
      if (/今日已签到|签到已得|already signed/i.test(html)) {
        log(`今天已经打过卡啦，摸摸头~`);
        
        // 解析奖励信息
        const rewardInfo = site.parseReward ? site.parseReward(html) : {};
        const continuousDays = rewardInfo.continuousDays || null;
        const reward = rewardInfo.reward || null;
        
        if (!continuousDays && !reward) {
          log(`⚠️ 警告：未能解析到签到信息，请开启调试模式 (PT_DEBUG=1) 查看详情`);
        }
        
        log(`📊 解析结果 - 连续签到：${continuousDays || '未获取'}天，奖励：${reward || '未获取'}`);
        
        return { 
          site: siteKey, 
          ok: true, 
          reason: '今日已签到',
          continuousDays,
          reward
        };
      }

      // 提取 formhash
      const m = html.match(/name="formhash"\s+value="([a-f0-9]{32})"/i);
      if (!m) throw new Error('页面结构变了，找不到 formhash（网站升级啦？）');

      const formhash = m[1];
      const params = new URLSearchParams({ action: 'attendance', formhash });

      // POST 签到
      const postHeaders = { ...headers, 'content-type': 'application/x-www-form-urlencoded' };
      if (WAF_BYPASS) {
        postHeaders['content-type'] = ['application/x-www-form-urlencoded', 'application/json'][Math.floor(Math.random() * 2)];
        postHeaders['x-forwarded-for'] = randomIP();
        postHeaders['x-real-ip'] = randomIP();
      }

      const { status: st2, data: d2 } = await http.post(site.url, params.toString(), { headers: postHeaders });

      if (DEBUG) {
        debug('POST 响应长度: ' + d2.length + ' 字符');
        debug('前 3000 字符:');
        debug(d2.slice(0, 3000));
      }

      if (d2.includes('成功') || d2.includes('success') || st2 === 302) {
        // 尝试从 POST 响应解析
        let rewardInfo = site.parseReward ? site.parseReward(d2) : {};
        
        // 如果 POST 响应没有信息，重新 GET 一次获取完整信息
        if (!rewardInfo.continuousDays || !rewardInfo.reward) {
          debug('POST 响应缺少信息，重新 GET 获取完整数据...');
          try {
            await new Promise(r => setTimeout(r, 1000));
            const { data: refreshHtml } = await http.get(site.url, { headers });
            rewardInfo = site.parseReward ? site.parseReward(refreshHtml) : {};
          } catch (e) {
            debug(`重新获取失败: ${e.message}`);
          }
        }
        
        const continuousDays = rewardInfo.continuousDays || null;
        const reward = rewardInfo.reward || null;
        
        log(`恭喜你，签到成功！连续签到：${continuousDays || '未获取'}天，获得奖励：${reward || '未获取'}！撒花~`);
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
        const msg = `${siteKey}: ❌ ${err.message}【原因：${getZhReason(err.message)}】`;
        await push('PT 签到失败', msg);
        return { site: siteKey, ok: false, reason: err.message };
      }
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

// BUG 原因中文解释
function getZhReason(msg) {
  if (/Cookie 失效/.test(msg)) return '你的 Cookie 过期啦，需要重新获取';
  if (/formhash/。test(msg)) return '网站页面结构变了，脚本需要升级';
  if (/接口返回异常/。test(msg)) return '服务器返回内容不对，可能网站升级或维护中';
  if (/Cookie 未配置/。test(msg)) return '没有填写站点 Cookie';
  if (/今日已签到/。test(msg)) return '今日已签到，无需重复打卡';
  if (/签到成功/。test(msg)) return '';
  return '未知原因，请查看日志详细信息';
}

/* ========= 主流程 ========= */
(async () => {
  log('可爱的小机器人上线啦，开始为你自动签到！');
  if (DEBUG) log('🔍 调试模式已启用，将输出详细信息');
  if (PROXY) {
    log(`检测到代理设置，已启用代理: ${PROXY}`);
  } else {
    log('当前未使用代理，直接访问站点。');
  }
  
  if (!DEBUG) {
    log('💡 提示：如需查看详细的 HTML 内容和匹配过程，请设置环境变量 PT_DEBUG=1');
  }
  
  const results = [];
  for (const key of Object.keys(sites)) results.push(await sign(key));

  // 生成包含奖励信息的汇总报告
  const summary = results.map(r => {
    if (r.ok) {
      let msg = `${r.site}: ✅ ${r.reason}`;
      if (r.continuousDays) {
        msg += `\n  🎯 连续签到：${r.continuousDays}天`;
      }
      if (r.reward) {
        msg += `\n  🎁 获得奖励：${r.reward}`;
      }
      return msg;
    } else {
      return `${r.site}: ❌ 签到失败（原因：${getZhReason(r.reason)}）`;
    }
  }).join('\n\n');

  log('\n===== 签到汇总 =====\n' + summary);
  await push('PT 签到结果', summary);
  log('全部任务完成，准备打个盹，明天见！');
})();
