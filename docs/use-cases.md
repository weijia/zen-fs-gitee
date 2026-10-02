# zen-fs-gitee 用例文档

> 文档目的：以参与者目标驱动，覆盖主 / 替 / 异流程。编号体系 `UC-`。涉及的需求见 `requirements.md`（FR-）。

## 用例清单
| 用例ID | 用例名 | 参与者 | 优先级 |
|--------|--------|--------|--------|
| UC-1 | 挂载并初始化仓库 | 应用 | P0 |
| UC-2 | 同步读取文件 | 应用 | P0 |
| UC-3 | 同步写入文件（含 mtime） | 应用 | P0 |
| UC-4 | 删除文件 | 应用 | P0 |
| UC-5 | 解析文件 mtime | 同步引擎 / 应用 | P0 |
| UC-6 | 构建同步快照 | 同步引擎 | P0 |
| UC-7 | 探测远端变更 | 同步引擎 | P0 |
| UC-8 | 与另一后端双向同步 | 同步引擎 | P0 |

---

## 用例详情：UC-1 挂载并初始化仓库
- **参与者**：应用
- **前置条件**：持有有效 Gitee token 且对 `owner/repo` 有写权限
- **基本流**：
  1. 应用调用 `configure({mounts:{'/repo':{backend:Gitee, token, owner, repo, branch}}})`
  2. `init()` 从 IndexedDB 热加载缓存（shaCache/contentCache/mtimeCache）
  3. 调用 tree API 拉取全量文件树，构建内存 Index
  4. 标记 `initialized=true`，记录分支最新提交 SHA 为基线
- **扩展 / 替代流**：
  - 2a. 配置分支不存在 → 从 `master` 创建该分支后重试
- **异常流**：
  - *a. tree API 鉴权/网络错误（非 404）→ `init()` 抛出异常，挂载失败
- **后置条件**：`/repo` 可读写，缓存与远端一致（或热加载命中）

---

## 用例详情：UC-2 同步读取文件
- **参与者**：应用
- **前置条件**：已初始化，且（默认）内容已预加载
- **基本流**：
  1. `fs.readFileSync('/repo/a.txt')` → 命中 `contentCache`，直接返回内容
- **扩展 / 替代流**：
  - 2a. 内容未缓存但 `disableAsyncCache=false` → 后台异步拉取并填充缓存
- **异常流**：
  - *a. 内容未缓存且 `disableAsyncCache=true` → 抛 `EAGAIN`，提示改用异步读
- **后置条件**：文件内容返回；命中缓存时不产生 API 调用

---

## 用例详情：UC-3 同步写入文件（含 mtime）
- **参与者**：应用
- **前置条件**：已初始化，目标路径可写
- **基本流**：
  1. `fs.writeFileSync('/repo/a.txt', data)`
  2. 合并 offset 写入 `contentCache`，立刻可同步读
  3. 后台排队调用 Contents API（`createFile` 或 `updateFile`）生成/更新 blob 与提交
  4. 同时写入 `.a.txt.mtime` sidecar，内容为当前 `mtimeMs`
- **扩展 / 替代流**：
  - 2a. 通过 `writeFile(path, data, {mtime})` 显式传入 mtime → sidecar 记录该值而非 `Date.now()`
- **异常流**：
  - *a. 写入 0 字节 → 以 `\n` 占位写入远端，本地 inode size 记为 0
  - *b. 后台 API 失败 → 被 `.catch` 吞掉，本地缓存已更新（最终一致性，由 `sync()` 等待）
- **后置条件**：`sync()` 后远端文件与 sidecar 均存在，mtime 可追溯

---

## 用例详情：UC-4 删除文件
- **参与者**：应用
- **前置条件**：文件存在
- **基本流**：
  1. `fs.unlinkSync('/repo/a.txt')`
  2. 分别删除数据文件与其 `.a.txt.mtime` sidecar（两次 Contents API DELETE）
  3. 从内存 Index 移除该路径
- **异常流**：
  - *a. 远端 SHA 未知（缓存缺失）→ 跳过对应 DELETE，仅清理本地
- **后置条件**：`sync()` 后远端数据文件与 sidecar 均消失，`stat` 返回 ENOENT

---

## 用例详情：UC-5 解析文件 mtime
- **参与者**：同步引擎 / 应用
- **前置条件**：文件存在
- **基本流**：
  1. `stat('/repo/a.txt')`
  2. 命中 `mtimeCache` 且 `fromSidecar=true` 且 SHA 未变 → 直接返回 sidecar 真实 mtime
- **扩展 / 替代流**：
  - 2a. 缓存无/过期 → 读 `.a.txt.mtime` sidecar（存在则解析为 mtimeMs 并缓存 `fromSidecar=true`）
- **异常流**：
  - *a. 无 sidecar（404，记入 `noSidecarCache` 带 TTL）→ 回退 Commits API 提交时间（`fromSidecar=false`）
  - *b. sidecar 内容不可解析 → 同样回退提交时间
- **后置条件**：返回尽量精确的 mtime，避免与源端真实时间不一致导致反复重同步

---

## 用例详情：UC-6 构建同步快照
- **参与者**：同步引擎
- **前置条件**：已初始化
- **基本流**：
  1. `createSnapshot(root, filter)`
  2. 一次 tree API 拉取全量；第一遍建立 sidecar→data 映射
  3. 第二遍为每个数据文件生成 `{path,size,mtimeMs}`：有 sidecar 取真实 mtime，否则用 `shaHash(blobSha)` 内容稳定代理
  4. 按 `filter` 的 include/exclude 前缀过滤；sidecar 文件被排除
- **异常流**：
  - *a. tree API 不可达 → 返回 `null`（调用方应跳过本轮同步）
- **后置条件**：返回可比较的快照；sidecar 不泄漏为用户可见文件

---

## 用例详情：UC-7 探测远端变更
- **参与者**：同步引擎
- **前置条件**：已初始化，存在基线 commit SHA
- **基本流**：
  1. `shouldSync()` 取分支最新提交 SHA
  2. 与 `lastCommitSha` 相同 → 返回 `false`（跳过同步）
  3. 不同 → 更新基线并返回 `true`
- **异常流**：
  - *a. API 错误 → 返回 `true`（fail-safe，宁触发同步不漏更新）
- **后置条件**：仅在远端确有新提交时触发同步

---

## 用例详情：UC-8 与另一后端双向同步
- **参与者**：同步引擎
- **前置条件**：已配置 `SyncPair(localFS, giteeFS, {direction:BiDirectional})`
- **基本流**：
  1. `pair.watch()` 定期轮询
  2. `shouldSync()` 为真时，引擎用 `createSnapshot` 比对两端
  3. 差异文件经 `writeFileWithMtime` 写入 Gitee，保留源端真实 mtime
- **后置条件**：两端内容一致且无「无差异空提交」循环（依赖 FR-6 / FR-11）
