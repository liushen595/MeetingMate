# PC 端认证 401 频发问题与解决方案

本文只描述当前 PC 端容易出现 `401 Unauthorized` 的原因和修复方案，不包含代码改动。目标是让 PC 端在 access token 过期后自动刷新会话，避免用户频繁重新登录。

## 结论

PC 端当前没有自动刷新 access token。后端 access token 有效期是 30 分钟，过期后任意受保护接口都会返回 401；PC 端收到加载失败后还会直接清空本地 session，所以用户表现为“经常需要重新登录”。

优先修复点不是后端 token 时长，而是 PC API 客户端缺失刷新链路和错误分类。

## 当前后端认证基线

后端当前认证模型如下：

| 项 | 当前实现 |
|---|---|
| access token | 随机 opaque bearer token，服务端存库 |
| access token 有效期 | 30 分钟 |
| refresh token | 随机 opaque token，服务端存库 |
| refresh token 有效期 | 30 天 |
| refresh 行为 | 校验 refresh token 后删除旧 refresh token，再签发新 access/refresh token |
| 设备绑定 | refresh 时校验 `client_id`，受保护写请求校验 `X-Client-Id` |
| 401 文案 | 统一返回 `unauthorized`，通常无法区分过期、无效、缺失 |

这不是 JWT 模式，而是服务端会话 token 模式。该模式本身可接受，但客户端必须正确处理 access token 过期和 refresh token 轮换。

相关后端位置：

- `backend/app/main.py` 的 `ACCESS_TOKEN_SECONDS` 和 `REFRESH_TOKEN_SECONDS`。
- `backend/app/main.py` 的 `create_tokens()` 负责签发 token。
- `backend/app/main.py` 的 `auth_context()` 负责校验 access token。
- `backend/app/main.py` 的 `/auth/refresh` 负责 refresh token 轮换。
- `backend/app/schema.sql` 的 `auth_tokens` 表保存 token。

## PC 端现象

典型触发路径：

1. 用户登录 PC 端。
2. 停留超过 30 分钟，或第二天打开应用但本地仍有旧 session。
3. `loadWorkspace()` 调用 `/manuscripts` 和 `/documents`。
4. 后端判断 access token 过期，返回 401。
5. PC 端没有调用 `/auth/refresh`。
6. `AppShell` 捕获异常后执行 `pcApi.clearSession()`。
7. UI 回到登录页，用户被迫重新登录。

当前相关 PC 端位置：

- `PC/src/lib/api.ts` 的 `request()` 只附带 `Authorization: Bearer <access_token>`，不处理 401 refresh。
- `PC/src/lib/api.ts` 的 `parseResponse()` 把所有非 2xx 都转成普通 `Error`，丢失 HTTP status。
- `PC/src/components/AppShell.tsx` 的启动加载失败逻辑会清空 session，不区分 401、网络错误、500 或后端临时不可用。
- `PC/src/lib/api.ts` 的 `getAssetObjectUrl()` 直接 `fetch` 资源流，不走统一 request，也不会自动刷新。

## 根因

### 1. 缺少自动 refresh

PC 端类型里只声明了 `access_token` 和 `refresh_token`，没有使用 `access_token_expires_in`。这不是问题本身，客户端可以被动在 401 时刷新；真正问题是当前完全没有刷新逻辑。

### 2. 错误处理过于粗糙

`parseResponse()` 抛出的普通 `Error` 不包含 `status`、`code`、`request_id`。上层无法判断是否应该刷新、清 session、提示重试或展示服务异常。

### 3. 启动失败直接登出

`AppShell` 在 workspace 加载失败时直接清 session。即使失败原因是网络断开、后端 500、接口超时，也会把用户登录态清掉。

### 4. 资源流接口绕过统一认证处理

`getAssetObjectUrl()` 使用独立 `fetch`。access token 过期时，音频或图片加载会直接失败，不会自动刷新后重试。

## 解决方案

### P0 必做

1. 在 PC API 客户端增加结构化错误类型。
2. 在 `request()` 中处理 401：调用 `/auth/refresh`，成功后重试原请求一次。
3. 增加 `refreshPromise`，保证同一时间只有一个 refresh 请求。
4. refresh 失败时才清 session，并让 UI 回到登录页。
5. `AppShell` 只在明确认证失效时清 session；网络错误和服务端错误只提示加载失败。
6. `getAssetObjectUrl()` 遇到 401 时走同一套 refresh 后重试一次。

### P1 建议

1. 保存 token 绝对过期时间，提前 1 到 2 分钟主动 refresh，减少用户请求撞上过期边界。
2. 对 `401 unauthorized` 以外的错误保留 `request_id`，方便排查后端日志。
3. 对长期打开的窗口增加 session 状态事件，让 UI 能统一响应 refresh 失败。

## 推荐实现设计

### Session 类型

PC 端应补齐后端返回字段：

```ts
type Session = {
  access_token: string;
  access_token_expires_in: number;
  refresh_token: string;
  refresh_token_expires_in: number;
  user: { id: string; email: string; name: string };
};
```

如果暂不使用 `expires_in`，也应该保留字段，避免丢失服务端契约。

### ApiError 类型

新增错误类型，至少保留：

```ts
class ApiError extends Error {
  status: number;
  code: string;
  requestId?: string;
}
```

上层判断认证失败时应基于 `error.status === 401`，而不是匹配错误文案。

### refresh 串行化

API 客户端内部维护：

```ts
private refreshPromise: Promise<void> | null = null;
```

规则：

1. 如果已有 `refreshPromise`，后续请求只等待它，不再发第二个 `/auth/refresh`。
2. 第一个请求负责调用 `/auth/refresh` 并更新 `this.session` 和 localStorage。
3. 等待者拿到最新 `this.session.access_token` 后重试原请求。
4. refresh 失败时清 session，并抛出 401 类型错误。

PC 端目前常见并发是 `loadWorkspace()` 同时请求手稿和文档。虽然 PC 当前没有 refresh，但补上 refresh 时必须一起做串行化，否则会复现 mobile 端的并发刷新问题。

### request 重试规则

推荐规则：

1. 默认请求需要认证。
2. 登录、注册、刷新不需要认证。
3. 普通请求收到 401 后最多 refresh 并重试一次。
4. 重试时应复用同一逻辑请求的 `Idempotency-Key`，避免写请求在认证边界出现重复语义。
5. refresh 失败不再重试，直接抛出认证失败。

### AppShell 行为

`AppShell` 应改成：

| 错误类型 | UI 行为 |
|---|---|
| refresh 成功 | 用户无感，继续加载 |
| refresh 失败或无 refresh token | 清 session，回登录页 |
| 网络错误 | 保留 session，提示网络不可用 |
| 5xx | 保留 session，提示服务器暂时不可用 |
| 403 | 保留 session，提示权限不足 |

这能避免服务临时不可用时把用户踢下线。

## 验收标准

### 必须通过

1. 登录后手动让 access token 过期，PC 端打开应用能自动 refresh 并加载工作区。
2. `loadWorkspace()` 并发请求只有一个 `/auth/refresh` 请求。
3. refresh 成功后 localStorage 中的 access/refresh token 都更新。
4. refresh token 失效时，用户才回到登录页。
5. 后端 500 或网络断开时不会清空 session。
6. 音频或图片资源流在 access token 过期后能 refresh 并重试加载。

### 建议补充测试

1. API 客户端单测：401 后 refresh 成功并重试。
2. API 客户端单测：两个并发 401 只触发一次 refresh。
3. API 客户端单测：refresh 失败清 session。
4. UI 集成测试：workspace 加载 500 不退出登录。

## 非本次范围

1. 不修改后端 token 存储方式。
2. 不把 opaque token 改成 JWT。
3. 不延长 access token 到数小时。
4. 不调整 `/auth/logout` 语义。

## 风险提示

refresh token 是一次性轮换的。PC 端补 refresh 时必须同时做 `refreshPromise` 串行化，否则两个并发 401 会同时使用同一个旧 refresh token，后端只会允许第一个成功，第二个会 401。
