// ============================================================
// VRChat 视频解析器 - 后台 Service Worker
// 功能：
//  1. 通过 webRequest 嗅探网络中的视频流（MP4/WebM/M3U8/FLV 等，含直播流）
//  2. 接收页面/弹窗发来的记录消息，按标签页存储到 storage.session
//  3. 为 Bilibili 解析提供后台兜底请求（可携带登录 Cookie）
//  4. 缓存 B 站分P列表（供弹窗渲染分P面板）
// ============================================================

const MEDIA_URL_RE = /\.(mp4|webm|m3u8|mkv|flv|mov|ogv)(\?|#|$)/i;
const MAX_PER_TAB = 120;

const keyOf = (tabId) => `videos_${tabId}`;
const pagesKeyOf = (tabId) => `pages_${tabId}`;

// 直播流去重键：CDN 会不断换签名参数刷新同一个流，按「域名 + 路径」归一
function streamKeyOf(url) {
  try {
    const u = new URL(String(url || ''));
    if (!/\.(flv|m3u8)$/i.test(u.pathname)) return '';
    return `${u.origin}${u.pathname}`;
  } catch (e) {
    return '';
  }
}

// 每个标签页串行化写入，避免并发覆盖
const writeChains = {};

async function doRecord(tabId, url, mime, source, extra) {
  if (!url || tabId == null || tabId < 0) return;
  if (/^(blob|data):/i.test(url)) return;
  const k = keyOf(tabId);
  let list = [];
  try {
    list = (await chrome.storage.session.get(k))[k] || [];
  } catch (e) {
    list = [];
  }
  const group = (extra && extra.group) || '';
  const node = (extra && extra.node) || '';
  // 同一视频的同一节点只保留最新链接（重复扫描会拿到新签名，避免刷屏）
  if (group && node) {
    list = list.filter((v) => !(v.group === group && v.node === node));
  }
  list = list.filter((v) => v.url !== url);
  // 直播流：同一个流只留最新一条（签名参数每次都换，但域名+路径不变）
  const sk = streamKeyOf(url);
  if (sk) list = list.filter((v) => streamKeyOf(v.url) !== sk);
  list.unshift({
    url,
    mime: mime || '',
    source: source || 'network',
    time: Date.now(),
    href: (extra && extra.href) || '',
    quality: (extra && extra.quality) || '',
    expires: (extra && extra.expires) || 0,
    group: (extra && extra.group) || '',
    node: (extra && extra.node) || '',
    part: (extra && extra.part) || '',
    live: !!(extra && extra.live),
  });
  if (list.length > MAX_PER_TAB) list.length = MAX_PER_TAB;
  try {
    await chrome.storage.session.set({ [k]: list });
  } catch (e) {
    // 存储失败不阻塞主流程
  }
}

function record(tabId, url, mime, source, extra) {
  const k = keyOf(tabId);
  const prev = writeChains[k] || Promise.resolve();
  const next = prev
    .then(() => doRecord(tabId, url, mime, source, extra))
    .catch(() => {});
  writeChains[k] = next;
  return next;
}

// ---------- 网络嗅探 ----------
chrome.webRequest.onResponseStarted.addListener(
  (details) => {
    if (details.tabId < 0) return;
    let ct = '';
    try {
      const h = (details.responseHeaders || []).find(
        (x) => String(x.name || '').toLowerCase() === 'content-type'
      );
      ct = h && h.value ? String(h.value) : '';
    } catch (e) {
      ct = '';
    }
    // HLS 的 .ts / DASH 的 .m4s 分片（每个只有几秒）一律不记录
    if (/\.(ts|m4s)(\?|#|$)/i.test(details.url) || /^video\/mp2t/i.test(ct)) return;
    const isVideoMime = /^video\//i.test(ct) || /x-flv/i.test(ct);
    const isHlsMime = /^application\/(vnd\.apple\.mpegurl|x-mpegurl)/i.test(ct);
    const isMediaExt = MEDIA_URL_RE.test(details.url);
    // 注意：.m4s/.ts 等 DASH/HLS 分片（每个只有几秒）已过滤，只保留整段媒体
    if (isVideoMime || isHlsMime || isMediaExt) {
      record(details.tabId, details.url, ct, 'network', {});
    }
  },
  {
    urls: ['http://*/*', 'https://*/*'],
    types: ['media', 'xmlhttprequest', 'other', 'main_frame', 'sub_frame'],
  }
);

// ---------- Bilibili 后台兜底请求 ----------
async function biliCookieHeader() {
  try {
    const cookies = (await chrome.cookies.getAll({ domain: '.bilibili.com' })) || [];
    const parts = cookies.map((c) => `${c.name}=${c.value}`);
    // 参考 bilibili-parse：补上画质/风控提示 Cookie，帮助接口按请求画质返回。
    // 真正的登录态由上面的真实 Cookie（SESSDATA）提供，未登录只能拿到 480P 以下。
    const names = new Set(cookies.map((c) => c.name));
    if (!names.has('CURRENT_QUALITY')) parts.push('CURRENT_QUALITY=80');
    if (!names.has('CURRENT_FNVAL')) parts.push('CURRENT_FNVAL=80');
    if (!names.has('CURRENT_BLACKGAP')) parts.push('CURRENT_BLACKGAP=1');
    return parts.join('; ');
  } catch (e) {
    return '';
  }
}

// ---------- 消息处理 ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'RECORD') {
    const tabId = sender && sender.tab ? sender.tab.id : null;
    record(tabId, msg.url, msg.mime || '', msg.source || 'page', {
      href: msg.href || '',
      quality: msg.quality || '',
      expires: msg.expires || 0,
      group: msg.group || '',
      node: msg.node || '',
      part: msg.part || '',
      live: !!msg.live,
    }).then(() => {
      try {
        sendResponse({ ok: true });
      } catch (e) {}
    });
    return true;
  }

  // ---------- B 站分P列表缓存（内容脚本上报 → 弹窗读取） ----------
  if (msg.type === 'PAGES') {
    const tabId = sender && sender.tab ? sender.tab.id : null;
    if (tabId == null || tabId < 0) return;
    const payload = {
      title: msg.title || '',
      bvid: msg.bvid || '',
      href: msg.href || '',
      current: msg.current || 1,
      pages: Array.isArray(msg.pages) ? msg.pages : [],
      time: Date.now(),
    };
    chrome.storage.session
      .set({ [pagesKeyOf(tabId)]: payload })
      .then(() => {
        try {
          sendResponse({ ok: true });
        } catch (e) {}
      })
      .catch(() => {
        try {
          sendResponse({ ok: false });
        } catch (e) {}
      });
    return true;
  }

  if (msg.type === 'GET_PAGES') {
    (async () => {
      let pages = null;
      try {
        pages = (await chrome.storage.session.get(pagesKeyOf(msg.tabId)))[pagesKeyOf(msg.tabId)] || null;
      } catch (e) {
        pages = null;
      }
      try {
        sendResponse({ ok: true, pages });
      } catch (e) {}
    })();
    return true;
  }

  if (msg.type === 'GET_VIDEOS') {
    (async () => {
      let list = [];
      try {
        list = (await chrome.storage.session.get(keyOf(msg.tabId)))[keyOf(msg.tabId)] || [];
      } catch (e) {
        list = [];
      }
      try {
        sendResponse({ ok: true, videos: list });
      } catch (e) {}
    })();
    return true;
  }

  if (msg.type === 'CLEAR') {
    (async () => {
      try {
        await chrome.storage.session.remove([keyOf(msg.tabId), pagesKeyOf(msg.tabId)]);
      } catch (e) {}
      try {
        sendResponse({ ok: true });
      } catch (e) {}
    })();
    return true;
  }

  // ---------- 直链探测：用极小 Range 请求确认真实类型与体积 ----------
  if (msg.type === 'PROBE') {
    (async () => {
      const urls = Array.isArray(msg.urls) ? msg.urls.slice(0, 8) : [];
      const results = await Promise.all(
        urls.map(async (url) => {
          try {
            const res = await fetch(url, {
              method: 'GET',
              headers: { Range: 'bytes=0-1' },
              signal: AbortSignal.timeout(9000),
            });
            // 立即丢弃响应体，避免真的把整个视频下下来
            try {
              if (res.body && res.body.cancel) res.body.cancel();
            } catch (e) {}
            const ct = String(res.headers.get('content-type') || '');
            let size = 0;
            const cr = String(res.headers.get('content-range') || '');
            const cm = cr.match(/\/(\d+)\s*$/);
            if (cm) size = parseInt(cm[1], 10) || 0;
            if (!size) {
              const cl = parseInt(String(res.headers.get('content-length') || ''), 10);
              if (Number.isFinite(cl)) size = cl;
            }
            return {
              url,
              ok: res.ok || res.status === 206,
              status: res.status,
              type: ct,
              size,
              finalUrl: res.url && res.url !== url ? res.url : '',
            };
          } catch (e) {
            return { url, ok: false, status: 0, type: '', size: 0, error: String((e && e.message) || e) };
          }
        })
      );
      try {
        sendResponse({ ok: true, results });
      } catch (e) {}
    })();
    return true;
  }

  if (msg.type === 'BILI_FETCH') {
    (async () => {
      try {
        let host = '';
        try {
          host = new URL(msg.url).hostname;
        } catch (e) {
          host = '';
        }
        const isBili = /(^|\.)bilibili\.com$/i.test(host);
        const headers = { 'User-Agent': navigator.userAgent };
        // 只对 B 站域名附带 Referer 与登录 Cookie，避免把凭据发给第三方解析服务
        if (isBili) {
          headers.Referer = 'https://www.bilibili.com/';
          headers.Origin = 'https://www.bilibili.com';
          const cookie = await biliCookieHeader();
          if (cookie) headers.Cookie = cookie;
        }
        const res = await fetch(msg.url, { headers });
        const json = await res.json();
        try {
          sendResponse({ ok: true, data: json });
        } catch (e) {}
      } catch (e) {
        try {
          sendResponse({ ok: false, error: String((e && e.message) || e) });
        } catch (e2) {}
      }
    })();
    return true;
  }
});

// ---------- 清理 ----------
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove([keyOf(tabId), pagesKeyOf(tabId)]).catch(() => {});
});
