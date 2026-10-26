/**
 * 多平台音乐服务分发层
 * platform: 'netease' | 'qq'；默认 netease
 */
const netease = require('./netease');
const qq = require('./qq');

const PROVIDERS = { netease, qq };

function provider(platform) {
  return PROVIDERS[platform === 'qq' ? 'qq' : 'netease'];
}

/** 搜索：统一返回 { songs: [{platform, songId, name, artists, album, cover, duration}] } */
async function search(platform, keyword, limit = 30) {
  const p = provider(platform);
  const data = await p.search(keyword, limit);
  const pname = platform === 'qq' ? 'qq' : 'netease';
  data.songs = (data.songs || []).map((s) => ({ ...s, platform: pname }));
  return data;
}

/** 单曲详情 */
async function getSongDetail(platform, songId) {
  const p = provider(platform);
  const item = await p.getSongDetail(songId);
  return { platform: platform === 'qq' ? 'qq' : 'netease', ...item };
}

/** 实时音源 URL */
async function getSongUrl(platform, songId, options) {
  return provider(platform).getSongUrl(songId, options);
}

module.exports = { search, getSongDetail, getSongUrl };
