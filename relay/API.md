# rain-relay 接口文档

`rain-relay` 是一个部署在 Cloudflare Worker 上的中继服务，让本地跑着的 AI agent 能远程操控一个静态托管的动画页面（当前用于 `innsuan/rain` 这个 GitHub Pages 项目），并接收页面上报的事件。

**Base URL**: `https://rain-relay.innsuanw.workers.dev`

**部署**: `cd relay && npx wrangler deploy`（需要先 `npx wrangler login`）

---

## 鉴权

只有**写入动态参数**（`POST /control`）和**发起抓拍**（`POST /capture`）需要鉴权,用一个共享密钥,通过请求头传：

```
X-Auth: <CONTROL_SECRET>
```

密钥用 `npx wrangler secret put CONTROL_SECRET` 设置在 Worker 环境变量里，不出现在任何客户端代码或仓库里。其余接口（读参数、上报触碰、读快照、页面上传抓拍帧）都不需要鉴权——都是低价值的遥测数据，公开读写风险可接受。

所有响应都是 `Content-Type: application/json`，并带 CORS 头（`Access-Control-Allow-Origin: *`），允许任意源的页面调用。

---

## 数据流向总览

```
                     ┌─────────────┐
   AI (本地 curl) ──POST /control──▶│             │──GET /control (轮询,~5s)──▶ 页面
   AI (本地 curl) ──POST /capture─▶│  rain-relay │──GET /capture (轮询,~5s)──▶ 页面
                     │  (Worker+KV │
   页面 ──POST /touch────────────▶│  +Durable   │──WS /watch (实时推送)────▶ AI (Monitor)
   页面 ──POST /snapshot──────────▶│  Object)    │
   页面 ──POST /frame─────────────▶│             │
                     └─────────────┘
   AI (本地 curl) ──GET /touches / /snapshot / /frame── 读回历史/最新数据
```

三种机制对应三种"重要性"：
- **控制参数**：AI 主动推送,页面被动轮询应用,不用刷新页面。
- **触碰事件**：页面主动上报,AI 可以选择实时监听（WebSocket）或事后查询（GET /touches）。
- **快照/抓拍**：纯拉取模型,页面按需响应,AI 想看的时候才主动去问。

---

## 接口列表

### `GET /control`
读取当前动态参数（page 每 ~5 秒轮询一次）。

**响应**：`{ [key: string]: number }`，key 是 `index.html` 里 `LIVE_RANGES` 定义的字段名（见下方“可控参数表”）。没设置过时返回 `{}`。

```bash
curl https://rain-relay.innsuanw.workers.dev/control
```

### `POST /control`  🔒 需要 `X-Auth`
设置动态参数,**整体覆盖**（不是合并),所以每次都要把想保留的字段一起传。

```bash
curl -X POST https://rain-relay.innsuanw.workers.dev/control \
  -H "Content-Type: application/json" -H "X-Auth: $SECRET" \
  -d '{"rainRate":5,"tideAmplitude":1,"tidePeriod":1.5}'
```

响应：`{"ok":true}` 或 `{"ok":false,"error":"unauthorized"}`（401）。

页面收到后调用 `window.liveConfig.setMany(data)`，每个字段会按 `LIVE_RANGES` 的范围各自 clamp。**只对 `LIVE_RANGES` 里列出的字段生效**，其余字段代码里不存在对应处理，会被 `liveConfig.set()` 拒绝（不报错，静默忽略该字段）。

### `POST /touch`
页面上报一次真实的拖拽（累计拖拽距离 ≥ 40px 才算一次，一次拖拽会话只报一次）。

```json
{ "dist": 90 }
```

Worker 收到后：写入 `touches` 日志（保留最近 50 条），**同时**通过 Durable Object 广播给所有当前连接 `/watch` 的 WebSocket 客户端。

### `GET /touches`
读取最近的触碰日志（fallback，没人实时监听 `/watch` 时用这个补看）。

```json
[ { "t": 1787555292672, "dist": 55 }, ... ]
```

### `GET /watch`  (WebSocket)
实时触碰频道。每次 `/touch` 都会作为一帧文本消息广播过来，内容是 `{"t":...,"dist":...}` 的 JSON 字符串。

```js
Monitor({ ws: { url: 'wss://rain-relay.innsuanw.workers.dev/watch' }, persistent: true })
```

### `POST /snapshot`
页面周期性（当前每 5 分钟）上报一次水的状态快照。

```json
{ "wind": 3.42, "tideAngle": 0.087, "particles": 8213, "drops": 12, "fps": 59.8, "live": { ... } }
```

Worker 收到后自动补一个 `t`（服务器时间戳，毫秒），追加进 `snapshots` 列表（保留最近 500 条）。

### `GET /snapshot?since=<ms>`
读回快照。不传 `since` 就是全部（最多 500 条），传了就只返回 `t > since` 的部分。

```bash
curl "https://rain-relay.innsuanw.workers.dev/snapshot?since=1787555000000"
```

### `POST /capture`  🔒 需要 `X-Auth`
请求抓一帧当前画面。只是把一个时间戳写进 KV，不等待页面响应。

```bash
curl -X POST https://rain-relay.innsuanw.workers.dev/capture \
  -H "Content-Type: application/json" -H "X-Auth: $SECRET" -d '{}'
```

### `GET /capture`
页面轮询这个接口（每 ~5 秒），看抓拍时间戳是否比上次处理过的新；变了就触发一次 `canvas.toDataURL()` 并上传到 `/frame`。

```json
{ "at": 1787558146815 }
```

### `POST /frame`
页面上传抓到的画面（JPEG，quality 0.85，data URL 格式）。**覆盖式**，只保留最新一张。

```json
{ "dataUrl": "data:image/jpeg;base64,..." }
```

### `GET /frame`
取回最新一帧。

```json
{ "t": 1787558146815, "dataUrl": "data:image/jpeg;base64,..." }
```

拿到后本地解码：

```bash
curl -s https://rain-relay.innsuanw.workers.dev/frame > frame.json
node -e "
const fs=require('fs');
const d=JSON.parse(fs.readFileSync('frame.json','utf8'));
const b64=d.dataUrl.replace(/^data:image\/\w+;base64,/,'');
fs.writeFileSync('frame.jpg', Buffer.from(b64,'base64'));
"
```

---

## 可控参数表（`LIVE_RANGES`，`index.html`）

| key | 范围 | 含义 |
|---|---|---|
| `r`, `g`, `b` | 0-255 | 水的颜色 |
| `rainRate` | 0-10（`rainRateMax`） | 雨量 |
| `waterLevel` | 0.03-0.97 | 水位（0=空，1=满） |
| `drainSpeed` | 0-2 | 排水/回到目标水位的速度 |
| `tideAmplitude` | 0-1 | 潮汐摆动角度（弧度），重力方向周期性旋转的幅度 |
| `tidePeriod` | 1.5-120 | 潮汐一个来回的秒数 |
| `flipRatio` | 0-0.99 | 流体粘稠感（0=蜂蜜，0.97=活泼易抖） |
| `windMin` / `windMax` | 0-150 | 风力随机游走的上下界 |
| `windChangeSpeed` | 0.02-10 | 风力追向新目标值的速度 |

不在这张表里、但影响行为的**静态上限**（改这些要修改 `index.html` 源码 + 重新部署 GitHub Pages，不能远程调）：

| 常量 | 位置 | 值 | 说明 |
|---|---|---|---|
| `rainRateMax` | CONFIG | 10 | `rainRate` 的真实硬顶 |
| `rainMaxDrops` | CONFIG | 700 | 空中同时存在的雨滴数上限 |
| `maxParticles` | CONFIG | 12000 | 水体粒子总量上限 |
| `dragMaxSpeed` | CONFIG | 50 | 拖拽注入速度上限 |
| `MAX_SPEED` | 独立变量 | 50 | 已落地水体粒子的速度安全钳制 |
| `rainInitialSpeed` | CONFIG | 50 | 雨滴沿重力方向的额外初速度（已从 LIVE 移除，纯静态） |

---

## 已知限制

- **代码变更需要刷新页面**：`LIVE_RANGES` 里的参数走轮询，不用刷新；但改 `CONFIG` 里的硬上限、改逻辑本身（比如这次的雨生成算法）是需要重新部署 + 用户手动刷新页面才能生效的代码变更，轮询机制覆盖不到。
- **KV 有写入传播延迟**：免费版偶尔要等几秒到几十秒才能在所有边缘节点读到最新写入,极端情况下 `GET` 紧跟着 `POST` 可能读到旧值。
- **`/frame` 只保留最新一张**，历史截图不会累积。
- **`touches`/`snapshots` 是定长循环缓冲区**（分别 50 条 / 500 条），超过会丢最旧的。
- 所有写接口没有 rate limit，`X-Auth` 是唯一的访问控制——密钥泄露的话任何人都能改动态参数或触发抓拍（但读接口本来就是公开的，风险有限）。

---

## 迁移到新项目

想让别的页面也接入这套远程控制/上报能力，可以选：

1. **共用这个 Worker**（省事，需要给 KV key 加命名空间前缀区分项目，目前代码还没做这层隔离——真要用的时候找我加）。
2. **整个复制一份 `relay/` 目录**，改 `wrangler.toml` 里的 `name`，重新 `wrangler kv namespace create`、`wrangler secret put`、`wrangler deploy`，得到一套完全独立的实例。
