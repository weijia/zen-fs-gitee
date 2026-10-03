# zen-fs-gitee 设计文档

> 文档目的：说明「怎么做」。先架构后细节。编号体系 `DM-`（设计决策）。涉及的需求见 `requirements.md`（FR-），用例见 `use-cases.md`（UC-）。

## 1. 概要设计

### 1.1 架构与分层
```
应用 / zen-fs-sync / zen-fs-cache
        │ 标准 fs API + 同步钩子
        ▼
   GiteeFS (extends IndexFS)        ← src/gitee-fs.ts
        │  HTTP (REST API v5)
        ▼
   GiteeAPI                         ← src/gitee-api.ts
        │  https://gitee.com/api/v5
        ▼
   Gitee 仓库（blob + commit on branch）
```
- **GiteeFS**：实现 ZenFS `FileSystem` 接口；维护内存 Index 与多套缓存，串行化后台写。
- **GiteeAPI**：封装 Contents API（`GET/POST/PUT/DELETE /repos/{o}/{r}/contents/{path}`）、Commits API（`GET last commit`）、Repos API（`GET tree`、`createBranch`、`getBranchSha`）。
- **utils.ts**：`mtimePathFor` / `sidecarToDataPath` / `isMtimeSidecar` / `shaHash` / `apiPath`。
- **index.ts**：导出 `Gitee` 类（含静态 `create` 工厂）。

### 1.2 模块职责
| 模块 | 职责 |
|------|------|
| gitee-fs.ts | 核心 FS：init / read / write / remove / stat / createSnapshot / shouldSync / getRevision |
| gitee-api.ts | 纯 HTTP 封装，不含业务状态 |
| utils.ts | 路径与哈希工具（mtime sidecar 映射） |
| types.ts | `GiteeOptions` 定义 |

### 1.3 缓存与持久化（数据模型）
本地缓存均以 `Map` 持有，并经 `IdbKVStore`（`zen-fs-cache`）持久化到 IndexedDB，**按 `zen-fs-gitee:{owner}/{repo}` 命名空间隔离**：

| 缓存 | Key → Value | 作用 |
|------|-------------|------|
| `shaCache` | path → blob SHA | 更新/删除需原 SHA；`getRevision` 来源 |
| `contentCache` | path → Uint8Array | 同步读；`stat` sidecar 解析 |
| `mtimeCache` | path → {sha, lastModified, fromSidecar} | mtime 解析优先源，`fromSidecar` 标记可信度 |
| `noSidecarCache` | path → timestamp | 负缓存（404），TTL=10min，避免 404 风暴 |
| `lastCommitSha` | 常量键 → SHA | `shouldSync` 基线 |

远端数据模型：每个用户文件 = 仓库内 blob；每次写生成一次提交；mtime 通过 **`.{name}.mtime` sidecar** 文件持久化（内容为 `mtimeMs` 字符串）。例：`/foo/bar.json` ↔ `/foo/.bar.json.mtime`。

### 1.4 关键依赖与边界
- 仅 Contents API 可写文件（Git Data API 在 Gitee 返回 404）。
- `disableAsyncCache=true` 时关闭预加载，同步读未命中即 `EAGAIN`。

---

## 2. 详细设计

### 2.1 接口 / API 契约
**`GiteeOptions`**：`token:string`（必填）、`owner:string`（必填）、`repo:string`（必填）、`branch?:string`（默认 `master`）、`baseUrl?:string`（默认 `https://gitee.com/api/v5`）、`disableAsyncCache?:boolean`。

**主要方法**：
| 方法 | 语义 | 关键行为 |
|------|------|----------|
| `init()` | 加载树 + 构建 Index + 热加载缓存 | 分支缺失则从 master 创建；清理远端已删的陈旧条目 |
| `preloadContents()` | 并发(≤8)预取内容 | 跳过 `.meta/.deleted/` 与 `.version` 等元数据 |
| `ready()` / `readySync()` | 等待初始化 | 未初始化同步调用抛 `EAGAIN` |
| `read/readSync` | 读内容 | 未命中同步读 → `EAGAIN` 并后台补读 |
| `write/writeSync` | 写内容（带 offset 合并） | 立即更新缓存；后台排队 API；**写 sidecar** |
| `writeFile/writeFileSync` | 透传 `{mtime}` 选项 | 转发给 `write`，确保 sidecar 被写入 |
| `writeFileWithMtime` | 原子写文件+sidecar | 先 API 成功再更新本地缓存（见 §2.4） |
| `remove/removeSync` | 删文件+sidecar | 两次 DELETE；同步移除内存 Index 条目 |
| `stat()`（override） | 解析真实 mtime | 四级优先级（见 §2.3） |
| `sync/syncSync` | 等待后台写 | `sync()` await `pending` |
| `createSnapshot` | 高效快照 | 单次 tree API，排除 sidecar（见 §2.5） |
| `getFileSha` / `getRevision` | 修订号 | 文件返回 blob SHA，目录/缺失返回 undefined |
| `shouldSync` | 变更探测 | 比较分支最新提交 SHA 与基线 |

### 2.2 初始化流程（DM-1 热启动）
`init()`：① 从 IndexedDB 热加载三套缓存与 `lastCommitSha` → ② `getTree` 拉取新鲜树 → ③ 逐条目构建 Index，SHA 未变的文件复用缓存内容（零重取），变则失效 → ④ 删除远端已不存在的陈旧条目 → ⑤ 批量持久化 SHA → ⑥ 记录基线 commit SHA（首次）。

### 2.3 mtime 解析优先级（DM-2）
`stat()` 的 mtime 解析顺序：
1. `mtimeCache` 且 `sha` 未变且 `fromSidecar=true` → 直接用真实 mtime；
2. `mtimeCache` 且负缓存（`noSidecarCache`）仍新鲜 → 用缓存值（可能是提交时间，已确认无 sidecar）；
3. 读 `.mtime` sidecar（存在则解析为真实 mtime，标记 `fromSidecar=true`）；
4. 回退 Commits API 提交时间（`fromSidecar=false`，避免跨周期误信）；
5. 返回 Inode 默认 mtime。

> `fromSidecar=false` 的提交时间**不被跨周期信任**：因 `writeFileWithMtime` 绕过本地 Index 直接写 sidecar，本地可能看不到 sidecar，若信任旧提交时间会触发「mtime 永不收敛→反复重 PUT」。

### 2.4 mtime sidecar 写入（DM-3，历史缺陷已修复）
- **问题**：早期 `write()`/`writeSync()` 只写数据文件、不写 sidecar，导致经普通写路径上云的文件无 sidecar，`stat()` 回退提交时间，源/目标 mtime 永远不一致，同步引擎每轮都重 PUT（「无差异空提交」）。
- **修复**：`write`/`writeSync`/`writeFile` 全部在写数据后调用 `writeMtimeSidecar`/`writeMtimeSidecarSync`，将 `effectiveMtime`（传入的 `mtime` 或 `Date.now()`）写入 `.{name}.mtime`。`writeMtimeSidecar` **拒绝嵌套**（已是 sidecar 的路径不再写 `.mtime.mtime`），并刷新数据文件的 `mtimeCache` 为 `fromSidecar=true` 使下次 `stat` 立即生效。
- **`writeFileWithMtime` 原子性**：先调用 Contents API 写数据与 sidecar，**两者都成功后**才更新本地 `contentCache/shaCache/inode/mtimeCache`，防止「缓存说存在但远端没写」导致引擎误判。
- **内容未变则只更新 sidecar**：`write`/`writeSync`/`writeFileWithMtime` 在写数据前先与 `contentCache` 中已缓存的远端内容做字节比对（`bytesEqual`）。若内容完全一致（仅 mtime 不同），**跳过数据文件写入**（不新增无意义的 commit），只写/更新 `.{name}.mtime` sidecar 以携带新的真实 mtime；已有的 blob SHA 保持不变。比对为纯内存操作（零网络）：正常同步中 `preloadContents()`/`read()` 已把数据内容缓存，因此该优化会生效；缓存未命中时保守地照常写数据文件。这正是消除「无差异空提交」循环（`docs/requirements.md` FR-6）的关键。

### 2.5 快照算法（DM-4）
`createSnapshot(root, filter)`：① 单次 `getTree`；② 第一遍用 `sidecarToDataPath` 建 `数据路径→sidecar路径` 映射（比 `isMtimeSidecar` 更可靠，能识别目录前缀路径如 `documents/.note.json.mtime`）；③ 第二遍为每个数据文件生成条目，mtime 优先取 sidecar 真实值，否则回退到 Commits API 的 commit 时间（`getLastCommit`，真实时间戳，缓存于 `mtimeCache` 并经 `noSidecarCache` 负窗口跨周期摊销，不回退到内容哈希）；④ 应用 `root`/`include`/`exclude` 前缀过滤；⑤ sidecar 文件被排除。API 不可达返回 `null`（fail-safe）。

> **Backend contract reference**: Excluding `.mtime` sidecars from `createSnapshot` (and from `readdir` / `stat`) implements the "internal files must be hidden from callers" rule in `zen-fs-sync/docs/SyncableFS.md` → 《后端实现契约》§1. For empty-directory survival, see the same doc §2: a backend that cannot store empty directories must create **and hide** its own placeholder on `mkdir`, and the sync engine preserves empty dirs by calling `mkdir` on the target — not by syncing the placeholder. Gitee's current placeholder behavior and the `\n` consistency risk are tracked in §5 open problem #3.

### 2.6 变更探测（DM-5）
`shouldSync()` 取分支最新提交 SHA 与 `lastCommitSha` 比较：相同→`false`；不同→更新基线并返回 `true`；首次/错误→`true`。仅 1 次 API 调用，不做树遍历。

---

## 3. 数据模型图（逻辑）
```
远端仓库
 ├─ foo/bar.json              (blob, 真实内容)
 ├─ foo/.bar.json.mtime       (sidecar: "1785066849718")
 └─ .gitignore.mtime          (注意：原文件名以 . 开头时不叠加点，见 utils)

本地（IndexedDB 命名空间 zen-fs-gitee:{owner}/{repo}）
 ├─ shaStore      : path → blobSha
 ├─ contentStore  : path → bytes
 ├─ mtimeStore    : path → {sha, lastModified, fromSidecar}
 └─ commitShaStore: 'lastCommitSha' → SHA
```

---

## 4. 非功能性设计
- **限流**：后台写经串行化 `pending` Promise 排队；单条失败 `.catch` 吞掉不阻断。
- **性能**：预加载并发 ≤8；快照仅 1 次 tree API。
- **可观测**：经 `@richard432/localstorage-logger` 输出日志。

---

## 5. 开放问题
1. **调试日志残留（建议修复）**：`stat()` 与 `writeFileWithMtime()` 中仍有 `console.log('[DIAG-GITEE] ...')` 诊断输出，应在发布前移除或降级为 `log.debug`。
2. **嵌套 sidecar 清理**：写逻辑对已存在的 `*.mtime.mtime` 仅告警不自动修复，需脚本清理历史脏数据。
3. **0 字节占位一致性**：`\n` 占位依赖 `writeFileWithMtime` 与 `createSnapshot` 两侧都按 size=0 还原；任一侧不一致会触发反复重同步。
4. **负缓存 TTL**：`noSidecarCache` 10min TTL 内若 sidecar 后写，需等 TTL 过期才被 `stat` 发现。
