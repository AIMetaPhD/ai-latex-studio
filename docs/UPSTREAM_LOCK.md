# 上游版本锁定（UPSTREAM_LOCK）

状态：**G1 进行中（候选已定，运行时待验证项标注 TODO）**
日期：2026-10-28

## 1. 结论：基线选 Overleaf CE 6.3.2，不采用 Gemini 建议的 5.5.7

| 候选 | 发布时间 | 判断 |
|---|---|---|
| **6.3.2** | 2026-10-23 | **选定**：当前最新正式版；Overleaf Toolkit 默认版本同步为 6.3.2（toolkit CHANGELOG 2026-10-23）；有完整 Toolkit 部署路径 |
| 6.3.1 | 2026-10-16 | 上一补丁版，仅作回退候选 |
| 5.5.7 | 2025-11-17 | **不采用**：距今约 11 个月，已落后两个大版本（6.x），无可辩护的维护优势 |

依据：Docker Hub `sharelatex/sharelatex` 标签列表（`page_size=25, ordering=last_updated`，2026-10-28 实测）；Overleaf Toolkit `CHANGELOG.md` 与 `lib/config-seed/version`。

> 注意：Docker 镜像 tag 与 `overleaf/overleaf` 的 Git tag 并不同名（仓库 Git tags 只有 `v0.1.x` 历史标签）。镜像 tag → 源码 commit 的映射须从镜像 OCI label（`org.opencontainers.image.revision`）读取，见 §4 TODO。**在取得该映射前，不得声称“源码基线已锁定到具体 commit”。**

## 2. 镜像摘要（pin）

| 项目 | 值 |
|---|---|
| 镜像 | `sharelatex/sharelatex:6.3.2` |
| 索引 digest（OCI image index） | `sha256:ada39211c54a1e748065834ec44d3a49094cc475c28d8b803a251901592a94b2` |
| `linux/amd64` manifest digest | `sha256:d17e196b04222837440b5efb2890864eb200a2e9341e434c0e6bd57a61011cbb` |
| 可用平台 | **仅 `linux/amd64`**（另有 `unknown/unknown` 证明用 attestation manifest） |
| 5.5.7 对照 | index `sha256:...`（未采用）；`linux/amd64` manifest `sha256:670e080892d210de903d3d524b9caeffba2cf670154f17222433d6149804161a` |

采集命令：Docker Registry v2 `GET /v2/sharelatex/sharelatex/manifests/6.3.2` + `Docker-Content-Digest` 响应头。

**Apple Silicon 结论（架构事实）**：官方未发布 `linux/arm64` manifest。macOS 只能走 (a) `platform: linux/amd64` 模拟执行，或 (b) 自行构建 arm64 镜像。二者都必须在真机测量。

## 3. Toolkit

| 项目 | 值 |
|---|---|
| 仓库 | `https://github.com/overleaf/toolkit` |
| commit | `1ae1306d83a2eeadae8eec8ff29df78149deb223`（2026-10-23） |
| 默认 CE 版本 | `6.3.2` |
| 许可 | 见 `LICENSE`（待与 CE 的 AGPL-3.0 一并归档到 THIRD_PARTY_NOTICES） |

## 4. 源码 revision 与验证边界

- 镜像 OCI label `com.overleaf.ce.revision = 370f4763da4bc910da8309c9a71c85ecbe39f6a7`（`docker inspect` Config.Labels 实测）。
- **验证边界（2026-10-29 复查，比先前结论更精确）**：
  1. `github.com/overleaf/overleaf` 的 `git-upload-pack` refs 枚举（345 行）显示 HEAD=`e039ad26…`，
     且**仓库仅发布 7 个 tag（v0.0.1-nightly … v0.2.0）**，与镜像版本 `6.3.2` 无任何对应关系。
  2. `raw.githubusercontent.com/overleaf/overleaf/<rev>/…` 与 `overleaf/web/<rev>/…` 均 404。
  3. 结论：该 label 是构建侧版本标识，**不能据此宣称"用户可从 GitHub 按 commit 获取对应源码"**。
- **AGPL 对应源码的可满足路径（本项目的实际依据）**：官方镜像自身即包含可读的服务端
  `.mjs`/`.ts` 源码（`/overleaf/services/web/app|frontend` 实测存在）；任何人 `docker pull`
  该 digest 即可获得与二进制对应的源码。因此本产品的"完整开源"承诺锚定在
  **pinned digest 镜像 + 本仓库叠加层源码**，README 必须如实这样写，不引用"GitHub commit 可追溯"。
- 前端源码级重建（G2 集成需要）以镜像内源码为基线；比对基准：
  `services/web/frontend/js/features/source-editor/extensions/realtime.ts` md5
  `5e95ea1ea7927f8733689448ef62e103`。

## 4b. G1 运行时已采集事实

- [x] CodeMirror 实际版本：镜像内 `services/web/package.json` 声明 `@codemirror/view 6.38.6`、`@codemirror/state 6.5.4`；探针 04/08 行为（dispatch→单历史→OT 同步→服务端往返）与 CM6 语义一致。
- [x] 镜像大小：`docker inspect` Size = 1,184,842,251 B（约 1.18 GB 压缩，解压 5.25 GB）。
- [x] 冷启动耗时：`bin/stop→bin/start` 容器就绪 34.0 s，HTTP 服务可响应再 +8.5 s（探针 07）。
- [x] IEEE fixture 编译：真实成功，PDF 162,679 B、1 页、0 错误行（探针 03）。
- [ ] toolkit LICENSE = AGPL-3.0（661 行，待写入 THIRD_PARTY_NOTICES）。


## 5. 禁止事项

- 禁止使用 `latest` 或浮动 `main` 作为构建输入。
- 禁止使用未经审计的社区 ARM64 镜像冒充官方支持。
- 镜像通过第三方加速地址拉取时，必须以官方 manifest digest 校验内容一致（见内部可行性记录 D-02）。
