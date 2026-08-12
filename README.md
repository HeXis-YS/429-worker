# 429 Worker

一个固定上游的 Cloudflare Worker 代理。所有请求都需要通过 API token 白名单认证；只有 `POST /v1/chat/completions` 和 `POST /v1/responses` 在上游返回 `429` 或首字节前连接关闭时会立即重试。

## 配置

`UPSTREAM_ORIGIN` 必须是没有路径、查询参数或认证信息的 HTTP(S) origin，例如：

```text
https://api.example.com
```

`API_TOKEN_ALLOWLIST` 是 JSON 字符串数组，token 不包含 `Bearer ` 前缀：

```json
["token-a", "token-b"]
```

`MAX_RETRIES` 是首次请求失败后的最大重试次数，必须是非负整数；未配置时默认为 `4`（即最多尝试 5 次）。设为 `0` 可禁用重试。该值不是 secret，可在 `wrangler.toml` 的 `[vars]` 中配置。

本地开发时创建未提交的 `.dev.vars`：

```text
UPSTREAM_ORIGIN=https://api.example.com
API_TOKEN_ALLOWLIST=["token-a","token-b"]
MAX_RETRIES=4
```

生产部署时使用 Wrangler secrets：

```bash
npx wrangler secret put UPSTREAM_ORIGIN
npx wrangler secret put API_TOKEN_ALLOWLIST
npm run deploy
```

## 行为

- 请求必须携带 `Authorization: Bearer <token>`，且 token 在白名单中。
- 缺少或无效 token 返回 `403` JSON；请求不会触达上游。
- 认证通过后，原始 `Authorization` header 会透传给上游。
- 上游 URL 使用固定 origin，并保留客户端 pathname 和 query string。
- 仅以下两个精确路径的 POST 请求会在 429 或上游响应首字节前连接关闭时按 `MAX_RETRIES` 配置重试：
  - `/v1/chat/completions`
  - `/v1/responses`
- 重试之间不等待，也不使用 `Retry-After`。
- 其他方法或路径只请求一次。
- 只有会重试的两个 POST 路径会缓存请求体；其他非 GET/HEAD 请求只转发一次并保留流式 body。
- 白名单在 Worker isolate 内按配置值缓存，并使用集合进行 token 查找。
- 重试耗尽后的上游网络错误返回 `502`；配置错误返回 `500`。

该 Worker 不提供 CORS、缓存、幂等键或额外的 Worker 访问控制。公开部署时，应在 Cloudflare Access 或路由层增加访问限制。

## 开发

```bash
npm install
npm test
npm run typecheck
npm run dev
```
