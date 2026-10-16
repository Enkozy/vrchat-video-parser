// ============================================================
// VRChat 视频解析器 - 内容脚本（隔离世界，document_idle）
// 功能：
//  1. 桥接主世界 inject.js 的媒体发现信号
//  2. 扫描页面 <video> / <source> 元素
//  3. Bilibili 解析：视频页 / 番剧页 → 整段 MP4 直链（多 CDN 节点 + 有效期）
//  4. 响应弹窗的 SCAN 请求
// ============================================================
(() => {
  if (window.__vrcParserContent) return;
  window.__vrcParserContent = true;

  let isTop = false;
  try {
    isTop = window === window.top;
  } catch (e) {
    isTop = false;
  }

  const toHttps = (u) => String(u || '').replace(/^http:\/\//i, 'https://');
  const isRealUrl = (u) => !!u && !/^(blob|data):/i.test(String(u));

  function post(record) {
    try {
      chrome.runtime.sendMessage(record).catch(() => {});
    } catch (e) {
      // ignore
    }
  }

  // ---------- 主世界信号桥接 ----------
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__vrcParser !== true) return;
    if (d.type === 'MEDIA') {
      if (isRealUrl(d.url)) {
        post({
          type: 'RECORD',
          url: d.url,
          mime: d.mime || '',
          source: 'network',
          href: location.href,
          quality: '',
          expires: 0,
        });
      }
    } else if (d.type === 'NAVIGATE') {
      scheduleRun(true);
    }
  });

  // ---------- DOM 扫描 ----------
  function scanDom() {
    try {
      const seen = new Set();
      document.querySelectorAll('video').forEach((v) => {
        const src = v.currentSrc || v.src || '';
        if (isRealUrl(src) && !seen.has(src)) {
          seen.add(src);
          post({
            type: 'RECORD',
            url: src,
            mime: '',
            source: 'DOM',
            href: location.href,
            quality: '',
            expires: 0,
          });
        }
        v.querySelectorAll('source').forEach((s) => {
          const su = s.src || '';
          if (isRealUrl(su) && !seen.has(su)) {
            seen.add(su);
            post({
              type: 'RECORD',
              url: su,
              mime: s.type || '',
              source: 'DOM',
              href: location.href,
              quality: '',
              expires: 0,
            });
          }
        });
      });
    } catch (e) {
      // ignore
    }
  }

  let moTimer = null;
  function scheduleScan() {
    clearTimeout(moTimer);
    moTimer = setTimeout(scanDom, 600);
  }

  function startObserver() {
    try {
      const mo = new MutationObserver(scheduleScan);
      mo.observe(document.documentElement || document.body, {
        childList: true,
        subtree: true,
      });
    } catch (e) {
      // ignore
    }
  }

  // ---------- Bilibili 解析 ----------
  const QN_LABEL = {
    127: '8K 超高清',
    126: '杜比视界',
    125: '4K HDR',
    120: '4K 超清',
    116: '1080P 60帧',
    112: '1080P 高码率',
    80: '1080P 高清',
    74: '720P 60帧',
    64: '720P 高清',
    32: '480P 清晰',
    16: '360P 流畅',
    6: '240P',
  };
  const AKAMAI_HOST = 'upos-hz-mirrorakam.akamaized.net';

  async function recordBili(url, mime, source, quality, expires, group, node) {
    if (!isRealUrl(url)) return;
    try {
      await chrome.runtime.sendMessage({
        type: 'RECORD',
        url,
        mime,
        source,
        href: location.href,
        quality,
        expires: expires || 0,
        group: group || '',
        node: node || '',
      });
    } catch (e) {
      // ignore
    }
  }

  async function fetchJson(url, opts) {
    try {
      const r = await fetch(url, opts);
      if (!r.ok) return null;
      return await r.json();
    } catch (e) {
      return null;
    }
  }

  // B 站直链带 deadline 时效参数（通常约 2 小时）
  function deadlineOf(url) {
    try {
      const t = parseInt(new URL(url).searchParams.get('deadline'), 10);
      return Number.isFinite(t) && t > 0 ? t * 1000 : 0;
    } catch (e) {
      return 0;
    }
  }

  // 海外 Akamai 节点变体：部分节点不校验 Referer，VRChat 播放成功率更高
  function akamaiVariant(url) {
    try {
      const u = new URL(url);
      if (u.hostname === AKAMAI_HOST) return null;
      if (/^upos-[a-z0-9-]+(\.bilivideo\.com|\.bilivideo\.cn|\.akamaized\.net)$/i.test(u.hostname)) {
        u.hostname = AKAMAI_HOST;
        return u.href;
      }
    } catch (e) {
      // ignore
    }
    return null;
  }

  // 记录 durl 直链集：同一视频的全部节点归入同一个 group（弹窗折叠为一条，节点用下拉切换）
  // mode: 'h5' = platform=html5（免 Referer，VRChat 首选）/ 'pc' = 普通网页接口
  async function recordDurlSet(data, groupId, mode) {
    const label = QN_LABEL[data.quality] || `画质 ${data.quality}`;
    const preview = !!data.is_preview;
    const source = preview ? 'bilibili-preview' : 'bilibili';
    const tag = preview ? `${label} · 试看` : label;
    const h5 = mode === 'h5';
    const durl = (data.durl || []).filter((d) => d && d.url);
    const seen = new Set();
    const add = async (url, node) => {
      const https = toHttps(url);
      if (!isRealUrl(https) || seen.has(https)) return;
      seen.add(https);
      await recordBili(https, 'video/mp4', source, tag, deadlineOf(https), groupId, node);
    };

    if (!durl.length) {
      // 该视频未提供整段 MP4，只能拿到 DASH 分片（VRChat 不支持）
      if (data.dash) {
        const vd = (data.dash.video || []).find((x) => x.baseUrl || x.base_url);
        const ad = (data.dash.audio || []).find((x) => x.baseUrl || x.base_url);
        if (vd) {
          await recordBili(
            toHttps(vd.baseUrl || vd.base_url || ''),
            'video/mp4',
            'bilibili-dash',
            `${label} · DASH 分片`,
            0,
            groupId,
            '视频流'
          );
        }
        if (ad) {
          await recordBili(
            toHttps(ad.baseUrl || ad.base_url || ''),
            'audio/mp4',
            'bilibili-dash',
            `${label} · DASH 分片`,
            0,
            groupId,
            '音频流'
          );
        }
      }
      return;
    }

    for (const d of durl) {
      const backups = d.backup_url || d.backupUrl || [];
      for (let i = 0; i < backups.length; i++) {
        await add(backups[i], h5 ? `免Referer·备用${i + 1}` : `备用节点${i + 1}`);
      }
    }
    for (let i = 0; i < durl.length; i++) {
      let node = '主链';
      if (preview) node = '试看片段';
      else if (h5) node = durl.length > 1 ? `免Referer·第${i + 1}段` : '免Referer（VRChat 首选）';
      else if (durl.length > 1) node = `主链·第${i + 1}段`;
      await add(durl[i].url, node);
    }
    // 海外 Akamai 节点变体只对普通接口有意义（h5 本身已免 Referer）
    if (!h5) {
      for (const d of durl) {
        const v = akamaiVariant(d.url);
        if (v) await add(v, '海外节点');
      }
    }
  }

  function cidFromState() {
    try {
      const st = window.__INITIAL_STATE__ || {};
      if (st.videoData && st.videoData.cid) return st.videoData.cid;
    } catch (e) {
      // ignore
    }
    return '';
  }

  // 当前分 P 序号（多 P 视频用）
  function pageFromState() {
    try {
      const st = window.__INITIAL_STATE__ || {};
      const p = parseInt(st.p, 10);
      return Number.isFinite(p) && p > 0 ? p : 1;
    } catch (e) {
      return 1;
    }
  }

  // 方案三兜底：bilibili-parse 公共演示 API（由后台请求，不附带任何 B 站 Cookie）
  async function publicParse(params) {
    let url = 'https://api.injahow.cn/bparse/?otype=json&format=mp4&q=80';
    if (params.epId) url += `&type=bangumi&ep=${encodeURIComponent(params.epId)}`;
    else if (params.bvid) url += `&bv=${encodeURIComponent(params.bvid)}&p=${params.page || 1}`;
    else if (params.aid) {
      url += `&av=${encodeURIComponent(String(params.aid).replace(/^av/i, ''))}&p=${params.page || 1}`;
    } else {
      return null;
    }
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'BILI_FETCH', url });
      const d = resp && resp.ok ? resp.data : null;
      if (!d || d.code !== 0 || !d.url) return null;
      return d;
    } catch (e) {
      return null;
    }
  }

  async function resolvePlayurl(apiUrl) {
    // 优先由后台请求：可附带登录 Cookie（SESSDATA）+ 画质提示 Cookie + Referer，
    // 登录后才有机会拿到 1080P（未登录一般只有 480P 以下）
    let json = null;
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'BILI_FETCH', url: apiUrl });
      if (resp && resp.ok) json = resp.data;
    } catch (e) {
      // ignore
    }
    // 后台失败时退回页面上下文请求（自带页面 Cookie）
    if (!json || json.code !== 0 || !json.data) {
      json = await fetchJson(apiUrl, {
        credentials: 'include',
        signal: AbortSignal.timeout(6000),
      });
    }
    return json && json.code === 0 && json.data ? json.data : null;
  }

  // 用户选择的目标画质（1080P=80 / 720P=64 / 480P=32…），默认 1080P
  async function getPreferQn() {
    try {
      const r = await chrome.storage.sync.get('preferQn');
      const q = parseInt(r && r.preferQn, 10);
      return Number.isFinite(q) && q > 0 ? q : 80;
    } catch (e) {
      return 80;
    }
  }

  // ---------- DASH 流（1080P 通道，音视频分离，供 ffmpeg 合并） ----------
  function pickDashVideo(dash) {
    const list = (dash.video || []).filter((x) => x.baseUrl || x.base_url);
    const avc = list.filter((x) => /avc1/i.test(String(x.codecs || '')));
    const pool = (avc.length ? avc : list).slice();
    pool.sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bandwidth || 0) - (a.bandwidth || 0));
    const within = pool.filter((x) => (x.height || 0) <= 1080);
    return (within.length ? within : pool)[0] || null;
  }

  function pickDashAudio(dash) {
    const list = (dash.audio || []).filter((x) => x.baseUrl || x.base_url);
    const aac = list.filter((x) => /mp4a/i.test(String(x.codecs || '')));
    const pool = (aac.length ? aac : list).slice();
    pool.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
    return pool[0] || null;
  }

  async function recordDashSet(data, groupId) {
    const dash = data.dash || {};
    const v = pickDashVideo(dash);
    const a = pickDashAudio(dash);
    if (v) {
      const url = toHttps(v.baseUrl || v.base_url || '');
      const h = v.height || 0;
      await recordBili(
        url,
        'video/mp4',
        'bilibili-dash',
        `${h ? h + 'P' : 'DASH'} 视频流（合并用）`,
        deadlineOf(url),
        groupId,
        '视频流'
      );
    }
    if (a) {
      const url = toHttps(a.baseUrl || a.base_url || '');
      await recordBili(
        url,
        'audio/mp4',
        'bilibili-dash',
        '音频流（合并用）',
        deadlineOf(url),
        groupId,
        '音频流'
      );
    }
  }

  async function bilibiliParse() {
    if (!isTop) return;
    const host = location.hostname.toLowerCase();
    if (!host.endsWith('bilibili.com')) return;
    const path = location.pathname;
    const vm = path.match(/^\/video\/(BV[0-9A-Za-z]+|av\d+)/i);
    const em = path.match(/^\/bangumi\/play\/(ep\d+|ss\d+)/i);
    if (!vm && !em) return;

    const qn = await getPreferQn();
    let apiUrl = '';
    let apiUrlH5 = '';
    let apiUrlDash = '';
    let groupId = '';
    let publicParams = null;
    if (vm) {
      // 普通视频页（BV / av 号）
      const id = vm[1];
      let cid = cidFromState();
      if (!cid) {
        const param = /^BV/i.test(id) ? `bvid=${id}` : `aid=${id}`;
        const j = await fetchJson(`https://api.bilibili.com/x/web-interface/view?${param}`, {
          credentials: 'include',
          signal: AbortSignal.timeout(5000),
        });
        if (j && j.code === 0 && j.data && j.data.cid) cid = j.data.cid;
      }
      if (!cid) return;
      const param = /^BV/i.test(id) ? `bvid=${id}` : `aid=${id}`;
      const isBv = /^BV/i.test(id);
      groupId = `bili:${id}:${cid}`;
      publicParams = isBv ? { bvid: id, page: pageFromState() } : { aid: id, page: pageFromState() };
      // 普通网页接口：多 CDN 节点，可切画质
      apiUrl =
        `https://api.bilibili.com/x/player/playurl?${param}&cid=${cid}` +
        `&qn=${qn}&fnval=1&fnver=0&fourk=1&platform=pc`;
      // bilibili-parse 方案（MIT）：platform=html5 + high_quality，返回免 Referer 的整段 MP4
      apiUrlH5 =
        `https://api.bilibili.com/x/player/playurl?${param}&cid=${cid}` +
        `&qn=${qn}&type=mp4&otype=json&fnver=0&fnval=0&fourk=1&platform=html5&high_quality=1`;
      // DASH 通道：B 站 1080P 只在这里（音视频分离，供 ffmpeg 合并）
      apiUrlDash =
        `https://api.bilibili.com/x/player/playurl?${param}&cid=${cid}` +
        `&qn=80&fnval=16&fnver=0&fourk=1&platform=pc`;
    } else {
      // 番剧 / 影视页（ep 直接取号；ss 从页面状态取当前集）
      let epId = '';
      const raw = em[1];
      if (/^ep/i.test(raw)) {
        epId = raw.slice(2);
      } else {
        try {
          const st = window.__INITIAL_STATE__ || {};
          const epInfo = st.epInfo || null;
          const epList = st.epList || [];
          epId =
            (epInfo && (epInfo.ep_id || epInfo.id)) ||
            (epList[0] && (epList[0].ep_id || epList[0].id)) ||
            '';
        } catch (e) {
          epId = '';
        }
      }
      if (!epId) return;
      groupId = `bili:ep${epId}`;
      publicParams = { epId };
      apiUrl =
        `https://api.bilibili.com/pgc/player/web/playurl?ep_id=${epId}` +
        `&qn=${qn}&fnval=1&fnver=0&fourk=1&platform=pc`;
      apiUrlH5 =
        `https://api.bilibili.com/pgc/player/web/playurl?ep_id=${epId}` +
        `&qn=${qn}&type=mp4&otype=json&fnver=0&fnval=0&fourk=1&platform=html5&high_quality=1`;
      apiUrlDash =
        `https://api.bilibili.com/pgc/player/web/playurl?ep_id=${epId}` +
        `&qn=80&fnval=16&fnver=0&fourk=1&platform=pc`;
    }

    // 方案一：bilibili-parse 的 html5 接口（免 Referer，VRChat 首选）
    const h5Data = apiUrlH5 ? await resolvePlayurl(apiUrlH5) : null;
    if (h5Data) await recordDurlSet(h5Data, groupId, 'h5');

    // 方案二：普通网页接口（多 CDN 节点 / 更高画质）
    const pcData = await resolvePlayurl(apiUrl);
    if (pcData) await recordDurlSet(pcData, groupId, 'pc');

    // 方案三：本机两种接口都拿不到直链时，兜底请求公共解析服务（bilibili-parse 官方演示站）
    if (!h5Data && !pcData && publicParams) {
      const pub = await publicParse(publicParams);
      if (pub) {
        const q = QN_LABEL[pub.quality] || `画质 ${pub.quality}`;
        await recordBili(
          toHttps(pub.url),
          'video/mp4',
          'bilibili-api',
          `${q} · 公共解析`,
          deadlineOf(pub.url),
          groupId,
          '公共解析服务'
        );
      }
    }

    // 方案四：DASH 通道（B 站 1080P 只在这里，音视频分离；弹窗提供 ffmpeg 合并命令）
    const bestQn = Math.max(h5Data ? h5Data.quality || 0 : 0, pcData ? pcData.quality || 0 : 0);
    if (apiUrlDash && bestQn < qn) {
      const dashData = await resolvePlayurl(apiUrlDash);
      if (dashData && dashData.dash) await recordDashSet(dashData, `${groupId}:dash`);
    }
  }

  // ---------- 运行调度 ----------
  let runTimer = null;
  let lastHref = location.href;

  function scheduleRun(immediate) {
    clearTimeout(runTimer);
    runTimer = setTimeout(async () => {
      try {
        scanDom();
        await bilibiliParse();
      } catch (e) {
        // ignore
      }
    }, immediate ? 400 : 1200);
  }

  scheduleRun(true);
  startObserver();

  // SPA 页面轮询兜底
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      scheduleRun(true);
    }
  }, 1500);

  // ---------- 弹窗消息 ----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'SCAN') return;
    if (!isTop) return;
    (async () => {
      try {
        scanDom();
        await bilibiliParse();
      } catch (e) {
        // ignore
      }
      try {
        sendResponse({ ok: true, href: location.href });
      } catch (e) {
        // ignore
      }
    })();
    return true;
  });
})();
