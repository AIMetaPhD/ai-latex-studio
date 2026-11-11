# AI LaTeX Studio（中文说明）

基于 **Overleaf 社区版（CE）** 的**本地优先网页应用**：一套浏览器界面、本地服务栈、本地存储、
本地 LaTeX 编译，AI 助手可接本地 Ollama 模型，或使用你自己的云 API Key。

> 状态：**预发布（v0.1.0 尚未发布）**。下面标注"已实测"的内容都在
> [已验证环境](#已验证环境) 中真实跑过；未实测的一律不宣称。

## 它是什么 / 不是什么

**是**：Overleaf CE 原有的项目管理、文件树、编辑器、编译、PDF 预览全部保留；新增一个可收起的
AI 侧栏，所有 AI 修改都以**可审阅的 Diff** 呈现，你点 Accept 才会改动，且走 CodeMirror 原生
编辑事务（一次 Ctrl+Z 即可撤销，并同步到协作服务端）。项目、数据库、PDF 都在本地 Docker 卷里；
云端模型逐条消息显式选择，发送前显示将外发的原文。

**不是**：桌面客户端（无 `.exe`/`.app`）、不是托管 SaaS、不替代 Overleaf 商业版、与 Overleaf
官方无隶属或背书关系。

## 已验证环境

| 层次 | 实测值 |
|---|---|
| 服务端 | Linux x86_64（WSL2 内 Ubuntu 22.04）、Docker Engine 29.7.2、Compose v5.5.0、`linux/amd64` 镜像 |
| 浏览器 | Chromium 148.0.7778.96（Playwright 自带） |
| 上游基座 | Overleaf CE 6.3.2，镜像 digest `sha256:ada39211…` |
| TeX | TeX Live 2026 + 学术宏包层（IEEEtran、cite、times、courier、xcolor） |
| 本地模型 | 宿主 Ollama（用 `qwen3.5:9b` 实测） |

**未验证**（不要假设）：Windows/macOS 上的 Docker Desktop、macOS 任意宿主、ARM64、Safari/Firefox。
详见 `docs/SERVER_SUPPORT_MATRIX.md`。

## 快速开始（已验证路径）

前置：Docker Engine + Compose v2、`openssl`，可选同机 Ollama。

```bash
git clone <本仓库> ai-latex-studio && cd ai-latex-studio
bash scripts/up.sh    # 首启路径（已实测）：生成密钥、获取 pinned 基础镜像（直连或经
                      # CE_MIRROR_URL 走镜像站）、校验 digest、构建并等待就绪
```

应用镜像已在本地后，下面这条更短的命令也已在全新数据卷上实测（CE 应答 200、
`doctor` 全绿、自测套件全绿；当前套件为 13 项，含 `X17` 聊天鉴权正例）：

```bash
docker compose -f infra/docker/docker-compose.yml up -d
```

**未验证**：在"只能经镜像站访问 Docker Hub、且本地完全无镜像"的环境做完整首启拉取；
该场景请用带 `CE_MIRROR_URL` 的 `up.sh`（见 `.env.example`）。

创建首个账号：CE 6.3.2 **没有首次访问注册**——`/launchpad` 不存在，`/register`
只显示"请联系管理员"（均在镜像内核实），所以用脚本建号，并顺带验证登录：

```bash
bash scripts/create-admin.sh you@example.com     # 生成密码并只打印一次
```

建议同时在 `.env` 里设置 `ADMIN_EMAIL`，那个页面上才会显示真实地址；
未设置时 `scripts/doctor.sh` 会给出警告（CE 会回落到 `placeholder@example.com`）。

然后打开 <http://127.0.0.1:8080> 登录。服务默认只绑定回环地址，
改动前请先读 `docs/THREAT-MODEL.md`。

**单用户免密（可选）。** 若是只绑回环的个人部署，可以不输密码：在 `.env` 里设
`AILS_LOCAL_AUTOLOGIN=1`，然后直接打开正常地址 <http://127.0.0.1:8080/>。
匿名的页面访问（包括根路径）会被转到 `/ails-login`，以第一个 admin 账号自动登录并
落到 `/project`。它只在请求 Host 为 `127.0.0.1`/`localhost`/`::1` 时生效（与回环端口
绑定一致），默认关闭，因此不会把应用暴露给其他机器。`/login` 仍可用于手动登录；
会话 cookie 与 CSRF 均不变。

### 本地模型（Ollama）

- **Docker Desktop**：`OLLAMA_URL=http://host.docker.internal:11434` 直接可用。
- **原生 Linux / WSL 的 Docker Engine**：`host.docker.internal` 指向 docker 网桥网关，
  那里没有监听。启动回环桥并把 sidecar 指过去：

```bash
docker compose -f infra/docker/docker-compose.yml --profile native-bridge up -d ollama-bridge
# 然后在 .env 设置：OLLAMA_URL=http://host.docker.internal:11435
```

桥只监听 docker 网桥地址并转发到宿主回环，**不会**把 Ollama 暴露到局域网。

### 云端模型（自带 Key）

在 `.env` 填 `OPENAI_API_KEY`；如需一个受管理员管控的 OpenAI 兼容端点，再填
`COMPAT_BASE_URL`/`COMPAT_API_KEY`。Key 只存在服务端，不下发浏览器、不进编译容器。
在侧栏选择云端 provider 时，会先显示将发送的原文，确认后才发出。

## 常用命令

| 命令 | 作用 |
|---|---|
| `scripts/up.sh` | 构建 + 启动并等待就绪（幂等） |
| `scripts/down.sh` | 停止；`--purge` 会二次确认后删除数据卷 |
| `scripts/doctor.sh` | 平台/架构、Docker 与 compose 插件、端口与只绑回环、密钥与 `ADMIN_EMAIL`、宿主与 sidecar 两侧的 Ollama、学术 TeX 宏包、**正在运行的那个镜像**里是否真带两处编译补丁、该容器的编译截止环境变量、磁盘余量 |
| `scripts/backup.sh` | 三个数据卷 + 镜像 ID 的一致性快照到 `backups/*.tar.gz`（先停服再导出；**若停不下来会直接中止**，不会把运行中的副本标成冷备份；`--hot` 是显式的不安全选项） |
| `scripts/restore.sh <文件>` | 先校验归档再恢复（需手动输入 `restore` 确认）；**hot/未知模式的归档默认拒绝**，需 `AILS_ALLOW_HOT_RESTORE=true`；恢复后会等 CE 真正应答才打印 restored |
| `scripts/scan-secrets.sh` | 发布门禁：扫跟踪内容（加 `--history` 扫全部可达提交；`--all` 再把 `git fsck` 找到的不可达对象并进来，并分别打印两个计数）。它需要操作者本机持有 `scripts/scan-secrets.local.sh`（已 gitignore，可从 `scripts/scan-secrets.local.example` 复制），里面放**你自己**那套私有基础设施特征；没有这个文件时门禁打印 `INCOMPLETE` 并 exit 2，**不会把更弱的扫描说成 clean** |
| `scripts/scan-package.sh <归档>` | 用同一口径检查交付包：先查条目名，再把解包后的树交给 `scan-secrets.sh` 自己扫——这样"包"和"仓库"不可能被两套规则分别评判 |

当前默认是冷快照（见 `scripts/backup.sh`）。它的完整闭环已于 2026-11-02 在本机**重新实测**，
跑在一次性的隔离 compose 项目上而不是现网：备份 → 清卷 → 恢复 → 重开，
**工程数据逐文件哈希一致、记录数一致**，恢复后的工程**重新编译通过**，
5 个异常输入（截断、缺 meta、缺卷、路径穿越、符号链接）在任何卷被触碰之前全部被拒。这次测量**不覆盖**：恢复过程中磁盘写满、
恢复进程被 kill 两种场景。

## 验证方式（2026-11-02 在参考机上实测）

```bash
cd services/ai-sidecar && npm test                                                                                # 31/31
# 想看清具体跑了哪些文件时，等价写法：
cd services/ai-sidecar && node --test test/proposal.test.mjs test/ssrf.test.mjs \
  test/byok-contract.test.mjs test/request-robustness.test.mjs
# 语法门禁：覆盖所有受版本管理的脚本与模块，不只是 scripts/*.sh ——
# qa/g0/restore-e2e.sh 是恢复闭环的关键脚本，glob 会漏掉它
for f in $(git ls-files '*.sh'); do bash -n "$f" || echo "FAIL: $f"; done          # 12/12 exit 0
for f in $(git ls-files '*.mjs'); do node --check "$f" || echo "FAIL: $f"; done    # 45/45 exit 0
bash scripts/doctor.sh                                                            # PASS=14 WARN=0（未设置 ADMIN_EMAIL 时 WARN=1）
CE_BASE_URL=http://127.0.0.1:8081 AILS_ADMIN_EMAIL=… AILS_ADMIN_PASS=… \
  node qa/g5/run-g5.mjs --out /tmp/g5                                             # 13/13
```

浏览器端到端套件**要求宿主 Ollama 正在运行且有至少一个模型**；否则侧栏模型下拉为空，
套件会停在第一个 AI 步骤。这是环境前置条件，不是产品缺陷（2026-11-02 实测并已定位）。

## 安全边界（对外暴露前必读）

- 仅限**可信本机单用户**，默认绑定 `127.0.0.1`。
- 同源 `/api/ai/*` 网关复用 CE 真实会话鉴权（匿名 401）与 CSRF（缺 token 403）；
  CSP **未削弱**，侧栏脚本用 CE 自带 nonce 加载。
- AI sidecar 不发布宿主端口，需共享密钥头。
- **编译不是沙箱**：`\write18` 已关闭并实测拒绝；但 TeX Live 2026 把 `openin_any`
  变成官方 no-op，恶意文档仍可读取编译用户可读的文件。缓解：不挂载宿主敏感目录、
  编译容器无云密钥、只给可信用户用。完整说明见 `docs/THREAT-MODEL.md`。
- 失控编译有两道边界：**墙钟截止**（默认 180 s，`COMPILE_TIMEOUT_MS`，到点杀整个进程组）
  与**容器上限**（默认 `CE_CPUS=4`、`CE_MEM_LIMIT=4g`）。两个默认值都是实测得出的，不是拍的；
  编译大文档可以调高。

## 许可与来源

本项目因衍生自 **AGPL-3.0** 的 Overleaf CE，同样以 **AGPL-3.0** 发布（见 `LICENSE`）。
上游以镜像 digest 锚定（见 `NOTICE.md`、`docs/UPSTREAM_LOCK.md`）。未使用 Overleaf
商标或商业版专有资源，也不暗示官方背书。

## 已知问题（v0.1）

- TeX Live 2026 的 `openin_any` 不再提供读保护（上游变更）。
- TeX 树的重建是"能力可复现"而非字节级可复现。
- 仅在上述参考服务端验证。
- 视觉检查为"同一页面 A/B"（冻结光标与动画后，比较注入节点存在与被移除），三档 viewport 未遮罩差异均为 0 px；
  **未**做"与独立构建的纯净 CE 镜像"对照，该项仍属未测量。
