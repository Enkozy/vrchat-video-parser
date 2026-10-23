// ============================================================
// VRChat 视频解析器 - 弹窗逻辑
// ============================================================
const $ = (id) => document.getElementById(id);

const listEl = $('list');
const emptyEl = $('empty');
const pageCardEl = $('pageCard');
const toastEl = $('toast');
const btnScan = $('btnScan');
const btnClear = $('btnClear');
const btnCopyBest = $('btnCopyBest');
const chkAll = $('chkAll');
const btnDiag = $('btnDiag');
const qqGroupEl = $('qqGroup');
const hlsBanner = $('hlsBanner');
const dashBanner = $('dashBanner');
const liveBanner = $('liveBanner');
const pagesPanelEl = $('pagesPanel');

let tabId = null;
let tabUrl = '';
let videos = [];
let probes = {};
let resolverDomain = '';
let showAll = false;
let preferQn = 80;
let toastTimer = null;
let scanning = false;
let pagesInfo = null;
let parsingPages = false;

// ---------- 工具 ----------
function toast(text, ms) {
  toastEl.textContent = text;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms || 1600);
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

function shortUrl(u) {
  u = String(u || '');
  return u.length > 70 ? u.slice(0, 67) + '…' : u;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function fmtTime(ts) {
  const d = new Date(ts || 0);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtExpiry(ms) {
  const d = new Date(ms);
  return `⏰ 有效至 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function isExpired(v) {
  return !!v.expires && v.expires < Date.now();
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e2) {
      return false;
    }
  }
}

// ---------- 外观：自定义背景图（裁切 / 缩放 / 模糊 / 压暗，只存本地） ----------
const bgState = { image: '', blur: 8, dim: 45, scale: 100, posX: 50, posY: 50 };

const clampNum = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function applyBg() {
  const root = document.documentElement;
  root.style.setProperty('--bg-blur', bgState.blur + 'px');
  root.style.setProperty('--bg-dim', String(bgState.dim / 100));
  root.style.setProperty('--bg-zoom', String(bgState.scale / 100));
  root.style.setProperty('--bg-pos', `${bgState.posX}% ${bgState.posY}%`);

  const url = bgState.image ? `url("${bgState.image}")` : '';
  const layer = $('bgImg');
  if (layer) layer.style.backgroundImage = url;
  const cropImg = $('bgCropImg');
  if (cropImg) cropImg.style.backgroundImage = url;
  document.body.classList.toggle('has-bg', !!bgState.image);

  const setVal = (id, v) => {
    const el = $(id);
    if (el) el.value = String(v);
  };
  setVal('bgBlur', bgState.blur);
  setVal('bgDim', bgState.dim);
  setVal('bgScale', bgState.scale);
  const setTxt = (id, t) => {
    const el = $(id);
    if (el) el.textContent = t;
  };
  setTxt('bgBlurVal', bgState.blur + 'px');
  setTxt('bgDimVal', bgState.dim + '%');
  setTxt('bgScaleVal', bgState.scale + '%');
}

async function saveBg() {
  try {
    await chrome.storage.local.set({
      bgImage: bgState.image,
      bgBlur: bgState.blur,
      bgDim: bgState.dim,
      bgScale: bgState.scale,
      bgPosX: bgState.posX,
      bgPosY: bgState.posY,
    });
    return true;
  } catch (e) {
    return false;
  }
}

async function loadBg() {
  try {
    const r = await chrome.storage.local.get([
      'bgImage',
      'bgBlur',
      'bgDim',
      'bgScale',
      'bgPosX',
      'bgPosY',
    ]);
    if (r) {
      if (typeof r.bgImage === 'string') bgState.image = r.bgImage;
      const b = parseInt(r.bgBlur, 10);
      const d = parseInt(r.bgDim, 10);
      const s = parseInt(r.bgScale, 10);
      const px = parseInt(r.bgPosX, 10);
      const py = parseInt(r.bgPosY, 10);
      if (Number.isFinite(b)) bgState.blur = clampNum(b, 0, 40);
      if (Number.isFinite(d)) bgState.dim = clampNum(d, 0, 90);
      if (Number.isFinite(s)) bgState.scale = clampNum(s, 100, 250);
      if (Number.isFinite(px)) bgState.posX = clampNum(px, 0, 100);
      if (Number.isFinite(py)) bgState.posY = clampNum(py, 0, 100);
    }
  } catch (e) {
    // 读不到就用默认值
  }
  applyBg();
}

// 图片压缩：最长边 1600px 的 JPEG，够当背景，存储也不会撑爆配额
function fileToBgDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('这个文件不是能识别的图片'));
      img.onload = () => {
        try {
          const max = 1600;
          let w = img.width || 1;
          let h = img.height || 1;
          if (w > max || h > max) {
            const s = Math.min(max / w, max / h);
            w = Math.round(w * s);
            h = Math.round(h * s);
          }
          const cv = document.createElement('canvas');
          cv.width = w;
          cv.height = h;
          const ctx = cv.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          resolve(cv.toDataURL('image/jpeg', 0.82));
        } catch (e) {
          resolve(String(reader.result || ''));
        }
      };
      img.src = String(reader.result || '');
    };
    reader.readAsDataURL(file);
  });
}

function initBgSettings() {
  const btnBg = $('btnBg');
  const panel = $('bgPanel');
  const file = $('bgFile');
  if (!btnBg || !panel) return;

  const openPanel = (open) => {
    panel.hidden = !open;
    btnBg.classList.toggle('active', open);
  };

  btnBg.addEventListener('click', () => openPanel(panel.hidden));
  const closeBtn = $('btnBgClose');
  if (closeBtn) closeBtn.addEventListener('click', () => openPanel(false));

  const pick = $('btnBgPick');
  if (pick && file) {
    pick.addEventListener('click', () => file.click());
    file.addEventListener('change', async () => {
      const f = file.files && file.files[0];
      if (!f) return;
      try {
        toast('正在处理图片…', 1200);
        bgState.image = await fileToBgDataUrl(f);
        applyBg();
        const ok = await saveBg();
        toast(ok ? '背景图已应用 ✓' : '图片太大，保存失败（换张小一点的）', ok ? 1800 : 4200);
      } catch (e) {
        toast(String((e && e.message) || '设置背景失败'), 3200);
      } finally {
        try {
          file.value = '';
        } catch (e) {}
      }
    });
  }

  const rm = $('btnBgRemove');
  if (rm) {
    rm.addEventListener('click', async () => {
      bgState.image = '';
      applyBg();
      await saveBg();
      toast('已移除背景图');
    });
  }

  const blurEl = $('bgBlur');
  if (blurEl) {
    blurEl.addEventListener('input', () => {
      bgState.blur = parseInt(blurEl.value, 10) || 0;
      applyBg();
    });
    blurEl.addEventListener('change', () => {
      saveBg();
    });
  }

  const dimEl = $('bgDim');
  if (dimEl) {
    dimEl.addEventListener('input', () => {
      bgState.dim = parseInt(dimEl.value, 10) || 0;
      applyBg();
    });
    dimEl.addEventListener('change', () => {
      saveBg();
    });
  }

  const scaleEl = $('bgScale');
  if (scaleEl) {
    scaleEl.addEventListener('input', () => {
      bgState.scale = clampNum(parseInt(scaleEl.value, 10) || 100, 100, 250);
      applyBg();
    });
    scaleEl.addEventListener('change', () => {
      saveBg();
    });
  }

  // 裁切：在小方块里拖动 = 调整取景位置（背景 background-position）
  const crop = $('bgCrop');
  if (crop) {
    let drag = null;
    crop.addEventListener('pointerdown', (e) => {
      if (!bgState.image) {
        toast('先选一张背景图，再来拖取景');
        return;
      }
      const rect = crop.getBoundingClientRect();
      drag = {
        x: e.clientX,
        y: e.clientY,
        px: bgState.posX,
        py: bgState.posY,
        w: Math.max(1, rect.width),
        h: Math.max(1, rect.height),
      };
      try {
        crop.setPointerCapture(e.pointerId);
      } catch (err) {}
    });
    crop.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = ((e.clientX - drag.x) / drag.w) * 100;
      const dy = ((e.clientY - drag.y) / drag.h) * 100;
      bgState.posX = clampNum(drag.px - dx * 1.6, 0, 100);
      bgState.posY = clampNum(drag.py - dy * 1.6, 0, 100);
      applyBg();
    });
    const endDrag = () => {
      if (!drag) return;
      drag = null;
      saveBg();
    };
    crop.addEventListener('pointerup', endDrag);
    crop.addEventListener('pointercancel', endDrag);
  }
}

// ---------- 格式分析 ----------
const EXT_RE = /\.(mp4|webm|m3u8|m4s|ts|mkv|flv|mov|ogv)(\?|#|$)/i;

function analyze(v) {
  const u = v.url || '';
  const m = u.match(EXT_RE);
  const ext = m ? m[1].toLowerCase() : '';
  const mime = String(v.mime || '').toLowerCase();
  let format = 'LINK';
  if (ext) format = ext.toUpperCase();
  else if (mime.includes('mpegurl')) format = 'M3U8';
  else if (mime.includes('mp4')) format = 'MP4';
  else if (mime.includes('webm')) format = 'WEBM';

  const src = v.source || '';
  const label = {
    bilibili: 'B站解析',
    'bilibili-preview': 'B站试看',
    'bilibili-dash': 'B站DASH',
    'bilibili-api': '公共解析',
    'bilibili-live': 'B站直播',
    'live-page': '直播抓取',
    'page-src': '页面源码',
    resolver: '中转服务',
    network: '网络嗅探',
    DOM: '页面元素',
  }[src] || '检测';

  const isLive = !!v.live || src === 'bilibili-live' || src === 'live-page';

  let level = 2;
  let note = '可能不支持，建议测试';
  if (src === 'resolver') {
    format = '中转';
    level = 1;
    note = 'VRChat 可直接播放（Worker 中转）';
  } else if (src === 'bilibili-preview') {
    level = 2;
    note = '试看片段，完整版需大会员';
  } else if (src === 'bilibili-dash') {
    level = 3;
    note = 'DASH 分片，VRChat 不支持';
  } else if (isLive) {
    format = ext === 'm3u8' ? 'M3U8' : 'FLV';
    level = 2;
    note = '直播流：VRChat 不能直接播，用顶部「转推/录制」按钮';
  } else if (format === 'M3U8') {
    level = 2;
    note = 'HLS 直播/切片，VRChat 不支持';
  } else if (ext === 'm4s') {
    level = 3;
    note = 'DASH 分片，VRChat 不支持';
  } else if (ext === 'ts') {
    level = 3;
    note = 'TS 分片，忽略（VRChat 不支持）';
  } else if (ext === 'mp4' || ext === 'webm' || format === 'MP4' || format === 'WEBM') {
    level = 1;
    note = /^audio\//.test(mime) ? '音频轨' : '可用于 VRChat';
  }

  // 探测结果修正：无法从 URL/MIME 判断时，用真实响应头判断"是不是完整文件、能不能分享"
  const p = probes[v.url];
  const probed =
    p &&
    p.ok &&
    !isLive &&
    src !== 'bilibili-dash' &&
    src !== 'bilibili-preview' &&
    src !== 'resolver';
  if (probed) {
    const pt = String(p.type || '').toLowerCase();
    const mb = p.size ? p.size / 1048576 : 0;
    if (pt.includes('mpegurl')) {
      format = 'M3U8';
      level = 2;
      note = 'HLS 切片流，VRChat 不支持直接播放';
    } else if (pt.includes('mp4') || pt.includes('video/') || pt.includes('octet-stream')) {
      if (mb >= 8) {
        if (!ext) format = 'MP4 直链';
        level = 1;
        note = `完整文件 ${mb.toFixed(0)}MB · 可分享给别人`;
      } else if (mb > 0) {
        level = 3;
        note = `仅 ${mb.toFixed(1)}MB · 疑似分片，别人可能播不了`;
      }
    }
  }
  if (p && !p.ok && format === 'LINK') {
    level = 2;
    note = `探测失败（HTTP ${p.status || '无响应'}）· 可能需要 Referer 或已被 CDN 拒绝`;
  }
  if (isExpired(v)) {
    level = 3;
    note = '链接已过期，请重新扫描';
  }
  return { format, level, note, label, isLive };
}

// ---------- 直链探测调度：给"看不出来是什么"的链接做真实类型/体积检测 ----------
let probeTimer = null;

function rememberProbe(x) {
  probes[x.url] = x;
  const keys = Object.keys(probes);
  if (keys.length > 300) delete probes[keys[0]];
}

function scheduleProbe() {
  const targets = videos
    .filter((v) => {
      if (!v.url || probes[v.url] || v.live) return false;
      const a = analyze(v);
      return a.format === 'LINK' || a.format === 'M3U8' || a.format === 'TS' || !v.mime;
    })
    .map((v) => v.url)
    .filter((u, i, arr) => u && arr.indexOf(u) === i)
    .slice(0, 8);
  if (!targets.length) return;
  clearTimeout(probeTimer);
  probeTimer = setTimeout(async () => {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'PROBE', urls: targets });
      if (r && r.ok && Array.isArray(r.results)) {
        r.results.forEach((x) => {
          if (x && x.url) rememberProbe(x);
        });
        render();
      }
    } catch (e) {
      // ignore
    }
  }, 350);
}

// ---------- 分组与渲染 ----------
// 同一视频的所有记录（多个 CDN 节点 / 同一 HLS 流的多个索引）归为一组，默认只显示一条
function filenameOf(u) {
  try {
    const p = new URL(u).pathname.split('/').pop() || '';
    return p || '节点';
  } catch (e) {
    return '节点';
  }
}

function nodePriority(v) {
  const n = (v.node || filenameOf(v.url) || '').toLowerCase();
  // 「免Referer」是 bilibili-parse 方案的 html5 直链，VRChat 播放成功率最高，排最前
  if (n.includes('免referer')) return 0;
  if (n === '海外节点') return 1;
  if (n === '主链' || n.startsWith('主链')) return 2;
  if (n.startsWith('备用')) return 3;
  if (n.startsWith('index')) return 4;
  return 5;
}

function groupKeyOf(v) {
  if (v.group) return `g:${v.group}`;
  const u = v.url || '';
  // 同一 HLS 流会有 index.m3u8 / mixed.m3u8 等多个索引，按 CDN 目录合并为一组
  if (/\.m3u8(\?|#|$)/i.test(u)) {
    const m = u.match(/^(https?:\/\/[^/]+\/[^/]+\/[^/]+)/i);
    if (m) return `hls:${m[1]}`;
  }
  return `raw:${u}`;
}

function buildGroups() {
  const map = new Map();
  for (const v of videos) {
    const key = groupKeyOf(v);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(v);
  }
  return [...map.values()].map((items) => {
    items.sort((a, b) => nodePriority(a) - nodePriority(b) || b.time - a.time);
    return items;
  });
}

// HLS 站点横幅：VRChat 不支持 HLS，引导用 ffmpeg 合并成 MP4
function buildFfmpegCommand(m3u8Url) {
  let referer = 'https://example.com/';
  try {
    if (tabUrl) referer = new URL(tabUrl).origin + '/';
  } catch (e) {
    // ignore
  }
  return (
    `ffmpeg -headers "Referer: ${referer}" -user_agent "Mozilla/5.0" ` +
    `-i "${m3u8Url}" -c copy -bsf:a aac_adtstoasc "anime.mp4"`
  );
}

// B 站 DASH（视频流 + 音频流）→ 合并出 1080P MP4 的 ffmpeg 命令
function buildDashMergeCommand(videoUrl, audioUrl) {
  const ref = 'https://www.bilibili.com/';
  return (
    `ffmpeg -headers "Referer: ${ref}" -user_agent "Mozilla/5.0" -i "${videoUrl}" ` +
    `-headers "Referer: ${ref}" -user_agent "Mozilla/5.0" -i "${audioUrl}" ` +
    `-c copy -movflags +faststart "bili_1080p.mp4"`
  );
}

// B 站 1080P 提示横幅：单文件通道上限 720P，1080P 需要 DASH 合并
function renderDashBanner(groups) {
  dashBanner.innerHTML = '';
  const pool = [];
  groups.forEach((g) => g.forEach((v) => pool.push(v)));
  const dashV = pool.find(
    (x) => x.source === 'bilibili-dash' && String(x.node || '').startsWith('视频流')
  );
  const dashA = pool.find(
    (x) => x.source === 'bilibili-dash' && String(x.node || '').startsWith('音频流')
  );
  if (!dashV || !dashA) return;

  const hMatch = String(dashV.quality || '').match(/(\d+)P/);
  const hText = hMatch ? `${hMatch[1]}P ` : '';

  const box = document.createElement('div');
  box.className = 'dash-box';
  box.innerHTML =
    `<div class="dash-title">🎯 想要 1080P？B 站单文件直链的上限是 720P</div>` +
    `<div class="dash-text">` +
    `1080P 只存在于 DASH 通道（音视频分离），VRChat 播放器不能直接播放。<br>` +
    `已抓到 <b>${hText}视频流 + 音频流</b>，用 ffmpeg 合并即可得到 1080P 的 MP4 文件。` +
    `</div>`;

  const row = document.createElement('div');
  row.className = 'dash-actions';

  const b1 = document.createElement('button');
  b1.className = 'btn small';
  b1.textContent = '⚙️ 复制 1080P 合并命令';
  b1.title = '步骤：① 装 ffmpeg → ② 复制本命令 → ③ 终端粘贴运行 → ④ 得到 bili_1080p.mp4';
  b1.addEventListener('click', async () => {
    const ok = await copyText(buildDashMergeCommand(dashV.url, dashA.url));
    toast(ok ? '合并命令已复制：装好 ffmpeg 后粘到终端运行 ✓' : '复制失败');
  });

  const b2 = document.createElement('button');
  b2.className = 'btn small';
  b2.textContent = '📥 复制 ffmpeg 安装命令';
  b2.title = '在终端粘贴运行一次即可（Windows 自带 winget）';
  b2.addEventListener('click', async () => {
    const ok = await copyText('winget install Gyan.FFmpeg');
    toast(ok ? 'ffmpeg 安装命令已复制：粘到终端运行一次 ✓' : '复制失败');
  });

  row.appendChild(b1);
  row.appendChild(b2);
  box.appendChild(row);
  dashBanner.appendChild(box);
}

function renderHlsBanner(groups) {
  hlsBanner.innerHTML = '';
  const m3u8Groups = groups.filter((g) => analyze(g[0]).format === 'M3U8');
  const hasPlayable = groups.some((g) => analyze(g[0]).level === 1);
  if (!m3u8Groups.length || hasPlayable) return;

  const bestM3u8 = m3u8Groups[0][0].url;
  const box = document.createElement('div');
  box.className = 'hls-box';
  box.innerHTML =
    `<div class="hls-title">🎬 本页为 HLS 切片流，VRChat 不支持直接播放</div>` +
    `<div class="hls-text">推荐：复制下方 <b>ffmpeg 命令</b>把视频合并成 MP4，再上传直链空间播放（步骤见 README）。<br>` +
    `<b>⚠️ 分享提醒</b>：这类站点链接常有 IP 绑定 / 短时效——你自己能播，别人（不同网络或设备）往往播不了。<br>` +
    `要让房间里所有人都能看，必须<b>合并成 MP4 后上传公开直链</b>。</div>`;

  const btnRow = document.createElement('div');
  btnRow.className = 'hls-actions';
  const btnCopyM3u8 = document.createElement('button');
  btnCopyM3u8.className = 'btn small';
  btnCopyM3u8.textContent = '📋 复制 m3u8 地址';
  btnCopyM3u8.addEventListener('click', async () => {
    const ok = await copyText(bestM3u8);
    toast(ok ? 'm3u8 地址已复制 ✓' : '复制失败');
  });
  const btnCmd = document.createElement('button');
  btnCmd.className = 'btn small';
  btnCmd.textContent = '⚙️ 复制 ffmpeg 合并命令';
  btnCmd.addEventListener('click', async () => {
    const ok = await copyText(buildFfmpegCommand(bestM3u8));
    toast(ok ? '命令已复制，粘贴到终端运行 ✓' : '复制失败');
  });
  btnRow.appendChild(btnCopyM3u8);
  btnRow.appendChild(btnCmd);
  box.appendChild(btnRow);
  hlsBanner.appendChild(box);
}

// ---------- 直播流处理：VRChat 不能直接播 FLV/HLS，给出转推/录制方案 ----------
function liveReferer(url) {
  try {
    const h = new URL(url).hostname;
    if (/bilibili|bilivideo|hdslb/i.test(h)) return 'https://live.bilibili.com/';
    if (/douyu/i.test(h)) return 'https://www.douyu.com/';
    if (/huya|msstatic/i.test(h)) return 'https://www.huya.com/';
  } catch (e) {
    // ignore
  }
  try {
    if (tabUrl) return new URL(tabUrl).origin + '/';
  } catch (e) {
    // ignore
  }
  return 'https://example.com/';
}

function buildLiveRelayCommand(streamUrl) {
  return (
    `ffmpeg -headers "Referer: ${liveReferer(streamUrl)}" -user_agent "Mozilla/5.0" ` +
    `-i "${streamUrl}" -c copy -f flv "rtmp://live.twitch.tv/app/<你的串流密钥>"`
  );
}

function buildLiveRecordCommand(streamUrl) {
  return (
    `ffmpeg -headers "Referer: ${liveReferer(streamUrl)}" -user_agent "Mozilla/5.0" ` +
    `-i "${streamUrl}" -c copy -t 3600 "live_record.mp4"`
  );
}

function renderLiveBanner(groups) {
  liveBanner.innerHTML = '';
  const pool = [];
  groups.forEach((g) => g.forEach((v) => pool.push(v)));
  const lives = pool
    .filter((v) => analyze(v).isLive)
    .sort(
      (a, b) =>
        (b.source === 'bilibili-live' ? 1 : 0) - (a.source === 'bilibili-live' ? 1 : 0) ||
        b.time - a.time
    );
  if (!lives.length) return;

  const best = lives[0];
  const siteName = best.source === 'bilibili-live' ? 'B站直播' : '直播站点';

  const box = document.createElement('div');
  box.className = 'live-box';
  box.innerHTML =
    `<div class="live-title"><span class="live-dot"></span>已抓到直播流（${escapeHtml(siteName)}）</div>` +
    `<div class="live-text">` +
    `VRChat 播放器<b>不能直接播放 FLV / HLS 直播流</b>，直播要先转成它能吃的地址。三条路：<br>` +
    `① <b>转推到 Twitch / YouTube 直播</b>（最省事，VRChat 原生支持这两个直播链接）；<br>` +
    `② 自建 RTMP 中继，把命令里的推流地址换成你的服务器；<br>` +
    `③ 临时<b>录制</b>成 MP4 再分享（适合只想给房间里的人放一会儿）。` +
    `</div>`;

  const row = document.createElement('div');
  row.className = 'live-actions';

  const b1 = document.createElement('button');
  b1.className = 'btn small';
  b1.textContent = '📋 复制直播流地址';
  b1.addEventListener('click', async () => {
    const ok = await copyText(best.url);
    toast(ok ? '直播流地址已复制 ✓（下面两条命令也用这条）' : '复制失败');
  });

  const b2 = document.createElement('button');
  b2.className = 'btn small';
  b2.textContent = '⚙️ 复制转推命令';
  b2.title = '把直播流转推到 Twitch / YouTube，再用 VRChat 支持的直播链接播放';
  b2.addEventListener('click', async () => {
    const ok = await copyText(buildLiveRelayCommand(best.url));
    toast(ok ? '转推命令已复制：把 <你的串流密钥> 换成自己的 ✓' : '复制失败');
  });

  const b3 = document.createElement('button');
  b3.className = 'btn small';
  b3.textContent = '📹 复制录制命令';
  b3.title = '把直播录成 MP4 文件，再上传直链给所有人看';
  b3.addEventListener('click', async () => {
    const ok = await copyText(buildLiveRecordCommand(best.url));
    toast(ok ? '录制命令已复制：运行后会得到 live_record.mp4 ✓' : '复制失败');
  });

  row.appendChild(b1);
  row.appendChild(b2);
  row.appendChild(b3);
  box.appendChild(row);
  liveBanner.appendChild(box);
}

// ---------- 分P 面板 ----------
function fmtDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}

async function refreshPages() {
  pagesInfo = null;
  if (tabId == null) {
    renderPagesPanel();
    return;
  }
  try {
    const r = await chrome.runtime.sendMessage({ type: 'GET_PAGES', tabId });
    if (r && r.ok && r.pages) pagesInfo = r.pages;
  } catch (e) {
    pagesInfo = null;
  }
  renderPagesPanel();
}

// 从已解析结果里挑出属于某个分P的最佳链接（免 Referer 主链优先）
function pickBestForPage(page) {
  const cid = String(page.cid || '');
  const part = String(page.part || '');
  const pool = videos.filter((v) => {
    const g = String(v.group || '');
    if (cid && g && g.split(':').indexOf(cid) >= 0) return true;
    if (part && v.part && String(v.part) === part) return true;
    return false;
  });
  if (!pool.length) return null;
  const playable = pool.filter((v) => analyze(v).level === 1);
  const list = (playable.length ? playable : pool).slice();
  list.sort((a, b) => nodePriority(a) - nodePriority(b) || b.time - a.time);
  return list[0] || null;
}

async function parseOnePage(page, opts) {
  const o = opts || {};
  const btn = pagesPanelEl.querySelector(`.page-btn[data-page="${page.page}"]`);
  if (btn) {
    btn.disabled = true;
    btn.textContent = '解析中…';
  }
  let resp = null;
  try {
    resp = await chrome.tabs.sendMessage(tabId, {
      type: 'PARSE_P',
      page: page.page,
      cid: page.cid,
    });
  } catch (e) {
    resp = null;
  }
  if (!resp || !resp.ok || !resp.added) {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '重试';
    }
    const why =
      (resp && resp.error) ||
      (resp && resp.ok === false ? '解析失败' : '页面无响应，请刷新页面后重试');
    if (!o.silent) toast(`P${page.page} 解析失败：${why}`, 4200);
    return { ok: false, error: why };
  }

  await sleep(250);
  await getVideos();
  render();

  // 合成一步：解析成功后直接把最佳链接放进剪贴板
  let copied = '';
  if (o.copy !== false) {
    const best = pickBestForPage(page);
    if (best && (await copyText(best.url))) copied = best.quality || '';
  }

  if (btn) {
    btn.textContent = copied ? '✓ 已复制' : '✓ 已解析';
    btn.classList.add('done');
    btn.disabled = true;
  }
  if (!o.silent) {
    if (copied) toast(`P${page.page} 已复制：${copied}（直接粘进 VRChat 即可）`, 3000);
    else toast(`P${page.page} 已解析，结果在下方列表`, 2600);
  }
  return { ok: true, added: resp.added, copied };
}

async function parseAllPages() {
  if (parsingPages || !pagesInfo) return;
  const list = pagesInfo.pages || [];
  if (!list.length) return;
  const limit = Math.min(list.length, 20);
  parsingPages = true;
  const allBtn = pagesPanelEl.querySelector('.page-all-btn');
  if (allBtn) {
    allBtn.disabled = true;
    allBtn.textContent = '解析中…';
  }
  let done = 0;
  const fails = [];
  for (let i = 0; i < limit; i++) {
    const page = list[i];
    const btn = pagesPanelEl.querySelector(`.page-btn[data-page="${page.page}"]`);
    if (btn && !btn.classList.contains('done')) {
      btn.textContent = `解析中 ${i + 1}/${limit}`;
    }
    const r = await parseOnePage(page, { silent: true, copy: false });
    if (r.ok) done += 1;
    else fails.push(`P${page.page}（${r.error}）`);
    await sleep(300);
  }
  parsingPages = false;
  if (allBtn) {
    allBtn.disabled = false;
    allBtn.textContent = '⚡ 解析全部分P（最多 20 个）';
  }
  if (fails.length) {
    toast(
      `成功 ${done}/${limit}，失败 ${fails.length} 个：${fails.slice(0, 2).join('；')}` +
        (fails.length > 2 ? ' …' : ''),
      5200
    );
  } else {
    toast(
      `全部分P已解析：${done}/${limit}` + (list.length > limit ? '（只处理前 20 个）' : '')
    );
  }
}

function renderPagesPanel() {
  pagesPanelEl.innerHTML = '';
  const pages = (pagesInfo && pagesInfo.pages) || [];
  if (pages.length < 2) return;

  const box = document.createElement('div');
  box.className = 'pages-box';

  const head = document.createElement('div');
  head.className = 'pages-head';
  const title = document.createElement('div');
  title.className = 'pages-title';
  title.textContent = '📚 分P：' + (pagesInfo.title || '未命名视频');
  const count = document.createElement('div');
  count.className = 'pages-count';
  count.textContent = `${pages.length} 个分P`;
  head.appendChild(title);
  head.appendChild(count);
  box.appendChild(head);

  const list = document.createElement('div');
  list.className = 'pages-list';
  pages.forEach((p) => {
    const row = document.createElement('div');
    row.className = 'page-row' + (p.page === pagesInfo.current ? ' current' : '');
    const idx = document.createElement('span');
    idx.className = 'page-idx';
    idx.textContent = `P${p.page}`;
    const name = document.createElement('span');
    name.className = 'page-name';
    name.textContent = p.part || `第 ${p.page} 段`;
    name.title = p.part || '';
    const dur = document.createElement('span');
    dur.className = 'page-dur';
    dur.textContent = fmtDuration(p.duration);
    const btn = document.createElement('button');
    btn.className = 'page-btn';
    btn.dataset.page = String(p.page);
    btn.textContent = '解析+复制';
    btn.title = '解析这个分P，解析成功后自动把最佳链接复制到剪贴板';
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await parseOnePage(p, { copy: true });
    });
    row.appendChild(idx);
    row.appendChild(name);
    row.appendChild(dur);
    row.appendChild(btn);
    list.appendChild(row);
  });
  box.appendChild(list);

  const actions = document.createElement('div');
  actions.className = 'pages-actions';
  const allBtn = document.createElement('button');
  allBtn.className = 'btn small page-all-btn';
  allBtn.textContent = '⚡ 解析全部分P（最多 20 个）';
  allBtn.title = '依次解析每个分P，会多请求几次接口，请耐心等待';
  allBtn.addEventListener('click', parseAllPages);
  actions.appendChild(allBtn);
  box.appendChild(actions);

  pagesPanelEl.appendChild(box);
}

function isBiliVideoPage() {
  try {
    const u = new URL(tabUrl);
    return (
      u.hostname.toLowerCase().endsWith('bilibili.com') &&
      (/^\/video\/(BV[0-9A-Za-z]+|av\d+)/i.test(u.pathname) ||
        /^\/bangumi\/play\/(ep\d+|ss\d+)/i.test(u.pathname))
    );
  } catch (e) {
    return false;
  }
}

function buildResolverLink() {
  try {
    const u = new URL(tabUrl);
    const domain = resolverDomain.trim();
    if (!domain) return '';
    const bm = u.pathname.match(/^\/video\/(BV[0-9A-Za-z]+|av\d+)/i);
    if (bm) return `https://${domain}/${bm[1]}`;
    const em = u.pathname.match(/^\/bangumi\/play\/(ep\d+|ss\d+)/i);
    if (em) return `https://${domain}/${u.href}`;
  } catch (e) {
    // ignore
  }
  return '';
}

function render() {
  let groups = buildGroups();
  // B 站 + 已配置中转服务：默认只显示中转链接（现成方案），内置解析折叠到「显示全部结果」
  if (isBiliVideoPage() && resolverDomain && !showAll) {
    const link = buildResolverLink();
    if (link) {
      const resolverEntry = {
        url: link,
        mime: '',
        source: 'resolver',
        href: tabUrl,
        quality: 'B站中转',
        time: Date.now(),
        expires: 0,
        group: 'resolver',
        node: '',
      };
      groups = [
        [resolverEntry],
        ...groups.filter((g) => g[0].source !== 'bilibili' && g[0].source !== 'bilibili-dash'),
      ];
    }
  }
  const flat = showAll
    ? groups.flatMap((g) => g.map((v) => ({ v, a: analyze(v), alts: null })))
    : groups.map((g) => {
        const best = g[0];
        return { v: best, a: analyze(best), alts: g.length > 1 ? g : null };
      });
  const rows = flat.sort((x, y) => x.a.level - y.a.level || y.v.time - x.v.time);

  // 工具条右侧的统计（纯展示，取不到元素就跳过，不影响功能）
  const statEl = $('stat');
  if (statEl) {
    statEl.textContent = videos.length
      ? `${videos.length} 条记录 · ${groups.length} 个视频`
      : '';
  }

  renderLiveBanner(groups);
  renderHlsBanner(groups);
  renderDashBanner(groups);

  listEl.innerHTML = '';
  emptyEl.style.display = rows.length ? 'none' : 'block';

  rows.forEach(({ v, a, alts }, idx) => {
    const li = document.createElement('li');
    li.className = 'item lv' + a.level;
    li.title = '点击复制链接';
    li.style.animationDelay = `${Math.min(idx, 12) * 40}ms`;

    let currentUrl = v.url;

    // 同一视频若同时有 DASH 视频流 + 音频流，说明可合并出 1080P MP4
    const gkey = groupKeyOf(v);
    const pool = videos.filter((x) => groupKeyOf(x) === gkey);
    const dashV = pool.find(
      (x) => x.source === 'bilibili-dash' && String(x.node || '').startsWith('视频流')
    );
    const dashA = pool.find(
      (x) => x.source === 'bilibili-dash' && String(x.node || '').startsWith('音频流')
    );
    if (dashV && dashA) a.note = 'DASH 分片：点右侧「⚙️ 合并命令」转成 1080P MP4';

    const top = document.createElement('div');
    top.className = 'row-top';
    top.innerHTML =
      `<span class="badge fmt">${a.format}</span>` +
      `<span class="badge src">${escapeHtml(a.label)}</span>` +
      (a.isLive ? `<span class="badge live">直播</span>` : '') +
      (v.part
        ? `<span class="badge part" title="${escapeHtml(v.part)}">${escapeHtml(v.part)}</span>`
        : '') +
      (v.quality
        ? `<span class="badge qn">${escapeHtml(showAll && v.node ? `${v.quality} · ${v.node}` : v.quality)}</span>`
        : '') +
      (alts ? `<span class="badge nodes">${alts.length} 个节点</span>` : '') +
      (a.note && a.note !== '可用于 VRChat' ? `<span class="note">${a.note}</span>` : '');

    const urlDiv = document.createElement('div');
    urlDiv.className = 'row-url';
    urlDiv.textContent = shortUrl(currentUrl);
    urlDiv.title = currentUrl;

    let nodeSel = null;
    if (alts) {
      nodeSel = document.createElement('select');
      nodeSel.className = 'node-select';
      nodeSel.title = '切换 CDN 节点';
      alts.forEach((alt) => {
        const opt = document.createElement('option');
        opt.value = alt.url;
        opt.textContent = alt.node || filenameOf(alt.url);
        opt.title = alt.url;
        if (alt.url === currentUrl) opt.selected = true;
        nodeSel.appendChild(opt);
      });
      nodeSel.addEventListener('change', () => {
        currentUrl = nodeSel.value;
        urlDiv.textContent = shortUrl(currentUrl);
        urlDiv.title = currentUrl;
      });
      nodeSel.addEventListener('click', (e) => e.stopPropagation());
    }

    const bot = document.createElement('div');
    bot.className = 'row-bot';
    bot.innerHTML = `<span class="time">${escapeHtml(fmtTime(v.time))}</span>`;

    if (v.expires) {
      const exp = document.createElement('span');
      exp.className = 'exp' + (isExpired(v) ? ' expired' : '');
      exp.textContent = isExpired(v) ? '⏰ 已过期' : fmtExpiry(v.expires);
      bot.appendChild(exp);
    }

    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.textContent = '复制';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      doCopy(currentUrl, btn, li);
    });
    bot.appendChild(btn);

    if (dashV && dashA) {
      const mbtn = document.createElement('button');
      mbtn.className = 'copy-btn merge-btn';
      mbtn.textContent = '⚙️ 合并命令';
      mbtn.title = '把 DASH 视频流 + 音频流合并成 1080P MP4（需先装 ffmpeg）';
      mbtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await copyText(buildDashMergeCommand(dashV.url, dashA.url));
        toast(ok ? '合并命令已复制：装好 ffmpeg 后粘到终端运行 ✓' : '复制失败');
      });
      bot.appendChild(mbtn);
    }

    li.appendChild(top);
    li.appendChild(urlDiv);
    if (nodeSel) li.appendChild(nodeSel);
    li.appendChild(bot);
    li.addEventListener('click', () => doCopy(currentUrl, null, li));
    listEl.appendChild(li);
  });

  scheduleProbe();
}

async function doCopy(url, btn, item) {
  const ok = await copyText(url);
  toast(ok ? '已复制到剪贴板 ✓' : '复制失败，请手动复制');
  if (!ok) return;
  if (btn) {
    btn.textContent = '已复制';
    btn.classList.add('done');
    setTimeout(() => {
      btn.textContent = '复制';
      btn.classList.remove('done');
    }, 1200);
  }
  if (item) {
    item.classList.add('copied');
    setTimeout(() => item.classList.remove('copied'), 650);
  }
}

// ---------- 页面提示卡片 ----------
const YT_HOSTS = new Set([
  'www.youtube.com',
  'm.youtube.com',
  'youtube.com',
  'youtu.be',
  'www.youtube-nocookie.com',
]);

// B 站登录状态检测（决定能否解析到 1080P）
async function checkLogin() {
  try {
    const r = await chrome.runtime.sendMessage({
      type: 'BILI_FETCH',
      url: 'https://api.bilibili.com/x/web-interface/nav',
    });
    const d = r && r.ok ? r.data : null;
    if (!d || d.code !== 0 || !d.data) return null;
    return { isLogin: !!d.data.isLogin, uname: d.data.uname || '' };
  } catch (e) {
    return null;
  }
}

function renderPageCard(url) {
  pageCardEl.innerHTML = '';
  if (!url || !/^https?:/i.test(url)) return;
  let u;
  try {
    u = new URL(url);
  } catch (e) {
    return;
  }
  const host = u.hostname;
  const bm = u.pathname.match(/^\/video\/(BV[0-9A-Za-z]+|av\d+)/i);
  const em = u.pathname.match(/^\/bangumi\/play\/(ep\d+|ss\d+)/i);

  const isBiliLive =
    host === 'live.bilibili.com' ||
    (host.endsWith('bilibili.com') && /^\/(blanc\/)?\d+\/?$/.test(u.pathname));
  const isLiveSite = /(^|\.)(douyu|huya|douyin|kuaishou|twitch)\.(com|tv)$/i.test(host);

  if (isBiliLive) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML =
      `<div class="card-title">🔴 Bilibili 直播</div>` +
      `<div class="card-text">直播流由插件<b>自动解析</b>（官方 playUrl 接口，免登录即可拿原画 FLV）。<br>` +
      `抓到后顶部会出现红色提示，提供「复制直播流地址 / 转推命令 / 录制命令」三件套。<br>` +
      `⚠️ VRChat 播放器不认 FLV / HLS，直播需要先<b>转推</b>到 Twitch / YouTube 才能直接在房间里播。</div>`;
    pageCardEl.appendChild(card);
  } else if (isLiveSite) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML =
      `<div class="card-title">🔴 直播页面</div>` +
      `<div class="card-text">斗鱼 / 虎牙 / 抖音这类站点，流地址由播放器动态签发（带签名 + 短时效）。<br>` +
      `用法：<b>先让直播画面跑起来</b>（进入房间、等几秒），再点右上角「🔄 扫描」，插件会把 FLV / M3U8 流抓出来。<br>` +
      `抓到后顶部会给出<b>转推 / 录制</b>命令——VRChat 不能直接播放直播流。</div>`;
    pageCardEl.appendChild(card);
  } else if (YT_HOSTS.has(host)) {
    const card = document.createElement('div');
    card.className = 'card youtube';
    card.innerHTML =
      `<div class="card-title">▶ YouTube</div>` +
      `<div class="card-text">VRChat 视频播放器原生支持 YouTube 链接，直接复制当前网址即可。</div>`;
    const btn = document.createElement('button');
    btn.className = 'btn block';
    btn.textContent = '复制 YouTube 链接';
    btn.addEventListener('click', async () => {
      const ok = await copyText(url);
      toast(ok ? '已复制 ✓' : '复制失败');
    });
    card.appendChild(btn);
    pageCardEl.appendChild(card);
  } else if (host.endsWith('bilibili.com') && (bm || em)) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML =
      `<div class="card-title">📺 Bilibili</div>` +
      (resolverDomain
        ? `<div class="card-text">✅ 已启用<b>中转服务</b>（现成解析方案）：<br>` +
          `B 站将直接显示绿色<b>中转链接</b>条目，复制即可在 VRChat 播放。<br>` +
          `内置解析结果保留在「显示全部结果」里，其他网站不受影响。</div>`
        : `<div class="card-text">B 站直链有 <b>Referer 防盗链</b>，VRChat 播放器不带 Referer 会被 403 拒绝。<br>` +
          `推荐：下方填入自建中转域名并「保存」，B 站将自动改用<b>中转链接</b>解析（最稳定）。<br>` +
          `未配置时可临时用条目的节点下拉框切换 CDN 节点。</div>`);

    // 中转域名设置
    const row = document.createElement('div');
    row.className = 'resolver-row';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = '中转域名，如 bili.你的域名.com';
    input.className = 'resolver-input';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn small';
    saveBtn.textContent = '保存';
    row.appendChild(input);
    row.appendChild(saveBtn);
    card.appendChild(row);

    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn block resolver-copy';
    copyBtn.textContent = '复制 VRChat 中转链接';
    copyBtn.style.display = resolverDomain ? '' : 'none';
    copyBtn.addEventListener('click', async () => {
      const domain = resolverDomain.trim();
      if (!domain) {
        toast('请先保存中转域名');
        return;
      }
      const target = bm ? `https://${domain}/${bm[1]}` : `https://${domain}/${u.href}`;
      const ok = await copyText(target);
      toast(ok ? '中转链接已复制 ✓' : '复制失败');
    });
    card.appendChild(copyBtn);

    const tip = document.createElement('div');
    tip.className = 'card-tip';
    tip.innerHTML =
      `免费自建：Cloudflare Workers 部署 <a href="https://github.com/Yamada-Ryo4/bili-resolver" target="_blank">bili-resolver</a>，` +
      `步骤见 README。国内需绑定自定义域名（workers.dev 无法访问）。`;
    card.appendChild(tip);

    const applyDomain = () => {
      const d = input.value
        .trim()
        .replace(/^https?:\/\//i, '')
        .replace(/\/+$/, '');
      if (d) {
        resolverDomain = d;
        chrome.storage.sync.set({ resolverDomain: d }).catch(() => {});
        input.value = d;
        copyBtn.style.display = '';
        toast('中转域名已保存');
      } else {
        resolverDomain = '';
        chrome.storage.sync.remove('resolverDomain').catch(() => {});
        copyBtn.style.display = 'none';
        toast('已清除中转域名');
      }
    };
    saveBtn.addEventListener('click', applyDomain);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') applyDomain();
    });

    if (resolverDomain) input.value = resolverDomain;

    // 目标画质（1080P 需登录 B 站；1080P+ / 4K 需大会员）
    const qnRow = document.createElement('div');
    qnRow.className = 'resolver-row';
    const qnSel = document.createElement('select');
    qnSel.className = 'node-select';
    qnSel.title = '目标画质：1080P 需登录 B 站，1080P+ / 4K 需大会员';
    [
      [80, '目标画质：1080P 高清'],
      [74, '目标画质：720P 60帧'],
      [64, '目标画质：720P 高清'],
      [32, '目标画质：480P 清晰'],
    ].forEach(([v, t]) => {
      const o = document.createElement('option');
      o.value = String(v);
      o.textContent = t;
      if (v === preferQn) o.selected = true;
      qnSel.appendChild(o);
    });
    qnSel.addEventListener('change', async () => {
      const q = parseInt(qnSel.value, 10) || 80;
      preferQn = q;
      try {
        await chrome.storage.sync.set({ preferQn: q });
      } catch (e) {
        // ignore
      }
      toast(`已设为 ${qnSel.options[qnSel.selectedIndex].textContent.replace('目标画质：', '')}，重新解析中…`);
      videos = [];
      render();
      scanPage();
    });
    qnRow.appendChild(qnSel);
    card.appendChild(qnRow);

    // B 站登录状态（决定能否解析到 1080P）
    const loginEl = document.createElement('div');
    loginEl.className = 'card-tip';
    loginEl.textContent = '正在检测 B 站登录状态…';
    card.appendChild(loginEl);
    checkLogin().then((info) => {
      if (!info) {
        loginEl.textContent = '未能检测登录状态（接口异常，可忽略此项）';
        return;
      }
      if (info.isLogin) {
        loginEl.innerHTML =
          `🔓 已登录${info.uname ? '：<b>' + escapeHtml(info.uname) + '</b>' : ''}` +
          `——单文件直链上限 <b>720P</b>（未登录 ≤480P）；` +
          `要 <b>1080P</b> 请解析后点顶部提示里的「⚙️ 复制 1080P 合并命令」`;
      } else {
        loginEl.innerHTML =
          '🔒 <b>未登录</b>：只能解析 480P 以下。请先在 Edge 登录 B 站，再点「🔄 扫描」';
      }
    });

    // 1080P 使用提示
    const q1080El = document.createElement('div');
    q1080El.className = 'card-tip';
    q1080El.innerHTML =
      'ℹ️ B 站<b>单文件 MP4 通道上限 720P</b>，1080P 只在 DASH 通道（音视频分离）。' +
      '解析完成后顶部会出现提示，点「<b>⚙️ 复制 1080P 合并命令</b>」用 ffmpeg 合并成 MP4 即可。';
    card.appendChild(q1080El);

    // 把冗长的说明收进「高级设置」，让首屏保持清爽（内容一字不少，展开即可看到）
    const adv = document.createElement('details');
    adv.className = 'adv';
    const advSum = document.createElement('summary');
    advSum.innerHTML = '⚙️ 高级设置<span class="adv-sub">画质 · 登录状态 · 1080P</span>';
    adv.appendChild(advSum);
    const advBody = document.createElement('div');
    advBody.className = 'adv-body';
    [tip, qnRow, loginEl, q1080El].forEach((node) => {
      if (node) advBody.appendChild(node);
    });
    adv.appendChild(advBody);
    card.appendChild(adv);

    pageCardEl.appendChild(card);
  }
}

// ---------- 诊断信息（纯文本，方便无法截图时粘贴交流） ----------
function buildDiagnostics() {
  const lines = [];
  lines.push(`VRChat 视频解析器 v${chrome.runtime.getManifest().version} 诊断信息`);
  lines.push(`页面: ${tabUrl || '(无)'}`);
  lines.push(`时间: ${new Date().toLocaleString('zh-CN')}`);
  const groups = buildGroups();
  lines.push(`检测结果: ${videos.length} 条原始记录，${groups.length} 个视频`);
  if (pagesInfo && pagesInfo.pages) {
    lines.push(`分P: 共 ${pagesInfo.pages.length} 个，当前 P${pagesInfo.current}，标题=${pagesInfo.title || '-'}`);
    lines.push(
      '分P明细: ' +
        pagesInfo.pages
          .slice(0, 8)
          .map((p) => `P${p.page}(cid=${p.cid})`)
          .join(' ') +
        (pagesInfo.pages.length > 8 ? ' …' : '')
    );
  } else {
    lines.push('分P: 无（单P视频，或分P信息没取到）');
  }
  groups.forEach((g, i) => {
    const v = g[0];
    const a = analyze(v);
    const exp = v.expires ? (isExpired(v) ? '已过期' : fmtExpiry(v.expires)) : '';
    const pb = probes[v.url];
    const pbTxt = pb
      ? ` | 探测: ${pb.ok ? 'OK' : '失败'} ${pb.type || '?'}${
          pb.size ? ' ' + Math.round(pb.size / 1048576) + 'MB' : ''
        }`
      : '';
    lines.push(`#${i + 1} [${a.format}] ${v.quality || ''} | ${a.note} | ${exp}${pbTxt}`);
    g.forEach((alt) => {
      lines.push(`   - ${alt.node || '节点'}: ${alt.url}`);
    });
  });
  if (!groups.length) lines.push('(无检测结果)');
  return lines.join('\n');
}

// ---------- 数据获取 ----------
async function getVideos() {
  try {
    const r = await chrome.runtime.sendMessage({ type: 'GET_VIDEOS', tabId });
    if (r && r.ok && Array.isArray(r.videos)) videos = r.videos;
  } catch (e) {
    // ignore
  }
}

async function scanPage() {
  if (scanning) return;
  if (!/^https?:/i.test(tabUrl)) {
    toast('当前页面不支持解析');
    return;
  }
  scanning = true;
  btnScan.disabled = true;
  btnScan.innerHTML = '<span class="spinner"></span>扫描中…';
  try {
    await Promise.race([
      chrome.tabs.sendMessage(tabId, { type: 'SCAN' }).catch(() => null),
      sleep(3000).then(() => null),
    ]);
  } catch (e) {
    // ignore
  }
  await sleep(450);
  await getVideos();
  render();
  await sleep(1200);
  await getVideos();
  render();
  scanning = false;
  btnScan.disabled = false;
  btnScan.textContent = '🔄 扫描';
  await refreshPages();
}

// ---------- 初始化 ----------
(async () => {
  try {
    const r = await chrome.storage.sync.get(['resolverDomain', 'preferQn']);
    resolverDomain = r && r.resolverDomain ? String(r.resolverDomain) : '';
    const q = parseInt(r && r.preferQn, 10);
    if (Number.isFinite(q) && q > 0) preferQn = q;
  } catch (e) {
    resolverDomain = '';
  }

  let tab = null;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = tabs && tabs[0];
  } catch (e) {
    tab = null;
  }
  tabId = tab && typeof tab.id === 'number' ? tab.id : null;
  tabUrl = (tab && tab.url) || '';

  renderPageCard(tabUrl);

  // 外观设置（自定义背景图 / 裁切 / 模糊 / 压暗）
  try {
    initBgSettings();
    await loadBg();
  } catch (e) {
    // 外观不影响主流程
  }

  // 版本号与 manifest 保持一致
  try {
    const verEl = $('ver');
    if (verEl) verEl.textContent = 'v' + chrome.runtime.getManifest().version;
  } catch (e) {
    // ignore
  }

  btnScan.addEventListener('click', scanPage);

  btnDiag.addEventListener('click', async () => {
    const ok = await copyText(buildDiagnostics());
    toast(ok ? '诊断信息已复制，粘贴到聊天即可 ✓' : '复制失败');
  });

  if (qqGroupEl) {
    qqGroupEl.addEventListener('click', async () => {
      const ok = await copyText('1130646085');
      toast(ok ? '群号已复制：1130646085 ✓' : '复制失败');
    });
  }

  chkAll.addEventListener('change', () => {
    showAll = chkAll.checked;
    render();
  });

  btnClear.addEventListener('click', async () => {
    try {
      await chrome.runtime.sendMessage({ type: 'CLEAR', tabId });
    } catch (e) {
      // ignore
    }
    videos = [];
    probes = {};
    render();
    toast('已清空');
  });

  btnCopyBest.addEventListener('click', async () => {
    const best = buildGroups()
      .map((g) => ({ v: g[0], a: analyze(g[0]) }))
      .filter((x) => x.a.level === 1)
      .sort((x, y) => y.v.time - x.v.time)[0];
    if (!best) {
      toast('暂无可用直链，请先扫描');
      return;
    }
    await doCopy(best.v.url);
  });

  await getVideos();
  render();
  if (tabId != null) scanPage();
})();
