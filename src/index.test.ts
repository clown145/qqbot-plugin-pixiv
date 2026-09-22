import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockContext, createMockSession, runCommand } from '@qqbot/sdk/testing'
import plugin from './index.js'
import type { PluginConfig } from './index.js'

const ILLUST = {
  id: '118908797',
  title: '青のパレード',
  description: '',
  user: { id: 17509087, name: '朔月八雲', account: 'sakutsuki' },
  tags: ['女の子', 'オリジナル', '少女'],
  urls: {
    mini: 'https://pixiv.yuki.sh/image/c/48x48/mini.jpg',
    regular: 'https://pixiv.yuki.sh/image/img-master/regular.jpg',
    original: 'https://pixiv.yuki.sh/image/img-original/original.png',
  },
}

const CONFIG = plugin.defaultConfig! as PluginConfig

/** 图片字节 0x01 0x02 0x03 → base64 'AQID' */
const IMG_BYTES = [0x01, 0x02, 0x03]
const IMG_BASE64 = 'AQID'

/** API 响应在先、图片下载在后；用真实 Response，headers / body / arrayBuffer 都走实际实现 */
function okFetch(body: unknown) {
  return vi
    .fn()
    .mockResolvedValueOnce(jsonResponse(body))
    .mockResolvedValueOnce(new Response(new Uint8Array(IMG_BYTES)))
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
}

/** 声明体积超预算的响应；cancel 记录调用，用于断言超限响应体被提前掐断 */
function oversizeResponse(bytes = 3 * 1024 * 1024) {
  const cancel = vi.fn(async () => undefined)
  return {
    cancel,
    res: {
      ok: true,
      status: 200,
      headers: { get: (name: string) => (name === 'content-length' ? String(bytes) : null) },
      body: { cancel },
      arrayBuffer: async () => new ArrayBuffer(0),
    },
  }
}

function run(argText: string, config?: Partial<PluginConfig>) {
  return runCommand(plugin, 'pixiv', argText, { ctx: { config: { ...CONFIG, ...config } } })
}

/** 直接调用图片代理路由，模拟 QQ 富媒体服务器来拉图 */
function hitProxy(src: string) {
  const route = plugin.routes?.find((r) => r.path === '/img')
  if (!route) throw new Error('未找到 /img 路由')
  return route.handler({
    ctx: createMockContext(plugin, { config: CONFIG }),
    request: new Request(`https://bot.example.com/p/pixiv/img?src=${encodeURIComponent(src)}`),
    params: {},
    authenticated: false,
  })
}

/** 从出站消息里取出按钮的 label 与指令，便于断言按钮内容而不被结构细节干扰 */
function buttonsOf(message: unknown): Array<{ label: string; data: string }> {
  const kb = (
    message as {
      keyboard?: { content?: { rows: Array<{ buttons: Array<{ render_data: { label: string }; action: { data?: string } }> }> } }
    }
  ).keyboard
  if (!kb?.content) return []
  return kb.content.rows.flatMap((row) =>
    row.buttons.map((b) => ({ label: b.render_data.label, data: b.action.data ?? '' })),
  )
}

/** 出站消息的文本（字符串或 { text } 两种形态都取得到） */
function textOf(message: unknown): string {
  return typeof message === 'string' ? message : ((message as { text?: string }).text ?? '')
}

const REGULAR_URL = 'https://pixiv.yuki.sh/image/img-master/regular.jpg'

afterEach(() => vi.unstubAllGlobals())

describe('pixiv plugin', () => {
  it('无参数回复帮助文案，并挂上三条指令按钮', async () => {
    const { replies } = await run('')
    expect(replies).toHaveLength(1)
    expect(textOf(replies[0])).toContain('/pixiv random')
    expect(textOf(replies[0])).toContain('/pixiv illust')
    // 指令按钮（action.type=2）由客户端插入 @bot + data，群聊也能命中命令
    expect(buttonsOf(replies[0])).toEqual([
      { label: '随机一张', data: '/pixiv random' },
      { label: '随机原图', data: '/pixiv random original' },
      { label: '随机小图', data: '/pixiv random small' },
    ])
  })

  it('random：作品信息与图片分两条发送，图片为 base64 直传', async () => {
    const fetchMock = okFetch({ success: true, data: ILLUST })
    vi.stubGlobal('fetch', fetchMock)
    const { replies } = await run('random')
    expect(replies).toHaveLength(2)
    expect(textOf(replies[0])).toBe(
      '随机Pixiv图片\n标题：青のパレード\n作品ID：118908797\n作者：朔月八雲 (作者ID: 17509087)\n标签：女の子, オリジナル, 少女',
    )
    expect(buttonsOf(replies[0])).toEqual([{ label: '再来一张', data: '/pixiv random' }])
    expect(replies[1]).toEqual({ image: { base64: IMG_BASE64 } })
    const [apiUrl, apiInit] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(apiUrl).toBe('https://pixiv.yuki.sh/api/recommend?type=json')
    expect((apiInit.headers as Record<string, string>).Referer).toBe('https://pixiv.yuki.sh/')
    const [imgUrl] = fetchMock.mock.calls[1] as [string]
    expect(imgUrl).toBe('https://pixiv.yuki.sh/image/img-master/regular.jpg') // 默认尺寸 regular
  })

  it('random：显式尺寸参数优先生效', async () => {
    const fetchMock = okFetch({ success: true, data: ILLUST })
    vi.stubGlobal('fetch', fetchMock)
    await run('random mini')
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://pixiv.yuki.sh/image/c/48x48/mini.jpg')
  })

  it('random：非法尺寸参数回落配置默认', async () => {
    const fetchMock = okFetch({ success: true, data: ILLUST })
    vi.stubGlobal('fetch', fetchMock)
    await run('random huge', { default_image_size: 'regular' })
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://pixiv.yuki.sh/image/img-master/regular.jpg')
  })

  it('show_image_info 关闭时只发图', async () => {
    vi.stubGlobal('fetch', okFetch({ success: true, data: ILLUST }))
    const { replies } = await run('random', { show_image_info: false })
    expect(replies).toEqual([{ image: { base64: IMG_BASE64 } }])
  })

  it('直链某档缺失时逐级回落', async () => {
    const fetchMock = okFetch({
      success: true,
      data: { ...ILLUST, urls: { small: 'https://pixiv.yuki.sh/image/small.jpg' } },
    })
    vi.stubGlobal('fetch', fetchMock)
    const { replies } = await run('random')
    expect(replies).toHaveLength(2)
    expect(replies[1]).toEqual({ image: { base64: IMG_BASE64 } })
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://pixiv.yuki.sh/image/small.jpg')
  })

  it('illust 非数字 ID 直接拒绝，不发请求', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { replies } = await run('illust abc')
    expect(replies[0]).toBe('作品ID必须是数字')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('illust：详情文案与图片分两条发送', async () => {
    const fetchMock = okFetch({ success: true, data: ILLUST })
    vi.stubGlobal('fetch', fetchMock)
    const { replies } = await run('illust 118908797')
    expect(textOf(replies[0])).toBe(
      '作品详情 (作品ID: 118908797)\n' +
        '标题：青のパレード\n' +
        '作者：朔月八雲 (作者ID: 17509087 | 账号：sakutsuki)\n' +
        '描述：无\n' +
        '标签：女の子, オリジナル, 少女',
    )
    // 指定作品没有"再来一张"的语义，按钮换成"随机一张"
    expect(buttonsOf(replies[0])).toEqual([{ label: '随机一张', data: '/pixiv random' }])
    expect(replies[1]).toEqual({ image: { base64: IMG_BASE64 } })
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://pixiv.yuki.sh/api/illust?id=118908797')
  })

  it('HTTP 错误返回分类文案', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }))
    const { replies } = await run('illust 1')
    expect(replies[0]).toBe('请求失败（状态码：404 - 作品或图片不存在，可能已删除或 ID 有误），请稍后再试')
  })

  it('success:false 透出上游 message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: false, message: '作品不存在' }) }))
    const { replies } = await run('illust 999')
    expect(replies[0]).toBe('作品不存在')
  })

  it('fetch 抛错（网络断开）返回连接失败文案', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('node down')))
    const { replies } = await run('random')
    expect(replies[0]).toBe('连接失败，请检查网络或API服务是否可用')
  })

  it('未知子命令回复帮助文案', async () => {
    const { replies } = await run('wallpaper')
    expect(textOf(replies[0])).toContain('/pixiv random')
    expect(buttonsOf(replies[0])).toHaveLength(3)
  })

  it('图片下载失败：已发作品信息时不重复报错，纯图模式回错误文案', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true, data: ILLUST }) })
        .mockRejectedValueOnce(new Error('node down')),
    )
    const withInfo = await run('random')
    expect(withInfo.replies).toHaveLength(1) // 只有作品信息

    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true, data: ILLUST }) })
        .mockRejectedValueOnce(new Error('node down')),
    )
    const withoutInfo = await run('random', { show_image_info: false })
    expect(withoutInfo.replies[0]).toContain('图片下载失败')
  })

  it('文本被平台拒绝：带按钮失败后去掉按钮重试，仍失败才报错', async () => {
    vi.stubGlobal('fetch', okFetch({ success: true, data: ILLUST }))
    const session = createMockSession()
    const ctx = createMockContext(plugin, { config: CONFIG })
    const replyMock = vi.fn().mockResolvedValue({ ok: false, status: 500, error: '平台拒绝（错误码 11244）' })
    session.reply = replyMock as never

    const result = await (plugin.commands!.pixiv as { handler: (i: unknown) => Promise<string | undefined> }).handler({
      args: ['random'],
      ctx,
      session,
    })
    // 第一次带按钮、第二次去掉按钮——按钮要 bot 侧开通，不能因为按钮把整条文案赔进去
    expect(replyMock).toHaveBeenCalledTimes(2)
    expect(buttonsOf(replyMock.mock.calls[0]?.[0])).toHaveLength(1)
    expect(typeof replyMock.mock.calls[1]?.[0]).toBe('string')
    expect(result).toContain('平台拒绝（错误码 11244）')
  })

  it('按钮发送失败但纯文本成功：用户仍能收到文案，不报错', async () => {
    vi.stubGlobal('fetch', okFetch({ success: true, data: ILLUST }))
    const session = createMockSession()
    const ctx = createMockContext(plugin, { config: CONFIG })
    const replyMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 400, error: '按钮未开通', raw: null })
      .mockResolvedValueOnce({ ok: true, status: 200, raw: null })
      .mockResolvedValueOnce({ ok: true, status: 200, raw: null })
    session.reply = replyMock as never

    const result = await (plugin.commands!.pixiv as { handler: (i: unknown) => Promise<string | undefined> }).handler({
      args: ['random'],
      ctx,
      session,
    })
    expect(result).toBeUndefined()
    expect(replyMock).toHaveBeenCalledTimes(3) // 带按钮失败 → 纯文本 → 图片
    expect(typeof replyMock.mock.calls[1]?.[0]).toBe('string')
    expect(replyMock.mock.calls[2]?.[0]).toEqual({ image: { base64: IMG_BASE64 } })
  })

  it('体积超预算：提前掐断超限响应体，并回落小一档', async () => {
    const big = oversizeResponse()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ success: true, data: ILLUST }))
      .mockResolvedValueOnce(big.res)
      .mockResolvedValueOnce(new Response(new Uint8Array(IMG_BYTES)))
    vi.stubGlobal('fetch', fetchMock)

    // 显式给 2 MB：默认已放宽到 20 MB，这里要验的是回落机制本身而非默认值
    const { replies } = await run('random', { max_image_mb: 2 })
    expect(replies[1]).toEqual({ image: { base64: IMG_BASE64 } })
    expect(big.cancel).toHaveBeenCalledOnce() // 没读字节就放弃，省掉一次完整搬运
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://pixiv.yuki.sh/image/img-master/regular.jpg')
    expect(fetchMock.mock.calls[2]?.[0]).toBe('https://pixiv.yuki.sh/image/c/48x48/mini.jpg')
  })

  it('体积超预算：所有候选档位都超限时回错误文案', async () => {
    const first = oversizeResponse()
    const second = oversizeResponse()
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ success: true, data: ILLUST }))
        .mockResolvedValueOnce(first.res)
        .mockResolvedValueOnce(second.res),
    )

    const { replies } = await run('random', { show_image_info: false, max_image_mb: 2 })
    expect(replies).toHaveLength(1)
    // 体积超限是尺寸问题不是网络问题，文案要给出可执行的下一步
    expect(replies[0]).toContain('超出单次处理上限')
    expect(replies[0]).toContain('/pixiv random small')
  })

  it('网络错误不触发尺寸回落（换档也一样失败，不白跑一次）', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ success: true, data: ILLUST }))
      .mockRejectedValueOnce(new Error('node down'))
    vi.stubGlobal('fetch', fetchMock)

    const { replies } = await run('random', { show_image_info: false })
    expect(replies[0]).toContain('图片下载失败')
    expect(fetchMock).toHaveBeenCalledTimes(2) // 没有为 mini 再发一次
  })

  it('max_image_mb 调大后放宽阈值，3 MB 不再触发回落', async () => {
    const big = oversizeResponse(3 * 1024 * 1024)
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ success: true, data: ILLUST }))
        .mockResolvedValueOnce(big.res),
    )

    const { replies } = await run('random', { max_image_mb: 6 })
    expect(big.cancel).not.toHaveBeenCalled() // 没被判定为超限
    expect(replies).toHaveLength(2) // 直接用了 regular，没有回落到 mini
  })

  it('默认阈值等于上限（20 MB），对 3 MB 的图不做人为限制', async () => {
    const big = oversizeResponse(3 * 1024 * 1024)
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ success: true, data: ILLUST }))
        .mockResolvedValueOnce(big.res),
    )

    // 有意选择：默认不设限制，把 Free 上的 CPU 风险交给使用者权衡（见配置说明）。
    // 这条用例把该决定钉住，避免以后被"顺手改回保守值"。
    await run('random', { show_image_info: false })
    expect(big.cancel).not.toHaveBeenCalled()
  })

  it('max_image_mb 被夹在 20 MB 上限内', async () => {
    const huge = oversizeResponse(25 * 1024 * 1024)
    const next = oversizeResponse(25 * 1024 * 1024)
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ success: true, data: ILLUST }))
        .mockResolvedValueOnce(huge.res)
        .mockResolvedValueOnce(next.res),
    )

    // 填 999 也应被夹到 20 MB（QQ 图片软限制），25 MB 的图仍然超限
    await run('random', { show_image_info: false, max_image_mb: 999 })
    expect(huge.cancel).toHaveBeenCalledOnce()
    expect(next.cancel).toHaveBeenCalledOnce()
  })

  it('max_image_mb 上限确为 20 MB：15 MB 的图不再被判超限', async () => {
    const big = oversizeResponse(15 * 1024 * 1024)
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ success: true, data: ILLUST }))
        .mockResolvedValueOnce(big.res),
    )

    await run('random', { show_image_info: false, max_image_mb: 999 })
    expect(big.cancel).not.toHaveBeenCalled() // 20 MB 上限内，放行
  })

  it('配置 public_base_url 后改走 URL 直传，插件不再下载图片', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ success: true, data: ILLUST }))
    vi.stubGlobal('fetch', fetchMock)

    const { replies } = await run('random', { public_base_url: 'https://bot.example.com' })
    expect(replies).toHaveLength(2)
    expect(replies[1]).toEqual({
      image: { url: `https://bot.example.com/p/pixiv/img?src=${encodeURIComponent(REGULAR_URL)}` },
    })
    expect(fetchMock).toHaveBeenCalledTimes(1) // 只有 API 调用，图片交给 QQ 自己拉
  })

  it('public_base_url 归一化为纯 origin，容忍尾斜杠与误粘的路径', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({ success: true, data: ILLUST })))
    const { replies } = await run('random', { public_base_url: 'https://bot.example.com/p/pixiv/' })
    expect((replies[1] as { image: { url: string } }).image.url).toBe(
      `https://bot.example.com/p/pixiv/img?src=${encodeURIComponent(REGULAR_URL)}`,
    )
  })

  it('public_base_url 非法时静默回退 base64', async () => {
    vi.stubGlobal('fetch', okFetch({ success: true, data: ILLUST }))
    const { replies } = await run('random', { public_base_url: 'not a url' })
    expect(replies[1]).toEqual({ image: { base64: IMG_BASE64 } })
  })

  it('public_base_url 只接受 https', async () => {
    vi.stubGlobal('fetch', okFetch({ success: true, data: ILLUST }))
    const { replies } = await run('random', { public_base_url: 'http://bot.example.com' })
    expect(replies[1]).toEqual({ image: { base64: IMG_BASE64 } })
  })

  it('URL 直传被平台同步拒绝（拉不到域名）时自动回退 base64', async () => {
    // 群聊/单聊下运行时先 POST /files 让平台拉图，拉不到会同步返回 ok=false；
    // 所以这里必须能观测到回退，而不是静默丢图。
    const fetchMock = okFetch({ success: true, data: ILLUST })
    vi.stubGlobal('fetch', fetchMock)

    const session = createMockSession()
    const replyMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, raw: null }) // 作品信息
      .mockResolvedValueOnce({ ok: false, status: 0, error: '上传富媒体失败 (HTTP 400)', raw: null }) // URL 直传被拒
      .mockResolvedValueOnce({ ok: true, status: 200, raw: null }) // 回退后的 base64
    session.reply = replyMock as never

    const ctx = createMockContext(plugin, { config: { ...CONFIG, public_base_url: 'https://bot.example.com' } })
    const result = await (plugin.commands!.pixiv as { handler: (i: unknown) => Promise<string | undefined> }).handler({
      args: ['random'],
      ctx,
      session,
    })

    expect(result).toBeUndefined() // 图最终发出去了，不该给用户报错
    expect(replyMock).toHaveBeenCalledTimes(3)
    expect(replyMock.mock.calls[1]?.[0]).toEqual({
      image: { url: `https://bot.example.com/p/pixiv/img?src=${encodeURIComponent(REGULAR_URL)}` },
    })
    expect(replyMock.mock.calls[2]?.[0]).toEqual({ image: { base64: IMG_BASE64 } })
    expect(fetchMock).toHaveBeenCalledTimes(2) // API + 自己下载一次
  })

  it('message_order = image_first：图片在前，文案连同按钮落在最底部', async () => {
    vi.stubGlobal('fetch', okFetch({ success: true, data: ILLUST }))
    const { replies } = await run('random', { message_order: 'image_first' })
    expect(replies).toHaveLength(2)
    expect(replies[0]).toEqual({ image: { base64: IMG_BASE64 } })
    expect(textOf(replies[1])).toContain('标题：青のパレード')
    expect(buttonsOf(replies[1])).toHaveLength(1)
  })

  it('image_first 下图片失败时不发文案——描述一张没发出的图没有意义', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ success: true, data: ILLUST }))
        .mockRejectedValueOnce(new Error('node down')),
    )
    const { replies } = await run('random', { message_order: 'image_first' })
    // 文案没发出去，所以错误可以透给用户；text_first 下则会静默（文案已发出）
    expect(replies).toHaveLength(1)
    expect(replies[0]).toContain('图片下载失败')
  })

  it('show_buttons 关闭时文本与帮助都不挂按钮', async () => {
    vi.stubGlobal('fetch', okFetch({ success: true, data: ILLUST }))
    const { replies } = await run('random', { show_buttons: false })
    expect(replies).toHaveLength(2)
    expect(typeof replies[0]).toBe('string') // 无按钮时保持纯文本，不升级成 markdown
    expect(buttonsOf(replies[0])).toEqual([])

    const help = await run('', { show_buttons: false })
    expect(textOf(help.replies[0])).toContain('/pixiv random')
    expect(buttonsOf(help.replies[0])).toEqual([])
  })

  it('再来一张复用显式尺寸参数，非法参数则回到默认', async () => {
    vi.stubGlobal('fetch', okFetch({ success: true, data: ILLUST }))
    const sized = await run('random mini')
    expect(buttonsOf(sized.replies[0])).toEqual([{ label: '再来一张', data: '/pixiv random mini' }])

    // huge 不是合法尺寸，pickSize 会回落到配置默认，按钮也不该把它带下去
    vi.stubGlobal('fetch', okFetch({ success: true, data: ILLUST }))
    const bogus = await run('random huge')
    expect(buttonsOf(bogus.replies[0])).toEqual([{ label: '再来一张', data: '/pixiv random' }])
  })

  it('代理路由拒绝白名单外的地址（不沦为开放代理）', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    for (const bad of [
      'https://evil.example.com/x.jpg',
      'http://pixiv.yuki.sh/image/a.jpg', // 非 https
      'https://pixiv.yuki.sh/other/a.jpg', // 路径不在白名单
      'https://pixiv.yuki.sh.evil.com/image/a.jpg', // 后缀伪造
      'not-a-url',
    ]) {
      expect((await hitProxy(bad)).status).toBe(403)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('代理路由转发白名单地址，并补上浏览器防盗链头', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(new Uint8Array(IMG_BYTES), { headers: { 'content-type': 'image/jpeg' } }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await hitProxy(REGULAR_URL)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/jpeg')

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(REGULAR_URL)
    expect((init.headers as Record<string, string>)['Sec-Fetch-Site']).toBe('same-origin')
    expect(init.redirect).toBe('manual') // 不跟随重定向，否则等于绕过白名单
  })

  it('代理路由不跟随重定向', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://evil.example.com/x.jpg' } })),
    )
    expect((await hitProxy(REGULAR_URL)).status).toBe(502)
  })

  it('代理路由上游出错时返回 502', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('upstream down')))
    expect((await hitProxy(REGULAR_URL)).status).toBe(502)
  })
})
