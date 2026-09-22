# qqbot-plugin-pixiv

运行在 [qqbot-workers](https://github.com/)（Cloudflare Workers）上的 QQ 机器人 Pixiv 图床插件，移植自 AstrBot 插件 [astrbot_plugin_pixiv_yuki](https://github.com/NightDust981989/astrbot_plugin_pixiv_yuki)。

图片资源来自 [pixiv.yuki.sh](https://pixiv.yuki.sh/) 第三方图床（已过滤 R-18），**版权归原作者所有**，使用需遵守相关法律法规及平台规则。

## 指令

| 指令 | 说明 |
| --- | --- |
| `/pixiv` | 查看帮助 |
| `/pixiv random [尺寸]` | 随机一张图，尺寸可选 `mini / thumb / small / regular / original`，缺省用配置 |
| `/pixiv illust <作品ID>` | 查询作品详情并附图 |

## 配置（面板 → 插件配置）

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `show_image_info` | bool | `true` | 随机图片是否附带作品信息（标题、作者、标签） |
| `default_image_size` | enum | `regular` | 随机图片默认尺寸 |
| `max_image_mb` | number | `20` | 单张图片体积上限（MB），超过则回落小一档；范围 0.5–20。默认=上限，即不设限制。仅 base64 路径生效 |
| `public_base_url` | string | 空 | Worker 公开地址（如 `https://bot.example.com`）。填了就走 URL 直传，可绕开 CPU 上限 |

## 发送机制

作品信息（纯文本）与图片分两条消息发送。图片有两条发送路径：

| 路径 | 触发条件 | 插件侧 CPU | 体积上限 |
| --- | --- | --- | --- |
| **URL 直传**（推荐） | 配了 `public_base_url` | ≈ 0 | 20 MB（QQ 侧软限制，超了会降级成文件卡片） |
| base64 直传 | `public_base_url` 留空 | ≈ 2.5 ms/MB 原图 | 约 3 MB（Free 套餐 CPU 上限所致） |

- 默认尺寸 `regular`（master1200 jpg，通常 1–3MB）。
- 每次发送都会检查结果，失败原因写入 Worker 日志（`wrangler tail` 可见）。

## URL 直传（v1.3.0 起，推荐）

v1.0.0 曾经把图床直链直接交给 QQ，失败得很惨——因为 yuki.sh 按 `Sec-Fetch-Site` 做防盗链，而 QQ 的抓取器不会带浏览器特征头，直接 403。**现在的做法是在中间加一层自己的代理**：请求头由插件加，QQ 只需要拉一个普通 URL。

流程（群聊/单聊）：

```
/pixiv random
  → 插件查 API，拿到图床直链
  → 回一条 { image: { url: "https://<你的域名>/p/pixiv/img?src=<图床直链>" } }
  → 运行时先 POST /v2/{groups|users}/{id}/files { file_type:1, url:…, srv_send_msg:false }
      平台在这一步来拉代理地址 → 代理加上浏览器头去图床取图 → 流式转发回平台
      平台转存后返回 file_info
  → 再 POST …/messages { msg_type:7, media:{ file_info } } 发出图片
```

插件全程**不下载、不编码、不序列化**，CPU 开销接近零。base64 路径上的约 3 MB CPU 天花板随之消失，改为受平台自己的规则约束（图片 20 MB 软限制）。

**开启方式**：面板配置 `public_base_url` 填 Worker 的公开地址（如 `https://bot.example.com`），插件会在其下拼接 `/p/pixiv/img`。只接受 `https`（Workers 与自定义域名本来就只有 https），填 `http` 会被当作未配置处理；多余路径会被裁掉，只取 origin。

### 失败会怎样

平台拉取发生在**上传接口那一次同步调用**里（上面流程的 `/files` 一步），所以域名拉不通不是"静默丢图"：

- 上传调用返回非 2xx 或缺 `file_info` → 运行时把它转成 `{ ok: false, error }`；
- 插件收到后**自动回退 base64 直传**，并在日志里留下 `URL 直传失败，回退 base64（多为平台拉不到该域名）`。

也就是说最坏情况是退回旧的 base64 路径（重新受 `max_image_mb` 约束），而不是收不到图。`workers.dev` 在国内可达性不稳，若日志反复出现这条 warn，建议换自定义域名；换不了就清空 `public_base_url`，行为与 v1.2.0 完全一致。

> 例外：**频道（guild）场景**没有 `/files` 端点，图片走消息体的 `image` 字段，那条路才是异步静默的。本插件主要面向群聊与单聊，不受影响。

### 开启 URL 直传后，两个配置项的性质变了

| 配置项 | 变化 |
| --- | --- |
| `max_image_mb` | **失效**（图片不经插件下载，无从预检）。它只在回退到 base64 时才起作用 |
| `default_image_size` | 仍然生效，且**不再需要为 CPU 让步**——可以考虑调到 `original` 拿最高画质 |

原因在代码路径上：URL 直传用的是 `candidateUrls` 的首项，也就是你请求的那一档，所以 `default_image_size` 与 `/pixiv random <尺寸>` 都照常生效；而 `max_image_mb` 只在 base64 分支的 `fetchImageBytes` 里被读到，URL 直传分支根本不会走到那里。

注意 `original` 是原图（可能几 MB 到十几 MB，部分作品是 PNG），平台侧的图片软限制是 **20 MB**，超了会降级成文件卡片而不是内联图。追求稳定的话 `regular` 已经足够。

### 代理路由的安全边界

QQ 没有登录态，所以这条路由必须是 `auth: 'public'`。已做的防护：

- **host + path 白名单**：用解析后的 `URL` 判定 `https` + `pixiv.yuki.sh` + `/image/` 前缀，挡得住 `https://pixiv.yuki.sh.evil.com/` 这类后缀伪造；
- **不跟随重定向**（`redirect: 'manual'`）：否则上游一次 302 就能绕过白名单；
- **流式转发**（`new Response(res.body, ...)`）：不把图片读进内存，这也是它 CPU 接近零的原因。

**残余风险**：知道该地址的人可以拿它当图床的免费 CDN（消耗你的带宽/请求数）。由于 host 被白名单锁死，无法用来 SSRF 其他主机。个人机器人可接受；如果介意，可以在代理路由里再加一层签名校验。

## CPU 预算与尺寸回落（v1.2.0 起）

Free 套餐每请求 CPU 上限固定 **10 ms**（官方明确不可提升），而 base64 直传的成本随图片体积线性增长。实测各环节开销（3 MB 图）：

| 环节 | 开销 | 归属 |
| --- | --- | --- |
| 原生 base64 编码 | ≈ 0.3 ms（改造前同一张图要 46 ms） | 插件 |
| 出站载荷序列化 | ≈ 1.87 ms / MB **载荷** ⇒ ≈ **2.5 ms / MB 原图** | 运行时，插件无法干预 |
| 运行时基线 | ≈ 2.2 ms | 运行时 |

> 单位容易搞混：`1.87` 是按 base64 **载荷**算的（实测 `JSON.stringify` 吞吐稳定在 537 MB/s），换算到原图要乘 1.33 的膨胀系数，即 `2.5 ms/MB`。

预算 `10 − 2.2 − 0.3 ≈ 7.5 ms` 用于序列化，**原图天花板约 3.0 MB**。超过这个体积会以 `Error 1102`（`exceededCpu`）失败——这不是编码器能解决的问题，任何插件侧优化都抬不动这条线。

v1.2.0 为此加入两层处理：

1. **下载前预检 `Content-Length`**：超预算直接掐断响应体，不白付一次完整的字节搬运与编码。
2. **逐级回落**：请求档超预算时自动改用小一档（`original → regular → small → thumb → mini`），而不是直接失败；回落会记 `warn` / `info` 日志，可用 `wrangler tail` 观察。

阈值即面板配置 `max_image_mb`，面板可调范围 0.5–20，**默认 20（等于上限，即不做人为限制）**。

### 默认为什么是不限制，以及代价是什么

上限取 **20 MB**，依据是 QQ 自己的图片软限制（官方富媒体文档：`file_type=1` 软限制 20 MB、硬限制 200 MB，超软限制会降级为文件卡片）——原图超过 20 MB 平台本来就会当文件发，再往上调没有意义。

默认值直接取上限，意味着**不替使用者做体积决策**。这个选择成立的依据是：推荐的 URL 直传路径根本不经过这里（配了 `public_base_url` 后图片不经插件下载，本项被完全忽略），所以默认值只在"URL 直传不可用"这条退路上才生效。

**代价必须说清楚**：在 Free 套餐上跑 base64 路径时，超过约 3 MB 的图会撞 `Error 1102` 让整条消息失败，而不是回落小一档。

| 阈值 | Free 上遇到 5 MB 的图 |
| --- | --- |
| 20 MB（默认） | 放行 → 下载 → base64 膨胀到 6.7 MB → 序列化约 12.5 ms → 超 10 ms 预算 → **整条失败** |
| 2 MB | 预检拦下 → 回落小一档 → **图照样发出去** |

关键在于**这条路径没有兜底**：CPU 一旦超限，官方文档只说明会向客户端返回 `1102` 错误页，**并未说明该错误能否被 `try/catch` 捕获**（我没实测过，不做断言）。但无论能否捕获，兜底都无从谈起——预算已经花光，而任何补救动作（比如改发小一档）本身还要再花 CPU。

所以：**在 Free 上跑 base64 路径且想要稳定，把 `max_image_mb` 调回 2**；Paid 套餐（默认 30 s CPU）下保持 20 完全没问题。

### 想要更大更清晰的图，正确的旋钮是 `default_image_size`

`max_image_mb` 只决定"超过就换小一档"，它不能让大图发出去——调高它只会把优雅降级换成硬失败。要真正提升画质：

1. 配好 `public_base_url` 走 URL 直传（此时体积与 CPU 都不再是约束）；
2. 把 `default_image_size` 调到 `original`。

只有在 URL 直传用不了（域名不被平台可达）时，才需要回到 `max_image_mb` 这里权衡。

## 排错

| 现象 | 排查 |
| --- | --- |
| 完全没反应 | 群聊需 @ 机器人（除非群已开「接收全部消息」）；`wrangler tail qqbot` 看是否命中命令 |
| 文字到了没图 | tail 日志搜 `图片发送失败` / `图片下载失败`，多为 QQ 富媒体审核拒绝或上游图床超时，可换个尺寸重试 |
| 偶尔收到比请求更小的图 | 正常回落，tail 搜 `已回落尺寸` / `图片超出体积预算` 看实际档位 |
| `Error 1102`（`exceededCpu`） | CPU 超 10 ms 上限。把面板的 `max_image_mb` 调小（如 1.5）；持续出现说明需要 Paid 套餐 |
| 配了 `public_base_url` 后图片明显变小/受 `max_image_mb` 影响 | 说明走了 base64 回退路径。tail 搜 `URL 直传失败` 确认；根因通常是平台拉不到该域名，换自定义域名或清空该项 |
| 配了 `public_base_url` 后文字到了但没图 | tail 搜 `图片发送失败` / `图片下载失败`。URL 直传失败会自动回退 base64，所以这里没有记录就不是"平台拉不到域名"的问题，而是富媒体审核或上游图床故障 |
| 代理路由返回 403 | `src` 不在白名单内，或图床直链格式变了（调整 `ALLOWED_HOST` / `ALLOWED_PATH_PREFIX`） |
| 代理路由返回 502 | 上游图床超时、返回非 2xx，或发生了重定向；tail 搜 `图片代理` 看具体原因 |

## 安装

机器人面板 → 插件 → 安装插件，source 填：

```
git:<owner>/qqbot-plugin-pixiv@<完整commit>
```

## 开发

```bash
npm install        # @qqbot/sdk 未发布到 npm 前，可在 qqbot-workers monorepo 内以符号链接方式本地调试
npm test           # vitest（fetch 全部 mock，不打真实 API）
npm run typecheck
npm run build      # 产物 dist/plugin.js + dist/manifest.json
npm run sync       # 构建并同步声明清单到仓库根目录（随代码提交）
```

## 许可

AGPL-3.0（与原插件一致），见 [LICENSE](./LICENSE)。原插件作者：NightDust981989 & xueelf。
