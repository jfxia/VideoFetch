/**
 * test-referer.mjs — 防盗链 Referer 的决策逻辑
 *
 * 用假 fetch 模拟两种站点：只有带「来源站 Referer」才回 206，否则 403。
 * 覆盖：DNR 规则生效 / DNR 装上但不生效 / 同源 / 无页面地址 / 取消后清理。
 */
import assert from 'node:assert';

let pass = 0;
let fail = 0;
function ok(cond, name, extra) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    console.log('  ✗ ' + name + (extra ? '  [' + extra + ']' : ''));
  }
}

const PAGE = 'https://duanju.one/drama/5sisterwithme-hq-ADVYPTTK';
const ORIGIN_REF = 'https://duanju.one/';
const VIDEO = 'https://cdn.duanju.one/2026/10/x/ep-001.mp4?v=abc';

/* ---------------- chrome 桩 ---------------- */
const rules = new Map();
const sessions = new Map();
const messageListeners = [];
let dnrWorks = true;
const removed = [];
const started = [];

globalThis.chrome = {
  runtime: {
    id: 'abcdefghijklmnopabcdefghijklmnop',
    getURL: (p) => 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/' + p,
    onMessage: { addListener: (fn) => messageListeners.push(fn) },
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} },
    sendMessage: async (msg) => {
      if (msg && msg.type === 'start') started.push(msg.task);
      return { ok: true };
    },
    getContexts: async () => [{ contextType: 'OFFSCREEN_DOCUMENT' }]
  },
  storage: {
    session: {
      get: async () => ({}),
      set: async () => {},
      remove: async () => {},
      setAccessLevel: async () => {}
    },
    local: { get: async () => ({}), set: async () => {} }
  },
  tabs: {
    query: async () => [],
    get: async (id) => ({ id, title: '' }),
    onRemoved: { addListener: () => {} },
    onUpdated: { addListener: () => {} },
    sendMessage: async () => ({ ok: true })
  },
  offscreen: { createDocument: async () => {}, hasDocument: async () => true },
  downloads: { download: async () => 1 },
  webRequest: { onHeadersReceived: { addListener: () => {} } },
  declarativeNetRequest: {
    updateSessionRules: async ({ addRules, removeRuleIds }) => {
      for (const id of removeRuleIds || []) {
        rules.delete(id);
        removed.push(id);
      }
      for (const r of addRules || []) {
        // tabIds 只在会话规则里合法；这里不过滤，直接收下
        rules.set(r.id, r);
      }
    }
  }
};

/* ---------------- fetch 桩 ---------------- */
const fetchLog = [];
globalThis.fetch = async (url, init = {}) => {
  if (String(url).startsWith('http://127.0.0.1') || String(url).includes('/log')) {
    return { ok: true, status: 200, text: async () => '' };
  }
  const useUrl = String(url);
  const dnr =
    dnrWorks &&
    [...rules.values()].some((r) => {
      const prefix = r.condition.urlFilter.replace(/^\|/, '');
      if (!useUrl.startsWith(prefix)) return false;
      if (r.condition.tabIds && !r.condition.tabIds.includes(-1)) return false;
      if (r.condition.initiatorDomains && !r.condition.initiatorDomains.includes(chrome.runtime.id)) return false;
      return true;
    });
  const viaOption = init.referrer === ORIGIN_REF;
  fetchLog.push({ url: useUrl, referrer: init.referrer || '', dnr });
  if (dnr || viaOption) return { ok: true, status: 206 };
  return { ok: false, status: 403 };
};

await import('../background/service-worker.js');

function fireMsg(msg, sender = {}) {
  return new Promise((resolve) => {
    let done = false;
    const sendResponse = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    for (const fn of messageListeners) {
      const r = fn(msg, sender, sendResponse);
      if (r !== true && !done) {
        done = true;
        resolve(undefined);
      }
    }
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 用例 ---------------- */

console.log('[1] 跨站直链：装上 DNR 规则并确认生效');
{
  const r = await fireMsg({
    target: 'sw', type: 'start', kind: 'file', url: VIDEO, title: 'ep1', pageUrl: PAGE, tabId: 7
  });
  await sleep(30);
  ok(r && r.ok, 'start 返回成功');
  ok(r.task.refererMode === 'dnr', '模式为 dnr', r.task && r.task.refererMode);
  ok(r.task.referer === 'https://duanju.one/', 'Referer 取源站 origin', r.task && r.task.referer);
  const rule = [...rules.values()][0];
  ok(!!rule, '会话规则已安装');
  ok(rule && rule.action.requestHeaders[0].value === ORIGIN_REF, '规则里写了 Referer');
  ok(rule && Array.isArray(rule.condition.tabIds) && rule.condition.tabIds[0] === -1, '只覆盖非标签页请求');
  ok(rule && rule.condition.urlFilter === '|https://cdn.duanju.one/', '规则只作用于该 CDN', rule && rule.condition.urlFilter);
  ok(!rule.action.requestHeaders.some((h) => h.header === 'origin'), '不去动 Origin（会被拒）');
  ok(started.length === 1 && started[0].refererMode === 'dnr', '模式随任务传给引擎');
}

console.log('\n[2] DNR 装上但不生效：退回 fetch 的 referrer 选项');
{
  rules.clear();
  dnrWorks = false;
  fetchLog.length = 0;
  const r = await fireMsg({
    target: 'sw', type: 'start', kind: 'file', url: VIDEO, title: 'ep1', pageUrl: PAGE, tabId: 7
  });
  await sleep(30);
  ok(r.task.refererMode === 'referrer', '模式降级为 referrer', r.task && r.task.refererMode);
  ok(rules.size === 0, '失败规则已撤掉', 'left=' + rules.size);
  ok(fetchLog.some((f) => f.referrer === ORIGIN_REF), '最后一次探测带上了 referrer 选项');
  dnrWorks = true;
}

console.log('\n[3] 同源：不需要额外处理');
{
  rules.clear();
  const r = await fireMsg({
    target: 'sw', type: 'start', kind: 'file',
    url: 'https://duanju.one/media/ep1.mp4', title: 'ep1', pageUrl: PAGE, tabId: 7
  });
  await sleep(20);
  ok(r.task.refererMode === 'same-origin', '模式为 same-origin', r.task && r.task.refererMode);
  ok(rules.size === 0, '没有多余规则');
}

console.log('\n[4] 没有页面地址：不折腾');
{
  rules.clear();
  const r = await fireMsg({
    target: 'sw', type: 'start', kind: 'file', url: VIDEO, title: 'ep1', pageUrl: '', tabId: 7
  });
  await sleep(20);
  ok(r.task.refererMode === 'none', '模式为 none', r.task && r.task.refererMode);
  ok(rules.size === 0, '没有安装规则');
}

console.log('\n[5] 分片在别的主机：补规则，取消时一起清掉');
{
  rules.clear();
  const r = await fireMsg({
    target: 'sw', type: 'start', kind: 'hls', url: 'https://api.example.com/pl/master.m3u8',
    title: 'hls', pageUrl: PAGE, tabId: 7
  });
  await sleep(30);
  ok(r.task.refererMode === 'dnr', '主规则已装', r.task && r.task.refererMode);
  const seg = 'https://seg.other-cdn.net/2026/ep1-001.m4s';
  const a = await fireMsg({ target: 'sw', type: 'arm-referer', taskId: r.task.id, url: seg, referer: ORIGIN_REF });
  await sleep(20);
  ok(a && a.ok, 'arm-referer 成功');
  ok(rules.size === 2, '分片主机多了一条规则', 'rules=' + rules.size);
  const segRule = [...rules.values()].find((x) => x.condition.urlFilter.includes('seg.other-cdn.net'));
  ok(!!segRule && segRule.action.requestHeaders[0].value === ORIGIN_REF, '分片规则写了同一个 Referer');
  await fireMsg({ target: 'sw', type: 'cancel', taskId: r.task.id });
  await sleep(20);
  ok(rules.size === 0, '两条规则一起清理', 'left=' + rules.size);
}

console.log('\n[6] 取消任务要顺手把规则撤掉');
{
  rules.clear();
  const r = await fireMsg({
    target: 'sw', type: 'start', kind: 'file', url: VIDEO, title: 'ep1', pageUrl: PAGE, tabId: 7
  });
  await sleep(30);
  ok(rules.size === 1, '先确认规则在');
  await fireMsg({ target: 'sw', type: 'cancel', taskId: r.task.id });
  await sleep(20);
  ok(rules.size === 0, '取消后规则已清理', 'left=' + rules.size);
}

console.log('\n========== ' + (fail ? 'FAILED' : 'PASSED') + ' ' + pass + '/' + (pass + fail) + ' ==========');
process.exit(fail ? 1 : 0);
