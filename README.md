# 429 Worker

一个多上游、按模型分流的 Cloudflare Worker 代理。所有请求都需要通过 API token 白名单认证；只有 `POST /v1/chat/completions` 和 `POST /v1/responses` 在上游返回 `429` 或首字节前连接关闭时会立即重试（仅在选中的上游内重试）。

## 配置

`UPSTREAM_ROUTES` 是 JSON 数组（secret），按数组顺序匹配模型，第一条命中生效：

```json
[
  { "origin": "https://gpt.example.com", "models": ["gpt-4*", "gpt-3.5*"] },
  { "origin": "https://claude.example.com", "models": ["claude-*"], "api_key": "sk-..." },
  { "origin": "https://default.example.com" }
]
```

- `origin` 必须是没有路径、查询参数或认证信息的 HTTP(S) origin。
- `models` 可选：非空字符串数组，支持 `*` 通配符（无 `*` 即为精确匹配），大小写敏感。省略 `models` 的条目是默认上游，全配置最多一个。
- `api_key` 可选：设置后转发给该上游的 `Authorization` 会被覆盖为 `Bearer <api_key>`；未设置则透传客户端 Authorization。
- 若请求没有匹配任何条目且未配置默认上游，返回 `400`，请求不会触达上游。

`API_TOKEN_ALLOWLIST` 是 JSON 字符串数组，token 不包含 `Bearer ` 前缀：

```json
["token-a", "token-b"]
```

`MAX_RETRIES` 是首次请求失败后的最大重试次数，必须是非负整数；未配置时默认为 `4`（即最多尝试 5 次）。设为 `0` 可禁用重试。该值不是 secret，可在 `wrangler.toml` 的 `[vars]` 中配置。

本地开发时创建未提交的 `.dev.vars`：

```text
UPSTREAM_ROUTES=[{"origin":"https://api.example.com"}]
API_TOKEN_ALLOWLIST=["token-a","token-b"]
MAX_RETRIES=4
```

生产部署时使用 Wrangler secrets：

```bash
npx wrangler secret put UPSTREAM_ROUTES
npx wrangler secret put API_TOKEN_ALLOWLIST
npm run deploy
```

## 行为

- 请求必须携带 `Authorization: Bearer <token>`，且 token 在白名单中。
- 缺少或无效 token 返回 `403` JSON；请求不会触达上游。
- 所有 `POST` 且 Content-Type 为 `application/json`（或 `*+json`）的请求会缓冲 body、读取顶层 `model` 字段并按 `UPSTREAM_ROUTES` 分流；无 `model` 或 JSON 解析失败的请求走默认上游，原始 body 原样转发。
- multipart 表单（音频转写/翻译、图片编辑等）、非 JSON body 以及其他方法不按模型分流，一律走默认上游；其中不在可重试路径上的 POST 请求体保持流式转发，只发送一次（可重试路径上的非 JSON body 仍会缓冲以支持重试）。
- 上游 URL 使用命中条目的 origin，并保留客户端 pathname 和 query string。
- 认证通过后，原始 `Authorization` header 会透传给上游；若命中条目配置了 `api_key`，则改为转发 `Bearer <api_key>`。
- 仅以下两个精确路径的 POST 请求会在 429 或上游响应首字节前连接关闭时按 `MAX_RETRIES` 配置重试：
  - `/v1/chat/completions`
  - `/v1/responses`
- 重试只发生在本次选中的上游内，不跨上游 failover；重试之间不等待，也不使用 `Retry-After`。
- 其他方法或路径只请求一次。
- 白名单与上游路由在 Worker isolate 内按配置值缓存。
- 重试耗尽后的上游网络错误返回 `502`；配置错误返回 `500`；没有可匹配上游返回 `400`。

该 Worker 不提供 CORS、缓存、幂等键或额外的 Worker 访问控制。公开部署时，应在 Cloudflare Access 或路由层增加访问限制。

## 开发

```bash
npm install
npm test
npm run typecheck
npm run dev
```
