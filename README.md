# 429 Worker

一个多上游、按模型分流的 Cloudflare Worker 代理。所有请求都需要携带 Worker 层单独的 auth token；只有 `POST /v1/chat/completions` 和 `POST /v1/responses` 在上游返回 `429` 或首字节前连接关闭时会立即重试（仅在选中的上游内重试）。

## 配置

`UPSTREAM_ROUTES` 是 JSON 数组字符串（secret），按数组顺序匹配模型，第一条命中生效：

```json
[
  { "origin": "https://gpt.example.com", "models": ["gpt-4*", "gpt-3.5*"], "api_key": "sk-gpt" },
  { "origin": "https://claude.example.com", "models": ["claude-*"], "api_key": "sk-claude" },
  { "origin": "https://default.example.com", "api_key": "sk-default" }
]
```

- `origin` 必须是没有路径、查询参数或认证信息的 HTTP(S) origin。
- `api_key` 必填：该上游的固定 API token，不能包含空白字符。Worker 转发给该上游时始终使用 `Authorization: Bearer <api_key>`，客户端 token 不会被转发到上游。
- `models` 可选：非空字符串数组，支持 `*` 通配符（无 `*` 即为精确匹配），大小写敏感。省略 `models` 的条目是默认上游，全配置最多一个。
- 若请求没有匹配任何条目且未配置默认上游，返回 `400`，请求不会触达上游。

`WORKER_AUTH_TOKEN` 是客户端访问本 Worker 的唯一 token（不含 `Bearer ` 前缀），作为 Wrangler secret 配置：

```text
token-a
```

`MAX_RETRIES` 是首次请求失败后的最大重试次数，必须是非负整数；未配置时默认为 `4`（即最多尝试 5 次）。设为 `0` 可禁用重试。该值不是 secret，可选配置。

本地开发时创建未提交的 `.dev.vars` 配置全部环境变量：

```text
UPSTREAM_ROUTES=[{"origin":"https://api.example.com","api_key":"sk-..."}]
WORKER_AUTH_TOKEN=token-a
MAX_RETRIES=4
```

生产部署时设置 secrets 并部署：

```bash
npx wrangler secret put UPSTREAM_ROUTES
npx wrangler secret put WORKER_AUTH_TOKEN
npm run deploy
```

## 行为

- 请求必须携带 `Authorization: Bearer <WORKER_AUTH_TOKEN>`。
- 缺少或无效 token 返回 `403` JSON；请求不会触达上游。
- 所有 `POST` 且 Content-Type 为 `application/json`（或 `*+json`）的请求会缓冲 body、读取顶层 `model` 字段并按 `UPSTREAM_ROUTES` 分流；无 `model` 或 JSON 解析失败的请求走默认上游，原始 body 原样转发。
- multipart 表单（音频转写/翻译、图片编辑等）、非 JSON body 以及其他方法不按模型分流，一律走默认上游；其中不在可重试路径上的 POST 请求体保持流式转发，只发送一次（可重试路径上的非 JSON body 仍会缓冲以支持重试）。
- 上游 URL 使用命中条目的 origin，并保留客户端 pathname 和 query string。
- 客户端 `Authorization` 仅用于 Worker 认证，不会转发给上游；转发请求始终使用命中条目的固定 `api_key`（`Authorization: Bearer <api_key>`）。
- 仅以下两个精确路径的 POST 请求会在 429 或上游响应首字节前连接关闭时按 `MAX_RETRIES` 配置重试：
  - `/v1/chat/completions`
  - `/v1/responses`
- 重试只发生在本次选中的上游内，不跨上游 failover；重试之间不等待，也不使用 `Retry-After`。
- 其他方法或路径只请求一次。
- 上游路由配置在 Worker isolate 内按配置值缓存。
- 重试耗尽后的上游网络错误返回 `502`；配置错误返回 `500`；没有可匹配上游返回 `400`。

该 Worker 不提供 CORS、缓存、幂等键或额外的 Worker 访问控制。公开部署时，应在 Cloudflare Access 或路由层增加访问限制。

## 开发

```bash
npm install
npm test
npm run typecheck
npm run dev
```
