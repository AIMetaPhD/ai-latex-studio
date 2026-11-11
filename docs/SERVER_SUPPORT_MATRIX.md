# 服务端与浏览器支持矩阵（实测驱动，v1.2 ADR-002）

> 规则：只有本文件标注 **VERIFIED** 的条目，README/Release 才能宣称支持。
> 未实测一律 `NOT_TESTED`；不得用浏览器可用推断服务端可部署。

## 服务端运行环境

| 服务端环境 | 状态 | 实测证据 |
|---|---|---|
| Linux x86_64 + Docker Engine/Compose + linux/amd64（本机为 WSL2 Ubuntu 22.04 内的原生 Engine 29.7.2） | **VERIFIED (G1 全链路)** | 内部可行性记录 §4 探针 01–10；冷启动 34 s + 就绪 8.5 s；编译/持久化/鉴权全通过 |
| Windows 11 + Docker Desktop (Linux containers) | NOT_TESTED | 本机未安装 Docker Desktop（D-01）；G2 在 WSL2 Engine 路径上固化安装脚本，Desktop 路径仅在另行实测后声明 |
| macOS Intel/Apple Silicon + Docker Desktop | NOT_TESTED | 无 mac 物理机；官方镜像仅 `linux/amd64` manifest（registry 实测），arm64 需模拟或自建，未验证 |
| Linux arm64 + Docker | NOT_TESTED | 本机无 arm64 环境 |

## 浏览器（前端）

| 浏览器 | 状态 | 证据 |
|---|---|---|
| Playwright 固定 Chromium 148.0.7778.96 | **VERIFIED (G1)** | 专用 profile + loopback CDP；REA+Playwright 同浏览器取证 `06-rea.json` |
| Chrome 156（宿主安装版） | NOT_TESTED（仅版本采集，未跑黄金路径） | — |
| Edge / Safari / Firefox | NOT_TESTED | — |

## 明确的支持声明口径（供 README/G6 使用）

- 可写：`Local-first Web App; verified on Linux x86_64 with Docker Engine/Compose (amd64 image) and Chromium; Ollama on host; BYOK cloud optional.`
- 在 G2–G5 补充实测前，不得写：`works on Windows/macOS out of the box`、`native ARM64`、`zero install`、`fully sandboxed`。
- Windows 用户当前唯一已验证路径 = 在 WSL2 Ubuntu 内安装 Docker Engine 后运行本仓库脚本；
  Docker Desktop for Windows 路径在实测（G2 候选）前标 `UNVERIFIED`。

## 变更纪律

每新增一个 VERIFIED 行，必须附：主机 `uname`/版本命令输出、Gate 探针编号、artifact 路径与 sha256，
并同步修改 README 支持表。撤销同样只能基于实测。
