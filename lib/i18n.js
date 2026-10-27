/**
 * lib/i18n.js — 界面文案（英文 / 简体中文）
 *
 * 为什么不用 chrome.i18n：它只能跟随浏览器界面语言，用户在设置里切不了。
 * 这里自带词表：默认英文（en），浏览器语言是中文时自动切到 zh。
 * 词表写在同一文件里，是同步可用的 —— 页面一渲染就是正确语言，不会先闪一下中文。
 *
 * 用法：
 *   VFI18N.init('auto' | 'en' | 'zh')     // 定语言，返回实际语言
 *   VFI18N.t('btn.download')              // 取词
 *   VFI18N.t('quality.count', { n: 3 })   // 带占位符
 *   VFI18N.applyDom(document)             // 按 data-i18n / data-i18n-title / data-i18n-ph 填文字
 *   VFI18N.trRuntime(msg)                 // 引擎抛出来的中文错误改成英文
 */
(function (g) {
  'use strict';

  const en = {
    'nav.sources': 'Sources',
    'nav.tasks': 'Downloads',
    'top.refresh': 'Refresh',
    'top.refreshTitle': 'Scan this page again',
    'top.clear': 'Clear',
    'top.clearTitle': 'Clear the list',
    'src.scanning': 'Scanning this page for videos…',
    'src.empty': 'No video sources found yet',
    'src.noHook': 'The page script is not attached. After installing or reloading the extension, refresh the page.',
    'src.checkedN': 'Checked {n} requests, none of them a recognizable media URL.',
    'src.playThenRefresh': 'Play the video on the page, then hit Refresh at the top right.',
    'src.diagHint': 'Still stuck? Open Diagnostics at the bottom right for details.',
    'tasks.empty': 'No downloads yet',
    'foot.waiting': 'Waiting for media requests…',
    'foot.diag': 'Diagnostics',
    'foot.settings': 'Settings',
    'unit.sec': '{n} sec',
    'unit.min': '{n} min',
    'unit.hm': '{h} h {m} min',
    'unit.h': '{h} h',
    'quality.count': '{n} qualities',
    'quality.n': 'Quality {n}',
    'quality.original': 'Original quality · HLS',
    'quality.unparsed': 'HLS (unparsed)',
    'opt.record': 'Capture as it plays · BLOB',
    'opt.dash': 'DASH · {mime}',
    'opt.direct': 'Direct link · {ext}{size}',
    'tag.live': 'LIVE',
    'tag.audio': 'AUDIO',
    'tag.direct': 'DIRECT',
    'btn.download': 'Download',
    'btn.downloadAudio': 'Download audio',
    'btn.export': 'Export capture',
    'btn.starting': 'Starting…',
    'title.untitled': 'Untitled media',
    'meta.audioOnly': 'Sound only · no picture',
    'meta.recorded': 'Captured {size}',
    'meta.waitPlay': 'Waiting for playback',
    'meta.estTip': 'File size, estimated from the selected quality bitrate',
    'audio.more': '{n} more audio-only sources (sound only)',
    'audio.less': 'Hide {n} audio-only sources',
    'err.readFail': 'Failed to load: {e}',
    'err.unknown': 'Unknown error',
    'toast.recFail': 'Could not read the captured data: {e}',
    'toast.noRecData': 'Nothing captured yet — play the video and let it record.',
    'toast.recTooSmall': 'Only {size} captured. Play the whole video first, then export.',
    'toast.startFail': 'Could not start: {e}',
    'toast.engineWarn': 'Engine: {e}',
    'toast.opFail': 'Action failed',
    'toast.saveFail': 'Save failed',
    'toast.copied': 'Copied',
    'toast.openFail': 'The file is no longer where it was saved — located it in the download list instead.',
    'status.queued': 'Queued',
    'status.running': 'Downloading',
    'status.pausing': 'Pausing',
    'status.paused': 'Paused',
    'status.saving': 'Saving',
    'status.done': 'Done',
    'status.error': 'Failed',
    'status.canceled': 'Canceled',
    'status.interrupted': 'Interrupted',
    'pct.done': 'Done',
    'pct.fail': 'Failed',
    'pct.pause': 'Pause',
    'pct.save': 'Save',
    'sub.live': 'Live capture',
    'sub.segments': '{a}/{b} segments',
    'sub.connecting': 'Connecting…',
    'sub.stopping': 'Stopping…',
    'sub.savingNow': 'Saving current progress…',
    'sub.pausedSnapFail': 'Paused · snapshot failed',
    'sub.pausedSnap': 'Paused · snapshot {size}',
    'sub.paused': 'Paused',
    'sub.audioYes': ' · with audio',
    'sub.upTo': ' · up to {n}%',
    'sub.saved': 'Saved',
    'sub.savedToDir': ' · {dir}',
    'sub.failed': 'Download failed',
    'sub.interrupted': 'Interrupted',
    'btn.pause': 'Pause',
    'btn.resume': 'Resume',
    'btn.pausing': 'Pausing…',
    'btn.resuming': 'Resuming…',
    'btn.save': 'Save',
    'btn.saving': 'Saving…',
    'btn.openSnap': 'Open snapshot',
    'btn.openFile': 'Open file',
    'btn.stopSave': 'Stop & save',
    'btn.cancel': 'Cancel',
    'btn.working': 'Working…',
    'btn.openFolder': 'Open folder',
    'title.pauseBtn': 'Pause. What is already downloaded is kept.',
    'title.resumeBtn': 'Continue from where it stopped',
    'title.saveBtn': 'Save what is downloaded so far. The task stays and can continue.',
    'title.openSnap': 'Open the snapshot with the default program',
    'title.openFile': 'Open with the default program',
    'title.dirSave': 'Saved into the folder you picked in Settings',
    'foot.nTasks': '{n} tasks · ',
    'foot.totalSpeed': 'Total {speed}',
    'foot.downloading': 'Downloading…',
    'foot.paused': 'Some tasks are paused — hit Resume to continue',
    'foot.count': '{n} tasks',
    'diag.empty': 'No diagnostics yet. Hit Refresh at the top right and try again.',
    'diag.inject': 'Page injection',
    'diag.status': 'Status',
    'diag.injected': 'Injected · {n} frames',
    'diag.frame': 'Frame {n}',
    'diag.notDetected': 'Not detected',
    'diag.injectNote': 'The injected script only runs at page load: after installing or reloading the extension, refresh the target page.',
    'diag.net': 'Network',
    'diag.seen': 'Requests checked',
    'diag.mediaHits': 'Recognized as media',
    'diag.orphan': 'No owning tab',
    'diag.orphanResolved': ', {n} recovered',
    'diag.ignored': 'Ignored look-alikes',
    'diag.none': 'None.',
    'diag.count': '{n}',
    'diag.copy': 'Click to copy: {url}',
    'diag.ctNone': 'no content-type',

    'set.title': 'VideoFetch settings',
    'set.saveTitle': 'Save location',
    'set.modeDownloads': 'Browser download folder',
    'set.subLabel': 'Subfolder',
    'set.subPh': 'VideoFetch',
    'set.subNote': 'Leave it empty to save directly in the download folder. Nested paths like Video/Shows work too.',
    'set.modeDir': 'Custom folder',
    'set.pick': 'Choose folder…',
    'set.change': 'Change folder',
    'set.noDir': 'No folder picked yet',
    'set.perms': 'Permission',
    'set.permGranted': 'Granted',
    'set.permPrompt': 'Needs re-authorization',
    'set.permDenied': 'Denied',
    'set.permNone': 'Not granted',
    'set.reauth': 'Authorize again',
    'set.clearDir': 'Forget folder',
    'set.openFolder': 'Open download folder',
    'set.langTitle': 'Interface language',
    'set.langAuto': 'Follow browser ({lang})',
    'set.langEn': 'English',
    'set.langZh': '简体中文',
    'set.saved': 'Saved',
    'set.dirPicked': 'Folder set: {name}',
    'set.dirCleared': 'Custom folder cleared',
    'set.permFail': 'Permission was not granted, so downloads would fall back to the browser folder.',
    'set.pickerMissing': 'This browser build has no folder picker; use the browser download folder instead.',
    'set.dirMissing': 'The saved folder is gone. Pick it again.',
    'set.notAllowed': 'This page cannot open a folder picker.',
    'set.fallback': 'Saved into the browser download folder instead.'
  };

  const zh = {
    'nav.sources': '视频源',
    'nav.tasks': '下载任务',
    'top.refresh': '刷新',
    'top.refreshTitle': '重新嗅探',
    'top.clear': '清空',
    'top.clearTitle': '清空列表',
    'src.scanning': '正在嗅探本页视频…',
    'src.empty': '暂未发现视频源',
    'src.noHook': '本页未检测到注入脚本。刚安装或重新加载扩展后，需要刷新页面才会生效。',
    'src.checkedN': '已检查 {n} 条请求，没有可识别的媒体地址。',
    'src.playThenRefresh': '播放一下页面上的视频，再点右上角「刷新」。',
    'src.diagHint': '仍有问题可点右下角「诊断」查看细节。',
    'tasks.empty': '暂无下载任务',
    'foot.waiting': '等待页面媒体请求…',
    'foot.diag': '诊断',
    'foot.settings': '设置',
    'unit.sec': '{n} 秒',
    'unit.min': '{n} 分钟',
    'unit.hm': '{h} 小时 {m} 分',
    'unit.h': '{h} 小时',
    'quality.count': '{n} 个清晰度',
    'quality.n': '清晰度 {n}',
    'quality.original': '原始清晰度 · HLS',
    'quality.unparsed': 'HLS（未解析）',
    'opt.record': '边播边录 · BLOB',
    'opt.dash': 'DASH · {mime}',
    'opt.direct': '直链 · {ext}{size}',
    'tag.live': '直播',
    'tag.audio': '音频',
    'tag.direct': '直链',
    'btn.download': '下载',
    'btn.downloadAudio': '下载音频',
    'btn.export': '导出录制',
    'btn.starting': '启动中…',
    'title.untitled': '未命名媒体',
    'meta.audioOnly': '仅声音 · 无画面',
    'meta.recorded': '已录 {size}',
    'meta.waitPlay': '待播放',
    'meta.estTip': '体积，按所选清晰度的码率估算',
    'audio.more': '另有 {n} 个纯音频源（只有声音）',
    'audio.less': '收起 {n} 个纯音频源',
    'err.readFail': '读取失败：{e}',
    'err.unknown': '未知错误',
    'toast.recFail': '读取录制数据失败：{e}',
    'toast.noRecData': '页面暂未录制到数据，请先播放视频，边播边录',
    'toast.recTooSmall': '录制数据过少（{size}），建议完整播放一遍再导出',
    'toast.startFail': '启动失败：{e}',
    'toast.engineWarn': '引擎提示：{e}',
    'toast.opFail': '操作失败',
    'toast.saveFail': '保存失败',
    'toast.copied': '已复制',
    'toast.openFail': '文件已不在保存时的位置，改为在下载列表中定位',
    'status.queued': '排队中',
    'status.running': '下载中',
    'status.pausing': '暂停中',
    'status.paused': '已暂停',
    'status.saving': '保存中',
    'status.done': '已完成',
    'status.error': '失败',
    'status.canceled': '已取消',
    'status.interrupted': '已中断',
    'pct.done': '完成',
    'pct.fail': '失败',
    'pct.pause': '暂停',
    'pct.save': '保存',
    'sub.live': '直播录制',
    'sub.segments': '{a}/{b} 段',
    'sub.connecting': '连接中…',
    'sub.stopping': '正在停下来…',
    'sub.savingNow': '正在保存当前进度…',
    'sub.pausedSnapFail': '已暂停 · 快照失败',
    'sub.pausedSnap': '已暂停 · 快照 {size}',
    'sub.paused': '已暂停',
    'sub.audioYes': ' · 含音轨',
    'sub.upTo': ' · 截至 {n}%',
    'sub.saved': '已保存',
    'sub.savedToDir': ' · {dir}',
    'sub.failed': '下载失败',
    'sub.interrupted': '已中断',
    'btn.pause': '暂停',
    'btn.resume': '继续',
    'btn.pausing': '暂停中…',
    'btn.resuming': '继续中…',
    'btn.save': '保存',
    'btn.saving': '保存中…',
    'btn.openSnap': '打开快照',
    'btn.openFile': '打开文件',
    'btn.stopSave': '停止并保存',
    'btn.cancel': '取消',
    'btn.working': '处理中…',
    'btn.openFolder': '打开所在文件夹',
    'title.pauseBtn': '暂停下载，已下载的部分会保留',
    'title.resumeBtn': '从断点继续下载',
    'title.saveBtn': '把截止当前的进度另存一份，任务保留、可以接着下',
    'title.openSnap': '用系统默认程序打开这份快照',
    'title.openFile': '用系统默认程序打开',
    'title.dirSave': '已存入你在设置里选定的文件夹',
    'foot.nTasks': '{n} 个任务 · ',
    'foot.totalSpeed': '总速度 {speed}',
    'foot.downloading': '下载中…',
    'foot.paused': '有任务已暂停，点「继续」接着下',
    'foot.count': '共 {n} 个任务',
    'diag.empty': '暂无诊断数据，点右上角「刷新」后重试。',
    'diag.inject': '页面注入',
    'diag.status': '状态',
    'diag.injected': '已注入 · {n} 个框架',
    'diag.frame': '框架 {n}',
    'diag.notDetected': '未检测到',
    'diag.injectNote': '注入脚本只在页面加载时执行：刚装扩展、或重新加载过扩展，都需要刷新目标页面。',
    'diag.net': '网络层',
    'diag.seen': '检查请求',
    'diag.mediaHits': '识别为媒体',
    'diag.orphan': '无标签归属',
    'diag.orphanResolved': '，已找回 {n}',
    'diag.ignored': '被忽略的可疑请求',
    'diag.none': '无。',
    'diag.count': '{n} 条',
    'diag.copy': '点击复制：{url}',
    'diag.ctNone': '无 content-type',

    'set.title': 'VideoFetch 设置',
    'set.saveTitle': '视频存储位置',
    'set.modeDownloads': '浏览器下载文件夹',
    'set.subLabel': '子目录',
    'set.subPh': 'VideoFetch',
    'set.subNote': '留空则直接存进下载文件夹。支持多层目录，例如 Video/Shows。',
    'set.modeDir': '自定义文件夹',
    'set.pick': '选择文件夹…',
    'set.change': '更换文件夹',
    'set.noDir': '尚未选择文件夹',
    'set.perms': '授权状态',
    'set.permGranted': '已授权',
    'set.permPrompt': '需要重新授权',
    'set.permDenied': '已拒绝',
    'set.permNone': '未授权',
    'set.reauth': '重新授权',
    'set.clearDir': '清除文件夹',
    'set.openFolder': '打开下载文件夹',
    'set.langTitle': '界面语言',
    'set.langAuto': '跟随浏览器（{lang}）',
    'set.langEn': 'English',
    'set.langZh': '简体中文',
    'set.saved': '已保存',
    'set.dirPicked': '已设置为：{name}',
    'set.dirCleared': '已清除自定义文件夹',
    'set.permFail': '没有拿到授权，下载会退回浏览器下载文件夹。',
    'set.pickerMissing': '当前浏览器版本没有文件夹选择器，请使用浏览器下载文件夹。',
    'set.dirMissing': '之前选的文件夹已经不在了，请重新选择。',
    'set.notAllowed': '本页面无法打开文件夹选择器。',
    'set.fallback': '已改存到浏览器下载文件夹。'
  };

  /* 引擎抛出来的中文错误：界面是英文时顺手翻译掉 */
  const RT = [
    ['HTTP ', 'HTTP ', '（站点启用了防盗链，扩展没能提供正确的来源）', ' (the site checks the referrer and the extension could not supply the right one)'],
    ['播放列表解析失败：', 'Failed to parse the playlist: '],
    ['不支持的加密方式：', 'Unsupported encryption: '],
    ['保存失败：', 'Save failed: '],
    ['该流使用 SAMPLE-AES 加密，暂不支持', 'This stream uses SAMPLE-AES encryption, which is not supported yet.'],
    ['该 m3u8 没有可用清晰度', 'This playlist has no usable quality level.'],
    ['播放列表中没有媒体分片', 'The playlist has no media segments.'],
    ['AES-128 密钥地址缺失', 'The AES-128 key URI is missing.'],
    ['不是播放列表', 'Not a playlist.'],
    ['未下载到任何数据', 'Nothing was downloaded.'],
    ['录制数据搬运超时', 'Timed out while collecting the captured data.'],
    ['页面无法提供录制数据', 'The page could not hand over the captured data.'],
    ['已取消', 'Canceled.'],
    ['后台下载引擎启动失败，请重试', 'The background download engine failed to start. Try again.'],
    ['后台已重启，断点丢失', 'The background restarted, so the resume point is gone.'],
    ['缺少标签页信息', 'Missing tab information.'],
    ['页面未返回录制数据', 'The page returned no captured data.'],
    ['无法连接页面（可能已刷新）：', 'Cannot reach the page (it may have been refreshed): '],
    ['服务器不支持断点续传，从头重新下载', 'The server does not support resuming; restarting from the beginning.'],
    ['文件探测失败，直接流式下载：', 'Probe failed, falling back to a streaming download: ']
  ];

  const CATALOG = { en, zh };
  let lang = 'en';
  let choice = 'auto';

  /** 浏览器语言 → 词表；除中文外一律英文 */
  function fromBrowser() {
    let l = '';
    try {
      l = String((g.navigator && (g.navigator.language || (g.navigator.languages || [])[0])) || '');
    } catch {}
    return /^zh/i.test(l) ? 'zh' : 'en';
  }

  function normChoice(c) {
    if (c === 'en' || c === 'zh') return c;
    return 'auto';
  }

  function setLang(c) {
    choice = normChoice(c);
    lang = choice === 'auto' ? fromBrowser() : choice;
    try {
      if (g.document && g.document.documentElement) {
        g.document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
      }
    } catch {}
    return lang;
  }

  function t(key, vars) {
    const c = CATALOG[lang] || en;
    let s = c[key];
    if (s == null) s = en[key];
    if (s == null) s = key;
    if (vars) {
      s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] == null ? m : String(vars[k])));
    }
    return s;
  }

  /** 按 data-i18n* 属性把静态文案填进 DOM */
  function applyDom(root) {
    const r = root || g.document;
    if (!r || !r.querySelectorAll) return;
    r.querySelectorAll('[data-i18n]').forEach((n) => {
      n.textContent = t(n.dataset.i18n);
    });
    r.querySelectorAll('[data-i18n-title]').forEach((n) => {
      n.title = t(n.dataset.i18nTitle);
    });
    r.querySelectorAll('[data-i18n-ph]').forEach((n) => {
      n.placeholder = t(n.dataset.i18nPh);
    });
    if (r.documentElement) r.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  }

  /** 引擎/后台抛出来的中文错误 → 当前语言。翻不了就原样返回 */
  function trRuntime(msg) {
    const s = String(msg == null ? '' : msg);
    if (lang !== 'en' || !s) return s;
    for (const row of RT) {
      if (row.length === 4) {
        // 「HTTP 403（…）」这种：中英文各一段，括号里那段单独换
        const [pfx, pfxEn, zhPart, enPart] = row;
        if (s.startsWith(pfx) && s.includes(zhPart)) return s.replace(zhPart, enPart);
        continue;
      }
      const [zhText, enText] = row;
      if (s === zhText) return enText;
      if (zhText.endsWith('：') && s.startsWith(zhText)) return enText + s.slice(zhText.length);
    }
    return s;
  }

  g.VFI18N = {
    t,
    setLang,
    applyDom,
    trRuntime,
    langs: ['en', 'zh'],
    get lang() {
      return lang;
    },
    get choice() {
      return choice;
    },
    browserLang: fromBrowser
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
