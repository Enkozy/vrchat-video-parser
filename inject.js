// ============================================================
// VRChat 视频解析器 - 主世界注入脚本 (document_start)
// 版本标记：v1.7.2（本文件含 safeWrap 安全改写器 + fetch 双处理器）
// 在主世界（页面 JS 环境）中拦截 fetch / XHR / 历史跳转，
// 通过 postMessage 把发现的媒体地址交给隔离世界的 content.js。
//
// 注意：
//  1. 本文件运行在 MAIN world，不能使用 chrome.* API
//  2. 所有对浏览器原生方法的改写都通过 safeWrap 进行：
//     任何站点禁用/冻结 fetch、XHR、history 时都静默跳过，
//     绝不抛出未捕获异常（避免在 edge://extensions 里显示错误）
//  3. fetch 包装只做旁路观察：成功与失败处理器都直接挂在原 promise 上，
//     页面请求失败时不会产生「未处理的拒绝」而被误记为扩展错误
// ============================================================
(() => {
  try {
    if (window.__vrcParserInjected) return;
    window.__vrcParserInjected = true;

    const post = (data) => {
      try {
        window.postMessage(Object.assign({ __vrcParser: true }, data), '*');
      } catch (e) {
        // ignore
      }
    };

    const isMediaLike = (url) =>
      /\.(mp4|webm|m3u8|mkv|flv|mov|ogv)(\?|#|$)/i.test(String(url || ''));
    const isSegment = (url) => /\.(ts|m4s)(\?|#|$)/i.test(String(url || ''));
    const isMediaResponse = (url, ct) => {
      if (isSegment(url)) return false;
      if (isMediaLike(url)) return true;
      return /^video\//i.test(ct) && !/^video\/mp2t/i.test(ct);
    };

    // 安全改写：赋值失败时退回 defineProperty，再失败就放弃（不抛异常）
    function safeWrap(obj, prop, factory) {
      try {
        if (!obj) return false;
        const original = obj[prop];
        if (typeof original !== 'function') return false;
        const patched = factory(original);
        if (typeof patched !== 'function') return false;
        try {
          obj[prop] = patched;
          if (obj[prop] === patched) return true;
        } catch (e) {
          // 只读属性 / 仅 getter —— 继续尝试 defineProperty
        }
        try {
          Object.defineProperty(obj, prop, {
            value: patched,
            writable: true,
            configurable: true,
            enumerable: false,
          });
          return obj[prop] === patched;
        } catch (e) {
          // 不可配置 —— 放弃改写
        }
        return false;
      } catch (e) {
        return false;
      }
    }

    // ---------- 拦截 fetch ----------
    safeWrap(window, 'fetch', (origFetch) =>
      function () {
        const args = arguments;
        let reqUrl = '';
        try {
          const req = args[0];
          reqUrl = typeof req === 'string' ? req : req && req.url ? String(req.url) : '';
        } catch (e) {
          reqUrl = '';
        }
        const p = origFetch.apply(this, args);
        try {
          if (p && typeof p.then === 'function') {
            // 关键：把「成功」和「失败」两个处理器都直接挂到页面拿到的这个 promise 上。
            //  - 只做旁路观察，页面自己的 then/catch 语义完全不受影响
            //  - 页面请求失败时（被拦截/中断/网络抖动）不会出现「未处理的拒绝」，
            //    避免这种与插件无关的报错被 Edge 算到扩展头上
            p.then(
              (res) => {
                try {
                  if (!res) return;
                  const ct = String(
                    (res.headers && res.headers.get && res.headers.get('content-type')) || ''
                  );
                  const finalUrl = res.url || reqUrl;
                  if (isMediaResponse(finalUrl, ct)) {
                    post({ type: 'MEDIA', url: finalUrl, mime: ct });
                  }
                } catch (e) {
                  // ignore
                }
              },
              () => {}
            );
          }
        } catch (e) {
          // ignore
        }
        return p;
      }
    );

    // ---------- 拦截 XMLHttpRequest ----------
    const xhrProto =
      typeof XMLHttpRequest !== 'undefined' && XMLHttpRequest ? XMLHttpRequest.prototype : null;

    safeWrap(xhrProto, 'open', (origOpen) =>
      function (method, url) {
        try {
          this.__vrcUrl = String(url || '');
        } catch (e) {
          // ignore
        }
        return origOpen.apply(this, arguments);
      }
    );

    safeWrap(xhrProto, 'send', (origSend) =>
      function () {
        try {
          this.addEventListener('load', () => {
            try {
              const ct = String(this.getResponseHeader('content-type') || '');
              const url = this.responseURL || this.__vrcUrl || '';
              if (isMediaResponse(url, ct)) {
                post({ type: 'MEDIA', url, mime: ct });
              }
            } catch (e) {
              // ignore
            }
          });
        } catch (e) {
          // ignore
        }
        return origSend.apply(this, arguments);
      }
    );

    // ---------- 拦截 SPA 路由跳转 ----------
    const historyWrap = (orig) =>
      function () {
        const r = orig.apply(this, arguments);
        try {
          post({ type: 'NAVIGATE', href: location.href });
        } catch (e) {
          // ignore
        }
        return r;
      };
    safeWrap(window.history, 'pushState', historyWrap);
    safeWrap(window.history, 'replaceState', historyWrap);

    try {
      window.addEventListener('popstate', () => {
        post({ type: 'NAVIGATE', href: location.href });
      });
    } catch (e) {
      // ignore
    }
  } catch (e) {
    // 兜底：任何意外都不向外抛出，避免被记为扩展错误
  }
})();
