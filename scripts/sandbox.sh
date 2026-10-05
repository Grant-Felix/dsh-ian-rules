#!/usr/bin/env bash
# 插件开发用的隔离沙箱：在**独立的 DSH_HOME** 里装本插件、起一个 web 实例，
# 全程不碰你日常在用的 profile，也不碰你真实的规则文件。
#
# 为什么需要它：本插件的宿主半体是在 profile 启动时加载的，一个有问题的改动足以让
# 整个 DSH 起不来 —— 拿日常在用的 profile 试，代价就是「开发时把自己锁在门外」。
# 沙箱把这份风险圈进一个一次性 home：起不来就 clean 掉重来，真实环境毫发无损。
#
# 用法：
#   scripts/sandbox.sh            # 装本地检出（link:）并启动；Ctrl-C 结束
#   scripts/sandbox.sh check      # 自检 + 在沙箱里组装 profile（含本插件），不启动
#   scripts/sandbox.sh install    # 只安装 / 刷新沙箱里的插件
#   scripts/sandbox.sh clean      # 删掉整个沙箱 home
#
# 环境变量：
#   DSH_SANDBOX_HOME    沙箱 home（默认 <仓库>/.sandbox/home）
#   DSH_SANDBOX_PORT    监听端口（默认 3199；传 0 让系统挑）
#   DSH_SANDBOX_SOURCE  安装来源（默认 link:<仓库>）。想验「使用者装到的到底是什么」，
#                       就传发布来源，例如：
#                         DSH_SANDBOX_SOURCE=github:Grant-Felix/dsh-ian-rules npm run sandbox
#                         DSH_SANDBOX_SOURCE=git+https://gitee.com/Grant-Felix/dev-rules.git npm run sandbox  # Gitee 镜像未随更名改动
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sandbox_home="${DSH_SANDBOX_HOME:-$repo/.sandbox/home}"
port="${DSH_SANDBOX_PORT:-3199}"
source_spec="${DSH_SANDBOX_SOURCE:-link:$repo}"
profile_dir="$sandbox_home/profiles/web"
# 包名从清单里读，不在这里再写一份：改名的风险点正是「文档/脚本里还有一处旧名」。
pkg_name="$(sed -n 's/.*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$repo/package.json" | head -1)"
# 更名前用过的包名（由新到旧）：沙箱里如果还装着它们，装新名字之前要先摘掉，
# 否则 profile 会同时装两份，而 bundle 阵容里还挂着旧包名。
legacy_names=("dsh-agent-rules" "dsh-dev-rules")
[ -n "$pkg_name" ] || { echo "读不出 package.json 的 name。" >&2; exit 1; }

command -v dsh >/dev/null 2>&1 || {
  echo "找不到 dsh：先装 DeepSeek Harness CLI（npm install -g @deepseek-ai/dsh）。" >&2
  exit 127
}

# 安全闸。沙箱 home 一旦指到真实 home，这个脚本就开始动你日常在用的 profile ——
# 那正是它要防的事，所以宁可直接拒绝。
real_home="${DSH_HOME:-$HOME/.dsh}"
if [ "$sandbox_home" = "$real_home" ] || [ "$sandbox_home" = "$HOME/.dsh" ]; then
  echo "拒绝：DSH_SANDBOX_HOME 指向真实 DSH_HOME（$sandbox_home）。" >&2
  echo "沙箱的价值就在隔离，请换一个路径。" >&2
  exit 1
fi

export DSH_HOME="$sandbox_home"

# 保证沙箱里确实装着「本次来源」的本插件。
# 少了这一步，check 会在一个只有 base 的空 profile 上通过 —— 那是假绿灯：
# 组装绿了，却根本没验过本插件。
ensure_profile() {
  local recorded
  # 用 node 读依赖表，而不是对着 package.json 正则：包名进了变量之后，引号/转义
  # 在 shell 里很容易写错，而这里判错的代价是「以为装好了，其实装的是旧那份」。
  recorded="$(PKG="$pkg_name" DIR="$profile_dir" node -e "
    try {
      const pkg = require(process.env.DIR + '/package.json')
      process.stdout.write(String((pkg.dependencies ?? {})[process.env.PKG] ?? ''))
    } catch {}
  " 2>/dev/null || true)"
  if [ "$recorded" = "$source_spec" ]; then
    return 0
  fi
  if [ -n "$recorded" ]; then
    echo "沙箱里装的是「$recorded」，与本次来源「$source_spec」不同 → 重新安装"
  else
    echo "在沙箱初始化 profile 并安装 $source_spec"
  fi
  # 更名（dsh-agent-rules → dsh-ian-rules，更早还有 dsh-dev-rules）之后，旧名字那条依赖会让
  # profile 同时装两份，而 bundle 阵容里还挂着旧包名。装新名字之前先把它们逐个摘掉。
  for legacy_name in "${legacy_names[@]}"; do
    if grep -qF "\"$legacy_name\"" "$profile_dir/package.json" 2>/dev/null; then
      echo "沙箱里还装着更名前的 $legacy_name → 先移除"
      dsh plugin --profile web remove "$legacy_name" || true
    fi
  done
  dsh plugin --profile web add "$source_spec"
  # 自动登记 bundle 是 dsh plugin 的职责，但「装上了却没进阵容」会让后面全部失真，
  # 所以这里显式确认一次，不靠假设。
  grep -qF "\"$pkg_name\"" "$profile_dir/package.json" || {
    echo "安装后沙箱 profile 里仍没有 $pkg_name，中止。" >&2
    exit 1
  }
}

cmd="${1:-boot}"

# 客户端 bundle 注册的 id 必须等于包名。DSH 的客户端模块图是按**包名**建行的
# （dsh-client-modules：`table.set(packageName, { entry: graphRow(packageName, …) })`），
# 对不上就在启动时报「Failed to load plugins：loaded without registering …」——
# 界面直接打不开，而宿主接口还是好的：只 curl /ian-rules/state 根本看不出来。
#
# 仓库里的用例只保证「检出里的文件」一致；这里保证**沙箱里装的那一份**一致 ——
# 来源换成 github: / git+… 时，两者未必是同一份代码。
verify_client_id() {
  local dir="$sandbox_home/profiles/web/node_modules/$pkg_name"
  [ -d "$dir" ] || { echo "沙箱里找不到已安装的插件目录：$dir" >&2; exit 1; }
  PLUGIN_DIR="$dir" node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs'
const dir = process.env.PLUGIN_DIR
const pkg = JSON.parse(readFileSync(dir + '/package.json', 'utf8'))
const field = pkg.exports?.['./client']
const rel = typeof field === 'string' ? field : (field?.default ?? '')
if (rel === '') {
  console.error('package.json 没有 exports["./client"]，DSH 找不到客户端半体')
  process.exit(1)
}
const source = readFileSync(dir + '/' + rel.replace(/^\.\//, ''), 'utf8')
// 允许 load({ 与 id: 之间夹注释与空白：本文件恰好就在那儿写明了「为什么 id 必须等于包名」
const found = /__ModuleLoader__\s*\.\s*load\s*\(\s*\{[\s\S]{0,600}?\bid:\s*['"]([^'"]+)['"]/.exec(source)
if (found === null) {
  console.error('客户端 bundle 里没有 __ModuleLoader__.load({ id })')
  process.exit(1)
}
if (found[1] !== pkg.name) {
  console.error(`客户端注册 id「${found[1]}」≠ 包名「${pkg.name}」：DSH 启动会报 Failed to load plugins`)
  process.exit(1)
}
console.log(`✓ 客户端注册 id 与包名一致：${pkg.name}`)
NODE
}

case "$cmd" in
  check)
    # 组装能过 ≠ 运行能过，但组装过不了就一定起不来；先把它和自检一起卡掉最便宜
    npm --prefix "$repo" run check
    ensure_profile
    verify_client_id
    dsh --profile web --dump-config >/dev/null
    echo "✓ 自检、客户端注册 id 与 profile 组装都通过（沙箱 home：$sandbox_home，来源：$source_spec）"
    ;;
  install)
    ensure_profile
    ;;
  clean)
    rm -rf "$sandbox_home"
    # 默认布局是 <仓库>/.sandbox/home：home 删掉后 .sandbox 会空着，顺手收掉，
    # 免得工作树里留个空目录让人以为还有东西。自定义路径只删它自己，不动父目录。
    case "$sandbox_home" in
      "$repo/.sandbox"/*) rmdir --ignore-fail-on-non-empty "$repo/.sandbox" 2>/dev/null || true ;;
    esac
    echo "已删除沙箱 home：$sandbox_home"
    ;;
  boot)
    ensure_profile
    echo "隔离实例：DSH_HOME=$sandbox_home  端口=$port  来源=$source_spec"
    echo "（它读沙箱自己的 ian-rules.json，不会碰 ~/.dsh/ian-rules.json）"
    # 改完代码重跑这一条即可；--no-open 免得每次弹浏览器
    exec dsh --profile web --port "$port" --no-open
    ;;
  *)
    echo "用法：$0 [boot|check|install|clean]" >&2
    exit 2
    ;;
esac
