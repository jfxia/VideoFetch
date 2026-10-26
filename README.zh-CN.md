# VideoFetch

[English](README.md) · 简体中文

Edge / Chrome 扩展（Manifest V3）。下载网页正在播放的内容：HLS 播放列表、直播流、直链 MP4，以及只以 `blob:` 地址交给播放器的媒体。分片在本地合并为一个文件。

<img src="docs/screenshot-1-sources-en.png" width="720" alt="视频源列表与清晰度选择">

## 功能

- 媒体地址由四条通道提供：响应头、页面对 `fetch` 与 `XMLHttpRequest` 的 hook、接口 JSON 响应体内的播放清单，以及作为兜底的 Resource Timing。站点封堵其中一条，通常还有另一条能命中。
- 分片按八个并发获取，按播放顺序写入。TS 经 mux.js 转成 fMP4，fMP4 到达即拼接。服务器接受 `Range` 时，普通 MP4 按 4 MB 分块下载。
- 独立音轨单独获取，再合回视频时间轴。`EXT-X-MEDIA` 声明的音轨、音视频分作两个文件的站点、向两个 `SourceBuffer` 追加数据的 MSE 播放器，都走这条路径。
- 有的源把 AAC 标注为 HE-AAC，却把扩展采样率写成与核心采样率相同。这组参数不对应任何真实码流，样本中也没有 SBR 数据，照标注解码会走一条数据并不支持的路径，听感发闷。导出时按样本实际的编码类型改写该标注。
- 暂停立即停止发起新请求，在途请求于 400 ms 内中止，已写入的分片保持原样，继续时自游标处恢复。「保存」把当前进度另存为第二个文件（`片名 (40%).mp4`），任务不结束。
- 已完成的任务与中途保存的快照，均能从任务卡用系统默认程序打开。文件已被移走的，改为在下载列表中定位。
- 不含 `#EXT-X-ENDLIST` 的播放列表按直播处理，按目标时长轮询，录制结束由用户决定。
- 分片加密与防盗链按站点情况处理。获取 AES-128 密钥后解密分片，`EXT-X-BYTERANGE` 按偏移截取，服务器忽略 `Range` 时在本地切分。只接受特定 `Referer` 的 CDN，则安装一条会话级 DNR 规则，并在下载前以 1 字节的 Range 请求验证该规则是否生效。
- 文件写入浏览器下载文件夹（默认 `VideoFetch/` 子目录），也可在设置页选定本机任意文件夹，同名文件追加序号而不覆盖。界面默认英文，浏览器语言为中文时用中文，设置中可固定为其中一种。

<img src="docs/screenshot-2-tasks-zh.png" width="720" alt="下载任务：一个正在下载，一个已暂停并保存过快照">

## 安装

### 加载解压包

1. 执行 `python _dev/build.py`，或解开一个 release 包
2. 打开 `edge://extensions/`（Chrome 为 `chrome://extensions/`）
3. 启用「开发人员模式」
4. 点击「加载解压缩的扩展」，选择 **`dist/`**
5. 刷新目标网页。content script 仅在页面加载时注入

### 商店

上架资料已备妥但尚未发布，发布后在此补充链接。

## 使用

1. 先让视频播放数秒，列表随页面发出的媒体请求逐步填充
2. 点击扩展图标。每个视频对应一张卡片，同一视频的多档清晰度收在一个下拉列表中，默认选中最高一档
3. 选择清晰度后点击「下载」
4. 切换至「下载任务」查看进度。每个任务均提供暂停、继续与保存，直播任务仅有「停止并保存」
5. 文件默认写入 `下载/VideoFetch/`，可在右下角「设置」中更改

无法获取列表时先看「诊断」：页面注入是否已装上、检查了多少条请求、哪些看似媒体的地址被拒绝，都记在这里。

## 设置

入口为面板右下角「设置」，也可在 `edge://extensions` 中点击扩展的「扩展选项」进入。

**视频存储位置**

- **浏览器下载文件夹**（默认）：`chrome.downloads` 只能写入浏览器设定的下载目录，绝对路径会被拒绝，因此设置页填写的是子目录，默认 `VideoFetch`。留空则写入下载文件夹根目录，`Video/Shows` 等多层路径同样支持。
- **自定义文件夹**：在设置页选择任意目录。所得到的 `FileSystemDirectoryHandle` 保存至扩展源下的 IDB，由 offscreen 引擎取出后以 `createWritable` 直接写入。

  目录选择器需要用户手势，popup 失去焦点即关闭，因此该操作只在设置页提供。授权失效后，下载退回浏览器下载文件夹，并在任务卡片上注明实际保存地址，不会静默切换。

**界面语言**

默认英文，浏览器语言为 `zh-*` 时自动使用中文。可在设置中固定为 English 或简体中文，修改后立即生效。引擎抛出的中文错误在英文界面下同步翻译，未收录的错误保留原文。

## 列表中的标签

`HLS` 是点播流，`直播` / `LIVE` 是不含 ENDLIST 的流，`BLOB` 的数据来自 MSE 录制，`MP4` / `WEBM` / `音频` 是直链。

纯音频源（例如 Reddit 的 `CMAF_AUDIO_64.mp4`，即从视频中拆出的音轨）归入列表底部的「另有 N 个纯音频源」，收起时不计入视频源数量。展开后按钮为「下载音频」，单独下载时保存为 `.m4a`，而不是 mp4。

合并过独立音轨的任务标有「含音轨」。未读到音轨时不加任何标注：`moov` 缺失、直播录制、合并尚未完成都会让读取失败，读不到并不等于没有，此时不下否定结论。

## 嗅探的四种通道

| 通道 | 覆盖 | 局限 |
|---|---|---|
| `webRequest` 响应头 | 绝大多数播放请求，不依赖页面实现 | 由页面 Service Worker 代发的请求取不到 `tabId`，按 `initiator` 反查归属 |
| 页面 hook `fetch` / `XHR` | 播放器自身发起的播放列表请求，可读到 content-type | 请求发生在 Worker 内时无法 hook |
| 接口 JSON 响应体 | 播放前由 API 下发清单的站点，例如 X 推文接口中的 `video_info.variants` | 仅处理 content-type 为 JSON 且 URL 形如接口的响应，单条上限 4 MB |
| Resource Timing | 前三者均遗漏的资源请求，按 URL 特征补充 | 只有 URL，没有响应头 |

同一个 m3u8 常会重复出现，列表按 URL 去重。来源通道不影响下载。

## 目录结构

源码位于仓库根目录，**`dist/` 是唯一可加载的运行产物**（`_dev/`、`_shots/` 均不进入安装包）。

```
dist/                            构建输出，加载扩展选这一层
├── manifest.json
├── _locales/{en,zh_CN}          扩展名与描述（跟随浏览器界面语言，默认 en）
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

## 构建

```bash
python _dev/build.py
```

清空并重建 `dist/`，校验 `manifest.json` 引用的路径是否齐全，然后打包为 `VideoFetch-<version>.zip`。

## 测试

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

合计 424 项。夹具为 ffmpeg 生成的真实媒体，另有一组取自线上 HLS 的 CMAF 分片，用于覆盖「分离音轨合并」这条路径。

## 已知限制

- **不支持 DRM**：Widevine、FairPlay 与 `SAMPLE-AES` 加密流会返回错误。
- **HEVC 与 AC3 的 TS 流**：这类流降级保存为 `.ts`，因为 mux.js 只支持 H.264 与 AAC / MP3。
- **blob 录制只捕获已播放的部分**：上限约 400 MB，不提供暂停。
- **直播必须手动停止**：未点击「停止并保存」会持续录制。暂停直播意味着未录到的部分无法补回。
- **直播的独立音轨暂不合并**：成片可能无声。
- **暂停状态保存在扩展后台环境中**：断点数据存于 offscreen 的内存与 OPFS，重新加载扩展后失效，任务需重新开始。
- **源识别依赖页面加载**：安装或重新加载扩展后需刷新页面。`chrome://`、扩展商店等特权页无法工作。
- **自定义文件夹在设置页选一次**：目录选择器需要用户手势，popup 失焦即关闭，因此只在设置页提供。授权失效后下载退回浏览器下载文件夹，并在任务中注明实际保存位置。
- **保存产生的是快照**：每次保存都复制一份当前进度，占用 OPFS 中的临时空间，任务本身不结束。
- **直链续传依赖 `Range`**：服务器不支持则从头重新下载。`moov` 位于文件尾部的 MP4 被截断后无法播放，这是容器格式决定的。
- **一次性签名的分片有时效**：部分站点的分片地址带签名，暂停过久后继续下载会失败。

## 截图

上文两张图放在 `docs/`，由 `_dev/make-store-art.py` 以 2 倍像素截取真实 popup 页面后，合成到 1280×800 画布上。同一个脚本还产出 Edge Add-ons 上架材料（图标、宣传图、中英文案、隐私政策），写入 `store/`，仅保存在本机，不纳入仓库。

## 许可

MIT，见 [LICENSE](LICENSE)。打包进来的 `vendor/mux.min.js` 为 Apache-2.0，版权归 Video.js 贡献者。
