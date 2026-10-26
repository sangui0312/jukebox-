/**
 * 对 NeteaseCloudMusicApi 独立进程的 HTTP 封装（Node 18+ 原生 fetch）
 * 仅搬运"歌的身份证"（songId + 展示元数据），音频 URL 只在播放瞬间实时获取。
 */
const config = require('./config');

let searchCache = new Map(); // keyword -> { expire, data }

function api(path) {
  return `${config.neteaseApiBase}${path}`;
}

function headers() {
  return config.neteaseCookie ? { Cookie: config.neteaseCookie } : {};
}

async function getJson(path, opts = {}) {
  // 搜索等公开接口匿名请求（避免触发网易云对登录态的搜索频率风控 405）
  const useCookie = opts.auth !== false;
  const timeout = AbortSignal.timeout(10000);
  const res = await fetch(api(path), { headers: useCookie ? headers() : {}, signal: opts.signal ? AbortSignal.any([timeout,opts.signal]) : timeout });
  if (!res.ok) throw new Error(`API ${path} -> HTTP ${res.status}`);
  return res.json();
}

function mapSearchSong(s) {
  const ar = s.ar || s.artists || [];
  const al = s.al || s.album || {};
  // 网易云接口时长统一为毫秒（dt），转成秒存储
  const ms = s.dt != null ? s.dt : s.duration != null ? s.duration : 0;
  return {
    songId: s.id,
    name: s.name || '',
    artists: (Array.isArray(ar) ? ar : []).map((a) => a.name),
    album: al.name || '',
    cover: al.picUrl || '',
    duration: Math.round(ms / 1000),
  };
}

/**
 * 带 405 风控自动降级的搜索请求：
 * 网易云对 /search 有动态频率风控（可能针对账号或匿名 IP），
 * 先带 cookie（VIP 账号配额更宽），若 405 则匿名重试一次，仍失败则抛错。
 */
async function searchWithFallback(keyword, limit) {
  const path = `/search?keywords=${encodeURIComponent(keyword)}&limit=${limit}`;
  try {
    return await getJson(path); // 带 cookie
  } catch (e1) {
    if (String(e1.message).includes('405')) {
      try {
        return await getJson(path, { auth: false }); // 账号被限 → 匿名
      } catch (e2) {
        throw new Error('搜索被网易云限流（账号与匿名均 405），请稍后再试');
      }
    }
    throw e1;
  }
}

/** 搜索（30 秒内存缓存；搜索接口不带封面，用 song/detail 批量补全） */
async function search(keyword, limit = 30) {
  const key = `${keyword}:${limit}`;
  const hit = searchCache.get(key);
  if (hit && Date.now() < hit.expire) return hit.data;

  const json = await searchWithFallback(keyword, limit);
  const songs = (json.result && json.result.songs || []).map(mapSearchSong);

  // 新版搜索接口不返回 al.picUrl，批量调 song/detail 补封面
  if (songs.length > 0) {
    try {
      const ids = songs.map((s) => s.songId).join(',');
      const det = await getJson(`/song/detail?ids=${ids}`);
      const coverMap = new Map((det.songs || []).map((d) => [d.id, (d.al && d.al.picUrl) || '']));
      for (const s of songs) {
        if (!s.cover && coverMap.get(s.songId)) s.cover = coverMap.get(s.songId);
      }
    } catch (e) {
      // 封面补全失败不影响搜索
    }
  }

  const data = { songs };
  searchCache.set(key, { expire: Date.now() + config.searchCacheMs, data });
  if (searchCache.size > 500) searchCache.clear();
  return data;
}

/** 单曲详情（点歌时校验存在性 + 取展示信息） */
async function getSongDetail(songId) {
  const json = await getJson(`/song/detail?ids=${songId}`);
  const s = json.songs && json.songs[0];
  if (!s) throw new Error('song not found');
  return mapSearchSong(s);
}

/** 实时取音源 URL（播放瞬间调用） */
async function getSongUrl(songId, options = {}) {
  const json = await getJson(`/song/url?id=${songId}`,options);
  const d = json.data && json.data[0];
  if (!d || !d.url) return null;
  return { url: d.url, freeTrial: !!d.freeTrialInfo, br: d.br };
}

/** 默认歌单全部歌曲（playlist/detail 直接返回完整 tracks） */
async function getPlaylist(id) {
  const json = await getJson(`/playlist/detail?id=${id}`);
  const pl = json.playlist;
  if (!pl) throw new Error('playlist not found');
  return {
    id: pl.id,
    name: pl.name || '',
    songs: (pl.tracks || []).map(mapSearchSong),
  };
}

// 歌单缓存（30 分钟，供用户前端"热歌榜"等入口使用，避免每次全量拉取）
let playlistCache = new Map();
async function getPlaylistCached(id) {
  const hit = playlistCache.get(id);
  if (hit && Date.now() < hit.expire) return hit.data;
  const data = await getPlaylist(id);
  playlistCache.set(id, { expire: Date.now() + 30 * 60 * 1000, data });
  if (playlistCache.size > 50) playlistCache.clear();
  return data;
}

/** 按名称搜索公开网易云歌单 */
async function searchPlaylists(keyword) {
  const json = await getJson(`/search?keywords=${encodeURIComponent(keyword)}&type=1000&limit=20`, { auth: false });
  if (json.code !== 200) throw new Error('歌单搜索暂不可用，请稍后重试');
  return (json.result?.playlists || []).map(item => ({ id: item.id, name: item.name, creator: item.creator?.nickname || '', count: item.trackCount || 0 }));
}

/** 心动FM（私人FM）：按用户口味推荐，每次返回少量歌曲 */
async function getFmSongs(options = {}) {
  const json = await getJson('/personal_fm',options);
  return (json.data || []).map(mapSearchSong);
}

module.exports = { search, getSongDetail, getSongUrl, getPlaylist, getPlaylistCached, getFmSongs, searchPlaylists };
