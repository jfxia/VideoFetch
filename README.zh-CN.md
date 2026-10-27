# VideoFetch

[English](README.md) · 简体中文

**下载网页正在播放的视频**：HLS 播放列表、不含自然终点的直播流、直链 MP4，以及只以 `blob:` 地址交给播放器的媒体。分片在本地按顺序逐步合并为一个可直接播放的文件，无需另行拼接。

这是一款 Edge / Chrome 扩展，基于 Manifest V3。分片以八路并发获取，音频与画面分轨的站点会自动对齐时间轴。

[发行说明](CHANGELOG.md) · [支持的站点](SUPPORTED_SITES.md)

<img src="docs/screenshot-1-sources-zh.png" width="720" alt="视频源列表与清晰度选择">

---

## 安装

**只想使用（推荐）**：到 [Releases](https://github.com/jfxia/VideoFetch/releases) 下载最新的 `VideoFetch-<version>.zip`，解压后打开 `edge://extensions/`（Chrome 为 `chrome://extensions/`），开启右上角的「开发人员模式」，点击「加载解压缩的扩展」，选择解压出来的文件夹（压缩包根目录就是扩展文件，没有再套一层目录），最后刷新目标网页即可。

> content script 仅在页面加载时注入，因此安装或重新加载扩展后需要刷新一次页面。`chrome://`、扩展商店等特权页面无法工作。

**想改源码或自行构建**：见下文「构建」一节。

## 使用

1. 先让视频播放数秒，列表会随页面发出的媒体请求逐步填充
   嗅探到视频后，工具栏图标会出现红色角标，数字即视频源数量；页面没有视频时不显示
2. 点击扩展图标打开面板，每个视频对应一张卡片，同一视频的多档清晰度收在一个下拉列表中，默认选中最高一档
3. 选择清晰度后点击「下载」
4. 切换到「下载任务」查看进度。普通任务提供暂停、继续与保存，直播任务仅有「停止并保存」
5. 文件默认写入 `下载/VideoFetch/`，可在面板右下角「设置」中更改

<img src="docs/screenshot-2-tasks-zh.png" width="720" alt="下载任务：一个正在下载，一个已暂停并保存过快照">

无法获取列表时先看「诊断」：页面注入是否已装上、检查了多少条请求、哪些看似媒体的地址被拒绝，都记在这里。

## 功能

- **识别片源**：页面开始播放后打开扩展面板，面板中列出该页面正在使用的视频。扩展在多个位置同时监视，某一途径被屏蔽时，通常仍有其他途径可以取得地址
- **合并成片**：分片按播放顺序在下载过程中逐步拼接，完成时即为可直接播放的 mp4 文件，无需另行合并
- **保留音轨**：画面与声音分作两个文件的站点，两路均单独获取，随后对齐至同一时间轴，成片不会缺失音轨（直播为例外，见「已知限制」）
- **纠正错标**：部分站点将普通 AAC 标注为 HE-AAC，解码器依标注查找样本中并不存在的数据，听感因此发闷。写入文件时按样本的实际编码改写该标注，不重新编码音频
- **断点续传**：暂停后不再向服务器发起新请求，已获取的分片保持原样，继续时自断点处恢复，不从头下载
- **保存快照**：中途需要可播放的文件时，使用「保存」另存一份当前进度，文件名含百分比，原任务不结束、继续下载
- **录制直播**：不含结束标记的流按直播处理，边下载边写入，由「停止并保存」结束。直播没有自然终点，结束时间由用户决定
- **加密与防盗链**：分片加密的站点仍可正常下载，取得密钥后在本地解密。仅接受特定来源页的 CDN，请求中会附带该来源页地址。下载开始前先发送一次探测请求，确认服务器接受

## 列表中的标签

`HLS` 是点播流，`直播` / `LIVE` 是不含 ENDLIST 的流，`BLOB` 的数据来自 MSE 录制，`MP4` / `WEBM` / `音频` 是直链。各类型的下载路径与限制见「已知限制」。

纯音频源（例如 Reddit 的 `CMAF_AUDIO_64.mp4`，即从视频中拆出的音轨）归入列表底部的「另有 N 个纯音频源」，收起时不计入视频源数量。展开后按钮为「下载音频」，单独下载时保存为 `.m4a`，而不是 mp4。

合并过独立音轨的任务标有「含音轨」。未读到音轨时不加任何标注：`moov` 缺失、直播录制、合并尚未完成都会让读取失败，读不到并不等于没有，此时不下否定结论。

## 设置

入口为面板右下角「设置」，也可在 `edge://extensions` 中点击扩展的「扩展选项」进入。

**视频存储位置**

- **浏览器下载文件夹**（默认）：`chrome.downloads` 只能写入浏览器设定的下载目录，绝对路径会被拒绝，因此设置页填写的是子目录，默认 `VideoFetch`。留空则写入下载文件夹根目录，`Video/Shows` 等多层路径同样支持
- **自定义文件夹**：在设置页选择任意目录。所得到的 `FileSystemDirectoryHandle` 保存至扩展源下的 IDB，由 offscreen 引擎取出后以 `createWritable` 直接写入

目录选择器需要用户手势，popup 失去焦点即关闭，因此该操作只在设置页提供。授权失效后，下载退回浏览器下载文件夹，并在任务卡片上注明实际保存地址，不会静默切换。

**界面语言**

界面语言随浏览器自动切换，缺省为英文，浏览器语言为 `zh-*` 时自动使用中文。可在设置中锁定为 English 或简体中文，修改后立即生效。引擎抛出的中文错误在英文界面下同步翻译，未收录的错误保留原文。

**同名文件**

默认自动追加序号，不覆盖已有文件。

---

## 技术细节

以下章节面向二次开发与贡献者，普通用户可跳过。

### 嗅探的四种通道

| 通道 | 覆盖 | 局限 |
|---|---|---|
| `webRequest` 响应头 | 绝大多数播放请求，不依赖页面实现 | 由页面 Service Worker 代发的请求取不到 `tabId`，按 `initiator` 反查归属 |
| 页面 hook `fetch` / `XHR` | 播放器自身发起的播放列表请求，可读到 content-type | 请求发生在 Worker 内时无法 hook |
| 接口 JSON 响应体 | 播放前由 API 下发清单的站点，例如 X 推文接口中的 `video_info.variants` | 仅处理 content-type 为 JSON 且 URL 形如接口的响应，单条上限 4 MB |
| Resource Timing | 前三者均遗漏的资源请求，按 URL 特征补充 | 只有 URL，没有响应头 |

同一个 m3u8 常会重复出现，列表按 URL 去重。来源通道不影响下载。

### 目录结构

源码位于仓库根目录，**`dist/` 是唯一可加载的运行产物**（`_dev/`、`_shots/` 均不进入安装包）。

```text
dist/                            构建输出，加载扩展选这一层
├── manifest.json
├── _locales/{en,zh_CN}          扩展名与描述（随浏览器语言切换，缺省 en）
├── background/service-worker.js 嗅探中枢 + 列表状态 + offscreen 调度 + 消息路由
├── content/inject.js            MAIN world：hook fetch/XHR/createObjectURL/MediaSource
├── content/content.js           ISOLATED：事件上报、把录制数据搬回扩展
├── offscreen/engine.js          下载引擎：并发/直播轮询/解密/转封装/落盘/保存
├── lib/m3u8.js                  播放列表解析
├── lib/remux.js                 TS 转 fMP4 装配器（含降级策略）
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

下载在 offscreen 文档里执行。MV3 的 service worker 闲置约三十秒即被回收，且没有 DOM 与 Blob，无法创建交给 `chrome.downloads` 的 Blob URL。

时间戳在整个下载过程中保持原值，装配完毕后再整体平移。mux.js 6.3 的 `setBaseMediaDecodeTime` 在此链路上不生效（实测分片时间轴重叠），因此保留原始 PTS 以保证连续，待分片装配完毕后由 `lib/mp4time.js` 将 `tfdt` 归零。

blob 源在 `SourceBuffer` 处捕获。无论播放器如何实现，媒体数据都要经过 `appendBuffer`，这是唯一不依赖站点内部实现细节的入口。

### 构建

```bash
python _dev/build.py
```

清空并重建 `dist/`，校验 `manifest.json` 引用的路径是否齐全，然后打包为 `VideoFetch-<version>.zip`。

### 测试

项目未使用测试框架，每个套件都是一个带断言的 Node 脚本。`_dev/serve.mjs` 提供支持 `Range` 的夹具服务器，`?delay=` 与 `?rate=` 用于复现慢速链路，以便检查暂停与续传的时序。

```bash
node _dev/serve.mjs 8898        # 夹具在 http://127.0.0.1:8898/player.html

node _dev/test-e2e.mjs          #  38  解析 / 转封装 / 解密
node _dev/test-engine.mjs       #  62  引擎全流程（mock chrome API）
node _dev/test-merge.mjs        #  41  fMP4 音轨合并
node _dev/test-popup.mjs        #  77  源列表、档位选择、任务卡按钮、英文界面
node _dev/test-settings.mjs     #  82  子目录规整、设置读写、词表对齐、写自定义文件夹
node _dev/test-sniff.mjs        #  11  后台嗅探与归属
node _dev/test-inject.mjs       #   8  页面 hook（vm 沙箱）
node _dev/test-referer.mjs      #  23  防盗链决策（假 fetch）
node _dev/test-pause.mjs        #  82  暂停 / 继续 / 快照保存（慢速夹具）
```

合计 424 项断言。右侧数字为该套件的断言条数。夹具为 ffmpeg 生成的真实媒体，另有一组取自线上 HLS 的 CMAF 分片，用于覆盖「分离音轨合并」这条路径。

## 已知限制

- **不支持 DRM**：Widevine、FairPlay 与 `SAMPLE-AES` 加密流会返回错误
- **HEVC 与 AC3 的 TS 流**：这类流降级保存为 `.ts`，因为 mux.js 只支持 H.264 与 AAC / MP3
- **blob 录制只捕获已播放的部分**：上限约 400 MB，不提供暂停
- **直播必须手动停止**：未点击「停止并保存」会持续录制。暂停直播意味着未录到的部分无法补回
- **直播的独立音轨暂不合并**：成片可能无声
- **暂停状态存在扩展后台环境中**：断点数据存于 offscreen 的内存与 OPFS，重新加载扩展后失效，任务需重新开始
- **源识别依赖页面加载**：安装或重新加载扩展后需刷新页面
- **自定义文件夹只在设置页选一次**：目录选择器需要用户手势，popup 失焦即关闭。授权失效后下载退回浏览器下载文件夹，并在任务中注明实际保存位置
- **保存产生的是快照**：每次保存都复制一份当前进度，占用 OPFS 中的临时空间，任务本身不结束
- **直链续传依赖 `Range`**：服务器不支持则从头重新下载。`moov` 位于文件尾部的 MP4 被截断后无法播放，这是容器格式决定的
- **一次性签名的分片有时效**：部分站点的分片地址带签名，暂停过久后继续下载会失败

## 许可

MIT，见 [LICENSE](LICENSE)。打包进来的 `vendor/mux.min.js` 为 Apache-2.0，版权归 Video.js 贡献者。
