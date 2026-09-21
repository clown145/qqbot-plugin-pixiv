import { definePlugin } from '@qqbot/sdk'

/** 与 configSchema 对应；面板保存的配置通过 ctx.config 注入 */
export interface PluginConfig {
  /** 随机图片是否附带作品信息（标题、作者、标签） */
  show_image_info: boolean
  /** 随机图片默认尺寸 */
  default_image_size: ImageSize
}

export type ImageSize = 'mini' | 'thumb' | 'small' | 'regular' | 'original'

const SIZES: readonly ImageSize[] = ['mini', 'thumb', 'small', 'regular', 'original']

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

/** 下载图片并转 base64：QQ 富媒体服务器拉不到境外图床直链，改为直传文件数据 */
async function fetchImageBase64(url: string): Promise<string> {
  let res: Response
  try {
    res = await fetch(url, { headers: REQUEST_HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (e) {
    throw new Error((e as Error)?.name === 'TimeoutError' ? '请求超时' : '连接失败')
  }
  if (!res.ok) throw new ApiError(res.status)
  return toBase64(new Uint8Array(await res.arrayBuffer()))
}

function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

/** 解析尺寸参数：显式参数优先，其次面板配置，兜底 regular（配置快照可能缺字段，不能直接信任） */
function pickSize(arg: string | undefined, configured: unknown): ImageSize {
  if (arg && (SIZES as readonly string[]).includes(arg)) return arg as ImageSize
  if (configured && (SIZES as readonly string[]).includes(configured as string)) return configured as ImageSize
  return 'regular'
}

/** 按尺寸取直链，缺失时逐级回落，保证能发出图 */
function pickUrl(illust: Illust, size: ImageSize): string {
  const urls = illust.urls ?? {}
  return urls[size] ?? urls.regular ?? urls.original ?? urls.small ?? ''
}

function infoText(illust: Illust, detail: boolean): string {
  const user = illust.user ?? {}
  const tags = (illust.tags ?? []).join(', ')
  if (!detail) {
    return `随机Pixiv图片\n标题：${illust.title}\n作者：${user.name ?? '未知'} (ID: ${user.id ?? '未知'})\n标签：${tags}`
  }
  return (
    `作品详情 (ID: ${illust.id})\n` +
    `标题：${illust.title}\n` +
    `作者：${user.name ?? '未知'} (ID: ${user.id ?? '未知'} | 账号：${user.account ?? '未知'})\n` +
    `描述：${illust.description || '无'}\n` +
    `标签：${tags}`
  )
}

/** 人类可读的错误文案（对齐原插件） */
function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const hint = e.status === 404 ? ' - API地址可能已变更或资源不存在' : e.status === 403 ? ' - 访问被拒绝，可能是IP限制' : ''
    return `请求失败（状态码：${e.status}${hint}），请稍后再试`
  }
  return (e as Error)?.message || '调用API出错，请稍后再试'
}

const HELP =
  '请按格式使用：\n' +
  '/pixiv random [尺寸]\n' +
  '/pixiv illust [作品id]'

interface SendOpts {
  session: { reply(message: unknown): Promise<{ ok: boolean; error?: string }> }
  logger: { error(message: string, data?: unknown): void }
  size: ImageSize
  /** 是否附带作品信息（illust 恒为 true，random 跟随配置） */
  withInfo: boolean
  /** 信息用简略（random）还是详情（illust）文案 */
  detail: boolean
}

/**
 * 发送一条作品：先作品信息（可选），再图片（base64 直传，纯图消息）。
 * 文字已发出的情况下图片失败不重复刷屏，只记日志；纯图模式失败才回错误文案。
 */
async function sendIllust(illust: Illust, opts: SendOpts): Promise<string | undefined> {
  const text = opts.withInfo ? infoText(illust, opts.detail) : undefined
  const info = text ? await opts.session.reply(text) : null
  if (info && !info.ok) {
    opts.logger.error('作品信息发送失败', { error: info.error ?? '未知错误' })
    return `消息发送失败：${info.error ?? '未知错误'}`
  }

  const url = pickUrl(illust, opts.size)
  if (!url) return text ? undefined : '未获取到图片链接，请稍后再试'

  let base64: string
  try {
    base64 = await fetchImageBase64(url)
  } catch (e) {
    opts.logger.error('图片下载失败', { url, error: String((e as Error)?.message ?? e) })
    return text ? undefined : `图片下载失败（${errorMessage(e)}）`
  }

  const sent = await opts.session.reply({ image: { base64 } })
  if (!sent.ok) {
    opts.logger.error('图片发送失败', { url, error: sent.error ?? '未知错误' })
    return text ? undefined : `图片发送失败：${sent.error ?? '未知错误'}`
  }
  return undefined
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
        description: 'regular 为 master1200 jpg，原图直传体积大、易上传失败',
      },
    },
  },
  defaultConfig: { show_image_info: true, default_image_size: 'regular' },

  commands: {
    pixiv: {
      description: 'Pixiv 随机美图 / 作品详情',
      usage: HELP,
      async handler({ args, ctx, session }) {
        const sub = (args[0] ?? '').toLowerCase()
        try {
          if (sub === 'random') {
            const size = pickSize(args[1], ctx.config.default_image_size)
            const illust = await fetchIllust('recommend?type=json')
            return await sendIllust(illust, {
              session,
              logger: ctx.logger,
              size,
              withInfo: ctx.config.show_image_info ?? true,
              detail: false,
            })
          }
          if (sub === 'illust') {
            const id = args[1]
            if (!id) return '请输入作品id：/pixiv illust [id]'
            if (!/^\d+$/.test(id)) return '作品ID必须是数字'
            const illust = await fetchIllust(`illust?id=${id}`)
            return await sendIllust(illust, { session, logger: ctx.logger, size: pickSize(undefined, ctx.config.default_image_size), withInfo: true, detail: true })
          }
          return HELP
        } catch (e) {
          return errorMessage(e)
        }
      },
    },
  },
})
