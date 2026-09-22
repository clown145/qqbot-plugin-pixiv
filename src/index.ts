import {
  button,
  definePlugin,
  keyboard,
  type Keyboard,
  type Logger,
  type OutgoingMessage,
  type SendResult,
} from '@qqbot/sdk'

/** 与 configSchema 对应；面板保存的配置通过 ctx.config 注入 */
export interface PluginConfig {
  /** 随机图片是否附带作品信息（标题、作者、标签） */
  show_image_info: boolean
  /** 随机图片默认尺寸 */
  default_image_size: ImageSize
  /** 单张图片体积上限（MB），见 DEFAULT_MAX_IMAGE_MB 的推导 */
  max_image_mb: number
  /** Worker 的公开访问地址（如 https://bot.example.com）；留空则回退 base64 直传 */
  public_base_url: string
  /** 是否在文本消息上挂内嵌按钮 */
  show_buttons: boolean
  /** 文本与图片的发送顺序 */
  message_order: MessageOrder
}

export type ImageSize = 'mini' | 'thumb' | 'small' | 'regular' | 'original'

/** 文本与图片的先后；text_first 时按钮夹在文本与图片之间，image_first 时按钮落在最底部 */
export type MessageOrder = 'text_first' | 'image_first'

const MESSAGE_ORDERS: readonly MessageOrder[] = ['text_first', 'image_first']

const SIZES: readonly ImageSize[] = ['mini', 'thumb', 'small', 'regular', 'original']

/** 尺寸由大到小；单张图片超出 CPU 预算时按此顺序逐级回落，而不是直接失败 */
const SIZE_DESC: readonly ImageSize[] = ['original', 'regular', 'small', 'thumb', 'mini']

/** 请求档比现有档都小时（如只要 mini 但只有 original）的兜底优先级，沿用原插件行为：regular 是体积与清晰度的平衡点 */
const FALLBACK_ORDER: readonly ImageSize[] = ['regular', 'original', 'small', 'thumb', 'mini']

/**
 * 单张图片体积上限的推导。Workers Free 每请求固定 10 ms CPU，官方明确不可提升，
 * 而 base64 直传的成本随体积线性增长，所以需要一个阈值（推导基准：3 MB 图实测）：
 *   原生 base64 编码   ≈ 0.3 ms（改造后；原实现在同一张图上要 46 ms）
 *   出站载荷序列化     ≈ 1.87 ms / MB **载荷**（实测 JSON.stringify 吞吐稳定在 537 MB/s）
 *                        base64 膨胀 1.33 倍 ⇒ ≈ 2.5 ms / MB **原图**（注意别把这两个单位搞混）
 *   运行时基线         ≈ 2.2 ms（官方公布的 Worker 平均值；宿主实际值未知，故留大余量）
 * 预算 10 − 2.2 − 0.3 ≈ 7.5 ms 用于序列化 ⇒ **Free 上的安全区约 3.0 MB**。
 *
 * 面板上限取 QQ 自己的图片软限制 20 MB（官方富媒体文档：`file_type=1` 软限制 20 MB、
 * 硬限制 200 MB，超软限制会降级为文件卡片）——原图超过 20 MB，平台本来就会把它当
 * 文件发而不是内联图，再往上调没有意义。这个数字是有据可依的，不是随手取的护栏。
 */
const MAX_IMAGE_MB_CEILING = 20

/**
 * 默认值 = 上限，即**默认不做人为限制**。
 *
 * 这是一次有意的取舍，代价必须写清楚：在 Free 套餐且**未配置 public_base_url**（或
 * URL 直传失败回退 base64）时，超过约 3 MB 的图会直接撞 Error 1102 让整条消息失败，
 * 而不再回落小一档。原因是两种错法的代价不对称——阈值偏小只是偶尔降一档（优雅降级），
 * 偏大则是硬失败；且这条路径**没有兜底**，CPU 花光后任何补救动作本身还要再花 CPU。
 *
 * 之所以敢把默认放这么宽，是因为推荐的 URL 直传路径根本不会走到这里：配了
 * public_base_url 后图片不经插件下载，本阈值被完全忽略。也就是说默认值只在
 * "URL 直传不可用"这条退路上生效。
 *
 * → 在 Free 上跑 base64 路径且想稳，把 max_image_mb 调到 2；Paid 套餐（30 s CPU）
 *   下 20 MB 完全没问题。安全区的推导见上。
 */
const DEFAULT_MAX_IMAGE_MB = MAX_IMAGE_MB_CEILING

/** 图片代理路由：运行时把插件路由挂在 `/p/<插件名>/` 下，改插件名时这里必须同步 */
const PROXY_MOUNT = '/p/pixiv'
const PROXY_PATH = '/img'

/** 代理路由是公开的，只能放行图床自己的图片直链，否则会沦为开放代理（SSRF + 带宽滥用） */
const ALLOWED_HOST = 'pixiv.yuki.sh'
const ALLOWED_PATH_PREFIX = '/image/'

/** pixiv.yuki.sh 第三方图床（非官方，图片版权归原作者所有） */
const API_BASE = 'https://pixiv.yuki.sh/api'
const TIMEOUT_MS = 15_000
const REQUEST_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Referer: 'https://pixiv.yuki.sh/',
  // yuki.sh（Vercel）按 Sec-Fetch-Site 做防盗链，非浏览器请求会被 403（Forbidden.），需伪装同站特征
  'Sec-Fetch-Site': 'same-origin',
  'Sec-Fetch-Mode': 'no-cors',
  'Sec-Fetch-Dest': 'image',
}

/** API 返回的作品数据（只取用到的字段） */
interface Illust {
  id: string
  title: string
  description?: string
  user?: { id?: number | string; name?: string; account?: string }
  tags?: string[]
  /** 五档尺寸直链；某档可能缺失，取用时逐级回落 */
  urls?: Partial<Record<ImageSize, string>>
}

/** HTTP 状态码错误，用于给出分类提示 */
class ApiError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`)
  }
}

/** 图片超出单次处理预算；与网络/HTTP 错误区分开——只有它才值得换小一档重试 */
class ImageTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(`图片 ${(bytes / 1048576).toFixed(1)}MB 超出单次处理上限`)
  }
}

async function fetchIllust(path: string): Promise<Illust> {
  let res: Response
  try {
    res = await fetch(`${API_BASE}/${path}`, { headers: REQUEST_HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (e) {
    throw new Error((e as Error)?.name === 'TimeoutError' ? '请求超时，请检查网络或稍后再试' : '连接失败，请检查网络或API服务是否可用')
  }
  if (!res.ok) throw new ApiError(res.status)
  let body: { success?: boolean; message?: string; data?: Illust }
  try {
    body = (await res.json()) as typeof body
  } catch {
    throw new Error('数据解析错误，请稍后再试')
  }
  if (!body.success || !body.data) throw new Error(body.message || '获取失败，返回数据异常')
  return body.data
}

/**
 * 下载图片字节：QQ 富媒体服务器拉不到境外图床直链（yuki.sh 按 Sec-Fetch-Site 防盗链），
 * 只能由插件取回后以 base64 直传，所以这一步是必需的。
 *
 * 声明体积超预算时直接掐断响应体——一次完整的字节搬运与编码都会计入 CPU，
 * 既然注定发不出去，就不该白付这份成本。Content-Length 可能缺失或被压缩，读完再兜一次底。
 */
async function fetchImageBytes(url: string, maxBytes: number): Promise<Uint8Array> {
  let res: Response
  try {
    res = await fetch(url, { headers: REQUEST_HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (e) {
    throw new Error((e as Error)?.name === 'TimeoutError' ? '请求超时' : '连接失败')
  }
  if (!res.ok) throw new ApiError(res.status)

  const declared = Number(res.headers.get('content-length') ?? 0)
  if (declared > maxBytes) {
    if (res.body) await res.body.cancel().catch(() => undefined)
    throw new ImageTooLargeError(declared)
  }

  const bytes = new Uint8Array(await res.arrayBuffer())
  if (bytes.byteLength > maxBytes) throw new ImageTooLargeError(bytes.byteLength)
  return bytes
}

/** 三级降级的原生 base64 编码；插件控制不了宿主的 nodejs_compat，所以必须逐级探测 */
interface NativeBase64 {
  toBase64?(): string
}
interface BufferLike {
  from(buffer: ArrayBufferLike, byteOffset: number, length: number): { toString(encoding: string): string }
}

/**
 * 原实现用 `String.fromCharCode(...chunk)` 逐块展开再 btoa，每块一次 32768 参数的调用，
 * 3 MB 图要 55 ms——在 Free 套餐 10 ms 的预算下必然超限。原生实现只要 0.39 ms。
 */
function toBase64(bytes: Uint8Array): string {
  const u8 = bytes as Uint8Array & NativeBase64
  // 1) 原生实现（V8 12.9+ / 新版 workerd），C++ 速度且零拷贝
  if (typeof u8.toBase64 === 'function') return u8.toBase64()

  // 2) nodejs_compat 下的 Buffer
  const Buf = (globalThis as unknown as { Buffer?: BufferLike }).Buffer
  if (Buf) return Buf.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')

  // 3) 兜底：apply 分块 + btoa，比 spread 快约 5.8 倍（3 MB 约 9.5 ms）
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[])
  }
  return btoa(binary)
}

/** 解析尺寸参数：显式参数优先，其次面板配置，兜底 regular（配置快照可能缺字段，不能直接信任） */
function pickSize(arg: string | undefined, configured: unknown): ImageSize {
  if (arg && (SIZES as readonly string[]).includes(arg)) return arg as ImageSize
  if (configured && (SIZES as readonly string[]).includes(configured as string)) return configured as ImageSize
  return 'regular'
}

/** 解析体积上限：配置快照可能缺字段或被改坏，兜底默认值并夹在合理区间内 */
function resolveMaxBytes(configured: unknown): number {
  const mb = typeof configured === 'number' && Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_IMAGE_MB
  return Math.min(mb, MAX_IMAGE_MB_CEILING) * 1024 * 1024
}

/**
 * 解析公开地址：归一化成纯 origin（去掉尾斜杠与用户误粘的路径）；非法就当没配，回退 base64。
 * 只认 https——Workers 与自定义域名本来就只跑 https，放行 http 没有收益，
 * 却让平台在明文信道上取图（可被篡改后再转发），不如直接拒绝。
 */
function resolvePublicBaseUrl(configured: unknown): string {
  if (typeof configured !== 'string' || !configured.trim()) return ''
  try {
    const url = new URL(configured.trim())
    return url.protocol === 'https:' ? `https://${url.host}` : ''
  } catch {
    return ''
  }
}

/**
 * 列出候选直链，按尺寸由大到小，供调用方依次尝试。
 * 覆盖两种回落：档位缺失（沿用原插件行为，保证有图可发）、档位存在但体积超预算。
 */
function candidateUrls(illust: Illust, requested: ImageSize): Array<{ size: ImageSize; url: string }> {
  const urls = illust.urls ?? {}
  const seen = new Set<string>()
  const out: Array<{ size: ImageSize; url: string }> = []
  const push = (size: ImageSize, url: string | undefined) => {
    if (!url || seen.has(url)) return
    seen.add(url)
    out.push({ size, url })
  }

  // 从请求档起逐级往小，超预算时才有更小的档可退
  for (let i = Math.max(0, SIZE_DESC.indexOf(requested)); i < SIZE_DESC.length; i++) {
    const size = SIZE_DESC[i]!
    push(size, urls[size])
  }
  if (!out.length) for (const size of FALLBACK_ORDER) push(size, urls[size])
  return out
}

/**
 * 判断一个地址是否属于图床的图片直链。代理路由是公开的，必须用解析后的
 * host + path 判定，不能用字符串前缀——`startsWith` 挡不住 URL 规范化带来的绕过。
 */
function isAllowedImageUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  return url.protocol === 'https:' && url.hostname === ALLOWED_HOST && url.pathname.startsWith(ALLOWED_PATH_PREFIX)
}

/** 把图床直链包装成 QQ 可以自己来拉的代理地址 */
function buildProxyUrl(origin: string, src: string): string {
  return `${origin.replace(/\/+$/, '')}${PROXY_MOUNT}${PROXY_PATH}?src=${encodeURIComponent(src)}`
}

/** 解析发送顺序：配置快照可能缺字段或被改坏，兜底 text_first（沿用既有行为） */
function resolveOrder(configured: unknown): MessageOrder {
  return (MESSAGE_ORDERS as readonly string[]).includes(configured as string)
    ? (configured as MessageOrder)
    : 'text_first'
}

/**
 * 命令按钮（`action.type = 2`）。客户端会自己把 `@bot + data` 填进输入框并发送，
 * 因此**不经过 `INTERACTION_CREATE`**：不需要写 `buttons` 回调处理器，也没有
 * 官方那 3 秒的 ack 时限（回调按钮要在这条消息链路上查 API + 发图，很容易超时）。
 * 插入的 `@bot` 还顺带解决了群聊必须 @ 才能被收到的问题。
 */
function cmdButton(label: string, command: string) {
  return button.command(label, command, { enter: true })
}

/** 随机图的"再来一张"：复用刚生效的那条指令，含显式尺寸参数 */
function rerollKeyboard(command: string, label = '再来一张'): Keyboard {
  return keyboard([[cmdButton(label, command)]])
}

/** 帮助文案的按钮：把三条常用指令变成可点的，省掉手打 */
function helpKeyboard(): Keyboard {
  return keyboard([
    [
      cmdButton('随机一张', '/pixiv random'),
      cmdButton('随机原图', '/pixiv random original'),
      cmdButton('随机小图', '/pixiv random small'),
    ],
  ])
}

type ReplyFn = (message: OutgoingMessage) => Promise<SendResult>
type ReplyLogger = Pick<Logger, 'info' | 'warn' | 'error'>

/**
 * 发一条文本，可选挂按钮。
 *
 * 带按钮失败时**去掉按钮重试一次**：内嵌按钮需要 bot 侧开通（官方文档把自定义按钮
 * 标为"内邀开通"），没开通时平台可能整条拒收。一次重试把最坏情况从"整条消息失败"
 * 降级成"没有按钮的纯文本"，这个代价很划算。
 */
async function replyText(
  session: { reply: ReplyFn },
  logger: ReplyLogger,
  text: string,
  kb: Keyboard | undefined,
): Promise<{ ok: boolean; error?: string }> {
  if (!kb) return session.reply(text)
  const res = await session.reply({ text, keyboard: kb })
  if (res.ok) return res
  logger.warn('带按钮的文本发送失败，去掉按钮重试', { error: res.error ?? '未知错误' })
  return session.reply(text)
}

function infoText(illust: Illust, detail: boolean): string {
  const user = illust.user ?? {}
  const tags = (illust.tags ?? []).join(', ')
  if (!detail) {
    // 作品 ID 与作者 ID 必须分开标注：用户会拿这里的 ID 去 illust 指令查详情，
    // 而 illust 查的是作品库——只标一个含糊的 "ID" 会让用户拿作者 ID 查出 404。
    return `随机Pixiv图片\n标题：${illust.title}\n作品ID：${illust.id}\n作者：${user.name ?? '未知'} (作者ID: ${user.id ?? '未知'})\n标签：${tags}`
  }
  return (
    `作品详情 (作品ID: ${illust.id})\n` +
    `标题：${illust.title}\n` +
    `作者：${user.name ?? '未知'} (作者ID: ${user.id ?? '未知'} | 账号：${user.account ?? '未知'})\n` +
    `描述：${illust.description || '无'}\n` +
    `标签：${tags}`
  )
}

/** 人类可读的错误文案（对齐原插件） */
function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const hint = e.status === 404 ? ' - 作品或图片不存在，可能已删除或 ID 有误' : e.status === 403 ? ' - 访问被拒绝，可能是IP限制' : ''
    return `请求失败（状态码：${e.status}${hint}），请稍后再试`
  }
  return (e as Error)?.message || '调用API出错，请稍后再试'
}

const HELP =
  '请按格式使用：\n' +
  '/pixiv random [尺寸]\n' +
  '/pixiv illust [作品id]'

interface SendOpts {
  session: { reply: ReplyFn }
  logger: ReplyLogger
  size: ImageSize
  /** 单张图片体积上限（字节），来自 resolveMaxBytes(ctx.config.max_image_mb) */
  maxBytes: number
  /** Worker 公开地址；非空时改走 URL 直传，插件侧不下载不编码 */
  publicBaseUrl: string
  /** 是否附带作品信息（illust 恒为 true，random 跟随配置） */
  withInfo: boolean
  /** 信息用简略（random）还是详情（illust）文案 */
  detail: boolean
  /** 挂在文本消息上的按钮；undefined 表示不挂 */
  keyboard: Keyboard | undefined
  /** 文本与图片的先后顺序 */
  order: MessageOrder
}

/**
 * 发送图片本身。返回错误文案（仅在需要向用户报错时非 undefined）——
 * 是否把错误透给用户由调用方决定：文案已经发出去时就不该再刷一条错误。
 */
async function sendImage(illust: Illust, opts: SendOpts): Promise<string | undefined> {
  const candidates = candidateUrls(illust, opts.size)
  if (!candidates.length) return '未获取到图片链接，请稍后再试'

  // 优先走 URL 直传：QQ 自己来拉，插件侧不下载、不编码、不序列化，CPU 归零，
  // 也就没有内联上传的体积天花板。请求头由代理路由自己加，QQ 不需要模拟浏览器。
  //
  // 群聊/单聊下这一步是**同步可观测**的：运行时先 POST /v2/{groups|users}/{id}/files
  // （body 里带 url、srv_send_msg=false），平台在这一次调用里就把图拉走转存，
  // 拉不到就返回非 2xx / 缺 file_info，运行时转成 { ok: false, error }。所以
  // 域名不可达不会是"静默丢图"，而是会落到下面的 base64 分支并留下 warn 日志。
  // （例外：频道场景没有 /files 端点，图片走消息体 image 字段，那条路才是异步静默的。）
  if (opts.publicBaseUrl) {
    const proxyUrl = buildProxyUrl(opts.publicBaseUrl, candidates[0]!.url)
    const sent = await opts.session.reply({ image: { url: proxyUrl } })
    if (sent.ok) return undefined
    opts.logger.warn('URL 直传失败，回退 base64（多为平台拉不到该域名）', {
      proxyUrl,
      error: sent.error ?? '未知错误',
    })
  }

  // 逐级尝试：只有"体积超预算"才值得换小一档，网络或 HTTP 错误换档也一样失败
  let picked: { size: ImageSize; url: string } | undefined
  let bytes: Uint8Array | undefined
  let failure: unknown
  for (const candidate of candidates) {
    try {
      bytes = await fetchImageBytes(candidate.url, opts.maxBytes)
      picked = candidate
      break
    } catch (e) {
      failure = e
      if (!(e instanceof ImageTooLargeError)) break
      opts.logger.warn('图片超出体积预算，回落更小尺寸', { size: candidate.size, bytes: e.bytes })
    }
  }

  if (!picked || !bytes) {
    opts.logger.error('图片下载失败', { size: opts.size, error: String((failure as Error)?.message ?? failure) })
    // 体积超限不是网络问题，别让用户去重试一个注定失败的请求
    if (failure instanceof ImageTooLargeError) {
      return `${failure.message}，请用更小的尺寸重试（如 /pixiv random small）`
    }
    return `图片下载失败（${errorMessage(failure)}）`
  }
  if (picked.size !== opts.size) {
    opts.logger.info('已回落尺寸', { requested: opts.size, used: picked.size, bytes: bytes.byteLength })
  }

  const sent = await opts.session.reply({ image: { base64: toBase64(bytes) } })
  if (!sent.ok) {
    opts.logger.error('图片发送失败', { url: picked.url, error: sent.error ?? '未知错误' })
    return `图片发送失败：${sent.error ?? '未知错误'}`
  }
  return undefined
}

/**
 * 发送一条作品：作品信息（可选）+ 图片，顺序由 `opts.order` 决定。
 *
 * - `text_first`（默认）：文案在前，按钮紧贴文案下方；图片失败时因为文案已发出，只记日志不刷屏。
 * - `image_first`：图片在前，文案连同按钮落在最底部；图片失败时**不发文案**——描述一张
 *   没发出去的图没有意义，此时把错误透给用户。
 */
async function sendIllust(illust: Illust, opts: SendOpts): Promise<string | undefined> {
  const text = opts.withInfo ? infoText(illust, opts.detail) : undefined
  let textSent = false

  const sendInfo = async (): Promise<string | undefined> => {
    if (!text) return undefined
    const res = await replyText(opts.session, opts.logger, text, opts.keyboard)
    if (res.ok) {
      textSent = true
      return undefined
    }
    opts.logger.error('作品信息发送失败', { error: res.error ?? '未知错误' })
    return `消息发送失败：${res.error ?? '未知错误'}`
  }

  if (opts.order === 'text_first') {
    const err = await sendInfo()
    if (err) return err
  }

  const imageErr = await sendImage(illust, opts)

  if (opts.order === 'image_first' && !imageErr) {
    const err = await sendInfo()
    if (err) return err
  }

  // 文案已经发出去时不再重复报错，避免一次失败刷两条消息
  return textSent ? undefined : imageErr
}

export default definePlugin<PluginConfig>({
  name: 'pixiv',
  displayName: 'Pixiv 图床',
  description: '随机获取 Pixiv 美图、按作品 ID 查询详情（pixiv.yuki.sh 第三方图床）',
  permissions: ['net'],

  configSchema: {
    type: 'object',
    properties: {
      show_image_info: { type: 'boolean', title: '随机图片是否显示作品信息（标题、作者、标签）', default: true },
      default_image_size: {
        type: 'string',
        title: '随机图片默认尺寸',
        enum: [...SIZES],
        default: 'regular',
        description: 'regular 为 master1200 jpg；Free 套餐单请求 CPU 上限 10 ms，超出预算的图会自动回落小一档',
      },
      max_image_mb: {
        type: 'number',
        title: '单张图片体积上限（MB，仅 base64 路径生效）',
        default: DEFAULT_MAX_IMAGE_MB,
        minimum: 0.5,
        maximum: MAX_IMAGE_MB_CEILING,
        description:
          `超过此体积的图会回落小一档。默认等于上限（${MAX_IMAGE_MB_CEILING} MB，即不做人为限制）。仅 base64 路径生效：配了 public_base_url 走 URL 直传后图片不经插件下载，本项被忽略。注意 Free 套餐单请求 CPU 上限 10 ms，base64 路径的安全区只有约 3 MB——在 Free 上且 URL 直传不可用时建议调到 2，否则超过约 3 MB 的图会撞 Error 1102 整条失败，而不是回落小一档。Paid 套餐（默认 30 s CPU）无需调整`,
      },
      public_base_url: {
        type: 'string',
        title: 'Worker 公开地址（走 URL 直传，可绕开 CPU 上限）',
        default: '',
        description:
          '填 Worker 的公开访问地址（如 https://bot.example.com），图片改由平台自己来拉，插件侧 CPU 归零、不受体积上限约束。留空则回退 base64 直传。只接受 https。填了之后建议实测一张：若平台拉不到该域名（workers.dev 在国内可达性不稳），本条会自动回退 base64 并在日志留下 warn，不会静默丢图',
      },
      show_buttons: {
        type: 'boolean',
        title: '在文本消息上挂内嵌按钮',
        default: true,
        description:
          '在作品信息与帮助文案下方挂"再来一张"等按钮，点击即自动发送对应指令。按钮需要 bot 侧开通（官方文档把自定义按钮标为"内邀开通"）；未开通时发送会失败，插件会自动去掉按钮重试一次，最坏退化成纯文本，不会丢消息。注意图片消息挂不了按钮——按钮只能挂在 markdown 文本消息上',
      },
      message_order: {
        type: 'string',
        title: '文本与图片的发送顺序',
        default: 'text_first',
        enum: [...MESSAGE_ORDERS],
        description:
          'text_first：先发作品信息（按钮紧贴其下），再发图片；image_first：先发图片，作品信息连同按钮落在最底部。想按按钮时少滚一点选 image_first；图片发送失败时该模式不会发文案（描述一张没发出的图没有意义）',
      },
    },
  },
  defaultConfig: {
    show_image_info: true,
    default_image_size: 'regular',
    max_image_mb: DEFAULT_MAX_IMAGE_MB,
    public_base_url: '',
    show_buttons: true,
    message_order: 'text_first',
  },

  commands: {
    pixiv: {
      description: 'Pixiv 随机美图 / 作品详情',
      usage: HELP,
      async handler({ args, ctx, session }) {
        const sub = (args[0] ?? '').toLowerCase()
        const maxBytes = resolveMaxBytes(ctx.config.max_image_mb)
        const publicBaseUrl = resolvePublicBaseUrl(ctx.config.public_base_url)
        const order = resolveOrder(ctx.config.message_order)
        const showButtons = ctx.config.show_buttons ?? true
        try {
          if (sub === 'random') {
            const size = pickSize(args[1], ctx.config.default_image_size)
            const illust = await fetchIllust('recommend?type=json')
            // 按钮复用刚生效的那条指令：显式尺寸参数合法时带上它，否则回到默认尺寸
            const explicit = args[1] && (SIZES as readonly string[]).includes(args[1]) ? ` ${args[1]}` : ''
            return await sendIllust(illust, {
              session,
              logger: ctx.logger,
              size,
              maxBytes,
              publicBaseUrl,
              withInfo: ctx.config.show_image_info ?? true,
              detail: false,
              keyboard: showButtons ? rerollKeyboard(`/pixiv random${explicit}`) : undefined,
              order,
            })
          }
          if (sub === 'illust') {
            const id = args[1]
            if (!id) return '请输入作品id：/pixiv illust [id]'
            if (!/^\d+$/.test(id)) return '作品ID必须是数字'
            const illust = await fetchIllust(`illust?id=${id}`)
            return await sendIllust(illust, {
              session,
              logger: ctx.logger,
              size: pickSize(undefined, ctx.config.default_image_size),
              maxBytes,
              publicBaseUrl,
              withInfo: true,
              detail: true,
              // 指定作品没有"再来一张"的语义，给一个换随机图的入口
              keyboard: showButtons ? rerollKeyboard('/pixiv random', '随机一张') : undefined,
              order,
            })
          }
          // 帮助：自己发而不是 return，才能拿到发送结果、在按钮失败时退回纯文本
          const res = await replyText(session, ctx.logger, HELP, showButtons ? helpKeyboard() : undefined)
          if (!res.ok) {
            ctx.logger.error('帮助文案发送失败', { error: res.error ?? '未知错误' })
            return `消息发送失败：${res.error ?? '未知错误'}`
          }
          return undefined
        } catch (e) {
          return errorMessage(e)
        }
      },
    },
  },

  routes: [
    {
      method: 'GET',
      path: PROXY_PATH,
      // 公开路由：QQ 的富媒体服务器没有登录态，必须匿名可访问
      auth: 'public',
      async handler({ request, ctx }) {
        const src = new URL(request.url).searchParams.get('src') ?? ''
        if (!isAllowedImageUrl(src)) return new Response('forbidden', { status: 403 })

        let res: Response
        try {
          // redirect: 'manual' —— 跟随重定向等于绕过了上面的白名单校验，宁可失败也不放行
          res = await fetch(src, {
            headers: REQUEST_HEADERS,
            redirect: 'manual',
            signal: AbortSignal.timeout(TIMEOUT_MS),
          })
        } catch (e) {
          ctx.logger.error('图片代理请求失败', { src, error: String((e as Error)?.message ?? e) })
          return new Response('upstream error', { status: 502 })
        }
        if (!res.ok) {
          ctx.logger.error('图片代理上游返回异常', { src, status: res.status })
          return new Response('upstream error', { status: 502 })
        }

        // 流式转发，不把图片读进内存：这条路由的 CPU 开销因此接近零，图片多大都不会超限
        return new Response(res.body, {
          headers: {
            'content-type': res.headers.get('content-type') ?? 'image/jpeg',
            'cache-control': 'public, max-age=3600',
          },
        })
      },
    },
  ],
})
