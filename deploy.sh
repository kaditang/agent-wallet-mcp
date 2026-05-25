#!/bin/bash
# Fly.io 部署脚本 — agent-wallet-mcp

set -e
cd "$(dirname "$0")"

echo "=== 步骤 1: 检查 fly CLI ==="
if ! command -v fly &>/dev/null; then
  echo "❌ fly CLI 未找到，请先安装：https://fly.io/docs/hands-on/install-flyctl/"
  exit 1
fi
fly version

echo ""
echo "=== 步骤 2: 检查登录状态 ==="
fly auth whoami

echo ""
echo "=== 步骤 3: 测试 gate（不通过不部署）==="
# Mirror the CI gate — never ship a red test suite to the real-money path.
# `set -e` aborts the deploy if tests fail.
npm test

echo ""
echo "=== 步骤 4: 开始部署 ==="
fly deploy

echo ""
echo "=== 步骤 5: 查看应用状态 ==="
fly status

echo ""
echo "=== 步骤 6: 最近日志 ==="
fly logs --tail 20

echo ""
echo "✅ 全部完成！"
