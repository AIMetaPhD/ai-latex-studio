# 威胁模型（v0.1，可信本机使用）

> 本文件描述**已实测**的边界，区分「直接证据」「因果解释」「未验证」。任何一条都不构成
> “LaTeX 沙箱”或多租户隔离承诺。

## 1. 部署前提

- 目标：**单用户、可信本机**（`127.0.0.1`），Docker Engine/Compose，linux/amd64。
- 不提供公网托管、不承诺不可信多人使用、不承诺 SaaS 隔离。
- 默认绑定 `127.0.0.1`；`docker compose ps` 实测为 `127.0.0.1:8080/8081->80`。

## 2. 已实测的控制

| 控制 | 证据 | 边界 |
|---|---|---|
| CE 会话鉴权 | 匿名 `GET /api/ai/health` → **401**；`GET /api/ai/models` 同理 | 仅证明该网关路径；不证明全部 CE 路由 |
| 单用户免密入口（可选，默认关） | `AILS_LOCAL_AUTOLOGIN=1` 时：回环 Host 的匿名页面访问（含根 `/`）→ 302 至 `/ails-login`，以首个 admin 建会话并跳 `/project`。实测：根 `/` → `/project`（真实浏览器无 cookie 上下文，无登录表单）；伪造 `Host: evil.example` 的 `/` → 302 至 `/login`（不触发免密），`/ails-login` 冒名 Host → **403**；匿名 JSON API 仍 **401**；`/login` 仍 200 | 仅因端口只绑 `127.0.0.1` 才安全；**不要把 `OVERLEAF_LISTEN_IP` 改成 0.0.0.0 还开着它**。它是本机单用户便利项，不是鉴权机制 |
| CSRF | 登录后无 token `POST /api/ai/chat` → **403**；带 `x-csrf-token` → **200** | 由 CE 自身 `Csrf.validateToken` 校验 |
| CSP 未削弱 | 响应头 `script-src 'nonce-…' 'unsafe-inline' 'strict-dynamic' …` 保持；侧栏脚本以 `nonce=scriptNonce` 加载 | 未做 report-only 降级 |
| `\write18` 拒绝 | 容器内 `shell_escape=false` 时 `\immediate\write18{touch …}` **未生成文件**；构建期同样硬门禁 | TeX Live 2026 中 `openin_any` 已是官方 **no-op**，读任意文件**无法**靠该变量阻止 |
| 编译容器无云密钥 | compose 未向 CE 注入 `OPENAI_API_KEY`（仅 sidecar 持有） | 未做内核级隔离，属配置级 |
| Sidecar 无宿主端口 | compose 中 sidecar 无 `ports:`，仅 compose 网络内可达 | 同 Docker 网络的容器可访问，属设计内 |
| sidecar 需共享密钥 | 缺 `x-ails-gateway-secret` → 401（fail-closed：未配置密钥则全部 401） | secret 在 env，不在浏览器 |
| 编译容器降权 | `docker inspect` 实测：`cap_drop=[ALL]`、`cap_add=[CHOWN,DAC_OVERRIDE,FOWNER,SETGID,SETUID,KILL]`、`no-new-privileges`、`pids_limit=2048`；降权后建工程/上传/编译（PDF 162679 B）实测通过 | 进程仍是**容器内 root**；编译与被测文档**同容器** |
| 编译进程拿不到服务端密钥 | 构建期补丁从编译子进程环境里剔除 8 类变量（网关/invite/云 Key/Mongo/History/Redis），`Dockerfile` 用 `grep AILS_SECRET_STRIPPED` 复验；`doctor.sh` 也检查运行镜像是否带该补丁 | 这是**环境变量**层面的隔离，不是内核隔离；容器内其它文件仍可能被 TeX 读取 |
| 失控编译有两条边界 | 单次编译 180 s 墙钟截止（到点杀整个进程组，实测 181 s 终止）；容器级 `cpus=4` / `mem_limit=4g`（阈值实测：正常两页编译峰值 0.66 核 / 1.14 GiB） | 配额是**容器级**而非每次编译；命中内存上限时被杀的是分配进程，pid 1 自尽的场景未测 |
| 编译容器可出网 | 容器内 `wget http://example.com` 返回 0 | 文档在 shell escape 受限时无法主动外联；一旦放开 shell escape，这就是直接外泄通道 |

## 3. 已知残余风险（必须写进 README）

1. **CE 编译非沙箱**：恶意 `.tex` 仍可读取容器内可访问的文件（`openin_any` 无效）、消耗资源，
   且与 web 进程同容器。
   **环境变量这条已经堵上**：编译子进程的环境里不再有 `OVERLEAF_INVITE_TOKEN_SECRET`、`AI_GATEWAY_SECRET`、
   `OPENAI_API_KEY` 等 8 类变量（构建期补丁 + `grep` 复验 + doctor 检查）。**没堵上的是文件与进程层面**：
   编译与 web 同容器、同 uid，若 TeX Live 出现代码执行漏洞，进程仍能读编译用户可读的文件与同容器的其他进程。
   缓解：capability 白名单 + no-new-privileges + pids/CPU/内存上限 + 180 s 截止（实测）+ 容器无宿主敏感挂载；
   仅可信用户使用。真正隔离需把编译放进独立容器，**未做**。
2. **同主机 Docker 越权**：任何能访问 docker socket 的进程等同于 root。
3. **AI 上下文外发**：云端 BYOK 已实现，发送前强制显示将离开本机的内容并要求确认（P06）。
   **真实云端 smoke 未做**（无授权 Key、本网络不可达）→ 对"与 OpenAI/兼容端点互通"不作任何宣称。
4. **Sidecar 共享密钥的粒度**：G2 为「网关↔sidecar」单一共享密钥；G3 需评估按用户/请求签名。
5. **未测**：SSRF/DNS-rebind（G3）、恶意 TeX 全谱（G4/G5）、多用户并发（不在 v0.1 范围）。

## 4. 与“Local-first”的关系（B-10）

浏览器只是 UI；数据与编译都在本机容器卷（`ce-data`/`mongo-data`/`redis-data`）。
“能在浏览器打开”不等于“无后端”，也不等于“离线可用”——后者需 G3 的断网实测。
