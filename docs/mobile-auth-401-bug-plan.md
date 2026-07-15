# Mobile 端认证 401 并发刷新问题与解决方案

本文只描述当前 Mobile 端容易出现 `401 Unauthorized` 的原因和修复方案，不包含代码改动。目标是保留现有后端 refresh token 轮换机制，同时让移动端并发请求在 access token 过期时稳定恢复。

## 结论

Mobile 端已经实现了“请求 401 后调用 `/auth/refresh` 再重试”的基本逻辑，但没有 refresh 并发锁。后端 refresh token 是一次性轮换的，多个请求同时遇到 access token 过期时，会同时拿旧 refresh token 去刷新。第一个请求成功后旧 refresh token 被删除，其他请求会刷新失败并收到 401。

所以 Mobile 端的核心修复是：给 refresh 增加 `refreshPromise` 串行化，并让所有等待中的请求复用同一次 refresh 结果。

## 当前后端认证基线

后端当前认证模型如下：

| 项 | 当前实现 |
|---|---|
| access token | 随机 opaque bearer token，服务端存库 |
| access token 有效期 | 30 分钟 |
| refresh token | 随机 opaque token，服务端存库 |
| refresh token 有效期 | 30 天 |
| refresh 行为 | 校验 refresh token 后删除旧 refresh token，再签发新 access/refresh token |
| 设备绑定 | refresh 请求必须带匹配的 `client_id` |
| 401 文案 | 统一返回 `unauthorized`，通常无法区分过期、无效、缺失 |

这是一种服务端会话 token 模式，不是 JWT。后端 refresh token 轮换本身是常见安全策略，但前端必须处理并发刷新。

相关后端位置：

- `backend/app/main.py` 的 `ACCESS_TOKEN_SECONDS` 和 `REFRESH_TOKEN_SECONDS`。
- `backend/app/main.py` 的 `/auth/refresh` 会删除旧 refresh token。
- `backend/app/main.py` 的 `auth_context()` 会在 access token 缺失、过期或无效时返回 401。
- `backend/app/schema.sql` 的 `auth_tokens` 表保存 access/refresh token。

## Mobile 端现象

典型触发路径：

1. 用户登录 Mobile 端。
2. access token 超过 30 分钟过期。
3. 用户打开应用或进入首页。
4. `refreshLibrary()` 同时发起 `listManuscripts()` 和 `listDocuments()`。
5. 两个请求都收到 401。
6. 两个请求都进入 `refreshSession()`，使用同一个旧 refresh token 调用 `/auth/refresh`。
7. 第一个 refresh 成功，后端删除旧 refresh token 并返回新 token。
8. 第二个 refresh 使用的旧 refresh token 已失效，收到 401。
9. UI 看到认证错误，用户误以为需要重新登录。

当前相关 Mobile 端位置：

- `mobile/src/lib/api.ts` 的 `request()` 已有 401 后 refresh 并重试逻辑。
- `mobile/src/lib/api.ts` 的 `refreshSession()` 每次都会直接发 `/auth/refresh`，没有并发复用。
- `mobile/src/App.tsx` 的 `refreshLibrary()` 使用 `Promise.all()` 并发加载手稿和文档，容易同时触发 401。
- `mobile/src/lib/api.ts` 的 `getAssetObjectUrl()` 直接 `fetch` 资源流，不走统一 request，也不会自动 refresh。

## 根因

### 1. refresh token 一次性轮换

后端 refresh 成功后会删除旧 refresh token。这是合理安全策略，但会放大并发刷新问题。

### 2. Mobile 端没有 refresh mutex

多个请求可以同时进入 `refreshSession()`。只要它们读到的是同一个旧 refresh token，就会发生“一次成功，其余失败”。

### 3. 启动加载天然并发

`refreshLibrary()` 同时请求 manuscripts 和 documents。access token 过期时，这两个请求几乎必然同时 401。

### 4. 资源流接口绕过统一认证处理

`getAssetObjectUrl()` 直接使用 `fetch`。当 access token 过期时，资源加载失败不会触发 refresh。

## 解决方案

### P0 必做

1. 在 Mobile API 客户端增加 `refreshPromise`。
2. 所有 401 请求进入同一个 refresh 流程，已有 refresh 进行中时只等待，不再发新的 `/auth/refresh`。
3. refresh 成功后所有等待请求使用最新 access token 重试一次。
4. refresh 失败时才清 session 或进入登录页。
5. `getAssetObjectUrl()` 遇到 401 时也使用同一套 refresh 后重试一次。
6. 单个逻辑请求重试时复用原 `Idempotency-Key`，避免写请求语义变动。

### P1 建议

1. 根据 `access_token_expires_in` 保存本地过期时间，提前 1 到 2 分钟主动 refresh。
2. 对 401 错误保留后端 `request_id` 并上报，方便定位是否为 refresh 竞争。
3. 引入统一 session 事件，让页面在 refresh 失败时只做一次全局登出处理。

## 推荐实现设计

### refresh 串行化

API 客户端内部维护：

```ts
private refreshPromise: Promise<void> | null = null;
```

行为规则：

1. `refreshPromise` 为空时，当前请求创建 refresh 任务。
2. `refreshPromise` 不为空时，当前请求等待现有 refresh 任务。
3. refresh 成功后更新 `this.session` 和 localStorage。
4. 所有等待者从 `this.session` 读取最新 access token 并重试原请求。
5. refresh 完成后在 `finally` 中把 `refreshPromise` 置空。
6. refresh 失败时清空 session，并抛出结构化 401 错误。

推荐伪代码：

```ts
private async ensureFreshSession() {
  if (this.refreshPromise) return this.refreshPromise;
  this.refreshPromise = this.refreshSession().finally(() => {
    this.refreshPromise = null;
  });
  return this.refreshPromise;
}
```

`request()` 中收到 401 后：

```ts
if (response.status === 401 && auth && retryAllowed && this.session?.refresh_token) {
  await this.ensureFreshSession();
  return this.request(path, retryOptions, rawResponse);
}
```

关键点是 `refreshSession()` 不能再被多个请求直接并发调用。

### refresh token 快照

发起 refresh 时应读取当前 session 的 refresh token 快照：

```ts
const session = this.session;
```

如果等待期间 session 已被其他 refresh 更新，后续请求不应继续使用旧 refresh token，而应等待已有 `refreshPromise` 结束后使用最新 access token 重试。

### Idempotency-Key 复用

当前写请求会在 `request()` 内生成 `Idempotency-Key`。401 后重试时，建议把本次逻辑请求的 key 保存在 retry options 或 headers 中，重试复用同一个 key。

虽然认证失败通常发生在业务处理前，但稳定复用同一个 `Idempotency-Key` 更符合幂等语义，也方便排查日志。

### 资源流重试

`getAssetObjectUrl()` 应处理：

1. 使用当前 access token 请求资源流。
2. 如果返回 401，调用 `ensureFreshSession()`。
3. 使用新 access token 再请求一次。
4. 第二次仍失败时抛出 `ApiError`。

## 验收标准

### 必须通过

1. access token 过期后打开首页，`listManuscripts()` 和 `listDocuments()` 并发请求只触发一次 `/auth/refresh`。
2. refresh 成功后两个原请求都能重试成功。
3. localStorage 中保存的是新的 access token 和 refresh token。
4. refresh token 真正过期或被服务端删除时，才进入登录流程。
5. 资源流接口在 access token 过期后能 refresh 并重新加载。
6. 多次连续点击创建、同步、导出等写操作时，不会因为 refresh 竞争导致随机 401。

### 建议补充测试

1. API 客户端单测：两个并发 401 只调用一次 `/auth/refresh`。
2. API 客户端单测：refresh 成功后两个请求都用新 access token 重试。
3. API 客户端单测：refresh 失败后清 session。
4. API 客户端单测：资源流 401 后 refresh 并重试。
5. 集成测试：应用启动时 access token 过期，首页列表仍能加载。

## 非本次范围

1. 不要求后端延长 access token 有效期。
2. 不要求后端取消 refresh token 轮换。
3. 不把 opaque token 改成 JWT。
4. 不改变现有 `client_id` 生成和保存规则。

## 后端协同建议

前端修复后，后端可以在后续迭代增强可观测性和容错：

1. 401 错误码细分为 `access_token_expired`、`refresh_token_expired`、`refresh_token_invalid`。
2. refresh token 入库前保存 hash，而不是明文 token。
3. 引入 refresh token family 和 reuse detection，区分攻击复用和客户端并发复用。
4. 对 refresh token 轮换增加极短 grace window，但这不是前端本次修复的前置条件。

## 风险提示

不能通过“失败后再次调用 `/auth/refresh`”解决该问题。旧 refresh token 已经被后端删除，继续重试只会产生更多 401。正确做法是从源头保证同一时刻只有一个 refresh 请求，其他请求等待并复用结果。
