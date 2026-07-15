这是一个非常典型且极具商业潜力的“多模态AI生产力工具”架构设计。针对你的需求，我将从**技术选型评估**、**三端实现边界划分**、**API规划**、**核心数据结构设计**以及**MVP 工程落地约束**五个维度提供架构方案。

---

### 一、 技术选型评估

#### 1. 手机端：React Web 框架（H5/SPA）
**结论：MVP 采用“React + Capacitor”方案。**
*   **优势**：React 生态极其成熟，组件库丰富，且与 PC 端（Electron）可以**共用一套核心代码库（Monorepo）**，极大降低多端维护成本。
*   **纯 Web 端的致命挑战**：
    *   **本地录音识别 (ASR)**：纯 Web 端（H5）很难做高质量的离线本地 ASR。`Web Speech API` 兼容性差且依赖网络；如果用 WebAssembly 跑 Whisper 等模型，对手机浏览器内存和算力消耗极大，容易崩溃。
    *   **硬件与权限**：iOS Safari 和微信环境对 `getUserMedia`（录音/拍照）的限制很多，后台录音容易被系统杀进程。
    *   **手写体验**：Canvas 在移动端处理高频触摸事件（Touch）时，如果不做防抖和贝塞尔曲线平滑，笔锋和延迟体验会很差。
*   **实现方案**：使用 React 开发 SPA，然后通过 **Capacitor** 打包成原生 App（iOS/Android）。这样既能复用 Web 代码快速上线，又能通过原生插件（Capacitor Plugins）调用底层麦克风、相机和文件能力。MVP 阶段不把端侧 ASR 作为主路径，云端 ASR 更稳定；端侧 ASR 只作为离线草稿或隐私场景的增强能力。

#### 2. 电脑端：Electron
**结论：MVP 采用 Electron。**
*   **优势**：可以直接复用 React 代码；拥有完整的本地文件系统访问权限；支持复杂的快捷键绑定；方便集成端侧大模型（如本地部署的 Ollama/Llama.cpp）用于隐私要求极高的数据或离线 AI 补全。
*   **非 MVP 方案**：Tauri 可作为后续安装包体积和内存优化方向，但不进入 MVP 技术栈。

---

### 二、 三端实现边界划分

核心原则：**电脑端与移动端功能边界一致，交互密度不同；端侧负责编辑、采集、预览与轻量 AI，云侧负责重算力、重存储和异步转换。**

这里的“一致”不是指两端使用完全相同的界面，而是指用户在任一端都能完成同一类核心任务：创建手稿、采集多模态素材、编辑文档、调用 AI、预览结果、同步和导出。差异主要体现在交互路径和细节暴露程度上，类似 Apple Pages 在 Mac 与 iPhone 上的关系：Mac 端提供完整工具栏、检查器、快捷键和精细排版；iPhone 端保留同一文稿能力，但把复杂设置折叠到底部面板、上下文菜单和分步流程中。

#### 1. 手机端 (Mobile Web / Hybrid App)
*   **定位**：移动场景下的完整文稿入口，强调快速采集、轻量编辑、即时修订和碎片化处理。
*   **功能边界**：与电脑端共享同一套 `Manuscript` / `Document` 数据模型，支持创建、打开、编辑、AI 处理、同步、预览和导出，不把移动端降级为单纯采集器。
*   **核心职责**：
    *   **多模态采集**：调用麦克风（含后台录音策略）、相机、相册、触控笔/手指输入，快速插入音频、图片、手写和文本 Block。
    *   **轻量文本编辑**：支持标题、段落、列表、引用、加粗、斜体、链接、图片说明等高频编辑能力；复杂样式、页面设置、批量排版等功能通过折叠面板提供，而不是常驻暴露。
    *   **移动端交互适配**：采用单列文档流、底部工具栏、浮动插入按钮、长按菜单、选区气泡、底部 Sheet 和全屏专注编辑，避免桌面端式的多栏检查器和密集工具条。
    *   **手稿画布与标注**：使用 `Konva.js` + `react-konva` 渲染多模态 Block；移动端优先支持手写、圈画、批注、局部擦除和图片标记，不追求桌面级复杂图层管理。
    *   **轻量 AI 交互**：提供选中文本润色、摘要、续写、语音转文字、图片/手写识别等高频动作；长文档 RAG、批量重排和复杂 Agent 工作流通过简化入口触发云端任务。
    *   **离线缓存与弱网续传**：使用 IndexedDB / SQLite 缓存未上传的手稿、录音切片和编辑操作，网络恢复后自动增量同步。
*   **交互取舍**：移动端不取消核心能力，但减少同时呈现的信息量；优先保证单手操作、低误触、快速撤销、断点续写和短时间内完成一次编辑闭环。

#### 2. 电脑端 (Electron)
*   **定位**：完整文档编辑器、AI Agent 工作台、知识管理中枢，强调长时间深度编辑、结构化整理和精细控制。
*   **功能边界**：与移动端共享同一套核心功能和数据结构，但暴露更完整的编辑工具、排版能力、快捷键体系、多窗口能力和批量处理能力。
*   **核心职责**：
    *   **完整富文本编辑**：基于 `BlockSuite` 构建 Block 编辑器，支持复杂嵌套、表格、引用、代码块、目录、跨 Block 拖拽和批量格式调整。
    *   **精细排版与检查器**：提供类似 Pages Mac 端的顶部工具栏、右侧检查器、样式面板、页面设置、段落属性、对象属性和文档级元数据管理。
    *   **多窗口/多标签页**：支持分屏查看原始手稿、转换后的正式文档、AI 建议和参考资料，适合进行长文档整理和对照编辑。
    *   **AI Agent 交互**：提供侧边栏 AI 对话框，支持划词解释、润色、续写、基于全篇文档的 RAG（检索增强生成）问答，以及更复杂的批量改写、结构重组和知识库检索。
    *   **本地存储与同步**：管理本地文档库，处理与云端的双向增量同步；MVP 先采用 Block 级增量同步、`revision` 和操作日志，后续多人实时协作再演进到 Yjs / CRDT。
*   **交互取舍**：电脑端不改变核心数据模型，但允许更高的信息密度和更复杂的并行操作；面向键盘、鼠标、触控板和大屏多任务，而不是把移动端交互简单放大。

#### 3. 双端一致能力与差异化交互
*   **能力一致**：创建/编辑文档、插入多模态素材、AI 辅助处理、预览、同步、导出、版本恢复等核心能力应在电脑端和移动端都存在。
*   **移动端简化**：同一能力在移动端优先以“任务流”呈现，例如“选中文本 -> AI 润色 -> 预览差异 -> 应用”，而不是常驻复杂面板。
*   **电脑端增强**：同一能力在电脑端优先以“工作台”呈现，例如侧边栏 Agent、右侧检查器、可停靠面板、多标签页和快捷键命令面板。
*   **共享数据模型**：两端必须读写同一份 Block JSON，避免出现“移动端文档”和“电脑端文档”两套格式；差异只发生在 UI 层和部分端侧能力调用方式上。
*   **渐进暴露**：高频能力直接可见，低频高级能力隐藏在更多菜单、检查器或设置页中；移动端隐藏得更深，电脑端暴露得更完整。

#### 4. 后端服务 (Cloud Backend)
*   **定位**：多模态 AI 引擎、数据中枢、重型文件处理厂。
*   **核心职责**：
    *   **多模态 LLM 解析 (核心)**：接收包含音频、图片、手写轨迹的 JSON 手稿，调用多模态大模型（如 GPT-4o, Qwen-VL, Claude 3.5 Sonnet），将其“翻译”并排版成结构化的富文本（Markdown 或 Block JSON）。
    *   **AI Agent 服务**：提供基于长文本的 RAG 服务、文档润色、摘要生成。
    *   **ASR 服务**：作为 MVP 阶段的主路径，接收音频 Asset 进行云端语音转文字；MVP 主实现使用阿里云百炼 DashScope `qwen3-asr-flash`，通过 Python SDK 以 Base64 data URI 传入音频；Azure Speech Fast Transcription 保留为后续 fallback provider。端侧 ASR 只作为离线增强。
    *   **格式导出工厂**：使用 Headless Chrome (Puppeteer) 生成 PDF，使用 LibreOffice 模板化方案生成 DOCX。

---

### 三、 API 契约

本章是 MVP 的前后端实现契约。除特别说明外，所有接口都使用 JSON，所有时间都是 UTC ISO 8601 字符串，所有金额、时长和文件大小都使用整数原子单位，例如 `duration_ms`、`size_bytes`。SSE 流式接口使用 `Content-Type: text/event-stream`。客户端必须按本章字段实现，不再各端自行扩展传输结构。

#### 1. 通用约定

*   **Base URL**：`/api/v1`
*   **Content-Type**：`application/json; charset=utf-8`
*   **认证头**：`Authorization: Bearer <access_token>`，除注册、登录、刷新 Token 和分享链接公开访问外均必填。
*   **设备头**：`X-Client-Id: device_abc`，所有登录后的写接口必填，对应 Block 中的 `client_id`。
*   **幂等头**：`Idempotency-Key: <uuid>`，所有创建任务、上传、导出、AI 调用和同步写接口必填。服务端以 `user_id + endpoint + Idempotency-Key` 去重。
*   **请求追踪**：客户端可传 `X-Request-Id`；服务端响应必须返回 `X-Request-Id`，没有传入时由服务端生成。
*   **分页参数**：列表接口统一使用 `limit` 和 `cursor`，`limit` 默认 20，最大 100。`cursor` 是服务端生成的不透明字符串，客户端只能保存和回传，不得解析、拼接或假设其内部结构。
*   **分页响应**：列表响应统一返回 `{ "items": [], "next_cursor": null, "sort_by": "updated_at,id", "sort_order": "desc" }`。`next_cursor` 只保证在当前资源 revision 附近稳定，不承诺永久有效。
*   **ID 格式**：服务端生成带前缀字符串 ID，例如 `u_`、`device_`、`asset_`、`m_`、`doc_`、`block_`、`task_`、`export_`。
*   **权限模型**：MVP 支持 `owner`、`editor`、`viewer` 三种文档权限；默认新建文档和手稿只有 `owner` 可访问。
*   **平台枚举**：`platform` 固定为 `ios`、`android`、`mac`、`windows`、`web`。
*   **Token 时效**：`access_token` 有效期 30 分钟，`refresh_token` 有效期 30 天。刷新成功后旧 refresh token 立即失效，采用轮换机制。
*   **限流响应**：超过限制返回 `429 Too Many Requests`，响应头包含 `Retry-After` 秒数。
*   **写入字段归属**：客户端负责生成 `block.id`、`op_id`、`client_id`、`platform` 和离线编辑时的 `created_at`；服务端根据 Token 校验或填充 `author_id`，并生成资源级 `revision`。如果请求体中的 `author_id` 与当前 Token 用户不一致，返回 `422 validation_error`。
*   **Revision 规则**：`base_revision` 必须等于客户端最后一次成功同步时拿到的资源级 `revision`。服务端成功应用操作后，资源级 `revision` 自增；Block 级 `revision` 用于定位 Block 内部变更，不作为资源级冲突判断的唯一依据。
*   **幂等有效期**：`Idempotency-Key` 有效期 24 小时。服务端缓存 `(user_id, endpoint, key) -> {request_hash, response}`；请求体 hash 相同则返回缓存响应，请求体 hash 不同则返回 `409 idempotency_conflict`。缓存丢失时允许重新执行，业务层仍需通过资源 ID、任务 ID 或引用计数避免不可逆副作用。
*   **时间可信度**：客户端提交的 `created_at` 用于还原离线创作时间，服务端不覆盖，但必须校验与服务端当前时间差不超过 24 小时，超出返回 `422 validation_error`。客户端提交的 `updated_at` 仅作参考，服务端成功写入后使用服务端时间覆盖。审计、排序和排障以服务端内部 `server_received_at` 为准，该字段不对客户端暴露。
*   **MVP 富文本边界**：MVP 所有文本类 `props.content` 都是纯文本字符串，不支持行内加粗、斜体、下划线、链接、评论锚点或混合 inline JSON。移动端和电脑端都必须按纯文本处理。行内格式属于 P1 能力，启用前必须先扩展 `DocumentBlock.props` 契约并通过 OpenAPI/codegen 同步三端类型。
*   **大对象限制**：单次同步 `operations` 最多 100 条；单个 Block JSON 序列化后最大 256KB；单个 `handwriting.props.strokes` 总点数最多 5000。超过限制时客户端必须拆分为多个 handwriting Block，或将渲染结果上传为 `image_asset_id` 并保留精简 strokes。超限请求返回 `413 payload_too_large`。
*   **source_refs 归属**：`source_refs` 只能由服务端写入和更新。客户端同步 Document Block 时如果携带 `source_refs`，服务端必须忽略该字段并保留服务端已有值；用户编辑 `props.content`、移动 Block 或改变 Block type 不会自动清空 `source_refs`。重新转换手稿会创建新 Document，不覆盖旧 Document 的 `source_refs`。

统一错误结构：

```json
{
  "error": {
    "code": "revision_conflict",
    "message": "Document revision is outdated.",
    "details": {
      "server_revision": 18,
      "client_revision": 16
    },
    "request_id": "req_abc123"
  }
}
```

错误码固定集合：

| HTTP | code | 含义 |
|---|---|---|
| 400 | `invalid_request` | 请求结构或字段非法 |
| 401 | `unauthorized` | Token 缺失、过期或无效 |
| 403 | `forbidden` | 无资源权限 |
| 404 | `not_found` | 资源不存在 |
| 409 | `revision_conflict` | `revision` 冲突，需要客户端拉取最新状态 |
| 409 | `idempotency_conflict` | 同一幂等键被用于不同请求体 |
| 409 | `resource_conflict` | 删除或状态变更与当前资源引用关系冲突 |
| 413 | `payload_too_large` | 文件或请求体超过限制 |
| 422 | `validation_error` | 字段格式正确但业务校验失败 |
| 429 | `rate_limited` | 触发限流或配额 |
| 500 | `internal_error` | 服务端未知错误 |
| 503 | `ai_unavailable` | AI / ASR / LLM 服务不可用 |

#### 2. 通用数据结构

用户结构：

```json
{
  "id": "u_123",
  "email": "user@example.com",
  "name": "Alice",
  "avatar_url": null,
  "created_at": "2026-07-14T10:00:00Z"
}
```

设备结构：

```json
{
  "id": "device_abc",
  "platform": "ios",
  "app_version": "1.0.0",
  "name": "Alice iPhone",
  "last_seen_at": "2026-07-14T10:00:00Z",
  "created_at": "2026-07-01T10:00:00Z"
}
```

Asset 结构：

```json
{
  "id": "asset_rec1",
  "kind": "audio",
  "filename": "meeting.m4a",
  "content_type": "audio/mp4",
  "size_bytes": 10485760,
  "checksum_sha256": "hex_sha256",
  "duration_ms": 120000,
  "width": null,
  "height": null,
  "status": "ready",
  "url": "https://object-storage.example/signed-url",
  "created_at": "2026-07-14T10:00:00Z",
  "updated_at": "2026-07-14T10:01:00Z"
}
```

`asset.kind` 取值：`audio`、`image`、`export`、`attachment`。`asset.status` 取值：`pending_upload`、`uploaded`、`ready`、`failed`。

Asset 状态机：

| 当前状态 | 触发 | 下一状态 | 说明 |
|---|---|---|---|
| `pending_upload` | `POST /assets/upload` 创建 | `pending_upload` | 服务端只生成预签名上传地址，文件尚未确认上传 |
| `pending_upload` | 客户端上传对象存储成功后调用 `/complete` | `uploaded` | 服务端校验 `size_bytes` 和 `checksum_sha256` |
| `uploaded` | 服务端完成元数据解析或安全检查 | `ready` | Block 只能引用 `ready` 状态的 Asset |
| `pending_upload` / `uploaded` | 校验失败、超时或对象不存在 | `failed` | 客户端可重新创建 Asset 上传 |

`pending_upload` 超过 24 小时未完成时，服务端可以自动标记为 `failed`。`ready` Asset 被 Block 引用后不能直接删除，必须先删除或改写引用它的 Block。

上传协议：MVP 统一使用预签名 multipart 上传。图片和小文件也可以只有 1 个 part；音频默认分片大小为 5MB。客户端本地必须保存 `asset_id`、`upload_id` 和已完成的 `part_number`，用于弱网断点续传。

音频 speaker segment 结构：

```json
{
  "speaker_id": "speaker_1",
  "start_ms": 12000,
  "end_ms": 18000,
  "text": "我们下周先推进移动端。",
  "confidence": 0.92
}
```

Manuscript Block 结构：

```json
{
  "id": "block_123",
  "type": "text",
  "revision": 3,
  "created_at": "2026-07-14T10:00:00Z",
  "updated_at": "2026-07-14T10:03:00Z",
  "author_id": "u_123",
  "client_id": "device_abc",
  "platform": "ios",
  "deleted": false,
  "props": {
    "content": "根据以上讨论，我们决定..."
  }
}
```

`ManuscriptBlock.type` 取值：`text`、`audio`、`image`、`handwriting`。各类型 `props` 固定如下：

```json
{
  "text": { "content": "正文" },
  "audio": { "asset_id": "asset_rec1", "duration_ms": 120000, "transcript": "转写文本", "speaker_segments": [], "asr_task_id": "task_123", "asr_generated_at": "2026-07-14T10:02:00Z" },
  "image": { "asset_id": "asset_photo1", "caption": "白板上的架构图", "width": 1280, "height": 720 },
  "handwriting": { "strokes": [], "image_asset_id": "asset_hw1", "ai_text": "第三季度营收增长" }
}
```

手写 stroke 结构：

```json
{
  "id": "stroke_1",
  "tool": "pen",
  "color": "#111111",
  "width": 2,
  "points": [
    { "x": 10.1, "y": 12.2, "t": 0, "pressure": 0.5 },
    { "x": 11.4, "y": 13.0, "t": 16, "pressure": 0.6 }
  ]
}
```

Document SourceRef 结构：

```json
{
  "manuscript_id": "m_88392",
  "block_id": "block_audio1",
  "range": { "start_ms": 12000, "end_ms": 18000 },
  "region": null
}
```

`range` 用于音频和文本来源，`region` 用于图片或手写区域，结构为 `{ "x": 10, "y": 20, "w": 300, "h": 120 }`。不适用时传 `null`。

Document Block 结构：

```json
{
  "id": "doc_block_1",
  "type": "paragraph",
  "revision": 2,
  "created_at": "2026-07-14T10:00:00Z",
  "updated_at": "2026-07-14T10:03:00Z",
  "author_id": "u_123",
  "client_id": "device_desktop_001",
  "platform": "mac",
  "deleted": false,
  "props": { "content": "本次会议决定推进移动端优先。" },
  "source_refs": [
    {
      "manuscript_id": "m_88392",
      "block_id": "block_audio1",
      "range": { "start_ms": 12000, "end_ms": 18000 },
      "region": null
    }
  ]
}
```

`DocumentBlock.type` 取值：`paragraph`、`heading`、`list`、`quote`、`image`、`table`、`code`。各类型 `props` 固定如下：

```json
{
  "paragraph": { "content": "正文" },
  "heading": { "level": 1, "content": "标题" },
  "list": { "style": "bullet", "items": ["事项一", "事项二"] },
  "quote": { "content": "引用内容" },
  "image": { "asset_id": "asset_photo1", "caption": "白板上的架构图", "width": 1280, "height": 720 },
  "table": { "rows": [["A1", "B1"], ["A2", "B2"]] },
  "code": { "language": "typescript", "content": "const a = 1;" }
}
```

Manuscript 结构：

```json
{
  "id": "m_88392",
  "title": "7 月 14 日会议手稿",
  "owner_id": "u_123",
  "revision": 12,
  "blocks": [],
  "created_at": "2026-07-14T10:00:00Z",
  "updated_at": "2026-07-14T10:03:00Z"
}
```

Document 结构：

```json
{
  "id": "doc_123",
  "title": "会议纪要",
  "owner_id": "u_123",
  "source_manuscript_ids": ["m_88392"],
  "derived_from": {
    "manuscript_id": "m_88392",
    "task_id": "task_123",
    "mode": "meeting_minutes",
    "converted_at": "2026-07-14T10:10:00Z"
  },
  "revision": 18,
  "blocks": [],
  "permission": "owner",
  "created_at": "2026-07-14T10:05:00Z",
  "updated_at": "2026-07-14T10:10:00Z"
}
```

手动创建的空白 Document 的 `derived_from` 为 `null`。由 Manuscript 转换生成的 Document 必须写入 `derived_from`。

同步操作结构：

```json
{
  "op_id": "op_7f7a",
  "type": "upsert_block",
  "block": {},
  "block_id": null,
  "before_block_id": null,
  "after_block_id": "block_456",
  "created_at": "2026-07-14T10:03:00Z"
}
```

`operation.type` 取值：`upsert_block`、`delete_block`、`move_block`、`restore_block`。`upsert_block` 必须传 `block`；`delete_block` 和 `restore_block` 必须传 `block_id`；`move_block` 必须传 `block_id`，并在 `before_block_id` 或 `after_block_id` 中至少传一个。

同步提交语义：

*   服务端必须按 `operations` 数组顺序执行。
*   单次同步请求是原子事务，成功则全部 operations 生效，失败则全部不生效。
*   任意 op 校验失败、权限失败或发生不可安全合并的冲突时，整个请求失败。
*   MVP 不做部分成功，不返回“部分 op 已应用”的状态。
*   成功时资源级 `revision` 只自增一次，`applied_op_ids` 必须等于请求内全部 `op_id`。
*   `applied_op_ids` 主要用于调试和幂等响应，不作为客户端判断部分成功的依据。

同步响应结构：

```json
{
  "resource_id": "doc_123",
  "revision": 19,
  "applied_op_ids": ["op_2"],
  "conflicts": [],
  "blocks": []
}
```

`blocks` 返回服务端应用本次操作后发生变化的完整 Block 列表；客户端必须用该列表覆盖本地对应 Block。`conflicts` 为空表示全部操作成功。发生可合并冲突时服务端返回 `200` 并在 `conflicts` 中给出冲突详情；发生资源级 `base_revision` 过期且无法安全合并时返回 `409 revision_conflict`。

冲突结构：

```json
{
  "op_id": "op_2",
  "block_id": "doc_block_1",
  "reason": "block_updated_by_other_client",
  "server_block": {},
  "client_block": {}
}
```

`conflict.reason` 取值：`block_updated_by_other_client`、`block_deleted_by_other_client`、`invalid_block_order`、`unsupported_merge`。

任务结构：

```json
{
  "id": "task_123",
  "type": "convert_manuscript",
  "status": "processing",
  "progress": {
    "stage": "asr",
    "current": 2,
    "total": 5,
    "message": "正在转写音频"
  },
  "result": null,
  "error": null,
  "retry_count": 0,
  "billing": null,
  "created_at": "2026-07-14T10:00:00Z",
  "updated_at": "2026-07-14T10:01:00Z"
}
```

`task.type` 取值：`convert_manuscript`、`asr_audio`、`export_document`、`ai_rewrite`。`task.status` 取值：`queued`、`processing`、`succeeded`、`failed`、`cancelled`。

任务 `progress.stage` 固定取值：`queued`、`uploading`、`asr`、`diarization`、`llm_parse`、`document_build`、`exporting`、`completed`。任务 `error` 结构：

```json
{
  "code": "ai_unavailable",
  "message": "AI service is temporarily unavailable.",
  "retryable": true
}
```

不同任务成功后的 `result` 结构：

```json
{
  "convert_manuscript": { "document_id": "doc_123" },
  "asr_audio": {
    "asset_id": "asset_rec1",
    "transcript": "完整转写文本",
    "speaker_segments": []
  },
  "export_document": {
    "export_id": "export_123",
    "asset_id": "asset_export1",
    "document_id": "doc_123",
    "document_revision": 19,
    "format": "pdf"
  },
  "ai_rewrite": {
    "message_id": "msg_123",
    "text": "润色后的文本"
  }
}
```

#### 3. 认证与设备 API

`POST /auth/login`

Request:

```json
{
  "email": "user@example.com",
  "password": "plain_password",
  "device": {
    "client_id": "device_abc",
    "platform": "ios",
    "app_version": "1.0.0",
    "name": "Alice iPhone"
  }
}
```

Response `200`:

```json
{
  "access_token": "jwt_access",
  "access_token_expires_in": 1800,
  "refresh_token": "jwt_refresh",
  "refresh_token_expires_in": 2592000,
  "user": {
    "id": "u_123",
    "email": "user@example.com",
    "name": "Alice",
    "avatar_url": null,
    "created_at": "2026-07-14T10:00:00Z"
  }
}
```

`POST /auth/register`

Request:

```json
{
  "email": "user@example.com",
  "password": "plain_password",
  "name": "Alice",
  "device": {
    "client_id": "device_abc",
    "platform": "ios",
    "app_version": "1.0.0",
    "name": "Alice iPhone"
  }
}
```

Response `201`：与登录响应一致。

`POST /auth/refresh`

Request:

```json
{
  "refresh_token": "jwt_refresh",
  "client_id": "device_abc"
}
```

Response `200` 与登录响应 Token 字段一致。刷新成功后旧 `refresh_token` 失效。

`POST /auth/logout`

Request:

```json
{
  "client_id": "device_abc",
  "refresh_token": "jwt_refresh"
}
```

Response `204`，无响应体。

`GET /devices`

Response `200`:

```json
{
  "items": [
    {
      "id": "device_abc",
      "platform": "ios",
      "app_version": "1.0.0",
      "name": "Alice iPhone",
      "last_seen_at": "2026-07-14T10:00:00Z",
      "created_at": "2026-07-01T10:00:00Z"
    }
  ],
  "next_cursor": null,
  "sort_by": "last_seen_at,id",
  "sort_order": "desc"
}
```

#### 4. Asset API

`POST /assets/upload`

Request:

```json
{
  "kind": "audio",
  "filename": "meeting.m4a",
  "content_type": "audio/mp4",
  "size_bytes": 10485760,
  "checksum_sha256": "hex_sha256",
  "part_size_bytes": 5242880
}
```

Response `201`:

```json
{
  "asset_id": "asset_rec1",
  "upload_id": "upload_123",
  "part_size_bytes": 5242880,
  "parts": [
    {
      "part_number": 1,
      "upload_url": "https://object-storage.example/presigned-part-1",
      "headers": { "Content-Type": "audio/mp4" },
      "expires_at": "2026-07-14T10:15:00Z"
    },
    {
      "part_number": 2,
      "upload_url": "https://object-storage.example/presigned-part-2",
      "headers": { "Content-Type": "audio/mp4" },
      "expires_at": "2026-07-14T10:15:00Z"
    }
  ]
}
```

`GET /assets/{asset_id}/upload-parts`

Response `200`:

```json
{
  "asset_id": "asset_rec1",
  "upload_id": "upload_123",
  "part_size_bytes": 5242880,
  "uploaded_parts": [
    { "part_number": 1, "etag": "etag_part_1", "size_bytes": 5242880 }
  ],
  "missing_parts": [
    {
      "part_number": 2,
      "upload_url": "https://object-storage.example/presigned-part-2",
      "headers": { "Content-Type": "audio/mp4" },
      "expires_at": "2026-07-14T10:15:00Z"
    }
  ]
}
```

客户端断点续传时先调用该接口，跳过 `uploaded_parts`，只上传 `missing_parts`。预签名 URL 过期时也通过该接口重新获取。

`POST /assets/{asset_id}/complete`

Request:

```json
{
  "upload_id": "upload_123",
  "size_bytes": 10485760,
  "checksum_sha256": "hex_sha256",
  "parts": [
    { "part_number": 1, "etag": "etag_part_1", "size_bytes": 5242880 },
    { "part_number": 2, "etag": "etag_part_2", "size_bytes": 5242880 }
  ],
  "duration_ms": 120000,
  "width": null,
  "height": null
}
```

Response `200`：返回完整 Asset 结构。服务端必须校验 `parts` 连续完整、总大小等于 `size_bytes`、对象存储返回的 ETag 匹配、最终文件 `checksum_sha256` 匹配。校验失败返回 `422 validation_error`，Asset 状态变为 `failed`。

`GET /assets/{asset_id}`

Response `200`：返回完整 Asset 结构，不包含长期公开 URL。

`GET /assets/{asset_id}/stream`

Response `302`：跳转到有效期 10 分钟的签名下载 URL。权限不足返回 `403`。

#### 5. Manuscript API

`GET /manuscripts?limit=20&cursor=...`

Response `200`:

```json
{
  "items": [
    {
      "id": "m_88392",
      "title": "7 月 14 日会议手稿",
      "owner_id": "u_123",
      "revision": 12,
      "created_at": "2026-07-14T10:00:00Z",
      "updated_at": "2026-07-14T10:03:00Z"
    }
  ],
  "next_cursor": null,
  "sort_by": "updated_at,id",
  "sort_order": "desc"
}
```

`POST /manuscripts`

Request:

```json
{
  "title": "7 月 14 日会议手稿",
  "client_id": "device_abc",
  "initial_blocks": []
}
```

Response `201`：返回完整 Manuscript 结构。

`GET /manuscripts/{manuscript_id}`

Response `200`：返回完整 Manuscript 结构，包含未删除和软删除 Block。客户端默认隐藏 `deleted: true` 的 Block。

`GET /manuscripts/{manuscript_id}/blocks?limit=100&cursor=...`

Response `200`:

```json
{
  "items": [],
  "next_cursor": null,
  "sort_by": "order_key,id",
  "sort_order": "asc",
  "revision": 12
}
```

当 Manuscript Block 数量超过 100 或响应体预计超过 1MB 时，客户端必须使用 blocks 分页接口加载，不应依赖 `GET /manuscripts/{id}` 一次性获取全部内容。

`PUT /manuscripts/{manuscript_id}/blocks`

Request:

```json
{
  "client_id": "device_abc",
  "base_revision": 12,
  "operations": [
    {
      "op_id": "op_1",
      "type": "upsert_block",
      "block": {
        "id": "block_audio1",
        "type": "audio",
        "revision": 1,
        "created_at": "2026-07-14T10:00:00Z",
        "updated_at": "2026-07-14T10:00:00Z",
        "author_id": "u_123",
        "client_id": "device_abc",
        "platform": "ios",
        "deleted": false,
        "props": {
          "asset_id": "asset_rec1",
          "duration_ms": 120000,
          "transcript": "",
          "speaker_segments": []
        }
      },
      "block_id": null,
      "before_block_id": null,
      "after_block_id": null,
      "created_at": "2026-07-14T10:00:00Z"
    }
  ]
}
```

Response `200`:

```json
{
  "resource_id": "m_88392",
  "revision": 13,
  "applied_op_ids": ["op_1"],
  "conflicts": [],
  "blocks": []
}
```

`409 revision_conflict` Response:

```json
{
  "error": {
    "code": "revision_conflict",
    "message": "Manuscript revision is outdated.",
    "details": {
      "server_revision": 13,
      "client_revision": 12,
      "latest_blocks": []
    },
    "request_id": "req_abc123"
  }
}
```

#### 6. Document API

`GET /documents?limit=20&cursor=...`

Response `200`:

```json
{
  "items": [
    {
      "id": "doc_123",
      "title": "会议纪要",
      "owner_id": "u_123",
      "source_manuscript_ids": ["m_88392"],
      "derived_from": {
        "manuscript_id": "m_88392",
        "task_id": "task_123",
        "mode": "meeting_minutes",
        "converted_at": "2026-07-14T10:10:00Z"
      },
      "revision": 18,
      "permission": "owner",
      "created_at": "2026-07-14T10:05:00Z",
      "updated_at": "2026-07-14T10:10:00Z"
    }
  ],
  "next_cursor": null,
  "sort_by": "updated_at,id",
  "sort_order": "desc"
}
```

`POST /documents`

Request:

```json
{
  "title": "空白文档",
  "client_id": "device_desktop_001",
  "source_manuscript_ids": [],
  "derived_from": null,
  "initial_blocks": []
}
```

Response `201`：返回完整 Document 结构。

`GET /documents/{document_id}`

Response `200`：返回完整 Document 结构。

`GET /documents/{document_id}/blocks?limit=100&cursor=...`

Response `200`:

```json
{
  "items": [],
  "next_cursor": null,
  "sort_by": "order_key,id",
  "sort_order": "asc",
  "revision": 18
}
```

当 Document Block 数量超过 100 或响应体预计超过 1MB 时，客户端必须使用 blocks 分页接口加载。

`PUT /documents/{document_id}/blocks`

Request:

```json
{
  "client_id": "device_desktop_001",
  "base_revision": 18,
  "operations": [
    {
      "op_id": "op_2",
      "type": "upsert_block",
      "block": {
        "id": "doc_block_1",
        "type": "paragraph",
        "revision": 2,
        "created_at": "2026-07-14T10:05:00Z",
        "updated_at": "2026-07-14T10:10:00Z",
        "author_id": "u_123",
        "client_id": "device_desktop_001",
        "platform": "mac",
        "deleted": false,
        "props": { "content": "本次会议决定推进移动端优先。" }
      },
      "block_id": null,
      "before_block_id": null,
      "after_block_id": null,
      "created_at": "2026-07-14T10:10:00Z"
    }
  ]
}
```

Response `200`:

```json
{
  "resource_id": "doc_123",
  "revision": 19,
  "applied_op_ids": ["op_2"],
  "conflicts": [],
  "blocks": []
}
```

`GET /documents/{document_id}/versions?limit=20&cursor=...`

Response `200`:

```json
{
  "items": [
    {
      "id": "ver_1",
      "document_id": "doc_123",
      "revision": 18,
      "title": "自动保存版本",
      "created_by": "u_123",
      "created_at": "2026-07-14T10:10:00Z"
    }
  ],
  "next_cursor": null,
  "sort_by": "created_at,id",
  "sort_order": "desc"
}
```

`POST /documents/{document_id}/versions/{version_id}/restore`

Request:

```json
{
  "client_id": "device_desktop_001",
  "base_revision": 19
}
```

Response `200`：返回恢复后的完整 Document 结构。恢复版本会生成新的资源级 `revision`，不会覆盖历史版本记录。

`POST /documents/{document_id}/share-links`

Request:

```json
{
  "permission": "viewer",
  "expires_at": "2026-08-14T10:00:00Z"
}
```

Response `201`:

```json
{
  "id": "share_123",
  "document_id": "doc_123",
  "permission": "viewer",
  "url": "https://app.example/share/share_123?token=opaque_token",
  "expires_at": "2026-08-14T10:00:00Z",
  "created_at": "2026-07-14T10:00:00Z"
}
```

`GET /share/{share_id}?token=opaque_token`

Response `200`：返回完整 Document 结构，其中 `permission` 为分享链接授予的权限。分享链接过期返回 `403 forbidden`。

#### 7. 删除与级联 API

`DELETE /documents/{document_id}`

Response `204`：硬删除 Document。删除 Document 不会删除关联 Manuscript 和 Asset。已经生成的 export 文件保留到对象存储生命周期自动清理。

`DELETE /manuscripts/{manuscript_id}`

Response `200`：软删除 Manuscript，返回更新后的 Manuscript 元数据。关联 Document 保留，`source_manuscript_ids` 不删除，但客户端展示时应把已删除来源标记为 tombstone。

```json
{
  "id": "m_88392",
  "deleted": true,
  "deleted_at": "2026-07-14T10:20:00Z"
}
```

`DELETE /assets/{asset_id}`

Response `204`：仅当没有任何 Block 引用该 Asset 时允许删除。仍被引用时返回 `409 resource_conflict`，`details.reason` 为 `still_referenced`。

#### 8. Manuscript 到 Document 转换规则

`POST /tasks/convert-manuscript` 必须遵循以下 MVP 转换规则，保证后端、电脑端和移动端对 AI 生成结果的结构理解一致。

| Manuscript 输入 | Document 输出 | 顺序规则 | source_refs 规则 |
|---|---|---|---|
| `text.props.content` | `paragraph.props.content` | 按 Manuscript Block 顺序 | 指向原 text Block，`range` 和 `region` 为 `null` |
| `audio.props.transcript` | 一个或多个 `paragraph` | 按 `speaker_segments.start_ms` 升序；无 speaker_segments 时按 transcript 原文顺序 | 每个 paragraph 指向对应 audio Block；有时间段时写入 `range` |
| `handwriting.props.ai_text` | `paragraph`，如果 AI 判断为短标题可生成 `heading` | 保持原 handwriting Block 在时间线中的位置 | 指向 handwriting Block；有区域识别时写入 `region`，否则 `region: null` |
| `image` | `image` | 保持原 image Block 在时间线中的位置 | 指向 image Block；caption 从 `image.props.caption` 或 AI 识别结果生成 |

转换补充规则：

*   同一 Manuscript 可以多次转换，每次转换都创建新的 Document，绝不覆盖已有 Document。
*   `convert-manuscript` 任务成功后，Document 必须带 `source_manuscript_ids`，并写入 `derived_from` 元数据。
*   如果原 Document 已被用户编辑，重新转换不会合并到该 Document；“覆盖原 Document”属于 P1+ 能力。
*   LLM 只能输出符合 `DocumentBlock.type` 和 `props` 枚举的结构；无法可靠识别的内容降级为 `paragraph` 纯文本。

`derived_from` 结构：

```json
{
  "manuscript_id": "m_88392",
  "task_id": "task_123",
  "mode": "meeting_minutes",
  "converted_at": "2026-07-14T10:10:00Z"
}
```

#### 9. Task 与 AI API

`POST /tasks/convert-manuscript`

Request:

```json
{
  "manuscript_id": "m_88392",
  "mode": "meeting_minutes",
  "title": "会议纪要",
  "client_id": "device_abc"
}
```

`mode` 取值：`meeting_minutes`、`todo_list`、`article_draft`。

Response `202`：返回任务结构。任务成功后的 `result`：

```json
{
  "document_id": "doc_123"
}
```

`POST /tasks/asr-audio`

Request:

```json
{
  "asset_id": "asset_rec1",
  "language": "zh-CN",
  "enable_diarization": true,
  "client_id": "device_abc"
}
```

Response `202`：返回任务结构。任务成功后 `result` 使用 `asr_audio` 结果结构。

该接口是非流式兼容入口。服务端创建 `asr_audio` task 后异步执行 ASR，客户端通过 `GET /tasks/{task_id}` 轮询任务状态。ASR 成功后，服务端必须覆盖所有引用该 `asset_id` 的 Manuscript `audio` Block 中的 `props.transcript` 和 `props.speaker_segments`，并写入 `props.asr_task_id`、`props.asr_generated_at`。

`POST /tasks/asr-audio/stream`

Request：与 `POST /tasks/asr-audio` 完全一致。

Response `200`，`Content-Type: text/event-stream`。该接口是 ASR 的流式主入口。服务端创建 `asr_audio` task 后立即开始 ASR，并通过 SSE 返回任务状态、增量文本和最终任务结果。客户端收到 `done` 后应以 `task.result` 为最终结果；如果需要和服务端 Manuscript revision 对齐，应重新拉取 Manuscript 或对应 blocks 分页接口。

SSE 事件格式：

```text
event: task
data: {"task":{"id":"task_123","type":"asr_audio","status":"queued","progress":{"stage":"queued","current":0,"total":1,"message":"ASR task queued."},"result":null,"error":null,"retry_count":0,"billing":null,"created_at":"2026-07-14T10:00:00Z","updated_at":"2026-07-14T10:00:00Z"}}

event: task
data: {"task":{"id":"task_123","type":"asr_audio","status":"processing","progress":{"stage":"asr","current":0,"total":1,"message":"ASR task processing."},"result":null,"error":null,"retry_count":0,"billing":null,"created_at":"2026-07-14T10:00:00Z","updated_at":"2026-07-14T10:00:01Z"}}

event: delta
data: {"task_id":"task_123","text":"你好","transcript":"你好"}

event: delta
data: {"task_id":"task_123","text":"，我是谁","transcript":"你好，我是谁"}

event: done
data: {"task":{"id":"task_123","type":"asr_audio","status":"succeeded","progress":{"stage":"completed","current":1,"total":1,"message":"ASR task completed."},"result":{"asset_id":"asset_rec1","transcript":"你好，我是谁","speaker_segments":[{"speaker_id":"speaker_1","start_ms":0,"end_ms":1000,"text":"你好，我是谁","confidence":1.0}]},"error":null,"retry_count":0,"billing":null,"created_at":"2026-07-14T10:00:00Z","updated_at":"2026-07-14T10:00:03Z"}}
```

错误事件：

```text
event: error
data: {"code":"ai_unavailable","message":"ASR service is temporarily unavailable."}
```

ASR 服务端实现约束：

*   MVP 默认 `ASR_PROVIDER=dashscope`，使用阿里云百炼 DashScope Python SDK 的 `MultiModalConversation.call`，模型默认为 `qwen3-asr-flash`。
*   DashScope 输入音频使用 Base64 data URI：`data:<content_type>;base64,<payload>`。服务端必须在调用前校验 Base64 后 payload 不超过 10MB，超过返回失败任务，`error.code` 使用 `validation_error`，`retryable=false`。
*   `language` 从前端契约的 BCP-47 语言码映射为 DashScope `asr_options.language`，例如 `zh-CN` 映射为 `zh`。
*   `enable_itn` 默认 `false`，确保数字和格式按当前产品需求输出；如后续改变，必须同步更新 OpenAPI、文档和三端类型。
*   DashScope 当前结果未提供稳定说话人时间段时，服务端可降级生成单个 `speaker_1` segment，时间范围使用完整音频时长。后续如供应商返回更细粒度时间戳或说话人分离结果，必须映射到统一 `speaker_segments` 结构。
*   Azure Speech Fast Transcription 保留为 provider fallback，环境变量为 `AZURE_SPEECH_ENDPOINT`、`AZURE_SPEECH_KEY`、`AZURE_SPEECH_API_VERSION`；启用前需要单独验证区域、文件大小、时长和 diarization 支持。

`GET /tasks/{task_id}`

Response `200`：返回任务结构。

`POST /tasks/{task_id}/cancel`

Response `200`：返回取消后的任务结构。只有 `queued` 和 `processing` 状态允许取消。

取消规则：

*   `queued` 任务取消后不扣 AI 配额。
*   `processing` 任务会尽力取消外部模型请求；如果外部请求已完成或不可取消，仍可能产生外部成本，但用户侧不扣未完成任务配额。
*   取消成功后的任务状态固定为 `cancelled`，任务产物不得写入 Document。
*   同一个 `Idempotency-Key` 在 24 小时内重新提交同一请求时仍返回原取消任务；用户要重新执行必须使用新的 `Idempotency-Key`。

取消后的任务示例：

```json
{
  "id": "task_123",
  "type": "convert_manuscript",
  "status": "cancelled",
  "progress": {
    "stage": "completed",
    "current": 0,
    "total": 0,
    "message": "任务已取消"
  },
  "result": null,
  "error": null,
  "retry_count": 0,
  "billing": {
    "charged": false,
    "external_request_cancelled": true
  },
  "created_at": "2026-07-14T10:00:00Z",
  "updated_at": "2026-07-14T10:01:00Z"
}
```

`POST /ai/agent/chat`

Request:

```json
{
  "document_id": "doc_123",
  "selected_block_ids": ["doc_block_1"],
  "prompt": "帮我总结这一段并润色",
  "mode": "rewrite",
  "client_id": "device_desktop_001"
}
```

Response `200`，`Content-Type: text/event-stream`。SSE 事件格式：

```text
id: 1
event: delta
data: {"text":"本次"}

id: 2
event: delta
data: {"text":"会议"}

id: 3
event: done
data: {"message_id":"msg_123","usage":{"input_tokens":1200,"output_tokens":300}}
```

SSE 连接规则：服务端每 15 秒发送一次 `: heartbeat\n\n`；单连接最长 30 分钟，到时服务端正常关闭，客户端可自动重连。客户端断线重连时携带 `Last-Event-ID`，服务端在任务结果仍可用时从该事件之后继续发送；如果结果缓存已过期，返回 `400 invalid_request`，客户端需要重新发起 AI 请求。

错误事件：

```text
event: error
data: {"code":"ai_unavailable","message":"AI service is temporarily unavailable."}
```

`WS /ai/handwriting/complete`

握手地址：`/api/v1/ai/handwriting/complete?access_token=<access_token>&client_id=device_abc`。服务端必须校验 Token 和 `client_id`，鉴权失败关闭连接并返回 WebSocket close code `1008`。

客户端发送：

```json
{
  "type": "stroke_delta",
  "document_id": "doc_123",
  "block_id": "block_hw1",
  "client_id": "device_abc",
  "stroke": {
    "id": "stroke_1",
    "tool": "pen",
    "color": "#111111",
    "width": 2,
    "points": [
      { "x": 10.1, "y": 12.2, "t": 0, "pressure": 0.5 }
    ]
  },
  "context_text": "第三季度"
}
```

服务端返回：

```json
{
  "type": "completion",
  "block_id": "block_hw1",
  "text": "营收增长",
  "confidence": 0.82,
  "latency_ms": 120
}
```

#### 10. Export API

`POST /exports`

Request:

```json
{
  "document_id": "doc_123",
  "format": "pdf",
  "client_id": "device_desktop_001"
}
```

`format` 取值：`pdf`、`docx`。

Response `202`：返回任务结构。任务成功后的 `result`：

```json
{
  "export_id": "export_123",
  "asset_id": "asset_export1",
  "document_id": "doc_123",
  "document_revision": 19,
  "format": "pdf"
}
```

导出快照规则：提交导出任务时，服务端必须基于当前 `document_id + revision` 创建不可变快照，并在导出任务中使用该快照。导出过程中用户继续编辑 Document 不影响本次导出结果。`export_id` 必须关联创建时的 `document_revision`。

Export 结果结构：

```json
{
  "export_id": "export_123",
  "asset_id": "asset_export1",
  "document_id": "doc_123",
  "document_revision": 19,
  "format": "pdf"
}
```

`GET /exports/{export_id}/download`

Response `200`:

```json
{
  "download_url": "https://object-storage.example/signed-download",
  "expires_at": "2026-07-14T10:15:00Z"
}
```

服务端必须在生成 `download_url` 前校验当前用户对 `document_id` 的访问权限。

#### 11. 契约维护与并行开发流程

为了支持电脑端、移动端和后端并行开发，API 契约必须以 OpenAPI 3.1 作为唯一真相源。

*   **契约源文件**：后端使用 FastAPI + Pydantic 定义请求、响应和错误模型，并导出 OpenAPI 3.1 schema。
*   **类型生成**：前端使用 `openapi-typescript` 从 OpenAPI schema 生成 TypeScript 类型，生成结果放入 `packages/shared-types/`，电脑端和移动端共用。
*   **变更流程**：任何接口字段、枚举、错误码、状态机变更，都必须先改 OpenAPI schema，再生成 types，最后改实现。禁止前端或后端私自扩展未入 schema 的字段。
*   **Mock 服务**：后端未完成时，前端使用 OpenAPI mock 服务（Prism 或 WireMock）开发 P0 流程；mock 必须覆盖注册登录、资产上传、手稿创建、同步、转换任务、文档读取和导出。
*   **CI 校验**：CI 必须检查 OpenAPI schema、生成的 TypeScript 类型和文档示例是否同步；schema 漂移时阻止合并。
*   **兼容策略**：MVP 阶段不做破坏性 API 变更。确需变更字段语义时，必须同时更新 OpenAPI、文档、mock、前端类型和后端实现。

#### 12. 并行开工补充条款

以下条款是三端并行开发的开工 gate，必须在 Sprint 1 第一个开发日确认，不作为后续争议项。

Cursor 排序规则：

| 接口 | sort_by | sort_order | cursor 说明 |
|---|---|---|---|
| `GET /documents` | `updated_at,id` | `desc` | opaque，服务端内部可编码 `updated_at + id` |
| `GET /manuscripts` | `updated_at,id` | `desc` | opaque，服务端内部可编码 `updated_at + id` |
| `GET /documents/{id}/blocks` | `order_key,id` | `asc` | opaque，服务端内部可编码 `order_key + block_id` |
| `GET /manuscripts/{id}/blocks` | `order_key,id` | `asc` | opaque，服务端内部可编码 `order_key + block_id` |
| `GET /documents/{id}/versions` | `created_at,id` | `desc` | opaque，服务端内部可编码 `created_at + id` |

同步与离线队列：服务端按 `operations` 数组顺序原子执行。客户端某个 `base_revision` 同步成功后，可以删除该 revision 之前的本地操作日志；失败日志最多本地保留 7 天用于排障，超过后可清理。

OpenAPI / Mock 开工 gate：后端必须先产出覆盖 P0 接口的 `openapi.json` 初版；前端通过 `openapi-typescript` 生成 `packages/shared-types/`；Mock 服务必须为每个 P0 接口提供至少一个 success fixture 和一个 error fixture。P0 mock 覆盖范围固定为：

```text
POST /auth/register
POST /auth/login
POST /auth/refresh
POST /assets/upload
GET /assets/{asset_id}/upload-parts
POST /assets/{asset_id}/complete
GET /manuscripts
POST /manuscripts
PUT /manuscripts/{id}/blocks
POST /tasks/convert-manuscript
POST /tasks/asr-audio
POST /tasks/asr-audio/stream
GET /tasks/{id}
GET /documents/{id}
PUT /documents/{id}/blocks
POST /exports
GET /exports/{id}/download
```

ASR 重跑规则：MVP 不保存多版本 ASR。二次 ASR 成功后覆盖 `audio.props.transcript` 和 `audio.props.speaker_segments`，并写入 `audio.props.asr_task_id`、`audio.props.asr_generated_at`。非流式和流式 ASR 入口遵循相同覆盖规则；流式入口只改变客户端获取增量文本的方式，不改变最终持久化语义。ASR 多版本、版本切换和人工对比属于 P1。

AI 消息历史：MVP 的 AI Agent 以“生成 -> 预览 -> 应用”为主，不要求保存完整消息历史。`GET /documents/{id}/ai-messages` 属于 Sprint 1 可补接口，但不阻塞 P0 mock 和三端开工。

设备远程撤销：`DELETE /devices/{device_id}` 属于 Sprint 1 可补接口；P0 依赖当前设备 `logout` 和 30 分钟 access token 过期机制，不阻塞三端开工。

---

### 四、 核心架构难点与数据结构建议

#### 1. 统一的数据结构：Block JSON
无论手机端还是电脑端，底层的数据结构必须统一。MVP 采用类似 Notion 的 **Block-based JSON** 结构，而不是传统的 HTML 字符串。Block JSON 放在文档或手稿 envelope 中，避免每个 Block 重复携带顶层归属信息；Block 自身保留最小必要的元数据，支撑同步、撤销、审计和冲突排查。

```json
{
  "manuscript_id": "m_88392",
  "revision": 12,
  "updated_at": "2026-07-14T10:03:00Z",
  "blocks": [
    {
      "id": "block_audio1",
      "type": "audio",
      "revision": 3,
      "created_at": "2026-07-14T10:00:00Z",
      "updated_at": "2026-07-14T10:02:00Z",
      "author_id": "u_123",
      "client_id": "device_abc",
      "platform": "ios",
      "deleted": false,
      "props": { "asset_id": "asset_rec1", "duration_ms": 120000, "transcript": "大家好，今天开会...", "speaker_segments": [] }
    },
    {
      "id": "block_hw1",
      "type": "handwriting",
      "revision": 1,
      "created_at": "2026-07-14T10:01:00Z",
      "updated_at": "2026-07-14T10:01:00Z",
      "author_id": "u_123",
      "client_id": "device_abc",
      "platform": "ios",
      "deleted": false,
      "props": { "strokes": [], "image_asset_id": "asset_hw1", "ai_text": "第三季度营收增长" }
    },
    {
      "id": "block_img1",
      "type": "image",
      "revision": 1,
      "created_at": "2026-07-14T10:02:00Z",
      "updated_at": "2026-07-14T10:02:00Z",
      "author_id": "u_123",
      "client_id": "device_desktop_001",
      "platform": "mac",
      "deleted": false,
      "props": { "asset_id": "asset_photo1", "caption": "白板上的架构图", "width": 1280, "height": 720 }
    },
    {
      "id": "block_text1",
      "type": "text",
      "revision": 2,
      "created_at": "2026-07-14T10:03:00Z",
      "updated_at": "2026-07-14T10:03:00Z",
      "author_id": "u_123",
      "client_id": "device_desktop_001",
      "platform": "mac",
      "deleted": false,
      "props": { "content": "根据以上讨论，我们决定..." }
    }
  ]
}
```
*   **优势**：多模态 LLM 读取这种 JSON 比读取复杂 HTML 更容易理解上下文；前端渲染时可以针对不同的 `type` 渲染不同的 React 组件（如 AudioPlayer, Canvas, ImageViewer）。
*   **字段说明**：`revision` 用于乐观锁、调试和增量同步，不等价于完整协作算法；`client_id` 是设备实例 ID，而不是简单的 `mobile` / `desktop`；`deleted` 用于软删除和恢复，完整撤销依赖操作日志或版本历史。

#### 2. “手稿”与“文档”的解耦
*   **手稿 (Manuscript)** 是**时间线流式**的，包含大量未经整理的碎片信息（音频、随手画的圈、拍糊的照片）。
*   **文档 (Document)** 是**空间结构化**的，包含标题、段落、列表、图表。
*   **边界处理**：后端 LLM 的作用就是做一个“翻译官”，将时间线流的 `Manuscript JSON` 提炼并重组成空间结构化的 `Document JSON`（BlockSuite / Block JSON，Markdown 仅作为导出或中间格式）。一旦转换完成，用户在电脑端或移动端编辑的都是同一份 Document，**不再直接修改原始手稿**（保留手稿作为溯源凭证）。
*   **溯源关系**：Document Block 必须保留来源引用，支持从正式文档跳回原始录音、图片或手写笔迹。这样“手稿是证据链”的产品语义才成立，也便于用户核对 AI 生成内容。

Document Block 示例：

```json
{
  "id": "doc_block_1",
  "type": "paragraph",
  "revision": 1,
  "created_at": "2026-07-14T10:05:00Z",
  "updated_at": "2026-07-14T10:05:00Z",
  "author_id": "u_123",
  "client_id": "device_desktop_001",
  "platform": "mac",
  "deleted": false,
  "props": {
    "content": "本次会议决定推进移动端优先。"
  },
  "source_refs": [
    {
      "manuscript_id": "m_88392",
      "block_id": "block_audio1",
      "range": { "start_ms": 12000, "end_ms": 18000 },
      "region": null
    },
    {
      "manuscript_id": "m_88392",
      "block_id": "block_hw1",
      "range": null,
      "region": null
    }
  ]
}
```

同一份 Manuscript 应允许生成多个 Document，例如“会议纪要版”“待办清单版”“对外发布版”。它们共享原始手稿来源，但各自拥有独立的文档结构、编辑历史和导出结果。

#### 3. MVP 技术栈决策
MVP 阶段技术栈需要收敛，优先减少多语言、多存储和多套协作方案带来的交付风险。

*   **前端 (双端共用核心)**：React 18 + TypeScript + Vite + TailwindCSS
*   **前端手稿画布**：`Konva.js` + `react-konva`
*   **前端富文本引擎**：`BlockSuite`
*   **移动端壳**：Capacitor (打包 iOS/Android)
*   **电脑端壳**：Electron (打包 Win/Mac)
*   **后端**：Python FastAPI
*   **异步任务**：MVP 先使用 PostgreSQL 持久化任务和 FastAPI 后台任务处理；任务量上升后再迁移到 Celery + Redis
*   **数据库**：MVP 使用 PostgreSQL + pgvector，统一存储关系数据、Block JSON 和基础向量检索；暂不引入 MongoDB 和独立向量数据库
*   **缓存与队列**：Redis
*   **对象存储**：S3-compatible object storage，用于音频、图片、导出文件和大体积附件
*   **ASR**：阿里云百炼 DashScope `qwen3-asr-flash` 作为默认云端 ASR；Azure Speech Fast Transcription 保留为 fallback provider
*   **PDF 导出**：Headless Chrome (Puppeteer)
*   **DOCX 导出**：LibreOffice 模板化导出

NestJS、ProseMirror、Slate.js、Fabric.js、Tauri、Temporal、MongoDB、Milvus / Qdrant、端侧大模型、本地私有 LLM 等能力可以作为后续演进或备选方案，不应成为 MVP 的前置依赖。

---

### 五、 MVP 工程落地约束

MVP 目标不是覆盖所有高级协作和企业能力，而是保证多端核心闭环稳定可用：采集素材、生成文档、编辑修订、AI 辅助、同步、预览和导出。以下约束需要在 MVP 文档中明确，否则后续很容易出现数据不可迁移、冲突不可解释、任务不可排查和性能不可验收的问题。

#### 1. MVP 最终技术决策

| 模块 | MVP 决策 |
|---|---|
| 后端语言 | Python |
| 后端框架 | FastAPI |
| 异步任务 | MVP 先使用 PostgreSQL 持久化任务 + FastAPI 后台任务；后续迁移 Celery + Redis |
| 数据库 | PostgreSQL + pgvector |
| 对象存储 | S3-compatible object storage |
| 前端核心 | React 18 + TypeScript + Vite + TailwindCSS |
| 移动端壳 | Capacitor |
| 电脑端壳 | Electron |
| 富文本编辑器 | BlockSuite |
| 手稿画布 | Konva.js + react-konva |
| PDF 导出 | Headless Chrome (Puppeteer) |
| DOCX 导出 | LibreOffice 模板化导出 |
| ASR | 阿里云百炼 DashScope `qwen3-asr-flash` 云端 ASR 主路径，Azure Speech Fast Transcription 作为 fallback provider |
| 多端同步 | Block 级增量同步 + revision + 操作日志 |
| 多人实时协作 | 非 MVP，后续采用 Yjs |

以上为 MVP 执行决策，不再作为候选方案讨论。只有在技术验证证明某项方案无法满足移动端编辑、性能或稳定性底线时，才进入替换评审。

#### 2. MVP 功能优先级

| 优先级 | 功能范围 | 验收口径 |
|---|---|---|
| P0 | 登录、Token 刷新、创建手稿、录音/图片上传、云端 ASR、手稿转文档、基础 Block 编辑、双端同步、基础 PDF 导出 | 用户能在移动端采集素材，在电脑端或移动端生成并编辑同一份文档，数据不丢失，可导出 PDF |
| P1 | AI 润色/摘要/续写、Document `source_refs` 回溯、版本历史、分享链接、DOCX 基础导出、任务进度展示 | 用户能核对 AI 内容来源，能分享和恢复关键版本，长任务有明确进度和失败重试 |
| P2 | 手写补全、长文档 RAG、批量重排、设备列表展示、复杂文档样式设置 | 增强效率体验，但不阻塞 MVP 首版上线 |

P0 是 MVP 上线门槛；P1 是首版可用性增强，允许按排期分批进入；P2 不阻塞首版，除非某项能力被证明是核心场景必需。

#### 3. 多端同步与冲突策略
*   **MVP 范围**：优先支持同一用户的电脑端与移动端同步，不把多人实时协作作为第一阶段必选项。
*   **同步粒度**：Block 结构层以 Block 为最小同步单元；富文本内容层由编辑器 transaction 管理；媒体资源层通过 `asset_id` 引用同步；AI 结果作为任务产物写入，避免静默覆盖用户手动编辑。
*   **冲突处理**：客户端提交时携带 `revision`、`client_id` 和操作时间；服务端发现冲突时不能静默覆盖，应保留双方版本或提示用户选择。
*   **离线策略**：客户端本地保存操作队列，网络恢复后按顺序重放；长时间离线后的冲突以保留版本为主，不做激进自动合并。
*   **后续演进**：如果进入多人实时协作或复杂离线编辑阶段，采用 Yjs；但 MVP 不强依赖完整 CRDT 落地。

#### 4. AI 降级、配额与失败恢复
*   **失败不丢数据**：AI 转写、总结、润色或多模态转换失败时，原始手稿、上传素材和用户编辑内容必须完整保留。
*   **可重试**：失败任务应显示可理解的错误提示，允许用户重新提交；服务端保留 `retry_count` 和失败原因，便于排查。
*   **降级路径**：LLM 不可用时，界面应提示稍后重试，并允许用户继续手动编辑；ASR 失败时至少保留原始录音和手动补录入口。
*   **成本控制**：MVP 即应具备用户级限流和基础配额，例如每日转写时长、AI 调用次数、最大上传文件大小和并发任务数。
*   **结果可核对**：AI 生成的 Document Block 应携带 `source_refs`，让用户能回看对应原始 Block，降低多模态幻觉带来的信任风险。

#### 5. 认证、权限与安全边界
*   **Token 策略**：采用短期 `access_token` + 长期 `refresh_token`；登出时可吊销当前设备 Token。
*   **设备标识**：每个客户端生成稳定的 `client_id`，用于同步、冲突定位和异常排查。
*   **文档权限**：MVP 默认所有文档私有；分享链接必须具备权限范围、过期时间和服务端校验。
*   **导出安全**：导出文件通过签名临时链接下载，链接必须过期，下载时仍需校验当前用户是否有权限访问文档。
*   **API 限流**：登录、上传、AI 调用、导出和分享链接创建都应有基础限流，防止滥用和成本失控。

#### 6. 移动端 ASR 与录音策略
*   **MVP 主路径**：云端 ASR 是默认路径，后端默认使用 DashScope `qwen3-asr-flash`；端侧 ASR 只作为离线草稿或隐私增强能力。
*   **录音上传**：移动端录音应分片保存和上传，支持断点续传；网络异常时先保存在本地，恢复后继续上传。
*   **转写链路**：移动端或电脑端先上传音频 Asset，待 Asset `ready` 后调用 `POST /tasks/asr-audio/stream` 获取增量文本；无法消费 SSE 的客户端可使用 `POST /tasks/asr-audio` + `GET /tasks/{id}` 轮询兼容链路。
*   **后台限制**：iOS 后台录音和浏览器录音能力受系统限制，不能把“长时间稳定后台录音”作为 Web MVP 的默认承诺；Capacitor 原生插件可以提升可靠性，但仍需设计中断恢复。

#### 7. 异步任务可观测性
*   **任务进度**：所有长耗时任务必须返回 `stage`、`current`、`total`、`message`，用于前端展示进度条或后台任务状态。
*   **任务日志**：服务端应记录任务开始、阶段切换、外部模型调用、失败原因、重试次数和耗时。
*   **队列指标**：至少监控队列长度、任务成功率、失败率、P95 耗时和重试次数；任务堆积时需要告警。
*   **幂等性**：转换、导出、上传完成回调等接口应支持幂等，避免用户重复点击导致重复扣费或重复生成。

#### 8. 性能预算与验收指标

| 场景 | MVP 目标 |
|---|---|
| 手写/输入上屏延迟 | P95 < 50ms |
| 手写补全返回 | P95 < 500ms |
| 普通文档打开 | P95 < 1.5s |
| 500 Block 文档滚动 | 接近 60 FPS，无明显卡顿 |
| 录音上传 | 支持分片、失败重试和弱网恢复 |
| AI Agent 首字返回 | P95 < 3s |
| 多模态手稿转文档 | P95 < 30s，超时进入后台任务 |
| PDF / DOCX 导出 | 异步处理，失败可重试 |

这些指标不是最终体验上限，而是 MVP 可验收底线。后续如果支持 1000+ Block 长文档、多人大型协作或高保真导出，需要单独制定更高的性能和稳定性目标。

#### 9. 非 MVP 范围
*   **多人实时协作**：后续版本支持，MVP 仅保留数据边界和技术演进路径。
*   **端侧 LLM / 完整端侧 ASR**：作为隐私和离线增强，不作为第一阶段主路径。
*   **独立向量数据库和 MongoDB**：等数据规模、查询模式和成本压力明确后再拆分。
*   **复杂设备管理后台**：MVP 先支持设备标识、刷新 Token 和登出吊销。
*   **高保真 DOCX 模板系统**：MVP 先保证基础 PDF / DOCX 导出和失败可重试。
*   **完整审计后台**：MVP 保留关键日志和任务日志，不做完整企业审计系统。

按照这个边界划分和 MVP 约束，前端团队可以集中精力打磨“双端一致但交互不同”的编辑体验，后端团队可以集中精力优化多模态 AI、异步任务、同步和权限安全，从而在控制复杂度的前提下保证产品快速迭代和高质量交付。
