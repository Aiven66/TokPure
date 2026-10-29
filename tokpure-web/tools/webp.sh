#!/usr/bin/env bash
# 把 assets/img 下的大图转成 WebP（需要 Homebrew 的 webp / cwebp）。
# 页面里用的是 900px（卡片大图）与 160px（缩略图）两档，按实际展示尺寸裁到够用为止。
set -euo pipefail
cd "$(dirname "$0")/../assets/img"

# 大图：900px 宽（约等于 450px 展示宽度的 2x）
for f in urban-night-raw urban-night-clean mac-studio-workstation apple-silicon-chip video-archivist; do
  cwebp -quiet -q 78 -m 6 -resize 900 0 "$f.jpg" -o "$f.webp"
done

# 缩略图：160px（40~48px 展示宽度的 3~4x）
for f in neon-dance architecture-drone culinary-pasta director-portrait; do
  cwebp -quiet -q 76 -m 6 -resize 160 0 "$f.jpg" -o "$f-thumb.webp"
done

# Logo：192px（页头 h-8 = 32px 的 6x，登录页也够用）
cwebp -quiet -q 88 -resize 192 192 logo.png -o logo.webp

echo "WebP 生成完成："
ls -la ./*.webp
