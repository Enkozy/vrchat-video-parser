# Edge 加载项商店 · 提交材料

> 版本：2.3.2 ｜ 提交包：`VRChat-Video-Parser-v2.3.2-store.zip`
> 图标：`store-logo-300.png`（300×300）｜ 截图：`screenshot-1.png`、`screenshot-2.png`（1280×800）

---

## 一、基本信息（照抄）

| 字段 | 内容 |
|---|---|
| 显示名称（≤45 字符） | `VRChat 视频解析器` |
| 简短描述（≤132 字符） | `从网页提取视频直链（MP4/WebM），一键复制到 VRChat 视频播放器。支持 Bilibili（含分P/番剧）解析、斗鱼/虎牙/B站直播流抓取与转推。` |
| 类别 | 效率（Productivity） |
| 语言 | 中文（简体） |
| 是否收费 | 免费，无应用内购买 |
| 隐私政策网址 | `https://github.com/Enkozy/vrchat-video-parser/blob/main/store/privacy-policy.md` |
| 支持网址 | `https://github.com/Enkozy/vrchat-video-parser/issues` |
| 主页（可选） | `https://github.com/Enkozy/vrchat-video-parser` |

> 隐私政策链接建议用 **GitHub Pages**（例如 `https://enkozy.github.io/vrchat-video-parser/privacy-policy.html`）更稳妥；
> 用 `blob/main/...md` 这类链接审核大多也接受，被驳回时再换 Pages 即可。

---

## 二、详细描述（整段粘贴）

```
把网页上的视频，变成 VRChat 播放器能直接播放的直链。

【它能做什么】
· B 站视频 / 番剧：一键解析出可直接播放的直链，免 Referer 的通道优先（VRChat 成功率最高）
· B 站分P：弹窗顶部列出全部分P（标题 + 时长），点「解析+复制」即解析并复制该 P 的链接
· 1080P：B 站单文件通道上限 720P，1080P 走 DASH 通道，插件会自动给出可复制的 ffmpeg 合并命令
· 直播：B 站直播走官方接口直接拿流；斗鱼 / 虎牙 / 抖音等由浏览器嗅探抓取，并给出「转推 Twitch/YouTube」或「录制」的一键命令
· 其他网站：自动嗅探 MP4 / WebM / M3U8 等媒体地址，按视频分组折叠，同一视频的多个 CDN 节点用下拉框切换
· 直链探测：对看不出来的链接发一次 Range 请求，显示真实类型与体积，一眼判断是不是完整文件

【怎么用】
1. 打开视频网页（B 站视频页可直接用；其他站点建议先播放几秒）
2. 点击工具栏上的插件图标
3. 绿色条目的链接可用：点「复制」，或直接点该条目
4. 进入 VRChat，打开视频播放器，粘贴到 URL 栏播放

【界面】
· 深色玻璃质感界面，结果行按状态色条区分（绿=可直接播 / 黄=需处理 / 灰=分片）
· 可自定义背景图：支持拖动裁切、缩放、模糊、压暗，图片自动压缩且只保存在本机

【隐私】
· 纯本地运行，没有服务器，不收集、不上传任何数据
· 开源（MIT），代码可自行审查

【注意】
· 仅支持 Windows 版 Edge 111 及以上
· VRChat 播放器不支持 FLV / HLS 直播流，直播需要先转推或录制
· 部分网站有 Referer 防盗链，直链可能无法在 VRChat 中播放，插件会明确标注
· 本工具仅供个人学习与交流使用，不提供、不存储、不分发任何影视内容
```

---

## 三、权限申请理由（审核会逐条看，照抄）

| 权限 | 申请理由（英文，Partner Center 用英文填） |
|---|---|
| `storage` | Save the current tab's parse results and the user's own preferences (preferred quality, custom background image). Everything stays on the user's device; nothing is uploaded. |
| `tabs` | Read the current tab's URL (to detect whether it is a supported video page) and run a one-off scan in that tab when the user clicks "Scan". |
| `webRequest` | Observe media responses inside the current tab (URL + content-type only) so the popup can list playable video URLs. Response bodies are never read or stored. |
| `clipboardWrite` | The only output of the extension is a video URL; a "Copy" button writes it to the clipboard so the user can paste it into VRChat. |
| `cookies` | Only for `*.bilibili.com`: read the user's own login cookies to call Bilibili's public player API with the same permissions the user already has on the site (higher quality links). Cookies are sent only to bilibili.com, never to any third party. |
| Host permissions `http://*/*`, `https://*/*` | Video sniffing must work on any site the user visits — the extension cannot know in advance which site hosts a video. The extension only records media URLs that the page itself already requested. |

---

## 四、给审核人员看的备注（Certification notes）

```
This extension helps VRChat users get a playable video URL from a web page.
It does NOT download media, does NOT bypass DRM or paywalls, and does NOT store any content.

How it works:
1. Bilibili pages: the extension calls Bilibili's official public player API
   (api.bilibili.com/x/player/playurl) with the user's own cookies, and shows the
   returned URLs. Same data the page can already play.
2. Other sites: it passively observes media requests the page itself makes
   (webRequest, URL + content-type only) and lists them. No content is fetched.
3. For each listed URL it performs a single "Range: bytes=0-1" HEAD-like request
   to report real file type/size. No bulk downloading.

No remote server is involved. No analytics. No data leaves the browser
(except the Bilibili API calls described above).

Test steps: open https://www.bilibili.com/video/BV1GJ411x7h7 , click the toolbar icon,
wait 2 seconds; a green entry appears. Any Bilibili video works without login
(lower quality); login only raises quality.

Source code: https://github.com/Enkozy/vrchat-video-parser
```

---

## 五、提交步骤（Partner Center）

1. 打开 <https://partner.microsoft.com/dashboard/microsoftedge/overview>，用你的 Microsoft 账号登录
2. 首次使用需注册开发者：选择**个人（Individual）**，填写姓名/地址，验证邮箱（免费；公司账号需要额外验证）
3. 进入 **Microsoft Edge → 概述 → 新建扩展**
4. 上传 `VRChat-Video-Parser-v2.3.2-store.zip`
5. **属性**：类别选「效率」，语言选中文（简体）
6. **商店一览**：填显示名称、简短描述、详细描述；上传 `store-logo-300.png` 与两张截图
7. **隐私**：隐私政策填上面的链接；数据收集项全部选「否」
8. **提交选项**：市场填「公共」，发布时间选「认证通过后立即发布」
9. 点 **提交认证**，等待审核（通常 1~7 个工作日）

审核期间若收到驳回邮件，常见原因是权限过宽或"下载工具"定性，按邮件里的整改要求调整文案/权限后重新提交即可。
