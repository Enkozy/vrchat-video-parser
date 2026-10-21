// ============================================================
// VRChat 视频解析器 - 内容脚本（隔离世界，document_idle）
// 功能：
//  1. 桥接主世界 inject.js 的媒体发现信号
//  2. 扫描页面 <video> / <source> 元素
//  3. Bilibili 解析：视频页（含分P）/ 番剧页 → 整段 MP4 直链（多 CDN 节点 + 有效期）
//  4. 直播解析：B站直播官方接口 + 斗鱼/虎牙/抖音等页面流地址抓取
//  5. 响应弹窗的 SCAN / PARSE_P 请求
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
          live: /\.flv(\?|#|$)/i.test(String(d.url)),
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

  // ---------- 直播站点识别 ----------
  const LIVE_SITES = [
    { name: 'B站直播', host: /^live\.bilibili\.com$/i },
    { name: 'B站直播', host: /(^|\.)bilibili\.com$/i, path: /^\/(blanc\/)?\d+\/?$/ },
    { name: '斗鱼', host: /(^|\.)douyu\.com$/i },
    { name: '虎牙', host: /(^|\.)huya\.com$/i },
    { name: '抖音', host: /(^|\.)douyin\.com$/i },
    { name: '快手', host: /(^|\.)kuaishou\.com$/i },
    { name: 'B站', host: /(^|\.)bilibili\.com$/i, path: /^\/live\// },
    { name: 'Twitch', host: /(^|\.)twitch\.tv$/i },
    { name: 'YouTube', host: /(^|\.)youtube\.com$/i, path: /^\/live(\/|$)/i },
  ];

  function liveSite() {
    let host = '';
    try {
      host = location.hostname.toLowerCase();
    } catch (e) {
      return null;
    }
    for (const s of LIVE_SITES) {
      if (!s.host.test(host)) continue;
      if (s.path && !s.path.test(location.pathname)) continue;
      return s;
    }
    return null;
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

  async function recordBili(url, mime, source, quality, expires, group, node, part, live) {
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
        part: part || '',
        live: !!live,
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

  // 后台优先（可带登录 Cookie + Referer），失败回退页面上下文请求
  async function biliJson(url) {
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'BILI_FETCH', url });
      if (resp && resp.ok && resp.data && typeof resp.data.code === 'number') return resp.data;
    } catch (e) {
      // ignore
    }
    return fetchJson(url, { credentials: 'include', signal: AbortSignal.timeout(6000) });
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
  // meta: { prefix: 'P2 · ', part: '分P标题' }
  async function recordDurlSet(data, groupId, mode, meta) {
    const m = meta || {};
    const prefix = m.prefix || '';
    const part = m.part || '';
    const label = QN_LABEL[data.quality] || `画质 ${data.quality}`;
    const preview = !!data.is_preview;
    const source = preview ? 'bilibili-preview' : 'bilibili';
    const tag = preview ? `${prefix}${label} · 试看` : `${prefix}${label}`;
    const h5 = mode === 'h5';
    const durl = (data.durl || []).filter((d) => d && d.url);
    const seen = new Set();
    const add = async (url, node) => {
      const https = toHttps(url);
      if (!isRealUrl(https) || seen.has(https)) return;
      seen.add(https);
      await recordBili(https, 'video/mp4', source, tag, deadlineOf(https), groupId, node, part);
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
            `${prefix}${label} · DASH 分片`,
            0,
            groupId,
            '视频流',
            part
          );
        }
        if (ad) {
          await recordBili(
            toHttps(ad.baseUrl || ad.base_url || ''),
            'audio/mp4',
            'bilibili-dash',
            `${prefix}${label} · DASH 分片`,
            0,
            groupId,
            '音频流',
            part
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

  // URL 上的 ?p=3 比页面状态更可信（SPA 切换分P时状态可能滞后）
  function pageFromUrl() {
    try {
      const p = parseInt(new URL(location.href).searchParams.get('p'), 10);
      return Number.isFinite(p) && p > 0 ? p : 0;
    } catch (e) {
      return 0;
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
    if (!json || json.code !== 0) {
      json = await fetchJson(apiUrl, {
        credentials: 'include',
        signal: AbortSignal.timeout(6000),
      });
    }
    if (!json || json.code !== 0) return null;
    return json.data || json.result || null;
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

  async function recordDashSet(data, groupId, meta) {
    const m = meta || {};
    const prefix = m.prefix || '';
    const part = m.part || '';
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
        `${prefix}${h ? h + 'P' : 'DASH'} 视频流（合并用）`,
        deadlineOf(url),
        groupId,
        '视频流',
        part
      );
    }
    if (a) {
      const url = toHttps(a.baseUrl || a.base_url || '');
      await recordBili(
        url,
        'audio/mp4',
        'bilibili-dash',
        `${prefix}音频流（合并用）`,
        deadlineOf(url),
        groupId,
        '音频流',
        part
      );
    }
  }

  // ---------- 分P 信息（view 接口：标题 + 全部分P） ----------
  let infoCache = { id: '', info: null };
  let lastCtx = null; // { id, title, pages, current }

  async function fetchVideoInfo(id) {
    const param = /^BV/i.test(id) ? `bvid=${id}` : `aid=${String(id).replace(/^av/i, '')}`;
    const j = await biliJson(`https://api.bilibili.com/x/web-interface/view?${param}`);
    if (!j || j.code !== 0 || !j.data) return null;
    return j.data;
  }

  function normalizePages(raw) {
    return (raw && raw.pages ? raw.pages : []).map((p) => ({
      cid: p.cid,
      page: p.page,
      part: String(p.part || '').trim(),
      duration: p.duration || 0,
    }));
  }

  async function getVideoInfo(id) {
    if (infoCache.id === id && infoCache.info) return infoCache.info;
    const raw = await fetchVideoInfo(id);
    if (!raw) return null;
    const info = {
      title: raw.title || '',
      bvid: raw.bvid || '',
      pages: normalizePages(raw),
    };
    infoCache = { id, info };
    return info;
  }

  // 把分P列表交给后台缓存，供弹窗渲染分P面板
  async function publishPages(info, current) {
    try {
      await chrome.runtime.sendMessage({
        type: 'PAGES',
        title: info.title || '',
        bvid: info.bvid || '',
        href: location.href,
        current: current || 1,
        pages: info.pages || [],
      });
    } catch (e) {
      // ignore
    }
  }

  // 解析单个分P（普通投稿视频）
  async function parseVideoPart(opts) {
    const id = opts.id;
    const cid = opts.cid;
    const page = opts.page || 1;
    const part = opts.part || '';
    const total = opts.total || 1;
    const qn = await getPreferQn();
    const prefix = total > 1 ? `P${page} · ` : '';
    const meta = { prefix, part };
    const groupId = `bili:${id}:${cid}`;
    const idParam = /^BV/i.test(id) ? `bvid=${id}` : `aid=${String(id).replace(/^av/i, '')}`;

    const apiUrl =
      `https://api.bilibili.com/x/player/playurl?${idParam}&cid=${cid}` +
      `&qn=${qn}&fnval=1&fnver=0&fourk=1&platform=pc`;
    const apiUrlH5 =
      `https://api.bilibili.com/x/player/playurl?${idParam}&cid=${cid}` +
      `&qn=${qn}&type=mp4&otype=json&fnver=0&fnval=0&fourk=1&platform=html5&high_quality=1`;
    const apiUrlDash =
      `https://api.bilibili.com/x/player/playurl?${idParam}&cid=${cid}` +
      `&qn=80&fnval=16&fnver=0&fourk=1&platform=pc`;

    // 方案一：bilibili-parse 的 html5 接口（免 Referer，VRChat 首选）
    const h5Data = await resolvePlayurl(apiUrlH5);
    if (h5Data) await recordDurlSet(h5Data, groupId, 'h5', meta);

    // 方案二：普通网页接口（多 CDN 节点 / 更高画质）
    const pcData = await resolvePlayurl(apiUrl);
    if (pcData) await recordDurlSet(pcData, groupId, 'pc', meta);

    // 方案三：本机两种接口都拿不到直链时，兜底请求公共解析服务
    if (!h5Data && !pcData) {
      const pub = await publicParse(
        /^BV/i.test(id) ? { bvid: id, page } : { aid: id, page }
      );
      if (pub) {
        const q = QN_LABEL[pub.quality] || `画质 ${pub.quality}`;
        await recordBili(
          toHttps(pub.url),
          'video/mp4',
          'bilibili-api',
          `${prefix}${q} · 公共解析`,
          deadlineOf(pub.url),
          groupId,
          '公共解析服务',
          part
        );
      }
    }

    // 方案四：DASH 通道（B 站 1080P 只在这里，音视频分离；弹窗提供 ffmpeg 合并命令）
    const bestQn = Math.max(h5Data ? h5Data.quality || 0 : 0, pcData ? pcData.quality || 0 : 0);
    if (bestQn < qn) {
      const dashData = await resolvePlayurl(apiUrlDash);
      if (dashData && dashData.dash) await recordDashSet(dashData, `${groupId}:dash`, meta);
    }
    return !!(h5Data || pcData);
  }

  // 解析番剧 / 影视（ep）
  async function parseBangumi(epId) {
    const qn = await getPreferQn();
    const meta = { prefix: '', part: '' };
    const groupId = `bili:ep${epId}`;
    const base = 'https://api.bilibili.com/pgc/player/web/playurl';
    const apiUrl = `${base}?ep_id=${epId}&qn=${qn}&fnval=1&fnver=0&fourk=1&platform=pc`;
    const apiUrlH5 =
      `${base}?ep_id=${epId}&qn=${qn}&type=mp4&otype=json&fnver=0&fnval=0` +
      `&fourk=1&platform=html5&high_quality=1`;
    const apiUrlDash = `${base}?ep_id=${epId}&qn=80&fnval=16&fnver=0&fourk=1&platform=pc`;

    const h5Data = await resolvePlayurl(apiUrlH5);
    if (h5Data) await recordDurlSet(h5Data, groupId, 'h5', meta);

    const pcData = await resolvePlayurl(apiUrl);
    if (pcData) await recordDurlSet(pcData, groupId, 'pc', meta);

    if (!h5Data && !pcData) {
      const pub = await publicParse({ epId });
      if (pub) {
        const q = QN_LABEL[pub.quality] || `画质 ${pub.quality}`;
        await recordBili(
          toHttps(pub.url),
          'video/mp4',
          'bilibili-api',
          `${q} · 公共解析`,
          deadlineOf(pub.url),
          groupId,
          '公共解析服务',
          ''
        );
      }
    }

    const bestQn = Math.max(h5Data ? h5Data.quality || 0 : 0, pcData ? pcData.quality || 0 : 0);
    if (bestQn < qn) {
      const dashData = await resolvePlayurl(apiUrlDash);
      if (dashData && dashData.dash) await recordDashSet(dashData, `${groupId}:dash`, meta);
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

    if (vm) {
      // 普通投稿（可能多 P）
      const id = vm[1];
      const info = await getVideoInfo(id);
      const pages = (info && info.pages) || [];
      const cidState = cidFromState();
      const pageState = pageFromUrl() || pageFromState();
      const target =
        pages.find((p) => p.page === pageState) ||
        pages.find((p) => String(p.cid) === String(cidState)) ||
        null;
      const cid = (target && target.cid) || cidState;
      if (!cid) return;
      const current = (target && target.page) || pageState;
      lastCtx = { id, title: (info && info.title) || '', pages, current };
      if (pages.length > 1) {
        await publishPages({ title: lastCtx.title, bvid: (info && info.bvid) || id, pages }, current);
      }
      await parseVideoPart({
        id,
        cid,
        page: current,
        part: (target && target.part) || '',
        total: pages.length || 1,
      });
      return;
    }

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
    lastCtx = null;
    await parseBangumi(epId);
  }

  // 解析指定分P（弹窗点「解析」时调用）
  async function parsePartByPage(pageNo, cidHint) {
    let host = '';
    try {
      host = location.hostname.toLowerCase();
    } catch (e) {
      host = '';
    }
    if (!host.endsWith('bilibili.com')) throw new Error('当前页面不是 B 站视频页');
    const vm = location.pathname.match(/^\/video\/(BV[0-9A-Za-z]+|av\d+)/i);
    if (!vm) throw new Error('只支持 /video/ 投稿页的分P解析');
    const id = vm[1];
    const info =
      lastCtx && lastCtx.id === id
        ? { title: lastCtx.title, pages: lastCtx.pages }
        : await getVideoInfo(id);
    const pages = (info && info.pages) || [];
    const hit =
      pages.find((x) => x.page === pageNo) ||
      (cidHint ? pages.find((x) => String(x.cid) === String(cidHint)) : null) ||
      (cidHint ? { cid: cidHint, page: pageNo || 1, part: '' } : null);
    if (!hit || !hit.cid) throw new Error('没找到该分P（可能已删除或接口繁忙）');
    await parseVideoPart({
      id,
      cid: hit.cid,
      page: hit.page || pageNo || 1,
      part: hit.part || '',
      total: pages.length || 1,
    });
    return true;
  }

  // ---------- 直播解析 ----------
  function biliLiveRoomId() {
    try {
      const host = location.hostname.toLowerCase();
      if (host === 'live.bilibili.com') {
        const m = location.pathname.match(/^\/(?:blanc\/)?(\d+)/);
        if (m) return m[1];
      }
      if (host.endsWith('bilibili.com')) {
        const m = location.pathname.match(/^\/(?:blanc\/)?(\d+)\/?$/);
        if (m) return m[1];
      }
    } catch (e) {
      // ignore
    }
    return '';
  }

  // B 站直播：room_init 拿真实房间号 → playUrl 拿 FLV 多线路（免登录）
  async function parseBiliLive(roomId) {
    const init = await biliJson(
      `https://api.live.bilibili.com/room/v1/Room/room_init?id=${roomId}`
    );
    let rid = roomId;
    if (init && init.code === 0 && init.data && init.data.room_id) rid = init.data.room_id;

    const j = await biliJson(
      `https://api.live.bilibili.com/room/v1/Room/playUrl?cid=${rid}&qn=10000&platform=web`
    );
    if (!j || j.code !== 0 || !j.data || !Array.isArray(j.data.durl)) return false;

    const desc = {};
    (j.data.quality_description || []).forEach((q) => {
      desc[q.qn] = q.desc;
    });

    const groupId = `live:bili:${rid}`;
    let n = 0;
    for (const d of j.data.durl) {
      if (!d || !d.url) continue;
      n += 1;
      const label = desc[d.qn || j.data.current_qn] || '直播流';
      await recordBili(
        toHttps(d.url),
        'video/x-flv',
        'bilibili-live',
        `直播 · ${label}`,
        0,
        groupId,
        `线路 ${d.order || n}`,
        '',
        true
      );
    }
    return n > 0;
  }

  // 从页面源码里抠直播流地址（斗鱼/虎牙等播放器把流地址写在 JS 里或先请求一次）
  const STREAM_SRC_RE = /https?:\/\/[^\s"'<>\\)]+?\.(?:flv|m3u8)(?:\?[^\s"'<>\\)]*)?/gi;
  let lastSrcScan = 0;

  function scanPageSource(force) {
    if (!isTop) return;
    const now = Date.now();
    if (!force && now - lastSrcScan < 4000) return;
    lastSrcScan = now;

    let html = '';
    try {
      html = document.documentElement ? document.documentElement.innerHTML : '';
    } catch (e) {
      html = '';
    }
    if (!html) return;
    if (html.length > 3000000) html = html.slice(0, 3000000);

    // 还原 JSON 里的转义形式（\\u002F、\\/、&amp;）
    const norm = html
      .replace(/\\u002F/gi, '/')
      .replace(/\\u0026/gi, '&')
      .replace(/\\\//g, '/')
      .replace(/&amp;/g, '&');

    const site = liveSite();
    const seen = new Set();
    STREAM_SRC_RE.lastIndex = 0;
    let m;
    let count = 0;
    while ((m = STREAM_SRC_RE.exec(norm)) !== null && count < 12) {
      const url = m[0];
      if (!/^https?:\/\//i.test(url)) continue;
      const base = url.split('?')[0];
      if (seen.has(base)) continue;
      seen.add(base);
      count += 1;
      const isFlv = /\.flv$/i.test(base);
      post({
        type: 'RECORD',
        url,
        mime: isFlv ? 'video/x-flv' : 'application/vnd.apple.mpegurl',
        source: site ? 'live-page' : 'page-src',
        href: location.href,
        quality: site ? `${site.name}直播` : '',
        expires: 0,
        live: !!site || isFlv,
      });
    }
  }

  async function liveParse() {
    if (!isTop) return;
    const site = liveSite();
    if (!site) return;
    if (site.name === 'B站直播') {
      const rid = biliLiveRoomId();
      if (rid) await parseBiliLive(rid);
    }
    // 斗鱼/虎牙/抖音等：以网络嗅探 + 页面源码抓流为主
    scanPageSource(true);
  }

  // ---------- 运行调度 ----------
  let runTimer = null;
  let lastHref = location.href;

  function scheduleRun(immediate) {
    clearTimeout(runTimer);
    runTimer = setTimeout(async () => {
      try {
        scanDom();
        if (liveSite()) {
          await liveParse();
        } else {
          await bilibiliParse();
        }
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
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'SCAN') {
      if (!isTop) return;
      (async () => {
        try {
          scanDom();
          if (liveSite()) await liveParse();
          else await bilibiliParse();
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
    }

    // 解析指定分P（分P面板按钮）
    if (msg.type === 'PARSE_P') {
      if (!isTop) return;
      (async () => {
        try {
          await parsePartByPage(parseInt(msg.page, 10) || 1, msg.cid || '');
          try {
            sendResponse({ ok: true });
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
})();
