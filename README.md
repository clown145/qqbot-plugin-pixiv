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
| `default_image_size` | enum | `original` | 随机图片默认尺寸 |

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
