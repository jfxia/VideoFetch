# VideoFetch

[English](README.md) · 简体中文

Edge / Chrome 扩展（Manifest V3）。嗅探网页里正在播放的视频源，把 HLS 分片、流式 MP4、直链音视频抓下来，在本地合并成单个可播放的文件。

<img src="store/screenshot-1-sources-en.png" width="720" alt="视频源列表与清晰度选择">

## 能做什么

- **找到真正的流。** 四条通道同时盯：`webRequest` 响应头、页面里的 `fetch`/`XHR` hook、接口 JSON 响应体里的播放清单、以及最后兜底的 Resource Timing。一种方式被站点绕开，另外几种通常还能捞到。
- **并发下载。** HLS 分片一次拉八个、按序交付；TS 分片经 mux.js 转成 fMP4，fMP4 分片直接二进制拼接；普通文件退到 4MB 分块 Range。
- **声音不丢。** HLS 的独立音轨（`EXT-X-MEDIA`）会单独下载再合回去；音视频拆成两个文件的站点，改走配对的那条 HLS 取声音；MSE 播放器推两条 `SourceBuffer` 时，两条都录下来拼成一个文件。
- **暂停与继续。** 点暂停当场生效：不再发新请求，在途请求 400ms 后掐断，分片游标原地保留；继续从游标接着下。「保存」把当前进度另存一份（`片名 (40%).mp4`），任务不结束。
- **录直播。** 没有 `#EXT-X-ENDLIST` 的播放列表按直播处理，按目标时长轮询；什么时候停你决定，停下才成片。
- **处理麻烦的部分。** AES-128 分片解密、`EXT-X-BYTERANGE` 分段、服务端忽略 `Range` 时的本地截取、以及只认来源站 `Referer` 的 CDN（装一条会话 DNR 规则，下载前先用 1 字节 Range 自检）。
- **存到指定位置。** 默认进浏览器下载文件夹，可加子目录；也可以在设置页选任意文件夹。同名文件自动加 `(2)`，不覆盖。
- **中英双语界面。** 默认英文，浏览器是中文就切中文，设置里也能固定一种。

<img src="store/screenshot-2-tasks-zh.png" width="720" alt="下载任务：一个在下，一个已暂停并保存过快照">

## 安装

### 加载解压包

1. `python _dev/build.py`（或解开一个 release 包）
2. 打开 `edge://extensions/`（Chrome 为 `chrome://extensions/`）
3. 打开右下角「开发人员模式」
4. 点「加载解压缩的扩展」，选 **`dist/`**
5. **刷新目标网页** —— content script 只在页面加载时注入

### 商店

上架资料已备好但还没发布，届时这里补链接。

## 使用

1. 先让视频播几秒，列表会随着页面发出的媒体请求长出来
2. 点扩展图标：一个视频一张卡，同一视频的多档清晰度收进一个下拉，默认最高
3. 选好清晰度点「下载」
4. 切到「下载任务」看进度。每个任务都有暂停 / 继续和保存；直播任务只有「停止并保存」
5. 文件默认写入 `下载/VideoFetch/`，点面板右下角「设置」可改

拿不到列表时点「诊断」：页面注入是否装上、检查了多少条请求、哪些看着像媒体的地址被拒绝，都在那里。

## 设置

面板右下角「设置」（`edge://extensions` 里点扩展的「扩展选项」同样能进）。

**视频存储位置**

- **浏览器下载文件夹**（默认）：`chrome.downloads` 只能落在浏览器设定的下载目录，绝对路径会被直接拒绝，所以这里填的是子目录，默认 `VideoFetch`，留空则存在下载文件夹根下，`Video/Shows` 这样的多层目录也支持。
- **自定义文件夹**：在设置页选任意目录。拿到的 `FileSystemDirectoryHandle` 存进扩展源下的 IDB，引擎（offscreen）取出来直接 `createWritable` 写入。

  目录选择器只能在有用户手势的页面弹，popup 一失焦就关，所以不能在 popup 里选。授权撤销后不会静默换地方：退回浏览器下载文件夹，并在任务卡片上写明。

**界面语言**

默认英文；浏览器语言是 `zh-*` 时自动用中文。设置里可锁定 English / 简体中文，立即生效。引擎抛出的中文错误在英文界面下会一并翻译，没收录的新错误保留原文。

## 列表里的标签

`HLS` 点播流、`直播`/`LIVE` 无 ENDLIST 的流、`BLOB` 靠 MSE 录制、`MP4`/`WEBM`/`音频` 直链。

纯音频源（Reddit 的 `CMAF_AUDIO_64.mp4` 这类，是视频拆出来的音轨）收进列表底部的「另有 N 个纯音频源」，收起时不计入视频源数量，展开后按钮是「下载音频」，单独下回来存成 `.m4a` 而不是假 mp4。

合并过独立音轨的任务会标「含音轨」。反过来不标任何东西——读不到音轨不等于没有声音，moov 缺失、直播录制、合并完成前的中间态都会读不到，所以不写「无音轨」这种判断。

## 嗅探的四条通道

| 通道 | 覆盖 | 局限 |
|---|---|---|
| `webRequest` 响应头 | 绝大多数播放请求，不依赖页面实现 | 页面 Service Worker 代发的请求拿不到 `tabId`（按 `initiator` 反查归属） |
| 页面 hook `fetch`/`XHR` | 播放器自己拉播放列表，能读到 content-type | 请求发生在 Worker 内时 hook 不到 |
| 接口 JSON 响应体 | 播放前用 API 下发清单的站点（X 的 `video_info.variants` 就在推文接口里） | 只处理 content-type 为 JSON 且 URL 像 API 的响应，单条上限 4MB |
| Resource Timing | 前三者都漏掉的资源请求，按 URL 特征补捞 | 只有 URL，没有响应头 |

同一个 m3u8 常会重复出现，列表按 URL 去重，来源优先级不影响下载。

## 目录结构

源码在仓库根目录，**`dist/` 是唯一可加载的运行产物**（`_dev/`、`_shots/`、`store/` 都不进包）。

```
dist/                            构建输出，加载扩展选这一层
├── manifest.json
├── _locales/{en,zh_CN}          扩展名与描述（跟随浏览器界面语言，默认 en）
├── background/service-worker.js 嗅探中枢 + 列表状态 + offscreen 调度 + 消息路由
├── content/inject.js            MAIN world：hook fetch/XHR/createObjectURL/MediaSource
├── content/content.js           ISOLATED：事件上报、把录制数据搬回扩展
├── offscreen/engine.js          下载引擎：并发/直播轮询/解密/转封装/落盘/保存
├── lib/m3u8.js                  播放列表解析
├── lib/remux.js                 TS→fMP4 装配器（含降级策略）
├── lib/mp4time.js               时间轴归零 + moov 时长回填
├── lib/crypto.js                AES-128-CBC 解密
├── lib/store.js                 分片暂存（OPFS 优先，回退内存）
├── lib/settings.js              存储位置与语言设置
├── lib/fsdir.js                 自定义文件夹句柄：IDB 存取、权限、写入
├── lib/i18n.js                  中英文案表 + DOM 填充 + 引擎错误翻译
├── popup/*                      列表 / 清晰度 / 任务进度
├── settings/*                   设置页
└── vendor/mux.min.js            MPEG-TS 转封装（Apache-2.0）
```

三个关键取舍：

- **下载放在 offscreen**：MV3 的 service worker 随时被回收，且没有 DOM / Blob，建不出交给 `chrome.downloads` 的 Blob URL。
- **保留原始时间戳再手动归零**：mux.js 6.3 的 `setBaseMediaDecodeTime` 在这条链路上不生效（实测分片时间轴重叠），改为保留原始 PTS 保证连续，事后把 `tfdt` 整体平移。
- **blob 靠录制**：只要播放器走 MSE，数据一定经过 `SourceBuffer.appendBuffer`，这是唯一不依赖站点实现细节的入口。

## 构建

```bash
python _dev/build.py
```

清空并重铺 `dist/`，校验 `manifest.json` 引用的路径是否齐全，然后打出 `VideoFetch-<version>.zip`。

## 测试

没有测试框架，每个套件都是一个带断言的 Node 脚本。`_dev/serve.mjs` 提供支持 `Range` 的夹具服务器，`?delay=` 与 `?rate=` 用来复现慢速现场。

```bash
node _dev/serve.mjs 8898        # 夹具在 http://127.0.0.1:8898/player.html

node _dev/test-e2e.mjs          #  38  解析 / 转封装 / 解密
node _dev/test-engine.mjs       #  62  引擎全流程（mock chrome API）
node _dev/test-merge.mjs        #  21  fMP4 音轨合并
node _dev/test-popup.mjs        #  71  源列表、档位选择、任务卡按钮、英文界面
node _dev/test-settings.mjs     #  82  子目录规整、设置读写、词表对齐、写自定义文件夹
node _dev/test-sniff.mjs        #  11  后台嗅探与归属
node _dev/test-inject.mjs       #   8  页面 hook（vm 沙箱）
node _dev/test-referer.mjs      #  23  防盗链决策（假 fetch）
node _dev/test-pause.mjs        #  82  暂停 / 继续 / 快照保存（慢速夹具）
```

合计 398 项。夹具是 ffmpeg 生成的真实媒体，另有一组从线上 HLS 拉下来的 CMAF 分片，专门锁住「分离音轨合并」这条路径。

## 已知限制

- **不支持 DRM**：Widevine / FairPlay、`SAMPLE-AES` 加密流会直接报错。
- **HEVC / AC3 的 TS 流**：mux.js 只认 H.264 + AAC/MP3，遇到不支持的编码降级保存为 `.ts`。
- **blob 录制是边播边录**：播多少录多少，上限约 400MB，不提供暂停。
- **直播必须手动停**：不点「停止并保存」会一直录；暂停直播意味着错过的那段补不回来。
- **直播的独立音轨暂不合并**：直播音轨没有终点，成片可能无声。
- **暂停只在扩展后台存活期内有效**：断点数据存在 offscreen 的内存与 OPFS 里，重载扩展就丢，只能重新开始。
- **嗅探依赖页面加载**：装完或重载扩展后要刷新页面；`chrome://`、扩展商店等特权页无法工作。
- **自定义文件夹需要一次授权**：目录选择器只能在设置页弹；授权失效会退回浏览器下载文件夹，并在卡片上说明。
- **保存是快照，不是收尾**：每保存一次多占一份当前进度（OPFS 下的临时副本在下载读完后删除）。
- **直链续传依赖 `Range`**：服务器不支持就从头重下；`moov` 在尾部的 MP4 截断后放不出来，这是容器格式决定的。
- 部分站点分片带一次性签名，暂停过久再续可能失败。

## 商店资料

`store/` 放的是 Edge Add-ons 上架要用的东西：图标、截图、宣传图、中英文案、隐私政策。图片由 `python _dev/make-store-art.py` 重新生成 —— 它们是用真实 popup / settings 页面渲染的，不是画出来的。

## 许可

MIT，见 [LICENSE](LICENSE)。打包进来的 `vendor/mux.min.js` 为 Apache-2.0，版权归 Video.js 贡献者。
