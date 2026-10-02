# zen-fs-gitee 需求文档

> 文档目的：对齐「做什么」与「做到什么程度」。本文件依据 `doc-writer` skill 规范编写，编号体系 `FR-`（功能）/ `NFR-`（非功能）。

## 1. 背景与目标

`zen-fs-gitee` 是 [ZenFS](https://github.com/weijia/zen-fs) 的一个后端（backend），通过 **Gitee REST API v5** 把标准 `fs` API 的文件操作映射到一个 Gitee 仓库。目标：让浏览器与 Node.js 都能像操作本地文件系统一样读写 Gitee 仓库，并可作为 `zen-fs-sync` 的同步端点做跨后端双向同步。

## 2. 范围

### 包含（In Scope）
- 把一个 Gitee 仓库挂载为 ZenFS 文件系统
- 通过标准 `fs` API 提供 `read` / `write` / `delete` / `stat` / `readdir` 等
- 同步读：挂载时预加载内容到内存缓存，`readFileSync` 开箱即用
- 异步写：`writeFileSync` / `removeSync` 立即更新本地缓存并后台排队 API 调用
- 每次写操作在目标分支生成一次提交
- 跨后端同步时保留文件真实 mtime（通过 `.mtime` sidecar）
- 浏览器与 Node.js 双环境
- 与 `zen-fs-sync` 兼容做双向同步
- 高效快照（`createSnapshot`）与变更探测（`shouldSync`）
- 为 `zen-fs-cache` 提供 `getRevision`（blob SHA）

### 不包含（Out of Scope）
- 硬链接 / 符号链接（返回 `ENOSYS`）
- 超出 Contents API 的 Git 级操作（如 rebase、PR）
- 同实例同时挂载多分支
- 仓库级权限管理（依赖 Gitee token 权限）

## 3. 干系人与角色
| 角色 | 职责 |
|------|------|
| 应用开发者 | 调用 `configure` / `fs` API 读写 Gitee 仓库 |
| 同步引擎（zen-fs-sync） | 调用 `createSnapshot` / `shouldSync` / `writeFileWithMtime` 做双向同步 |
| 缓存层（zen-fs-cache） | 调用 `getRevision` 判断内容是否变化 |

## 4. 功能需求
| 编号 | 需求描述 | 优先级 | 验收标准 |
|------|----------|--------|----------|
| FR-1 | 挂载即用 | P0 | 给定 `token/owner/repo/branch`，`configure` 后 `fs.readFileSync(path,'utf-8')` 返回仓库内该文件内容 |
| FR-2 | 同步读 | P0 | 默认预加载内容；`readFileSync` 无需异步即可返回。若 `disableAsyncCache=true` 且内容未缓存，同步读抛 `EAGAIN` |
| FR-3 | 异步写 | P0 | `writeFileSync` 立即更新本地缓存并排队后台 API；调用 `sync()` 后文件出现在仓库且内容一致，分支新增提交 |
| FR-4 | 删除 | P0 | `unlinkSync` 删除数据文件**及**其 `.mtime` sidecar，且从内存索引移除；`sync()` 后远端一并消失 |
| FR-5 | mtime 解析 | P0 | `stat()` 的 `mtimeMs` 优先取 `.mtime` sidecar 真实时间；无 sidecar 时回退到 Commits API 提交时间 |
| FR-6 | mtime sidecar 持久化 | P0 | 任意写路径（`write`/`writeSync`/`writeFile`/`writeFileWithMtime`）均写入 `.{name}.mtime`，内容为 `mtimeMs` 字符串 |
| FR-7 | 分支自动创建 | P1 | 配置分支不存在时，`init()` 从 `master` 创建该分支并使挂载成功 |
| FR-8 | 快照 | P0 | `createSnapshot` 通过一次 tree API 返回 `path→{size,mtimeMs}`；sidecar 不出现在快照中；有 sidecar 时取真实 mtime |
| FR-9 | 变更探测 | P0 | `shouldSync()` 比较分支最新提交 SHA 与基线；未变返回 `false`，有新版返回 `true`；首次/API 错误返回 `true`（fail-safe） |
| FR-10 | 修订号 | P1 | `getRevision` 对文件返回 40 位 blob SHA，对目录/不存在路径返回 `undefined` |
| FR-11 | 同步集成 | P0 | 与 `zen-fs-sync` 双向（`BiDirectional`）同步可用，内容无差异时不产生空提交 |
| FR-12 | 0 字节文件 | P1 | Gitee 不支持 0 字节，用 `\n` 占位；读取时还原为 0 字节（size=0） |

## 5. 非功能需求
- **NFR-1 限流**：Gitee 认证用户约 180 次/3 分钟；后台写通过串行化 `pending` Promise 节流，单个失败不阻断其余。
- **NFR-2 持久化**：`shaCache`/`contentCache`/`mtimeCache`/`lastCommitSha` 写入 IndexedDB，按 `owner/repo` 命名空间隔离，跨页面刷新保留。
- **NFR-3 性能**：预加载并发上限 8；快照仅 1 次 tree API。
- **NFR-4 环境**：同一份代码在浏览器与 Node.js 运行。

## 6. 依赖与约束
- peerDependency：`@zenfs/core ^2.5.0`
- 依赖：`zen-fs-cache`（IndexedDB KV）、`@richard432/localstorage-logger`
- 仅能用 Gitee Contents API 写文件（Git Data API 在 Gitee 返回 404）

## 7. 风险与开放问题
- `stat()` 与 `writeFileWithMtime()` 中残留 `[DIAG-GITEE]` 调试 `console.log`（见 `DESIGN.md` §开放问题），发布前应移除。
- 嵌套 sidecar（`*.mtime.mtime`）由写逻辑拒绝并告警，但已存在的脏数据需手动清理。
- 0 字节用 `\n` 占位，依赖 `writeFileWithMtime` 与 `snapshot` 两侧一致处理，否则会触发反复重同步。
