# 手稿图片流程与转文档业务计划

本文规划两个连续能力：手稿图片 Block 接入后端多模态识别，以及真实的手稿转文档业务流程。目标是让移动端和 PC 端使用同一套后端契约，保证图片、手写、录音和文本四类 Block 都能被稳定转换成 Document。

## 结论

MVP 阶段图像块只需要持久化 `caption`，不做全文 OCR 正文抽取。图像块的产品语义是“原图 + 描述”，对应 Document 中的 `image` Block；`task.result.text` 可用于流式临时预览或后续 P1 扩展，不进入 `image.props`。

手稿转文档的目标不是简单复制现有 Block，而是在后端创建异步任务，识别出需要请求 LLM/VLM 的处理单元，并发执行后按原手稿顺序组装 Document。客户端只负责提交转换意图、展示进度和打开结果，不在端侧拼装最终文档。

## 范围

P0 必须覆盖：

- 移动端和 PC 端都能上传图片 Asset，并创建带 `asset_id` 的 Manuscript image Block。
- 图片识别成功后，后端把 caption 写回引用该 Asset 的 Manuscript image Block。
- 图片识别失败不删除 Asset 和 Block，允许用户重试或手动编辑 caption。
- 转文档入口弹窗询问文档标题，并提供“启用录音内容优化”开关。
- 转文档任务有进度展示，完成后打开新 Document。
- 文本、录音、图像、手写四类 Block 都有明确转换规则和降级策略。

P0 不做：

- 图片全文 OCR 持久化到 `image.props`。
- 图片识别文本自动拆成多个正文段落。
- 覆盖或增量合并到已有 Document。
- 手稿转文档时重新跑 ASR。录音块依赖已有 `audio.props.transcript`。
- 多人实时协作冲突合并。

## 当前契约基线

图片上传仍走现有 Asset 流程：

```text
POST /api/v1/assets/upload
PUT /api/v1/assets/{asset_id}/upload-parts/{part_number}?...
POST /api/v1/assets/{asset_id}/complete
```

`upload_url` 必须是后端 API 地址，不再兼容对象存储直传 URL。前端不能根据 URL 形态自行分支到对象存储直传。

创建 Manuscript image Block 前，客户端必须先完成 Asset 上传，并在 `/complete` 传入 `width`、`height`。Asset `ready` 后再创建 Block。

Manuscript image Block props：

```json
{
  "asset_id": "asset_photo1",
  "caption": "",
  "width": 1280,
  "height": 720,
  "recognition_task_id": null,
  "recognition_generated_at": null
}
```

图片识别流式主入口：

```text
POST /api/v1/tasks/recognize-image/stream
```

Request：

```json
{
  "asset_id": "asset_photo1",
  "language": "zh-CN",
  "client_id": "device_abc"
}
```

非流式兼容入口：

```text
POST /api/v1/tasks/recognize-image
GET /api/v1/tasks/{task_id}
```

图片识别成功后的 `task.result`：

```json
{
  "asset_id": "asset_photo1",
  "caption": "白板上的三端架构草图",
  "text": "白板上的三端架构草图\n移动端、PC 端和后端 API 协作。"
}
```

持久化规则：

- `image.props.caption` 使用 `task.result.caption`。
- `image.props.recognition_task_id` 使用成功任务 ID。
- `image.props.recognition_generated_at` 使用服务端生成时间。
- `task.result.text` 不写入 `image.props`，仅用于前端临时预览或后续 P1。

## 手稿图片插入流程

### 移动端流程

1. 用户点击“图片追加”或在 Block 菜单中点击“插入图片”。
2. 客户端调用相机、相册或文件选择能力，得到图片 Blob、文件名、MIME、宽高。
3. 客户端计算 `checksum_sha256`。
4. 调用 `POST /assets/upload`，`kind` 固定为 `image`。
5. 逐个 `PUT upload_url` 上传分片，`upload_url` 必须按后端返回值原样使用。
6. 调用 `POST /assets/{asset_id}/complete`，传入 `width`、`height`。
7. Asset 返回 `ready` 后，创建 Manuscript image Block，`caption` 初始为空。
8. 先同步 Manuscript Block，确保服务端已经能查到引用该 `asset_id` 的 image Block。
9. Block 同步成功后，调用 `POST /tasks/recognize-image/stream`。
10. SSE `task` 事件用于展示“图片识别中”。
11. SSE `delta` 事件用 `caption` 或 `recognized_text` 做本地预览，不作为最终持久化状态。
12. SSE `done` 事件以 `task.result` 为准。
13. 收到 `done` 后重新拉取 Manuscript 或 blocks 分页接口，对齐服务端 revision。

关键约束：必须先同步 image Block，再启动图片识别任务。否则识别任务可能先完成，但服务端扫描不到引用该 `asset_id` 的 Block，导致 caption 无法写回 Manuscript。

### PC 端流程

PC 端应与移动端使用同一流程。后续接入时，`recognizeImage` 不应再抛“服务器契约未提供图片识别接口”，而应执行：

1. 选择本地图片文件。
2. 上传 `kind: "image"` Asset。
3. Asset `ready` 后创建带 `asset_id` 的 Manuscript image Block。
4. 同步 Block。
5. 调用 `recognize-image` 流式或非流式接口。
6. 成功后重新拉取 Manuscript，展示服务端写回的 caption。

PC 端如果暂时无法消费 SSE，可先使用非流式入口轮询 `GET /tasks/{task_id}`。但最终建议和移动端保持同样的 SSE 主链路，减少用户等待时的不确定性。

### 图片失败与重试

图片识别失败时：

- 不删除图片 Asset。
- 不删除 Manuscript image Block。
- 保留原图，caption 为空或保留用户已有 caption。
- UI 提示“图片描述生成失败，可稍后重试或手动编辑描述”。
- 重试必须使用新的 `Idempotency-Key`。
- 重试成功后按服务端返回结果覆盖 `caption`、`recognition_task_id`、`recognition_generated_at`。

如果用户已经手动编辑 caption，重试时前端应询问是否覆盖；MVP 可先采用“只有 caption 为空时自动覆盖，非空时提示用户确认”的策略。

## 转文档入口交互

用户点击“转文档”时，两端都使用窗口交互，而不是直接提交任务。

窗口字段：

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| 文档标题 | 文本输入 | `{手稿标题} 文档` | 不能为空，作为新 Document 标题 |
| 启用录音内容优化 | 开关 | 关闭 | 开启后由后端调用 LLM 清理口水词和无意义重复 |
| 转换模式 | 可隐藏或高级项 | `meeting_minutes` | MVP 默认会议纪要模式 |

提交前客户端必须完成：

- flush 本地待同步 Block 操作。
- 确认正在上传的音频、图片已经完成或明确提示用户仍有素材未上传。
- 如果存在图片 caption 任务正在处理中，提示用户“等待图片描述完成”或“继续转换”。MVP 推荐继续转换，由后端在 caption 缺失时补充图片描述。
- 如果存在录音 ASR 任务正在处理中，提示用户等待。转文档不应在关键录音 transcript 为空时静默提交。

## 转文档 API 调整

在现有 `POST /tasks/convert-manuscript` 基础上增加 `optimize_audio`：

```json
{
  "manuscript_id": "m_88392",
  "mode": "meeting_minutes",
  "title": "会议纪要",
  "client_id": "device_abc",
  "optimize_audio": true
}
```

响应仍返回 Task。任务成功后：

```json
{
  "document_id": "doc_123",
  "warnings": [
    {
      "block_id": "block_audio1",
      "code": "audio_optimization_failed",
      "message": "录音优化失败，已使用原始 ASR 文本。"
    }
  ]
}
```

`warnings` 是可选字段。P0 可以先在 `result` 中返回，后续如需要严格类型，可补充独立 schema。

## 并行开发补充契约

本节用于支持后端、客户端图片流程、客户端转文档流程三条线并行开发。以下约定优先级高于实现习惯，三端不得自行扩展或改名。

### 分工边界

| 模块 | 负责内容 | 不负责内容 |
|---|---|---|
| 后端 | Asset 上传、图片识别、caption 写回、转文档异步任务、模型调用、Document 组装、Task 进度 | 客户端弹窗、客户端本地预览状态、用户是否确认覆盖手动 caption |
| 客户端图片流程 | 上传图片、创建 image Block、同步 Block、启动识别任务、消费 SSE、重新拉取 Manuscript | 直接调用模型、端侧生成最终 caption、端侧写服务端 revision |
| 客户端转文档流程 | 弹窗收集标题和 `optimize_audio`、提交任务、轮询 Task、展示进度、打开 Document | 端侧拼装 Document、端侧执行录音优化、端侧识别手写 |

### 字段与类型锁定

`ImageProps` 使用后端 OpenAPI 的 snake_case 字段，客户端类型不得改成 camelCase：

```ts
type ImageProps = {
  asset_id: string;
  caption: string | null;
  width: number | null;
  height: number | null;
  recognition_task_id: string | null;
  recognition_generated_at: string | null;
};
```

客户端创建新 image Block 时必须显式传：

```json
{
  "asset_id": "asset_photo1",
  "caption": "",
  "width": 1280,
  "height": 720,
  "recognition_task_id": null,
  "recognition_generated_at": null
}
```

`width`、`height` 应与 `/assets/{asset_id}/complete` 传入值一致。客户端必须尽量解析真实图片尺寸；如果平台暂时无法解析，必须明确记录为待修复问题，不得用固定占位尺寸伪造。

`ConvertManuscriptRequest.optimize_audio` 在新契约中是必填 boolean。客户端不得省略该字段；如果用户没有开启，则传 `false`。

```ts
type ConvertManuscriptRequest = {
  manuscript_id: string;
  mode: "meeting_minutes" | "todo_list" | "article_draft";
  title: string;
  client_id: string;
  optimize_audio: boolean;
};
```

弹窗里的“文本文件命名”在 MVP 中等价于新 Document 的 `title`。后续导出 PDF/DOCX 时可默认复用该 title 作为文件名。

### 图片识别任务时序

图片客户端必须遵守以下顺序：

```text
upload Asset -> complete Asset -> create image Block locally -> sync image Block -> start recognize-image task -> consume task result -> reload Manuscript
```

不得在 image Block 同步成功前启动 `recognize-image`。当前识别 API 只有 `asset_id`，没有 `manuscript_id` 或 `block_id`；如果任务完成时服务端找不到引用该 Asset 的 Block，caption 可能无法写回。

MVP 约定：每次插入图片都创建新的 Asset。客户端不得把同一个 image Asset 复用到多个逻辑 image Block，除非这些 Block 共享同一 caption 是产品上可接受的。

### Caption 覆盖策略

为了避免 AI 结果覆盖用户手动编辑内容，三端采用以下策略：

- 新建 image Block 的 `caption` 初始为空字符串。
- 识别任务启动时，客户端可在本地记录该 Block 处于 `recognizing` 状态，但该状态不写入服务端 Block props。
- 后端写回 AI caption 时，只应自动覆盖当前 caption 为空的 image Block。
- 如果服务端发现当前 caption 已非空，应保留用户 caption；Task 仍可成功，`task.result.caption` 继续返回 AI caption。
- 客户端收到 `done` 后必须重新拉取 Manuscript，以服务端最终 Block 为准。
- 如果用户点击“用 AI 描述覆盖当前 caption”，客户端必须提交一次普通 Block 同步操作，而不是依赖旧识别任务再次覆盖。

如果后端短期内尚未实现“非空 caption 不覆盖”，客户端必须在识别中禁用 caption 编辑，或在 UI 上提示“识别完成前编辑可能被覆盖”。最终目标仍以上述安全覆盖策略为准。

### SSE 事件结构

`recognize-image/stream` 只要求客户端处理四类事件：

```text
event: task
data: {"task": Task}

event: delta
data: {"task_id":"task_123","text":"增量文本","caption":"当前首行描述","recognized_text":"当前完整识别文本"}

event: done
data: {"task": Task}

event: error
data: {"code":"ai_unavailable","message":"Image recognition service is temporarily unavailable."}
```

处理规则：

- `task` 更新任务状态。
- `delta.text` 是增量片段，不是完整 caption。
- `delta.caption` 是基于当前识别文本推导出的临时 caption，可用于预览。
- `delta.recognized_text` 是当前完整临时文本，不持久化。
- `done.task.result` 是最终任务结果。
- 收到 `done` 后必须重新拉取 Manuscript 或 blocks 分页接口，对齐服务端 revision。
- 收到 `error` 时，不删除 Asset 和 Block，只展示失败状态。

### 转文档任务与源手稿关系

`convert-manuscript` 任务必须基于提交时的 Manuscript 快照生成新 Document。除创建 Task 和 Document 外，转换任务不应修改源 Manuscript。

具体约定：

- 转文档中生成的图片 caption 只写入新 Document，不回写 Manuscript image Block。
- 转文档中生成的手写识别文本只写入新 Document，不回写 `handwriting.props.ai_text`。
- 转文档中的录音优化文本只写入新 Document，不覆盖 `audio.props.transcript`。
- 只有独立的 `recognize-image` 任务负责回写 Manuscript image caption。
- 只有独立的 ASR 任务负责回写 Manuscript audio transcript。

这样可以保证用户在转换期间继续编辑源手稿时，不会被转换任务的中间结果静默覆盖。

### 转文档与进行中的图片识别任务

转文档任务不等待客户端已经启动的 `recognize-image` 任务。转换快照中 image Block 的 `caption` 为空时，后端可以在转换任务内部创建图片描述处理单元，生成 Document image caption。

客户端策略：

- 如果本地知道图片识别正在进行，可以提示用户“图片描述仍在生成，继续转换时后端会尝试补充描述”。
- 用户选择继续转换时，客户端直接提交 `convert-manuscript`。
- 用户选择等待时，客户端等待图片识别 `done` 并重新拉取 Manuscript 后再提交转换。

后端策略：

- 转换任务内部只对当前转换快照去重，同一 `asset_id` 在一个转换任务内最多请求一次图片描述。
- 转换任务不依赖外部 `recognize-image` task 的状态。
- 如果转换内图片描述失败，Document 仍插入原图，caption 使用快照已有值或空字符串，并写入 warning。

### 音频优化粒度

录音优化必须尽量保留 source range。

- 如果 `speaker_segments` 非空，后端按 segment 独立优化，每个 segment 生成一个 paragraph，并保留该 segment 的 `source_refs.range`。
- 如果 `speaker_segments` 为空但 `transcript` 非空，后端优化完整 transcript，生成一个 paragraph，`range=null`。
- 如果 `optimize_audio=false`，仍按上述粒度生成 paragraph，只是不请求 LLM。
- 后端负责确保 `发言：` 前缀只出现一次；如果模型输出已经包含该前缀，应去重。

### 转文档 Task 进度结构

转文档任务必须使用可预测的进度结构，方便客户端并行实现进度条。

创建任务后立即返回：

```json
{
  "type": "convert_manuscript",
  "status": "queued",
  "progress": {
    "stage": "queued",
    "current": 0,
    "total": 1,
    "message": "转换任务已创建"
  },
  "result": null,
  "error": null
}
```

后台任务分析完处理单元后，必须把 `total` 更新为最终总数。客户端要容忍 `total` 从 `1` 变成更大的数字。

处理阶段示例：

```json
{
  "stage": "llm_parse",
  "current": 3,
  "total": 7,
  "message": "正在处理手写和图片描述 3/5"
}
```

组装阶段示例：

```json
{
  "stage": "document_build",
  "current": 6,
  "total": 7,
  "message": "正在组装文档"
}
```

成功阶段示例：

```json
{
  "stage": "completed",
  "current": 7,
  "total": 7,
  "message": "转换完成"
}
```

客户端不得用 `stage` 推断具体处理了哪些 Block，只能用于展示；具体结果以成功后的 Document 为准。

### Warning 结构与错误码

`convert_manuscript` 成功但部分降级时，`task.result.warnings` 使用固定结构：

```ts
type ConvertWarning = {
  block_id: string;
  code:
    | "audio_transcript_missing"
    | "audio_optimization_failed"
    | "image_caption_failed"
    | "handwriting_empty"
    | "handwriting_render_failed"
    | "handwriting_recognition_failed";
  message: string;
};
```

客户端展示策略：

- warnings 不阻止打开 Document。
- Document 打开后可用非阻塞提示展示“部分内容已降级处理”。
- 如果用户点击详情，再展示具体 Block warning。

任务失败只用于全局不可恢复错误，例如权限失败、Manuscript 不存在、数据库写入失败、任务被取消或模型服务整体不可用且无法降级。

### 手写渲染约定

后端渲染 handwriting strokes 时，P0 采用以下默认规则：

- 背景使用白色。
- 坐标以客户端提交的 stroke point `x`、`y` 为准。
- 画布宽度取 strokes 最大 `x` 加安全边距，最小 320px。
- 画布高度取 strokes 最大 `y` 加安全边距，最小 120px。
- 保留 stroke 的 `color`、`width`、`pressure` 能力；如果渲染库不支持 pressure，可忽略 pressure。
- 生成的手写图片 Asset `kind="image"`，只作为 Document image Block 引用，不自动插入源 Manuscript。

如果 handwriting block 已有可用 `image_asset_id`，后端可直接复用该 Asset 作为 VLM 输入和 Document 图片来源。

### Mock 与联调 Gate

后端实现未完成时，客户端可以基于 mock 并行开发，但 mock 必须和本节契约一致。

P0 mock 必须提供：

- 图片上传成功 fixture：`POST /assets/upload` 返回后端 API upload_url。
- 图片 complete 成功 fixture：返回 ready image Asset，包含 width、height。
- `PUT /manuscripts/{id}/blocks` 同步 image Block 成功 fixture。
- `POST /tasks/recognize-image/stream` SSE 成功 fixture，包含 `task`、`delta`、`done`。
- `POST /tasks/recognize-image/stream` SSE 失败 fixture，包含 `error`。
- `POST /tasks/convert-manuscript` queued fixture。
- `GET /tasks/{task_id}` 转文档进度序列 fixture：queued -> llm_parse -> document_build -> succeeded。
- 转文档成功 Document fixture，至少包含 text、audio、image、handwriting 四类来源。
- 转文档 partial warning fixture。

联调前置条件：

- 后端 OpenAPI 已包含 `recognize_image`、`ImageProps` 识别字段、`ConvertManuscriptRequest.optimize_audio`。
- 两个客户端已基于同一份 OpenAPI 或等价手写类型更新。
- 图片上传不再走对象存储直传兼容分支。
- `convertManuscript` 客户端实现不再假设 202 返回时任务已经 `succeeded`。

## 后端转文档任务编排

后端收到转文档请求后，不应在请求线程里同步拼装完成，而应创建异步任务。

任务步骤：

1. 校验 Token、`X-Client-Id`、`Idempotency-Key`、资源权限。
2. 读取 Manuscript，过滤 `deleted=true` 的 Block。
3. 创建不可变转换快照，避免任务执行期间用户继续编辑影响本次结果。
4. 创建 `convert_manuscript` Task，状态为 `queued`。
5. 扫描快照中的 Block，构造需要请求 LLM/VLM 的处理单元。
6. 使用并发上限执行所有处理单元。
7. 每完成一个处理单元，更新 Task `progress.current` 和 `progress.message`。
8. 所有单元完成或降级后，进入 `document_build` 阶段。
9. 按原 Manuscript Block 顺序组装 Document blocks。
10. 创建新的 Document，写入 `source_manuscript_ids` 和 `derived_from`。
11. 创建 Document 初始 version。
12. 更新 Task 为 `succeeded`，`result.document_id` 指向新 Document。

并发建议：

- MVP 默认模型并发上限为 4。
- 每个模型单元设置超时，例如 60 秒。
- 对同一任务内的相同 Asset 可去重，避免重复识别。
- 单个非关键单元失败不应直接失败整个转换任务，应记录 warning 并降级。

进度建议：

```text
total = 1 + 模型处理单元数量 + 1
```

含义：

- 第 1 步：创建转换快照和分析处理单元。
- 中间 N 步：LLM/VLM 处理单元完成数。
- 最后 1 步：组装并保存 Document。

阶段映射：

| stage | message 示例 |
|---|---|
| `queued` | 转换任务已创建 |
| `llm_parse` | 正在识别手写、描述图片或优化录音 |
| `document_build` | 正在组装文档 |
| `completed` | 转换完成 |

客户端用 `current / total` 展示进度条，并显示 `progress.message`。

## 模型处理单元

### 文本块

文本块不请求模型。

输入：

```json
{
  "type": "text",
  "props": { "content": "根据以上讨论，我们决定..." }
}
```

输出：

- `DocumentParagraphBlock`
- `props.content = text.props.content`
- `source_refs` 指向原 text block

规则：

- 空文本跳过。
- 不做润色、不总结、不重排。

### 录音块

录音块依赖已有 ASR 结果。

输入：

```json
{
  "type": "audio",
  "props": {
    "asset_id": "asset_rec1",
    "transcript": "嗯我们今天就是讨论一下移动端...",
    "speaker_segments": []
  }
}
```

如果 `optimize_audio=false`：

- 不请求 LLM。
- 直接使用 `speaker_segments` 或 `transcript`。
- 写入文档时段首加 `发言：`。

如果 `optimize_audio=true`：

- 构造文本 LLM 处理单元。
- 要求模型只去除口水词、无意义重复、明显停顿词。
- 不允许总结、扩写、改变原意。
- 输出仍按发言内容写入文档，段首加 `发言：`。

输出：

- 有 `speaker_segments` 时，按 `start_ms` 升序生成一个或多个 paragraph。
- 无 `speaker_segments` 但有 `transcript` 时，生成一个 paragraph。
- 每个 paragraph 的 `props.content` 形如 `发言：{文本}`。
- 有时间段时，`source_refs.range` 指向对应音频时间范围。

降级：

- 优化失败时使用原始 ASR 文本，并写入 warning。
- transcript 为空时跳过该录音块，并写入 warning。
- 不在转文档任务中自动重新跑 ASR，避免任务耗时和成本不可控。

音频优化模型提示词约束：

```text
你正在清理一段 ASR 转写文本。只删除口水词、无意义重复、明显停顿词和误触发内容。
不要总结，不要扩写，不要改变原意，不要加入新信息。
保留原本的语气和事实顺序。
只输出清理后的文本。
```

### 图像块

图像块的目标是原样插入，即原图加 caption。

输入：

```json
{
  "type": "image",
  "props": {
    "asset_id": "asset_photo1",
    "caption": "白板上的三端架构草图",
    "width": 1280,
    "height": 720,
    "recognition_task_id": "task_123",
    "recognition_generated_at": "2026-07-15T10:00:00Z"
  }
}
```

规则：

- 如果 `caption` 已存在，转文档不再请求 VLM。
- 如果 `caption` 为空，后端可以在转换任务中构造图片描述单元，复用 `recognize-image` provider 逻辑生成 caption。
- 只持久化和写入 Document image caption，不做全文 OCR 正文段落。
- 输出 `DocumentImageBlock`，`props` 包含 `asset_id`、`caption`、`width`、`height`。
- `source_refs` 指向原 image block。

降级：

- 图片描述失败时仍插入原图。
- caption 使用已有值；没有已有值则为空字符串。
- 写入 warning，提示用户可稍后手动编辑 caption。

图片描述模型提示词约束：

```text
请为这张手稿图片生成一句简洁中文描述，适合作为文档图片 caption。
如果图片包含白板、草图、图表或界面，请概括其主题。
不要编造看不见的信息。
只输出一行 caption。
```

### 手写块

手写块是转文档流程中最重的多模态处理单元。

输入：

```json
{
  "type": "handwriting",
  "props": {
    "strokes": [],
    "image_asset_id": null,
    "ai_text": ""
  }
}
```

处理：

1. 后端将 `strokes` 渲染成图片。
2. 如果 `image_asset_id` 已存在且 Asset 可用，可优先复用该图片。
3. 将图片发送给多模态 LLM/VLM。
4. 模型返回识别文本，并判断是否存在值得保留的示意图、流程图、结构图、草图等手绘内容。
5. 后端根据判断决定文档中是否插入手写图片。

模型结构化输出：

```json
{
  "recognized_text": "第三季度营收增长，移动端优先。",
  "has_keepable_drawing": true,
  "drawing_caption": "手绘漏斗图，表示用户从采集到生成文档的流程。",
  "regions": [
    {
      "kind": "drawing",
      "x": 10,
      "y": 20,
      "w": 300,
      "h": 180
    }
  ],
  "confidence": 0.86
}
```

输出规则：

- 如果只有手写文字，没有可保留绘图：只输出识别文本。
- 如果存在可保留绘图：先输出手写图片，再输出识别文本。
- 识别文本较短且像标题时，可以输出 `heading`；否则输出 `paragraph`。
- 手写图片使用 `DocumentImageBlock`，caption 使用 `drawing_caption`。
- 所有输出 block 都写入 `source_refs` 指向原 handwriting block。

降级：

- VLM 识别失败但渲染图片成功：插入手写图片，caption 可为空，并写入 warning。
- 渲染失败：跳过该手写块，并写入 warning。
- `strokes` 为空且没有 `image_asset_id`：跳过该手写块。

手写识别模型提示词约束：

```text
请识别这张手写手稿图片。
输出 JSON，不要输出 Markdown。
recognized_text 是识别出的正文内容。
has_keepable_drawing 表示图片中是否有值得在正式文档中保留的手绘图、示意图、流程图、结构图或草图。
如果只有手写文字，没有图示，has_keepable_drawing 必须为 false。
不要编造看不见的信息。
```

## Document 组装规则

后端按 Manuscript Block 原始顺序组装 Document。一个 Manuscript Block 可以生成 0 个、1 个或多个 Document Block。

| Manuscript Block | Document 输出 | 是否请求模型 |
|---|---|---|
| text | paragraph | 否 |
| audio | paragraph，段首 `发言：` | 仅 `optimize_audio=true` 时请求文本 LLM |
| image | image，包含原图和 caption | caption 缺失时可请求 VLM |
| handwriting | paragraph/heading，可选 image | 是 |

source refs：

- 文本 block：`range=null`，`region=null`。
- 录音 block：有 segment 时写入 `range.start_ms/end_ms`。
- 图片 block：`range=null`，`region=null`。
- 手写 block：默认 `region=null`；如果模型返回可靠区域，可写入 `region`。

重新转换规则：

- 每次转换创建新的 Document。
- 不覆盖已有 Document。
- 不合并到用户已编辑的 Document。
- Document 写入 `source_manuscript_ids` 和 `derived_from`。

## 客户端进度展示

转文档任务创建后，两端都使用统一 Task 状态展示。

展示内容：

- 进度条：`progress.current / progress.total`。
- 主文案：`progress.message`。
- 状态标签：`queued`、`processing`、`succeeded`、`failed`、`cancelled`。
- 成功后显示“已生成文档”，并自动或手动打开 Document。
- 失败后显示错误、是否可重试、重试按钮。

轮询策略：

- MVP 使用 `GET /tasks/{task_id}` 轮询即可。
- 默认轮询间隔 1.5 到 2 秒。
- 任务完成、失败或取消后停止轮询。
- 未来可补 `convert-manuscript/stream`，但不阻塞 P0。

## 客户端实现计划

### 移动端

1. 更新 TypeScript 类型，补齐 image props 的 `recognition_task_id` 和 `recognition_generated_at`。
2. 图片上传继续使用现有 Asset 上传能力，但移除对象存储直传 URL 兼容分支。
3. `uploadImage` 在 Asset ready 后创建 image Block。
4. 创建 image Block 后立即 flush，同步成功再启动 `recognize-image/stream`。
5. 增加图片识别中的 UI 状态和失败提示。
6. SSE `delta` 用于临时预览 caption。
7. SSE `done` 后重新拉取 Manuscript。
8. 转文档按钮改为打开弹窗。
9. 弹窗提交时传 `title` 和 `optimize_audio`。
10. TaskBanner 改成进度条样式。
11. Task 成功后打开生成的 Document。

### PC 端

1. 更新 PC 端 API 类型和 Block 转换逻辑，支持 image props 识别字段。
2. `recognizeImage` 改为真实后端调用，不再抛“接口缺失”。
3. 图片插入流程改为上传 Asset、创建 image Block、同步、启动识别。
4. 图片识别完成后重新拉取 Manuscript 或更新本地 Store。
5. 转文档入口改为弹窗，输入标题和录音优化开关。
6. `convertManuscript` 不再假设任务立即成功，应支持轮询 Task 进度。
7. 成功后写入 workspace store 并打开 Document。

## 后端实现计划

### 阶段 1：图像流程稳定化

- 保持 `ImageProps` 只持久化 caption 和识别元数据。
- 确保 `recognize-image` 成功后只覆盖服务端目标 Block 的 caption。
- 对 caption 非空的用户手动编辑场景增加覆盖策略评审。
- 保持 upload URL 为后端 API 地址。
- 增加或保留测试：图片上传、识别、caption 写回、转文档保留 image source ref。

### 阶段 2：转文档契约扩展

- `ConvertManuscriptRequest` 增加 `optimize_audio`。
- OpenAPI 更新并生成前端类型。
- `Task.result` 支持 `warnings`。
- 客户端和后端同时调整 mock、测试、文档示例。

### 阶段 3：转文档异步化

- `POST /tasks/convert-manuscript` 创建 queued task 后返回。
- 后台任务执行真实转换。
- `GET /tasks/{task_id}` 返回实时进度。
- 支持取消任务，取消后不写入 Document。
- 任务幂等保持 24 小时缓存语义。

### 阶段 4：模型单元实现

- 文本块直接转换。
- 录音块实现 `发言：` 前缀。
- 录音优化接入文本 LLM。
- 图片块在 caption 缺失时复用 VisionProvider 生成 caption。
- 手写块实现 strokes 到图片渲染。
- 手写块接入 VLM 识别和 `has_keepable_drawing` 判断。

### 阶段 5：验证与观测

- 记录每个模型单元的耗时、失败原因和降级路径。
- 统计转换任务成功率、失败率、P95 耗时。
- 增加端到端测试：混合文本、录音、图片、手写的 Manuscript 转 Document。
- 增加失败测试：图片识别失败、音频优化失败、手写识别失败。

## 验收标准

图片流程验收：

- 移动端插入图片后，服务端有 ready image Asset。
- Manuscript image Block 的 `asset_id`、`width`、`height` 正确。
- 图片 Block 同步成功后会启动识别任务。
- 识别成功后，重新拉取 Manuscript 能看到 `caption`、`recognition_task_id`、`recognition_generated_at`。
- 识别失败时原图仍可查看，Block 不丢失。
- PC 端图片插入不再抛“后端未提供图片识别接口”。

转文档验收：

- 点击转文档会弹窗询问文档标题。
- 用户可以选择是否启用录音内容优化。
- 转换期间客户端显示进度条。
- 文本块直接进入文档段落。
- 录音块进入文档时段首有 `发言：`。
- 启用录音优化后，明显口水词和无意义重复被去除，事实不被改写。
- 图片块在文档中保留原图和 caption。
- 纯手写文字只输出识别文本。
- 包含值得保留图示的手写块输出手写图片和识别文本。
- 转换成功后创建新 Document，不覆盖旧 Document。
- Document blocks 都带正确 `source_refs`。
- 任一非关键模型单元失败时，任务尽量降级成功并返回 warning。

## 风险与处理

| 风险 | 处理 |
|---|---|
| 图片识别任务完成时 Block 尚未同步 | 客户端必须先同步 Block，再启动识别 |
| 用户手动 caption 被 AI 覆盖 | caption 非空时重试前确认，或只在 caption 为空时自动覆盖 |
| 转文档任务耗时过长 | 后端异步任务 + 客户端轮询进度 |
| 模型并发导致成本失控 | 服务端设置并发上限、超时、用户级限流 |
| 手写渲染和 VLM 输出不稳定 | 结构化 JSON 输出、失败降级插入原图或跳过 |
| 录音优化改变原意 | 提示词约束 + fallback 原始 ASR + 后续人工校对入口 |

## 后续 P1

- 图片全文 OCR 持久化为 `recognized_text`，或作为独立 text Block 插入 Document。
- `convert-manuscript/stream` SSE 主入口。
- 手写识别结果回写 `handwriting.props.ai_text`。
- 图片 caption 版本历史和人工确认。
- 对已有 Document 做增量重新转换和差异合并。
- 更细粒度的 source region 回溯。
