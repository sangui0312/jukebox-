/**
 * 全局状态单例：双源模型
 *   - userQueue   插播区（用户点的歌，FIFO，先点先播）
 *   - playlist    默认歌单（背景音乐，列表循环）
 *   - playSource  'playlist'（网易云歌单）| 'fm'（网易云心动FM）| 'qq-playlist' | 'qq-radar'
 * 取歌规则：插播区非空优先播插播区；空了按当前播放源取下一首。
 */
const config = require('./config');
const users = require('./users');
const persistence = require('./persistence');
const channels = require('./channels');

/** Fisher-Yates 洗牌 */
function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

class State {
  constructor() {
    this.current = null; // queueItem | null（当前正在播放）
    this.userQueue = []; // queueItem[]
    this._onChange = null; // 状态变更回调（index.js 注册，用于动作触发的播放核算）
    this.playlist = {
      id: 0,
      name: '',
      platform: 'netease',
      songs: [], // queueItem[]
      order: [], // 随机播放顺序（Fisher-Yates 洗牌；播完一轮重新洗牌）
      index: -1, // 当前播到第几首（-1 = 未开始）
    };
    this.playSource = config.fmMode ? 'fm' : 'playlist'; // 播放源
    this.fmQueue = []; // 心动FM 已拉取的推荐歌曲缓存
    this.qqRadarQueue = []; // QQ 私人雷达已拉取的推荐歌曲缓存
    this.channels = channels.load(); // 平台渠道开关 {netease, qq}
    this.skipVotes = new Map(); // 当前歌曲的跳过投票：clientId -> nickname
    this.skipRequired = config.skipRequired; // 投票跳过所需票数
    this.playback = {
      queueTotalSec: 0, // 插播区总时长（秒）
      currentPos: null, // 当前播放位置（秒，无播放=null）
      totalRemainSec: 0, // 距队列播完剩余秒数（含当前曲剩余）
      estimatedEndAt: null, // 预计播完时刻（epoch ms）
      checkedAt: null, // 服务端核算时间
    };
    this.version = 0;
  }

  /** 更新播放核算（index.js 定期调用，不 bump 避免频繁落盘） */
  updatePlayback(p) {
    this.playback = { ...this.playback, ...p };
  }

  bump() {
    this.version++;
    persistence.schedule(() => this.snapshotForDisk()); // 状态变更自动落盘（防抖）
    if (this._onChange) this._onChange(); // 动作触发回调（播放核算等）
  }

  /** 注册状态变更回调（每次队列/播放被修改时调用） */
  setOnChange(fn) {
    this._onChange = fn;
  }

  /** 落盘数据（不含瞬时状态：投票/歌单歌曲本体） */
  snapshotForDisk() {
    return {
      userQueue: this.userQueue,
      current: this.current,
      playSource: this.playSource,
      users: users.toJSON(),
      savedAt: Date.now(),
    };
  }

  /** 启动恢复（重启后队列/用户/播放源原样恢复；当前歌曲由 index.js 重播） */
  restore(data) {
    if (!data) return;
    if (Array.isArray(data.userQueue)) this.userQueue = data.userQueue;
    if (data.current) this.current = data.current;
    if (['playlist', 'fm', 'qq-playlist', 'qq-radar'].includes(data.playSource)) this.playSource = data.playSource;
    users.restore(data.users);
    let recovered = false;
    // Recover only missing names from actual song requests, never replace a
    // saved explicit rename or invent a name for an IP address.
    for (const song of [...this.userQueue].reverse().concat(this.current || [])) {
      const user = users.get(song.requestedBy);
      if (user && !user.nickname && typeof song.nickname === 'string' && song.nickname.trim() && song.nickname !== '匿名') {
        users.setNickname(song.requestedBy, song.nickname.trim().slice(0, 12));
        recovered = true;
      }
    }
    // 统一历史昵称 + 旧数据补 platform（多平台改造前点的歌默认 netease）
    for (const s of this.userQueue) {
      if (!s.platform) s.platform = 'netease';
      const u = users.get(s.requestedBy);
      if (u && u.nickname) s.nickname = u.nickname;
    }
    if (this.current && !this.current.platform) this.current.platform = 'netease';
    if (recovered) this.bump();
  }

  playlistMeta() {
    return {
      id: this.playlist.id,
      name: this.playlist.name,
      platform: this.playlist.platform || 'netease',
      count: this.playlist.songs.length,
      index: this.playlist.index,
    };
  }

  snapshot() {
    return {
      current: this.current,
      // 附带 canonicalId（合并身份）与顶歌数据，供前端判断"我点的/顶过"
      userQueue: this.userQueue.map((s) => ({
        ...s,
        canonicalId: users.canonicalOf(s.requestedBy),
        boostCount: (s.boosts || []).length,
        boostVoters: s.boosts || [],
      })),
      playlistMeta: this.playlistMeta(),
      playSource: this.playSource,
      skip: {
        votes: this.skipVotes.size,
        required: this.skipRequired,
        voters: [...this.skipVotes.keys()],
      },
      boostRequired: config.boostRequired,
      queueLimits: { maxPerUser: config.maxPerUser, maxUserQueue: config.maxUserQueue },
      channels: this.channels,
      playback: this.playback,
      playbackControl: this.playbackControl,
      version: this.version,
    };
  }

  /** 顶歌：同一 IP（canonicalId）对同一首歌只能顶一次；达到阈值升到队列第一 */
  addBoost(clientId, platform, songId) {
    const canonicalId = users.canonicalOf(clientId);
    const idx = this.userQueue.findIndex(
      (s) => s.platform === platform && String(s.songId) === String(songId)
    );
    if (idx === -1) return { ok: false, error: '队列中无此歌', code: 404 };
    const item = this.userQueue[idx];
    item.boosts = item.boosts || [];
    if (item.boosts.includes(canonicalId)) {
      return { ok: false, error: '你已经顶过这首歌了', already: true };
    }
    item.boosts.push(canonicalId);
    const count = item.boosts.length;
    let promoted = false;
    if (count >= config.boostRequired && idx !== 0) {
      // 达到阈值：升到队列第一（下一首）
      this.userQueue.splice(idx, 1);
      this.userQueue.unshift(item);
      promoted = true;
    }
    this.bump();
    return { ok: true, count, required: config.boostRequired, promoted };
  }

  /** 投票跳过当前歌曲（同一身份对同一首歌只算一票；合并后的号共享票权） */
  addSkipVote(clientId, nickname) {
    if (!this.current) return { ok: false, error: '当前没有播放中的歌曲' };
    const canonicalId = users.canonicalOf(clientId);
    if (this.skipVotes.has(canonicalId)) return { ok: false, error: '你已经投过票了', already: true };
    this.skipVotes.set(canonicalId, nickname || '匿名');
    const votes = this.skipVotes.size;
    const shouldSkip = votes >= this.skipRequired;
    this.bump();
    return { ok: true, votes, required: this.skipRequired, shouldSkip };
  }

  /** 当前曲目切换时清空投票 */
  clearSkipVotes() {
    if (this.skipVotes.size > 0) this.skipVotes.clear();
  }

  /** 修改跳过所需票数（管理端） */
  setSkipRequired(n) {
    this.skipRequired = Math.max(1, Math.min(100, Number(n) || 8));
    this.bump();
  }

  /** 插播点歌（每人限 maxPerUser 首，插播区上限 maxUserQueue；合并后的号共享限额） */
  addUserSong(item) {
    if (this.userQueue.length >= config.maxUserQueue) {
      return { ok: false, error: `插播区已满（上限${config.maxUserQueue}首）` };
    }
    const canonicalId = users.canonicalOf(item.requestedBy);
    const userCount = this.userQueue.filter((s) => users.canonicalOf(s.requestedBy) === canonicalId).length;
    if (userCount >= config.maxPerUser) {
      return { ok: false, error: `每人最多点${config.maxPerUser}首（你已点${userCount}首）` };
    }
    // 同一首歌（同平台同 songId）在"队列 + 正在播放"中只能有一首：已存在则拒绝
    const sameSong = (s) =>
      s && s.platform === item.platform && String(s.songId) === String(item.songId);
    if (this.current && sameSong(this.current)) {
      return { ok: false, error: '这首歌正在播放中，暂时不能重复点歌' };
    }
    if (this.userQueue.some(sameSong)) {
      return { ok: false, error: '这首歌已经在队列里了，不用重复点' };
    }
    this.userQueue.push(item);
    this.bump();
    return { ok: true, duplicate: false };
  }

  /** 删歌（仅本人；合并后的号互相可删） */
  removeUserSong(platform, songId, clientId) {
    const idx = this.userQueue.findIndex(
      (s) => s.platform === platform && String(s.songId) === String(songId)
    );
    if (idx === -1) return { ok: false, error: '插播区无此歌', code: 404 };
    if (users.canonicalOf(this.userQueue[idx].requestedBy) !== users.canonicalOf(clientId)) {
      return { ok: false, error: '只能删除自己点的歌', code: 403 };
    }
    this.userQueue.splice(idx, 1);
    this.bump();
    return { ok: true };
  }

  /** 修改昵称：同步用户表 + 队列里该用户（含合并号）的所有歌 */
  updateNickname(clientId, nickname) {
    const changed = users.get(clientId)?.nickname !== nickname;
    const canonicalId = users.setNickname(clientId, nickname);
    let updated = 0;
    for (const s of this.userQueue) {
      if (users.canonicalOf(s.requestedBy) === canonicalId && s.nickname !== nickname) {
        s.nickname = nickname;
        updated++;
      }
    }
    if (changed || updated > 0) this.bump();
    return { ok: true, updated };
  }

  /** 管理员删任意歌（跳过归属校验） */
  adminRemoveUserSong(platform, songId) {
    const idx = this.userQueue.findIndex(
      (s) => s.platform === platform && String(s.songId) === String(songId)
    );
    if (idx === -1) return { ok: false, error: '插播区无此歌', code: 404 };
    this.userQueue.splice(idx, 1);
    this.bump();
    return { ok: true };
  }

  /** 管理员移动队列歌曲（from → to 位置，0 = 下一首） */
  moveUserSong(from, to) {
    const len = this.userQueue.length;
    if (!len) return { ok: false, error: '插播区为空' };
    if (from < 0 || from >= len || to < 0 || to >= len || from === to) {
      return { ok: false, error: '无效的移动位置' };
    }
    const [item] = this.userQueue.splice(from, 1);
    this.userQueue.splice(to, 0, item);
    this.bump();
    return { ok: true, item };
  }

  /** 管理员清空插播区 */
  clearUserQueue() {
    const n = this.userQueue.length;
    this.userQueue = [];
    if (n > 0) this.bump();
    return { ok: true, removed: n };
  }

  /**
   * 取下一首（唯一规则，所有入口共用）
   * @returns {{item?: object, needFm?: boolean, needQqRadar?: boolean, empty?: boolean}}
   *   item 有歌可播；needFm/needQqRadar 表示推荐队列为空，需要异步拉取后重试
   */
  nextSong() {
    if (this.userQueue.length > 0) {
      const item = this.userQueue.shift();
      this.bump();
      return { item };
    }
    if (this.playSource === 'fm') {
      if (this.fmQueue.length > 0) {
        const item = this.fmQueue.shift();
        this.bump();
        return { item };
      }
      return { needFm: true };
    }
    if (this.playSource === 'qq-radar') {
      if (this.qqRadarQueue.length > 0) {
        const item = this.qqRadarQueue.shift();
        this.bump();
        return { item };
      }
      return { needQqRadar: true };
    }
    if (this.playlist.songs.length > 0) {
      // 随机播放：本轮洗牌播完（order 空）后重新洗牌
      if (this.playlist.order.length === 0) {
        this.playlist.order = shuffleArray(this.playlist.songs.slice());
      }
      const item = this.playlist.order.shift();
      this.playlist.index++;
      this.bump();
      return { item };
    }
    return { empty: true };
  }

  /** 设置默认歌单 */
  setPlaylist(id, name, songs, platform = 'netease') {
    this.playlist = { id, name, platform: platform === 'qq' ? 'qq' : 'netease', songs, order: [], index: -1 };
    this.bump();
  }

  /** 切换播放源：'playlist' | 'fm' | 'qq-playlist' | 'qq-radar' */
  setPlaySource(mode) {
    this.playSource = ['playlist', 'fm', 'qq-playlist', 'qq-radar'].includes(mode) ? mode : 'playlist';
    this.bump();
  }

  /** 填充心动FM 推荐歌曲到缓存 */
  fillFm(songs) {
    const seen = new Set(this.fmQueue.map((s) => s.songId));
    for (const s of songs) {
      if (s && s.songId && !seen.has(s.songId)) {
        this.fmQueue.push(s);
        seen.add(s.songId);
      }
    }
    this.bump();
  }

  /** 填充 QQ 私人雷达推荐歌曲缓存。 */
  fillQqRadar(songs) {
    const seen = new Set(this.qqRadarQueue.map((s) => String(s.songId)));
    for (const song of songs) {
      if (song && song.songId && !seen.has(String(song.songId))) {
        this.qqRadarQueue.push({ ...song, platform: 'qq' });
        seen.add(String(song.songId));
      }
    }
    this.bump();
  }
}

module.exports = new State();
