# store/ — Edge Add-ons 上架资料

这个目录只放提交到 Microsoft Edge Add-ons 时要填、要传的东西，不参与扩展打包。

| 文件 | 用途 | 规格 |
|---|---|---|
| `icon-300.png` | 商店图标（Store logo） | 300×300 PNG |
| `screenshot-1-sources-en.png` | 截图 1：视频源列表、清晰度下拉、直播与音频源 | 1280×800 |
| `screenshot-2-tasks-zh.png` | 截图 2：下载任务，一个在下、一个已暂停并保存过快照 | 1280×800 |
| `screenshot-3-settings-en.png` | 截图 3：存储位置与界面语言 | 1280×800 |
| `promo-small-440x280.png` | 小型宣传图块 | 440×280 |
| `promo-large-1400x560.png` | 大型宣传图块 | 1400×560 |
| `listing-en.md` | 英文文案：名称、短描述、详细描述、搜索词、分类、链接 | 可直接复制到表单 |
| `listing-zh.md` | 中文文案，字段与英文版一一对应 | 同上 |
| `privacy-policy.md` | 隐私政策全文 | 提交时填它的 GitHub 链接 |

## 图片怎么来的

截图不是在画布上摆的：`_dev/make-store-art.py` 用 headless Chrome 打开 `_shots/` 下的页面，而这些页面直接引用 `popup/` 和 `settings/` 的 CSS 与脚本，只把后台消息换成一小组固定数据。所以图里的按钮、进度条、状态图标跟装好扩展后看到的是同一套样式，没有另画一套。

截图里的文件名、时长、码率是示例数据，不对应任何真实站点。

改了界面之后重新生成，别手工 P 图：

```bash
python _dev/make-store-art.py            # 图标 + 三张截图 + 两张宣传图
python _dev/make-store-art.py --shots    # 只重出截图
python _dev/make-store-art.py --promo    # 只重出宣传图
python _dev/make-store-art.py --icon     # 只重出 300×300 图标
```

需要 Pillow 和 Chrome（脚本里写的是默认安装路径，换机器要改 `CHROME` 常量）。

## 提交顺序

1. 打包：`python _dev/build.py`，产物在仓库根目录 `VideoFetch-<version>.zip`
2. Partner Center 新建扩展 → 上传 zip
3. 按 `listing-*.md` 填名称、短描述、详细描述、搜索词、分类
4. 上传三张截图（按 1→2→3 顺序）与两张宣传图、300×300 图标
5. 隐私政策填 `privacy-policy.md` 的仓库链接
6. 提交审核

## 注意

- 商店不给「下载受版权保护内容」背书，文案里已经写明「请只下载你有权保存的内容」，被问到就照这个口径答。
- 截图里出现的是演示域名（`videofetch-demo.net`），审核如果问起，说明是本地夹具数据。
