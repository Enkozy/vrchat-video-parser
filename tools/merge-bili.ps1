# ============================================================
#  VRChat 视频解析器 · B站 1080P 一键合并脚本
#  用法：先在浏览器插件里点「⚙️ 合并命令」，再双击「一键合并.cmd」
# ============================================================
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

function Pause-Exit([int]$code) {
  Write-Host ''
  Read-Host '按回车键退出' | Out-Null
  exit $code
}

function Refresh-Path {
  try {
    $m = [System.Environment]::GetEnvironmentVariable('Path', 'Machine')
    $u = [System.Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = (($m, $u) | Where-Object { $_ }) -join ';'
  } catch {}
}

Write-Host ''
Write-Host '===== VRChat 视频解析器 · B站 1080P 合并 =====' -ForegroundColor Cyan
Write-Host ''

# ---------- 1. 检查 ffmpeg（缺了就自动装） ----------
Refresh-Path
$ff = Get-Command ffmpeg -ErrorAction SilentlyContinue
if (-not $ff) {
  Write-Host '[!] 未检测到 ffmpeg（合并视频必需）。' -ForegroundColor Yellow
  $ans = Read-Host '    是否现在自动安装？（需要 winget，约 1~3 分钟）[Y/n]'
  if ($ans -ne '' -and $ans -notmatch '^[Yy]') {
    Write-Host '    已取消。你也可以手动执行： winget install Gyan.FFmpeg'
    Pause-Exit 1
  }
  Write-Host ''
  Write-Host '    正在安装 ffmpeg，请稍候 ...' -ForegroundColor Cyan
  winget install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements
  Refresh-Path
  $ff = Get-Command ffmpeg -ErrorAction SilentlyContinue
  if (-not $ff) {
    Write-Host ''
    Write-Host '[!] 安装后仍未找到 ffmpeg。请关闭本窗口重新运行本脚本。' -ForegroundColor Yellow
    Pause-Exit 1
  }
}
Write-Host "[OK] ffmpeg 已就绪：$($ff.Source)" -ForegroundColor Green

# ---------- 2. 读取剪贴板里由插件复制的命令 ----------
$cmd = ''
try { $cmd = (Get-Clipboard -Raw) } catch {}
if (-not $cmd -or $cmd -notmatch 'ffmpeg') {
  Write-Host ''
  Write-Host '[!] 剪贴板里没有合并命令。' -ForegroundColor Yellow
  Write-Host '    请先：打开 B 站视频页 → 点插件图标 → 等扫描完成 → 点红色条目上的「⚙️ 合并命令」'
  Write-Host '    然后再双击本脚本。'
  Pause-Exit 1
}
$cmd = $cmd.Trim()

# ---------- 3. 输出到本文件夹的 merged 子目录 ----------
$outDir = Join-Path $PSScriptRoot 'merged'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$outFile = Join-Path $outDir ('bili_' + (Get-Date -Format 'yyyyMMdd_HHmmss') + '.mp4')
if ($cmd -match '"bili_1080p\.mp4"') {
  $cmd = $cmd -replace '"bili_1080p\.mp4"', ('"' + $outFile + '"')
}

Write-Host ''
Write-Host '将要执行：' -ForegroundColor Cyan
Write-Host $cmd -ForegroundColor DarkGray
Write-Host ''
Write-Host '开始下载并合并（1080P 视频通常 1~5 分钟，请勿关闭窗口）...' -ForegroundColor Cyan
Write-Host ''

Set-Location $PSScriptRoot
Invoke-Expression $cmd
$code = $LASTEXITCODE

# ---------- 4. 结果 ----------
Write-Host ''
if (Test-Path $outFile) {
  $size = [math]::Round((Get-Item $outFile).Length / 1MB, 1)
  Write-Host "[完成] 已生成：$outFile  （$size MB）" -ForegroundColor Green
  Write-Host ''
  Write-Host '下一步：把这个 mp4 上传到直链空间（推荐 Cloudflare R2），'
  Write-Host '        再把得到的 https 网址粘贴进 VRChat 的视频播放器。'
  Start-Process explorer.exe "/select,$outFile"
} else {
  Write-Host "[失败] ffmpeg 退出码：$code" -ForegroundColor Red
  Write-Host ''
  Write-Host '常见原因与处理：' -ForegroundColor Yellow
  Write-Host '  1) 链接已过期（B 站直链约 2 小时有效）'
  Write-Host '     → 回到视频页，点插件「🗑 清空」→「🔄 扫描」→ 重新点「⚙️ 合并命令」→ 再运行本脚本'
  Write-Host '  2) 网络中断 / 需要加速器 → 重试一次'
  Write-Host '  3) 若提示 403 → 同上，重新获取链接'
}
Pause-Exit 0
