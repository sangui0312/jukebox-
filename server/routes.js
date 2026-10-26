/**
 * REST 路由（操作走 REST，广播走 WebSocket）
 * 依赖注入 io（Socket.io）与 player，避免循环引用。
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const state = require('./state');
const netease = require('./netease');
const qq = require('./qq');
const music = require('./music');
const users = require('./users');
const logger = require('./logger');
const channels = require('./channels');
const config = require('./config');
const scheduler = require('./scheduler');
const { playlistId, qqPlaylistId } = require('./playlist-input');

/** 渠道是否开启 + 名称 */
function channelOn(platform) {
  const on = platform === 'qq' ? state.channels.qq : state.channels.netease;
  const name = platform === 'qq' ? 'QQ音乐' : '网易云';
  return { on, name };
}

function cleanIp(ip) {
  if (!ip) return '';
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  if (ip === '::1') return '127.0.0.1';
  return ip;
}

// ===== 预设歌单持久化（presets.json，不入 git） =====
const PRESETS_FILE = require('./paths').presetsPath;
function loadPresets() {
  try {
    const arr = JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf8'));
    if (Array.isArray(arr)) return arr.map(p => ({...p, platform:p.platform === 'qq' ? 'qq' : 'netease'}));
  } catch (e) {
    /* 无文件或损坏 */
  }
  return Array.isArray(config.presetPlaylists) ? config.presetPlaylists.map(p => ({...p, platform:p.platform === 'qq' ? 'qq' : 'netease'})) : [];
}
function savePresets(presets) {
  try {
    fs.writeFileSync(PRESETS_FILE, JSON.stringify(presets, null, 2));
  } catch (e) {
    /* ignore */
  }
}

// Append explicit overrides so old configs, quoted keys and missing fields all
// work. Commit the file before changing memory or reporting success.
function saveVoteSettings(key, value) {
  const cfgPath = require('./paths').configPath;
  const tempPath = cfgPath + '.votes.tmp';
  const settings = { skipRequired: config.skipRequired, boostRequired: config.boostRequired, [key]: value };
  try {
    const source = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, 'utf8') : 'module.exports = {};\n';
    const marker = /\/\/ BEGIN JUKEBOX_VOTE_SETTINGS[\s\S]*?\/\/ END JUKEBOX_VOTE_SETTINGS/;
    const block = '// BEGIN JUKEBOX_VOTE_SETTINGS\n' + Object.entries(settings)
      .map(([name, number]) => `module.exports.${name} = ${JSON.stringify(number)};`).join('\n') + '\n// END JUKEBOX_VOTE_SETTINGS';
    const next = marker.test(source) ? source.replace(marker, () => block) : source + '\n' + block + '\n';
    fs.writeFileSync(tempPath, next, 'utf8');
    fs.renameSync(tempPath, cfgPath);
  } catch (error) {
    try { fs.unlinkSync(tempPath); } catch {}
    throw error;
  }
}

function createRouter(io, player, playNext, system) {
  const router = express.Router();
  const broadcast = () => io.emit('state:update', state.snapshot());
  const controlSettings = () => ({ maxPerUser: config.maxPerUser, maxUserQueue: config.maxUserQueue,
    autoStart: config.autoStart === true, loudnessNormalization: config.loudnessNormalization !== false });

  // 用户活跃记录中间件（带 x-client-id 的请求都会登记 IP/昵称）
  router.use((req, res, next) => {
    const cid = req.get('x-client-id');
    if (cid) {
      const previous = users.get(cid);
      const previousName = previous?.nickname;
      const previousIp = previous?.ip;
      let nickname = '';
      if (req.path !== '/me/nickname') {
        if (typeof req.body?.nickname === 'string') nickname = req.body.nickname;
        if (!nickname) { try { nickname = decodeURIComponent(req.get('x-client-nickname') || ''); } catch {} }
      }
      users.touch(cid, cleanIp(req.ip), nickname);
      const user = users.get(cid);
      if (!previous || user.nickname !== previousName || user.ip !== previousIp) {
        const synced = user.nickname ? state.updateNickname(cid, user.nickname) : { updated: 0 };
        if (!synced.updated) state.bump();
        broadcast();
      }
    }
    next();
  });

  /** 管理接口认证中间件（x-admin-key 必须等于 config.adminKey） */
  function adminAuth(req, res, next) {
    const key = req.get('x-admin-key') || '';
    if (!config.adminKey) return res.status(403).json({ error: '管理功能未启用（config 未设置 adminKey）' });
    if (key !== config.adminKey) return res.status(401).json({ error: '口令错误' });
    next();
  }

  /** GET /api/search?platform=&keyword=&limit= 搜索（不含音频 URL） */
  router.get('/search', async (req, res) => {
    const keyword = (req.query.keyword || '').trim();
    const platform = req.query.platform === 'qq' ? 'qq' : 'netease';
    if (!keyword) return res.status(400).json({ error: 'keyword 必填' });
    const ch = channelOn(platform);
    if (!ch.on) return res.status(503).json({ error: `${ch.name}渠道维护中，暂时无法搜索` });
    try {
      const data = await music.search(platform, keyword, Number(req.query.limit) || 30);
      res.json(data);
    } catch (e) {
      res.status(502).json({ error: '搜索失败: ' + e.message });
    }
  });

  /** GET /api/state 首次加载快照 */
  router.get('/state', (req, res) => {
    res.json(state.snapshot());
  });

  /** GET /api/me 当前身份（clientId → canonicalId，前端判断"可删自己的歌"） */
  router.get('/me', (req, res) => {
    const clientId = req.get('x-client-id') || '';
    res.json({ clientId, canonicalId: clientId ? users.canonicalOf(clientId) : '', nickname: users.get(clientId)?.nickname || '' });
  });

  /** GET /api/chart-songs?platform=&id=&limit= 榜单歌曲（netease=歌单ID，qq=topId；缓存） */
  router.get('/chart-songs', async (req, res) => {
    const platform = req.query.platform === 'qq' ? 'qq' : 'netease';
    const limit = Number(req.query.limit) || 30;
    const id = String(req.query.id || '');
    if (!id) return res.status(400).json({ error: 'id 必填' });
    const ch = channelOn(platform);
    if (!ch.on) return res.status(503).json({ error: `${ch.name}渠道维护中，榜单暂不可用` });
    try {
      const data =
        platform === 'qq'
          ? await qq.getChart(Number(id) || 0, limit)
          : await netease.getPlaylistCached(Number(id) || 0);
      const songs = (data.songs || []).slice(0, limit).map((s) => ({ ...s, platform }));
      res.json({ name: data.name, count: data.songs ? data.songs.length : 0, songs });
    } catch (e) {
      res.status(502).json({ error: '榜单加载失败: ' + e.message });
    }
  });
  /** GET /api/playlist-songs?id=&limit= 歌单歌曲（用户前端"热歌榜"等入口；缓存30分钟） */
  router.get('/playlist-songs', async (req, res) => {
    const id = Number(req.query.id);
    const limit = Number(req.query.limit) || 30;
    if (!id) return res.status(400).json({ error: 'id 必填' });
    if (!state.channels.netease) return res.status(503).json({ error: '网易云渠道维护中' });
    try {
      const pl = await netease.getPlaylistCached(id);
      res.json({ name: pl.name, count: pl.songs.length, songs: pl.songs.slice(0, limit) });
    } catch (e) {
      res.status(502).json({ error: '歌单加载失败: ' + e.message });
    }
  });

  /** POST /api/queue {platform, songId, nickname} 插播点歌 */
  router.post('/queue', async (req, res) => {
    const { songId, nickname } = req.body || {};
    const platform = req.body && req.body.platform === 'qq' ? 'qq' : 'netease';
    const clientId = req.get('x-client-id') || '';
    if (!songId) return res.status(400).json({ error: 'songId 必填' });
    if (!clientId) return res.status(400).json({ error: '缺少 x-client-id' });
    const ch = channelOn(platform);
    if (!ch.on) return res.status(503).json({ error: `${ch.name}渠道维护中，暂时无法点歌` });

    let item;
    try {
      item = await music.getSongDetail(platform, String(songId));
    } catch (e) {
      return res.status(404).json({ error: '歌曲不存在或无法获取' });
    }
    item.requestedBy = clientId;
    // 昵称以用户表为准（同一IP用户所有歌统一显示最新昵称），无记录才用请求昵称
    const u = users.get(clientId);
    item.nickname = (u && u.nickname) || nickname || '匿名';
    item.requestedAt = Date.now();

    const r = state.addUserSong(item);
    if (!r.ok) return res.status(409).json({ error: r.error });
    broadcast();
    playNext(); // 插播区可能从空变非空，触发播放循环
    logger.log('info', `${item.nickname} 点了《${item.name}》[${platform}]${r.duplicate ? '（重复）' : ''}`, 'queue');
    res.json({ ok: true, duplicate: r.duplicate });
  });

  /** DELETE /api/queue/:platform/:songId 删歌（仅本人） */
  router.delete('/queue/:platform/:songId', (req, res) => {
    const clientId = req.get('x-client-id') || '';
    if (!clientId) return res.status(400).json({ error: '缺少 x-client-id' });
    const platform = req.params.platform === 'qq' ? 'qq' : 'netease';
    const r = state.removeUserSong(platform, String(req.params.songId), clientId);
    if (!r.ok) return res.status(r.code || 400).json({ error: r.error });
    broadcast();
    logger.log('info', `用户删除了自己的歌曲`, 'queue');
    res.json({ ok: true });
  });

  /** POST /api/vote-skip 投票跳过当前歌曲（达票数自动跳过） */
  router.post('/vote-skip', (req, res) => {
    const clientId = req.get('x-client-id') || '';
    if (!clientId) return res.status(400).json({ error: '缺少 x-client-id' });
    const r = state.addSkipVote(clientId, (req.body && req.body.nickname) || '匿名');
    if (!r.ok) return res.status(409).json({ error: r.error });
    broadcast();
    if (r.shouldSkip) {
      // 达票：跳过当前，稍后触发播下一首
      logger.log('warn', `投票达 ${r.votes}/${r.required}，跳过当前歌曲`, 'vote');
      if(system?.skip)system.skip();else player.stop();
      res.json({ ok: true, votes: r.votes, required: r.required, skipped: true });
      return;
    }
    logger.log('info', `投票跳过 ${r.votes}/${r.required}`, 'vote');
    res.json({ ok: true, votes: r.votes, required: r.required, skipped: false });
  });

  /** POST /api/me/nickname {nickname} 修改用户名（同步更新队列里该用户点的歌） */
  router.post('/me/nickname', (req, res) => {
    const clientId = req.get('x-client-id') || '';
    if (!clientId) return res.status(400).json({ error: '缺少 x-client-id' });
    const nickname = typeof req.body?.nickname === 'string' ? req.body.nickname.trim().slice(0, 12) : '';
    if (!nickname) return res.status(400).json({ error: '昵称不能为空' });
    const before = users.get(clientId);
    const oldNickname = (before && before.nickname) || '匿名';
    const actorIp = (before && before.ip) || cleanIp(req.ip) || '未知IP';
    const r = state.updateNickname(clientId, nickname);
    broadcast();
    logger.log(
      'action',
      `用户改名：${oldNickname} → ${nickname}（IP ${actorIp}，队列同步 ${r.updated} 首）`,
      'user',
      {
        action: 'nickname-change',
        actorNicknameBefore: oldNickname,
        actorNicknameAfter: nickname,
        actorIp,
        updatedQueueCount: r.updated,
      },
    );
    res.json({ ok: true, nickname, updated: r.updated });
  });

  /** POST /api/boost {platform, songId} 顶歌（每IP一顶，达阈值升到队首） */
  router.post('/boost', (req, res) => {
    const clientId = req.get('x-client-id') || '';
    if (!clientId) return res.status(400).json({ error: '缺少 x-client-id' });
    const platform = (req.body && req.body.platform) === 'qq' ? 'qq' : 'netease';
    const songId = String((req.body && req.body.songId) || '');
    if (!songId) return res.status(400).json({ error: 'songId 必填' });
    const target = state.userQueue.find(
      (s) => s.platform === platform && String(s.songId) === songId,
    );
    const songName = (target && target.name) || `ID ${songId}`;
    const artists = target && Array.isArray(target.artists) ? target.artists.filter(Boolean).join('/') : '';
    const actorRecord = users.get(clientId);
    const booster = (actorRecord && actorRecord.nickname) || '匿名';
    const actorIp = (actorRecord && actorRecord.ip) || cleanIp(req.ip) || '未知IP';
    const r = state.addBoost(clientId, platform, songId);
    if (!r.ok) return res.status(r.code || 409).json({ error: r.error });
    broadcast();
    logger.log(
      'action',
      `${booster}（IP ${actorIp}）顶歌《${songName}》${artists ? ` - ${artists}` : ''} [${platform}]，${r.count}/${r.required}${r.promoted ? '（升到第一！）' : ''}`,
      'boost',
      {
        action: 'boost',
        actorNickname: booster,
        actorIp,
        platform,
        songId,
        songName,
        artists,
        count: r.count,
        required: r.required,
        promoted: r.promoted,
      },
    );
    res.json({
      ok: true,
      count: r.count,
      required: r.required,
      promoted: r.promoted,
    });
  });

  // ============ 管理接口（/api/admin/*，需 x-admin-key） ============

  /** GET /api/admin/channels 渠道开关状态 */
  router.get('/admin/channels', adminAuth, (req, res) => {
    res.json({ channels: state.channels });
  });

  /** POST /api/admin/channels {platform, enabled} 开/关渠道（持久化 + 广播） */
  router.post('/admin/channels', adminAuth, (req, res) => {
    const platform = (req.body && req.body.platform) === 'qq' ? 'qq' : 'netease';
    const enabled = !!(req.body && req.body.enabled);
    state.channels = channels.set(platform, enabled);
    logger.log('action', `管理员${enabled ? '开启' : '关闭'}了${platform === 'qq' ? 'QQ音乐' : '网易云'}渠道`, 'admin');
    broadcast();
    res.json({ ok: true, channels: state.channels });
  });

  /** POST /api/admin/cookie {platform, cookie} 填写平台 Cookie（立即生效） */
  router.post('/admin/cookie', adminAuth, async (req, res) => {
    const platform = (req.body && req.body.platform) === 'qq' ? 'qq' : 'netease';
    const cookie = String((req.body && req.body.cookie) || '').trim();
    if (!cookie) return res.status(400).json({ error: 'cookie 不能为空' });
    if (platform === 'netease') {
      // 写 config.local.js + 更新内存
      const cfgPath = require('./paths').configPath;
      try {
        let content = fs.readFileSync(cfgPath, 'utf8');
        const field = /\bneteaseCookie\s*:\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/;
        if (!field.test(content)) throw new Error('未找到网易云 Cookie 配置字段');
        content = content.replace(field, () => 'neteaseCookie: ' + JSON.stringify(cookie));
        fs.writeFileSync(cfgPath, content);
        config.neteaseCookie = cookie;
      } catch (e) {
        return res.status(500).json({ error: '配置写入失败: ' + e.message });
      }
      logger.log('action', '管理员更新了网易云 Cookie', 'admin');
      res.json({ ok: true, platform: 'netease' });
    } else {
      // 调 QQMusicApi setCookie（热更新其 userCookie）
      try {
        const r = await fetch(`${config.qqApiBase}/user/setCookie`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: cookie }),
        });
        const j = await r.json();
        if (j.result !== 100) throw new Error('QQ API 拒绝: ' + (j.errMsg || j.result));
        logger.log('action', '管理员更新了QQ音乐 Cookie', 'admin');
        res.json({ ok: true, platform: 'qq' });
      } catch (e) {
        res.status(502).json({ error: 'QQ API 设置失败: ' + e.message });
      }
    }
  });

  /** GET /api/admin/cookie-status 平台账号状态（配置 + 登录验证） */
  router.get('/admin/cookie-status', adminAuth, async (req, res) => {
    // 网易云登录探测
    let neteaseAccount = '';
    if (config.neteaseCookie) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 4000);
        const r = await fetch(`${config.neteaseApiBase}/login/status`, {
          headers: { Cookie: config.neteaseCookie },
          signal: ctrl.signal,
        });
        clearTimeout(t);
        const j = await r.json();
        const profile = j.data && j.data.profile;
        if (profile) neteaseAccount = profile.nickname;
      } catch (e) {
        /* 探测失败 */
      }
    }
    // 文件存在不等于登录有效，查询 QQ API 的实际认证结果。
    const qqCookieFile = path.join(require('./paths').qqDir, 'cookie.json');
    let qqStatus = {configured:fs.existsSync(qqCookieFile) || fs.existsSync(qqCookieFile + '.bak'), authenticated:null, state:'unreachable'};
    try {
      const response = await fetch(`${config.qqApiBase}/user/loginStatus`, {signal:AbortSignal.timeout(9000)});
      if (response.ok) {
        const status = await response.json();
        qqStatus = {configured:!!status.configured,authenticated:status.authenticated,state:status.state,renewal:status.renewal};
      }
    } catch {}
    res.json({
      channels: state.channels,
      netease: { configured: !!config.neteaseCookie, account: neteaseAccount },
      qq: qqStatus,
    });
  });

  /** POST /api/admin/auth {key} 登录验证（前端进入管理页时调用） */
  router.post('/admin/auth', (req, res) => {
    const key = (req.body && req.body.key) || '';
    if (!config.adminKey) return res.status(403).json({ error: '管理功能未启用' });
    if (key === config.adminKey) return res.json({ ok: true });
    res.status(401).json({ error: '口令错误' });
  });

  /** GET /api/admin/status 系统状态 */
  router.get('/admin/status', adminAuth, async (req, res) => {
    const snap = state.snapshot();
    // 探测两个音乐 API 服务在线状态
    const probe = async (url) => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 1500);
        const r = await fetch(url, { signal: ctrl.signal });
        clearTimeout(t);
        return r.ok;
      } catch {
        return false;
      }
    };
    res.json({
      ...snap,
      controlSettings: controlSettings(),
      player: {
        running: player.isPlaying(),
        paused: player.paused,
        active: state.playbackControl?.active ?? player.isPlaying(),
        volume: player.volume,
        mpvPath: config.mpvPath,
      },
      services: {
        netease: await probe(config.neteaseApiBase),
        qq: await probe(config.qqApiBase),
      },
      config: {
        adminEnabled: !!config.adminKey,
        cookieConfigured: !!config.neteaseCookie,
        neteaseApiBase: config.neteaseApiBase,
      },
      uptime: process.uptime(),
    });
  });

  /** GET /api/admin/schedules 定时播放任务 */
  router.get('/admin/schedules', adminAuth, (req, res) => {
    res.json({ schedules: scheduler.list() });
  });

  /** POST /api/admin/schedules {song, recurrence, time, weekdays} 新增定时播放任务 */
  router.post('/admin/schedules', adminAuth, (req, res) => {
    try {
      const schedule = scheduler.add(req.body || {});
      logger.log('action', `管理员新增定时播放《${schedule.name}》[${schedule.platform}] ${schedule.time}`, 'schedule');
      res.json({ ok: true, schedule });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  /** PATCH /api/admin/schedules/:id {enabled} 启用/停用定时播放任务 */
  router.patch('/admin/schedules/:id', adminAuth, (req, res) => {
    try {
      const schedule = scheduler.update(String(req.params.id), { enabled: !!(req.body && req.body.enabled) });
      logger.log('action', `管理员${schedule.enabled ? '启用' : '停用'}定时播放《${schedule.name}》`, 'schedule');
      res.json({ ok: true, schedule });
    } catch (e) {
      res.status(404).json({ error: e.message });
    }
  });

  /** DELETE /api/admin/schedules/:id 删除定时播放任务 */
  router.delete('/admin/schedules/:id', adminAuth, (req, res) => {
    try {
      scheduler.remove(String(req.params.id));
      logger.log('action', '管理员删除定时播放任务', 'schedule');
      res.json({ ok: true });
    } catch (e) {
      res.status(404).json({ error: e.message });
    }
  });

  /** POST /api/admin/pause {paused:true|false} 暂停/继续（未播放时 false = 开始播放） */
  router.post('/admin/pause', adminAuth, (req, res) => {
    const paused = !!(req.body && req.body.paused);
    if (paused) {
      if(system?.pause)system.pause();else player.setPaused(true);
    } else if (system?.resume) {
      system.resume();
    } else if (player.isPlaying()) {
      player.setPaused(false);
    } else {
      playNext(); // 启动后默认暂停：管理台点"开始播放"从此处启动播放循环
    }
    broadcast();
    res.json({ ok: true, paused: player.paused });
  });

  /** POST /api/admin/volume {volume:0-100} 调音量（持久化，重启保持） */
  router.post('/admin/volume', adminAuth, (req, res) => {
    const v = Number(req.body && req.body.volume);
    if (Number.isNaN(v) || v < 0 || v > 100) return res.status(400).json({ error: 'volume 需为 0-100' });
    player.setVolume(v);
    config.volume = v; // 同步内存配置
    // 持久化到 config.local.js（保留其他配置）
    const cfgPath = require('./paths').configPath;
    try {
      if (fs.existsSync(cfgPath)) {
        let content = fs.readFileSync(cfgPath, 'utf8');
        content = content.replace(/(volume:\s*)\d+/, `$1${v}`);
        fs.writeFileSync(cfgPath, content);
      }
    } catch (e) {
      // 持久化失败不阻塞
    }
    res.json({ ok: true, volume: player.volume });
  });

  /** POST /api/admin/skip 跳过当前（仅管理员；kill mpv → onEnd → 播下一首） */
  router.post('/admin/skip', adminAuth, (req, res) => {
    if(system?.skip)system.skip();else player.stop();
    res.json({ ok: true });
  });

  /** Control settings are validated and persisted before changing runtime state. */
  router.post('/admin/control-settings', adminAuth, (req, res) => {
    const values = req.body || {};
    const keys = ['maxPerUser', 'maxUserQueue', 'autoStart', 'loudnessNormalization'];
    if (Object.keys(values).some(key => !keys.includes(key)) ||
        !Number.isInteger(values.maxPerUser) || values.maxPerUser < 1 || values.maxPerUser > 300 ||
        !Number.isInteger(values.maxUserQueue) || values.maxUserQueue < 1 || values.maxUserQueue > 3000 ||
        typeof values.autoStart !== 'boolean' || typeof values.loudnessNormalization !== 'boolean') {
      return res.status(400).json({ error: '每人上限需为 1–300 的整数，点歌区上限需为 1–3000 的整数，开关需为布尔值' });
    }
    const settings = Object.fromEntries(keys.map(key => [key, values[key]]));
    const cfgPath = require('./paths').configPath;
    const tempPath = cfgPath + '.settings.tmp';
    try {
      const source = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, 'utf8') : 'module.exports = {};\n';
      const block = '// BEGIN JUKEBOX_ADMIN_SETTINGS\n' + keys.map(key => `module.exports.${key} = ${JSON.stringify(settings[key])};`).join('\n') + '\n// END JUKEBOX_ADMIN_SETTINGS';
      const marker = /\/\/ BEGIN JUKEBOX_ADMIN_SETTINGS[\s\S]*?\/\/ END JUKEBOX_ADMIN_SETTINGS/;
      const next = marker.test(source) ? source.replace(marker, () => block) : source + '\n' + block + '\n';
      fs.writeFileSync(tempPath, next, 'utf8');
      fs.renameSync(tempPath, cfgPath);
    } catch {
      try { fs.unlinkSync(tempPath); } catch {}
      return res.status(500).json({ error: '设置未保存，请检查用户数据目录的写入权限后重试' });
    }
    Object.assign(config, settings);
    broadcast();
    logger.log('action', `管理员修改控制设置：每人 ${settings.maxPerUser} 首，点歌区 ${settings.maxUserQueue} 首，启动自动播放${settings.autoStart ? '开启' : '关闭'}，响度均衡${settings.loudnessNormalization ? '开启' : '关闭'}`, 'admin');
    res.json({ ok: true, settings });
  });

  /** GET /api/admin/skip-config 当前投票跳过配置 */
  router.get('/admin/skip-config', adminAuth, (req, res) => {
    res.json({ required: state.skipRequired });
  });

  /** POST /api/admin/skip-config {required} 修改投票跳过所需票数（持久化） */
  router.post('/admin/skip-config', adminAuth, (req, res) => {
    const n = Number(req.body && req.body.required);
    if (!Number.isInteger(n) || n < 1 || n > 100) return res.status(400).json({ error: 'required 需为 1-100 的整数' });
    try { saveVoteSettings('skipRequired', n); }
    catch { return res.status(500).json({ error: '跳过条件未保存，请检查用户数据目录的写入权限后重试' }); }
    state.setSkipRequired(n);
    config.skipRequired = n;
    broadcast();
    res.json({ ok: true, required: state.skipRequired });
  });

  /** POST /api/admin/boost-config {required} 修改顶歌所需次数（持久化） */
  router.post('/admin/boost-config', adminAuth, (req, res) => {
    const n = Number(req.body && req.body.required);
    if (!Number.isInteger(n) || n < 1 || n > 100) return res.status(400).json({ error: 'required 需为 1-100 的整数' });
    try { saveVoteSettings('boostRequired', n); }
    catch { return res.status(500).json({ error: '顶歌条件未保存，请检查用户数据目录的写入权限后重试' }); }
    config.boostRequired = n;
    broadcast();
    res.json({ ok: true, required: config.boostRequired });
  });

  /** DELETE /api/admin/queue/:platform/:songId 管理员删任意歌 */
  router.delete('/admin/queue/:platform/:songId', adminAuth, (req, res) => {
    const platform = req.params.platform === 'qq' ? 'qq' : 'netease';
    const r = state.adminRemoveUserSong(platform, String(req.params.songId));
    if (!r.ok) return res.status(r.code || 400).json({ error: r.error });
    broadcast();
    logger.log('action', `管理员删除队列中的歌曲`, 'admin');
    res.json({ ok: true });
  });

  /** POST /api/admin/queue/clear 清空插播区 */
  router.post('/admin/queue/clear', adminAuth, (req, res) => {
    const r = state.clearUserQueue();
    broadcast();
    logger.log('action', `管理员清空插播区（${r.removed} 首）`, 'admin');
    res.json(r);
  });

  /** POST /api/admin/queue/move {from, to} 移动队列歌曲顺序 */
  router.post('/admin/queue/move', adminAuth, (req, res) => {
    const from = Number(req.body && req.body.from);
    const to = Number(req.body && req.body.to);
    if (Number.isNaN(from) || Number.isNaN(to)) return res.status(400).json({ error: 'from/to 必填' });
    const r = state.moveUserSong(from, to);
    if (!r.ok) return res.status(400).json({ error: r.error });
    broadcast();
    logger.log('action', `管理员移动队列歌曲 #${from + 1} → #${to + 1}`, 'admin');
    res.json({ ok: true });
  });

  /** POST /api/admin/queue/play-now {index} 立即播放队列第 index 首 */
  router.post('/admin/queue/play-now', adminAuth, (req, res) => {
    const idx = Number(req.body && req.body.index);
    if (Number.isNaN(idx) || idx < 0 || idx >= state.userQueue.length) {
      return res.status(400).json({ error: '无效的位置' });
    }
    const [item] = state.userQueue.splice(idx, 1);
    state.userQueue.unshift(item);
    state.bump();
    if (system?.playNow) {
      system.playNow();
    } else if (player.isPlaying()) {
      player.stop(); // 触发 onEnd → 播队首（目标歌）
    } else {
      playNext();
    }
    broadcast();
    logger.log('action', `管理员立即播放《${item.name}》`, 'admin');
    res.json({ ok: true });
  });

  const platformOf = value => value === 'qq' ? 'qq' : 'netease';
  const currentIds = () => ({netease:config.playlistId || 3778678, qq:config.qqPlaylistId || 0});
  const loadPlaylist = (platform,id) => platform === 'qq'
    ? (id ? qq.getPlaylist(id) : qq.getChart(config.qqChartId || 26,100).then(chart => ({id:0,name:chart.name || 'QQ热歌榜',songs:chart.songs}))) : netease.getPlaylistCached(id);
  function persistPlaylist(platform,id) {
    const cfgPath = require('./paths').configPath;
    const key = platform === 'qq' ? 'qqPlaylistId' : 'playlistId';
    let content = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath,'utf8') : 'module.exports = {};';
    const pattern = new RegExp('((?:\\b' + key + '\\s*:|module\\.exports\\.' + key + '\\s*=)\\s*)\\d+', 'g');
    if (pattern.test(content)) content = content.replace(pattern, (_,prefix) => prefix + id);
    else content += `\nmodule.exports.${key} = ${id};\n`;
    fs.writeFileSync(cfgPath, content);
    config[key] = id;
  }
  router.post('/admin/playlist', adminAuth, async (req,res) => {
    const platform = platformOf(req.body && req.body.platform);
    const id = Number(req.body && req.body.playlistId);
    if (!Number.isSafeInteger(id) || id < (platform === 'qq' ? 0 : 1)) return res.status(400).json({error:'歌单 ID 无效'});
    try {
      const pl = await loadPlaylist(platform,id);
      persistPlaylist(platform,id);
      state.setPlaylist(id,pl.name,pl.songs,platform);
      state.setPlaySource(platform === 'qq' ? 'qq-playlist' : 'playlist');
      broadcast();
      if (player.isPlaying() && !player.manualPaused) playNext();
      logger.log('action', `管理员切换${platform === 'qq' ? 'QQ音乐' : '网易云'}歌单：${pl.name}（${pl.songs.length} 首）`, 'admin');
      res.json({ok:true,name:pl.name,count:pl.songs.length,active:true,playSource:state.playSource});
    } catch(e) {res.status(502).json({error:'歌单加载失败: '+e.message});}
  });
  router.get('/admin/presets',adminAuth,(req,res) => {
    res.json({presets:loadPresets(),current:config.playlistId || 0,currentByPlatform:currentIds()});
  });
  router.get('/admin/playlist-search',adminAuth,async(req,res) => {
    const keyword = String(req.query.keyword || '').trim();
    const platform = platformOf(req.query.platform);
    if (!keyword || keyword.length > 100) return res.status(400).json({error:'请输入 1–100 个字符的歌单名称'});
    try {res.json({playlists:(await (platform === 'qq' ? qq : netease).searchPlaylists(keyword)).map(p => ({...p,platform}))});}
    catch(e) {res.status(502).json({error:'歌单搜索失败: '+e.message});}
  });
  router.post('/admin/presets',adminAuth,async(req,res) => {
    const platform = platformOf(req.body && req.body.platform);
    let id;
    try {id = await (platform === 'qq' ? qqPlaylistId : playlistId)(req.body && req.body.playlistId);}
    catch(e) {return res.status(400).json({error:e.message});}
    try {
      const pl = await loadPlaylist(platform,id);
      const presets = loadPresets();
      if (!presets.some(p => Number(p.id) === id && p.platform === platform)) {
        presets.push({id,name:pl.name || `歌单 ${id}`,platform}); savePresets(presets);
      }
      res.json({ok:true,name:pl.name,presets});
    } catch(e) {res.status(502).json({error:'歌单加载失败: '+e.message});}
  });
  router.delete('/admin/presets/:playlistId',adminAuth,(req,res) => {
    const id = Number(req.params.playlistId), platform = platformOf(req.query.platform);
    const presets = loadPresets().filter(p => Number(p.id) !== id || p.platform !== platform);
    savePresets(presets); res.json({ok:true,presets});
  });
  router.get('/admin/playlist',adminAuth,async(req,res) => {
    if (!req.query.platform) return res.json({meta:state.playlistMeta(),songs:state.playlist.songs.slice(0,50)});
    const platform = platformOf(req.query.platform), id = currentIds()[platform];
    if (state.playSource === (platform === 'qq' ? 'qq-playlist' : 'playlist') && Number(state.playlist.id) === id && state.playlist.platform === platform) return res.json({meta:state.playlistMeta(),songs:state.playlist.songs.slice(0,50)});
    try {
      const pl = await loadPlaylist(platform,id);
      res.json({meta:{id,name:pl.name,platform,count:pl.songs.length,index:-1},songs:pl.songs.slice(0,50)});
    } catch(e) {res.status(502).json({error:'歌单加载失败: '+e.message});}
  });

  /** GET /api/admin/audio-devices 查询 mpv 可用音频设备 */
  router.get('/admin/audio-devices', adminAuth, (req, res) => {
    player.enumerateDevices( (err, stdout, stderr) => {
      const out = (stderr || stdout || '').toString();
      const devices = [];
      const re = /^\s*'([^']+)'\s*\(([^)]*)\)/gm;
      let m;
      while ((m = re.exec(out))) {
        devices.push({ id: m[1], label: m[2] || m[1] });
      }
      res.json({ current: config.audioDevice || 'auto', devices });
    });
  });

  /** POST /api/admin/audio-device {device} 切换音频设备（运行时生效 + 持久化到 config.local.js） */
  router.post('/admin/audio-device', adminAuth, (req, res) => {
    const device = (req.body && req.body.device) || '';
    player.setAudioDevice(device === 'auto' ? '' : device);
    // 持久化到 config.local.js（保留其他配置）
    const cfgPath = require('./paths').configPath;
    try {
      if (fs.existsSync(cfgPath)) {
        let content = fs.readFileSync(cfgPath, 'utf8');
        content = content.replace(/(audioDevice:\s*')[^']*(')/, `$1${device === 'auto' ? '' : device}$2`);
        fs.writeFileSync(cfgPath, content);
      }
    } catch (e) {
      // 持久化失败不阻塞运行时切换
    }
    broadcast();
    res.json({ ok: true, current: config.audioDevice || 'auto' });
  });

  /** GET /api/admin/play-source 当前播放源 */
  router.get('/admin/play-source', adminAuth, (req, res) => {
    res.json({ playSource: state.playSource, qqChartId: config.qqChartId || 26 });
  });

  /** GET /api/admin/users 用户名单（昵称/IP/活跃/队列数） */
  router.get('/admin/users', adminAuth, (req, res) => {
    res.json({ users: users.list(state.userQueue) });
  });

  /** GET /api/admin/logs?limit= 系统日志（最近N条，最新在前） */
  router.get('/admin/logs', adminAuth, (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    res.json({ logs: logger.readRecent(limit) });
  });

  /** POST /api/admin/restart 重启服务（先落盘，再平滑重启） */
  router.post('/admin/restart', adminAuth, (req, res) => {
    if (!system || !system.restart) return res.status(500).json({ error: '重启功能不可用' });
    res.json({ ok: true, message: '服务重启中，请稍后刷新页面' });
    setTimeout(() => system.restart(), 500);
  });

  /** POST /api/admin/shutdown 关闭服务（先落盘） */
  router.post('/admin/shutdown', adminAuth, (req, res) => {
    if (!system || !system.shutdown) return res.status(500).json({ error: '关闭功能不可用' });
    res.json({ ok: true, message: '服务已关闭' });
    setTimeout(() => system.shutdown(), 500);
  });

  /** POST /api/admin/play-source {mode:'playlist'|'fm'} 切换播放源（运行时生效 + 持久化） */
  router.post('/admin/play-source', adminAuth, (req, res) => {
    const requested = req.body && req.body.mode;
    const mode = ['playlist', 'fm', 'qq-playlist', 'qq-radar'].includes(requested) ? requested : 'playlist';
    (async () => {
      try {
        if (mode === 'playlist') {
          const pl = await netease.getPlaylistCached(config.playlistId || 3778678);
          state.setPlaylist(pl.id, pl.name, pl.songs, 'netease');
        } else if (mode === 'qq-playlist') {
          const pl = await qq.getBackgroundPlaylist();
          state.setPlaylist(pl.id, pl.name, pl.songs, 'qq');
        } else if (mode === 'fm') {
          state.setPlaylist(0, '网易云心动FM', [], 'netease');
        } else {
          state.setPlaylist(99, 'QQ音乐私人雷达', [], 'qq');
        }

        state.setPlaySource(mode);
        config.fmMode = mode === 'fm'; // 兼容旧配置；实际播放源同时随状态快照保存
        const cfgPath = require('./paths').configPath;
        try {
          if (fs.existsSync(cfgPath)) {
            let content = fs.readFileSync(cfgPath, 'utf8');
            content = content.replace(/(fmMode:\s*)(true|false)/, `$1${mode === 'fm'}`);
            fs.writeFileSync(cfgPath, content);
          }
        } catch (e) {
          // 持久化失败不阻塞运行时切换
        }
        broadcast();
        if (player.isPlaying() && !player.manualPaused) playNext(); // 只在已有播放循环中立即切源；启动默认暂停时不自动开播
        const labels = {
          playlist: '网易云默认歌单',
          fm: '网易云心动FM',
          'qq-playlist': 'QQ音乐歌单',
          'qq-radar': 'QQ音乐私人雷达',
        };
        logger.log('action', `管理员切换播放源：${labels[mode]}`, 'admin');
        res.json({ ok: true, playSource: state.playSource, qqChartId: config.qqChartId || 26 });
      } catch (e) {
        res.status(502).json({ error: '播放源切换失败: ' + e.message });
      }
    })();
  });

  return router;
}

module.exports = createRouter;
