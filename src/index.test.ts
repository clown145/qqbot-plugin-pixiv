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

/** API 响应在先、图片下载在后 */
function okFetch(body: unknown) {
  return vi
    .fn()
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => body })
    .mockResolvedValueOnce({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array(IMG_BYTES).buffer })
}

function run(argText: string, config?: Partial<PluginConfig>) {
  return runCommand(plugin, 'pixiv', argText, { ctx: { config: { ...CONFIG, ...config } } })
}

afterEach(() => vi.unstubAllGlobals())

describe('pixiv plugin', () => {
  it('无参数回复帮助文案', async () => {
    const { replies } = await run('')
    expect(replies).toHaveLength(1)
    expect(replies[0]).toContain('/pixiv random')
    expect(replies[0]).toContain('/pixiv illust')
  })

  it('random：作品信息与图片分两条发送，图片为 base64 直传', async () => {
    const fetchMock = okFetch({ success: true, data: ILLUST })
    vi.stubGlobal('fetch', fetchMock)
    const { replies } = await run('random')
    expect(replies).toEqual([
      '随机Pixiv图片\n标题：青のパレード\n作者：朔月八雲 (ID: 17509087)\n标签：女の子, オリジナル, 少女',
      { image: { base64: IMG_BASE64 } },
    ])
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
    expect(replies[0]).toBe(
      '作品详情 (ID: 118908797)\n' +
        '标题：青のパレード\n' +
        '作者：朔月八雲 (ID: 17509087 | 账号：sakutsuki)\n' +
        '描述：无\n' +
        '标签：女の子, オリジナル, 少女',
    )
    expect(replies[1]).toEqual({ image: { base64: IMG_BASE64 } })
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://pixiv.yuki.sh/api/illust?id=118908797')
  })

  it('HTTP 错误返回分类文案', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }))
    const { replies } = await run('illust 1')
    expect(replies[0]).toBe('请求失败（状态码：404 - API地址可能已变更或资源不存在），请稍后再试')
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
    expect(replies[0]).toContain('/pixiv random')
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

  it('被动回复被拒（reply not ok）：返回带原因的错误文案', async () => {
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
    expect(replyMock).toHaveBeenCalledTimes(1)
    expect(result).toContain('平台拒绝（错误码 11244）')
  })
})
