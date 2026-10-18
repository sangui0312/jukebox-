<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import {
  adminLogin, adminStatus, adminPause, adminVolume, adminRemove, adminClear,
  adminSetPlaylist, adminGetPlaylist, adminGetPresets, adminAddPreset, adminRemovePreset, adminSearchPlaylists,
  adminAudioDevices, adminSetAudioDevice,
  adminSetPlaySource, adminSkip, adminSetSkipConfig, adminSetBoostConfig, adminGetUsers, adminGetLogs, adminRestart, adminShutdown,
  adminSetChannels, adminSetCookie, adminGetCookieStatus, adminMoveQueue, adminPlayNow,
  adminSetControlSettings,
  adminGetSchedules, adminAddSchedule, adminSetScheduleEnabled, adminDeleteSchedule,
} from '../api';
import { search, queueSong } from '../api';
import { connectSocket } from '../socket';

const authed = ref(false);
const keyInput = ref('');
const loginError = ref('');
const toast = ref('');
let toastTimer = null;
const loc = window.location; // 页面地址（模板用，避免 location 被 Vue 当组件属性解析）

const status = ref(null);
const pausePending = ref(false);
let statusRefreshId = 0;
const queue = ref([]);
const playlist = ref({ meta: { name: '', count: 0 }, songs: [] });
const presets = ref([]);
const playlistPlatform = ref('netease');
const selectedPlaylistId = ref(0);
let playlistRefreshId = 0;
const playlistPlatformLabel = computed(() => playlistPlatform.value === 'qq' ? 'QQ音乐' : '网易云');
const newPlaylistId = ref('');
const playlistResults = ref([]);
const playlistBusy = ref(false);
const playlistSearched = ref(false);
const audioDevices = ref([]);
const audioCurrent = ref('auto');
const skipRequired = ref(8);
const boostRequired = ref(3);
const controlDraft = ref({ maxPerUser: 10, maxUserQueue: 300, autoStart: false, loudnessNormalization: true });
const controlReady = ref(false);
const controlDirty = ref(false);
const controlSaving = ref(false);
const users = ref([]);
const logs = ref([]);
const cookieStatus = ref(null);
const neteaseCookieInput = ref('');
const qqCookieInput = ref('');
const desktopLogin = !!window.musicLogin;
const platformLoginMessage = ref('');
let removeLoginListener;
const adminSearchPlatform = ref('netease');
const adminSearchKeyword = ref('');
const adminSearchResults = ref([]);
const adminSearching = ref(false);
const adminSearchError = ref('');
const adminQueueingSongId = ref('');
const scheduleDraftSong = ref(null);
const scheduleRecurrence = ref('daily');
const scheduleTime = ref('12:00');
const scheduleWeekdays = ref([1]);
const schedules = ref([]);
const scheduleSaving = ref(false);
const WEEKDAYS = [
  { value: 1, label: '一' },
  { value: 2, label: '二' },
  { value: 3, label: '三' },
  { value: 4, label: '四' },
  { value: 5, label: '五' },
  { value: 6, label: '六' },
  { value: 0, label: '日' },
];
const PLAY_SOURCE_INFO = {
  playlist: { label: '网易云歌单', provider: '网易云' },
  fm: { label: '心动 FM', provider: '网易云' },
  'qq-playlist': { label: 'QQ歌单', provider: 'QQ音乐' },
  'qq-radar': { label: 'QQ 私人雷达', provider: 'QQ音乐' },
};
let socket = null;

function showToast(msg) {
  toast.value = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = ''), 2500);
}

async function doLogin() {
  loginError.value = '';
  try {
    await adminLogin(keyInput.value.trim());
    sessionStorage.setItem('jukebox_admin_key', keyInput.value.trim());
    authed.value = true;
    refreshAll();
    refreshPresets();
    refreshAudioDevices();
    refreshLogs();
    refreshSchedules();
  } catch (e) {
    loginError.value = e.message;
  }
}

async function refreshAll() {
  try {
    const refreshId = ++statusRefreshId;
    const nextStatus = await adminStatus();
    if (refreshId !== statusRefreshId) return;
    status.value = nextStatus;
    if (nextStatus.controlSettings && !controlDirty.value && !controlSaving.value) {
      controlDraft.value = { ...nextStatus.controlSettings };
      controlReady.value = true;
    }
    queue.value = status.value.userQueue || [];
    if (status.value.skip?.required) skipRequired.value = status.value.skip.required;
    if (status.value.boostRequired) boostRequired.value = status.value.boostRequired;
    users.value = (await adminGetUsers()).users || [];
  } catch (e) {
    showToast(e.message);
  }
}

const adminSearchEnabled = computed(() => status.value?.channels?.[adminSearchPlatform.value] !== false);

async function saveControlSettings() {
  if (controlSaving.value || !controlReady.value) return;
  const settings = { ...controlDraft.value };
  if (!Number.isInteger(settings.maxPerUser) || settings.maxPerUser < 1 || settings.maxPerUser > 300 ||
      !Number.isInteger(settings.maxUserQueue) || settings.maxUserQueue < 1 || settings.maxUserQueue > 3000) {
    return showToast('请输入范围内的整数：每人 1–300 首，点歌区 1–3000 首');
  }
  controlSaving.value = true;
  try {
    const result = await adminSetControlSettings(settings);
    controlDraft.value = { ...result.settings };
    controlDirty.value = false;
    showToast('控制设置已保存');
    await refreshAll();
  } catch (error) { showToast(error.message); }
  finally { controlSaving.value = false; }
}

function resetControlSettings() {
  if (!status.value?.controlSettings) return;
  controlDraft.value = { ...status.value.controlSettings };
  controlDirty.value = false;
}

async function doAdminSearch() {
  const keyword = adminSearchKeyword.value.trim();
  if (!keyword) return showToast('请输入歌曲或歌手');
  if (!adminSearchEnabled.value) return showToast('该平台渠道已关闭');
  adminSearching.value = true;
  adminSearchError.value = '';
  try {
    const r = await search(keyword, 30, adminSearchPlatform.value);
    adminSearchResults.value = r.songs || [];
    if (!adminSearchResults.value.length) adminSearchError.value = '无搜索结果';
  } catch (e) {
    adminSearchResults.value = [];
    adminSearchError.value = e.message;
  } finally {
    adminSearching.value = false;
  }
}

function switchAdminSearchPlatform(platform) {
  adminSearchPlatform.value = platform;
  adminSearchResults.value = [];
  adminSearchError.value = '';
}

function fmtSearchDuration(sec) {
  if (!sec) return '';
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
}

async function doAdminQueue(song) {
  if (adminQueueingSongId.value) return;
  adminQueueingSongId.value = song.songId;
  try {
    await queueSong(song.songId, '管理员', song.platform || adminSearchPlatform.value);
    showToast(`已点歌：${song.name}`);
    await refreshAll();
  } catch (e) {
    showToast(e.message);
  } finally {
    adminQueueingSongId.value = '';
  }
}

function selectScheduleSong(song) {
  scheduleDraftSong.value = { ...song, platform: song.platform || adminSearchPlatform.value };
  scheduleRecurrence.value = 'daily';
  scheduleTime.value = '12:00';
  scheduleWeekdays.value = [1];
}

function clearScheduleDraft() {
  scheduleDraftSong.value = null;
}

async function refreshSchedules() {
  try {
    schedules.value = (await adminGetSchedules()).schedules || [];
  } catch (e) {
    showToast(e.message);
  }
}

async function doSaveSchedule() {
  if (!scheduleDraftSong.value) return showToast('请先选择歌曲');
  if (!/^\d{2}:\d{2}$/.test(scheduleTime.value)) return showToast('请选择播放时间');
  if (scheduleRecurrence.value === 'weekly' && !scheduleWeekdays.value.length) {
    return showToast('每周任务至少选择一天');
  }
  scheduleSaving.value = true;
  try {
    await adminAddSchedule({
      song: scheduleDraftSong.value,
      recurrence: scheduleRecurrence.value,
      time: scheduleTime.value,
      weekdays: scheduleWeekdays.value,
    });
    showToast('定时播放已添加');
    clearScheduleDraft();
    await refreshSchedules();
  } catch (e) {
    showToast(e.message);
  } finally {
    scheduleSaving.value = false;
  }
}

async function doToggleSchedule(task) {
  try {
    await adminSetScheduleEnabled(task.id, !task.enabled);
    await refreshSchedules();
  } catch (e) {
    showToast(e.message);
  }
}

async function doDeleteSchedule(task) {
  if (!confirm(`删除定时播放《${task.name}》？`)) return;
  try {
    await adminDeleteSchedule(task.id);
    showToast('定时任务已删除');
    await refreshSchedules();
  } catch (e) {
    showToast(e.message);
  }
}

function scheduleWeekdaysLabel(task) {
  if (task.recurrence === 'daily') return '每天';
  return `每周${(task.weekdays || []).map((day) => WEEKDAYS.find((item) => item.value === day)?.label || '').filter(Boolean).join('、')}`;
}

async function refreshLogs() {
  try {
    logs.value = (await adminGetLogs(200)).logs || [];
  } catch (e) {
    /* 忽略 */
  }
}

async function refreshCookieStatus() {
  try {
    cookieStatus.value = await adminGetCookieStatus();
  } catch (e) {
    /* 忽略 */
  }
}

async function doPlatformLogin(platform) {
  try {
    await window.musicLogin.open(platform, sessionStorage.getItem('jukebox_admin_key') || '');
  } catch (e) { showToast(e.message); }
}

// 保存平台 Cookie（管理端直接填写）
async function doSaveCookie(platform) {
  const cookie = platform === 'qq' ? qqCookieInput.value : neteaseCookieInput.value;
  if (!cookie.trim()) return showToast('请粘贴 Cookie');
  try {
    await adminSetCookie(platform, cookie);
    showToast(platform === 'qq' ? 'QQ音乐 Cookie 已保存' : '网易云 Cookie 已保存');
    if (platform === 'qq') qqCookieInput.value = '';
    setTimeout(refreshCookieStatus, 1500);
  } catch (e) {
    showToast(e.message);
  }
}

// 开/关渠道
async function doToggleChannel(platform, enabled) {
  const name = platform === 'qq' ? 'QQ音乐' : '网易云';
  if (!confirm(`${enabled ? '开启' : '关闭'}${name}渠道？（关闭后用户端搜索/点歌显示维护中）`)) return;
  try {
    await adminSetChannels(platform, enabled);
    showToast(`${name}渠道已${enabled ? '开启' : '关闭'}`);
    refreshAll();
    refreshCookieStatus();
  } catch (e) {
    showToast(e.message);
  }
}

function fmtLogTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const LEVEL_STYLE = {
  info: 'text-slate-300',
  warn: 'text-amber-400',
  error: 'text-red-400',
  action: 'text-indigo-300',
};

async function refreshPresets() {
  const platform = playlistPlatform.value;
  const refreshId = ++playlistRefreshId;
  try {
    const [r, currentPlaylist] = await Promise.all([adminGetPresets(platform), adminGetPlaylist(platform)]);
    if (refreshId !== playlistRefreshId || platform !== playlistPlatform.value) return;
    presets.value = (r.presets || []).filter(p => (p.platform || 'netease') === platform);
    selectedPlaylistId.value = r.currentByPlatform?.[platform] ?? (platform === 'netease' ? r.current : 0);
    playlist.value = currentPlaylist;
  } catch (e) {
    if (refreshId === playlistRefreshId) showToast(e.message);
  }
}

function changePlaylistPlatform(platform) {
  if (playlistBusy.value || platform === playlistPlatform.value) return;
  playlistPlatform.value = platform;
  presets.value = [];
  playlist.value = { meta: { name: '', count: 0 }, songs: [] };
  newPlaylistId.value = '';
  playlistResults.value = [];
  playlistSearched.value = false;
  refreshPresets();
}

function presetSelected(id) {
  return String(selectedPlaylistId.value) === String(id);
}

function presetActive(id) {
  return presetSelected(id) && status.value?.playSource === (playlistPlatform.value === 'qq' ? 'qq-playlist' : 'playlist');
}

// 点击预设歌单：切换当前播放歌单
async function doSwitchPreset(id) {
  if (playlistBusy.value) return;
  playlistBusy.value = true;
  try {
    const r = await adminSetPlaylist(id, playlistPlatform.value);
    showToast(`已切换：${r.name}（${r.count} 首）`);
    await Promise.all([refreshAll(), refreshPresets()]);
  } catch (e) {
    showToast(e.message);
  } finally { playlistBusy.value = false; }
}

// 按名称搜索，或直接添加分享链接/ID
async function doFindPlaylist() {
  const input = newPlaylistId.value.trim();
  if (!input || playlistBusy.value) return;
  playlistResults.value = [];
  playlistSearched.value = false;
  if (/^\d+$/.test(input) || /https?:\/\//i.test(input)) return doAddPreset(input);
  playlistBusy.value = true;
  try {
    const result = await adminSearchPlaylists(input, playlistPlatform.value);
    playlistResults.value = result.playlists || [];
    playlistSearched.value = true;
  } catch (e) { showToast(e.message); }
  finally { playlistBusy.value = false; }
}

async function doAddPreset(id) {
  if (playlistBusy.value) return;
  playlistBusy.value = true;
  try {
    const r = await adminAddPreset(id, playlistPlatform.value);
    showToast(`已添加：${r.name}`);
    newPlaylistId.value = '';
    playlistResults.value = [];
    playlistSearched.value = false;
    refreshPresets();
  } catch (e) {
    showToast(e.message);
  } finally { playlistBusy.value = false; }
}

// 删除预设歌单
async function doRemovePreset(id) {
  if (!confirm('从预设列表删除这个歌单？（不影响当前播放）')) return;
  try {
    await adminRemovePreset(id, playlistPlatform.value);
    showToast('已删除预设');
    refreshPresets();
  } catch (e) {
    showToast(e.message);
  }
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtUptime(sec) {
  if (!sec) return '-';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}小时${m}分` : `${m}分钟`;
}

async function refreshAudioDevices() {
  try {
    const r = await adminAudioDevices();
    audioDevices.value = r.devices;
    audioCurrent.value = r.current;
  } catch (e) {
    showToast(e.message);
  }
}

async function doSetAudioDevice(device) {
  try {
    const r = await adminSetAudioDevice(device);
    audioCurrent.value = r.current;
    showToast(device === 'auto' ? '已切回系统默认' : '音频设备已切换');
  } catch (e) {
    showToast(e.message);
  }
}

async function doSetPlaySource(mode) {
  try {
    const r = await adminSetPlaySource(mode);
    showToast(`已切换：${PLAY_SOURCE_INFO[mode]?.label || '默认歌单'}`);
    refreshAll();
  } catch (e) {
    showToast(e.message);
  }
}

async function doPause() {
  if (pausePending.value) return;
  pausePending.value = true;
  ++statusRefreshId;
  try {
    const running = !!status.value?.player?.running;
    // 未播放 → 点按钮表示"开始播放"；播放中 → 暂停/继续切换
    const target = running ? !status.value.player.paused : false;
    const r = await adminPause(target);
    if (status.value) status.value.player.paused = r.paused;
    if (!running && !target) {
      showToast('已开始播放');
      setTimeout(refreshAll, 600);
    } else {
      showToast(target ? '已暂停' : '已继续');
    }
    await refreshAll();
  } catch (e) {
    showToast(e.message);
  } finally {
    pausePending.value = false;
  }
}

async function doVolume(v) {
  try {
    const r = await adminVolume(v);
    if (status.value) status.value.player.volume = r.volume; // 只更新音量字段
  } catch (e) {
    showToast(e.message);
  }
}

async function doSkip() {
  try {
    await adminSkip();
    showToast('已跳过');
    setTimeout(refreshAll, 500);
  } catch (e) {
    showToast(e.message);
  }
}

async function doSetSkipRequired() {
  const n = Number(skipRequired.value);
  if (!n || n < 1 || n > 100) return showToast('请输入 1-100 的票数');
  try {
    const r = await adminSetSkipConfig(n);
    showToast(`跳过条件已改为 ${r.required} 票`);
    refreshAll();
  } catch (e) {
    showToast(e.message);
  }
}

async function doSetBoostRequired() {
  const n = Number(boostRequired.value);
  if (!n || n < 1 || n > 100) return showToast('请输入 1-100 的次数');
  try {
    const r = await adminSetBoostConfig(n);
    showToast(`顶歌条件已改为 ${r.required} 次`);
    refreshAll();
  } catch (e) {
    showToast(e.message);
  }
}

async function doRestart() {
  if (!confirm('确定重启服务？队列与用户会自动保存并恢复。')) return;
  try {
    await adminRestart();
    showToast('服务重启中，约 5 秒后请刷新页面');
  } catch (e) {
    showToast(e.message);
  }
}

async function doShutdown() {
  if (!confirm('确定关闭服务？点歌机将停止工作（队列已自动保存）。')) return;
  try {
    await adminShutdown();
    showToast('服务已关闭');
  } catch (e) {
    showToast(e.message);
  }
}

async function doRemove(item) {
  try {
    await adminRemove(item.platform || 'netease', item.songId);
    showToast('已删除');
  } catch (e) {
    showToast(e.message);
  }
}

// 移动队列歌曲（上移/下移）
async function doMoveQueue(from, to) {
  try {
    await adminMoveQueue(from, to);
    refreshAll();
  } catch (e) {
    showToast(e.message);
  }
}

// 立即播放队列第 index 首
async function doPlayNow(index) {
  if (!confirm('立即播放这首？（当前歌曲会被切掉）')) return;
  try {
    await adminPlayNow(index);
    showToast('已设为下一首播放');
    setTimeout(refreshAll, 800);
  } catch (e) {
    showToast(e.message);
  }
}

async function doClear() {
  if (!confirm('确定清空插播区？')) return;
  try {
    await adminClear();
    showToast('已清空');
  } catch (e) {
    showToast(e.message);
  }
}

async function doSwitchPlaylist() {
  const id = Number(newPlaylistId.value);
  if (!id) return showToast('请输入歌单 ID');
  try {
    const r = await adminSetPlaylist(id, playlistPlatform.value);
    showToast(`已切换：${r.name}（${r.count} 首）`);
    newPlaylistId.value = '';
    refreshPresets();
  } catch (e) {
    showToast(e.message);
  }
}

const playing = computed(() => status.value?.current);
const activePlaySource = computed(() => PLAY_SOURCE_INFO[status.value?.playSource] || PLAY_SOURCE_INFO.playlist);

onMounted(() => {
  removeLoginListener = window.musicLogin?.onResult(message => {
    platformLoginMessage.value = message;
    refreshCookieStatus();
  });
  if (sessionStorage.getItem('jukebox_admin_key')) authed.value = true;
  socket = connectSocket(() => refreshAll());
  if (authed.value) {
    refreshAll();
    refreshPresets();
    refreshAudioDevices();
    refreshLogs();
    refreshSchedules();
    refreshCookieStatus();
  }
});

onUnmounted(() => { socket?.close(); removeLoginListener?.(); });
</script>

<template>
  <div class="admin-shell min-h-dvh">
    <div class="admin-frame mx-auto max-w-[1440px] p-6">
      <!-- 页头 -->
      <header class="admin-hero mb-6 flex items-center justify-between gap-8">
        <div class="admin-hero-copy">
          <p class="admin-eyebrow">● JUKEBOX · CONTROL ROOM</p>
          <h1>让音乐<br>开始流动<span>。</span></h1>
          <p class="admin-subtitle">播放控制、歌单与用户管理，都在这里轻松完成。</p>
          <div class="admin-tags" aria-label="管理台功能">
            <span>播放控制</span><span>双平台曲库</span><span>局域网共享</span>
          </div>
          <div class="admin-address">服务地址：<strong>{{ loc.protocol }}//{{ loc.host }}</strong></div>
        </div>
        <div class="admin-hero-aside">
          <div class="admin-orbit" aria-hidden="true"></div>
          <div class="admin-record" aria-hidden="true"><div class="admin-record-label"><b>JUKEBOX</b><i></i><small>SIDE A · GOOD TIMES</small></div></div>
          <span class="admin-spark" aria-hidden="true">✦</span>
          <div class="admin-record-caption"><span class="admin-equalizer" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>本页仅限管理员使用</div>
        </div>
      </header>

      <!-- 登录层 -->
      <div v-if="!authed" class="mx-auto mt-24 max-w-sm">
        <div class="admin-login-card rounded-xl border border-slate-700/50 bg-slate-800/60 p-6 shadow-xl">
          <h2 class="mb-1 text-lg font-semibold text-white">管理员登录</h2>
          <p class="mb-4 text-xs text-slate-500">输入管理口令进入控制台</p>
          <input
            v-model="keyInput"
            type="password"
            class="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2.5 text-white outline-none focus:border-indigo-500"
            placeholder="口令"
            @keyup.enter="doLogin"
          />
          <p v-if="loginError" class="mt-2 text-sm text-red-400">{{ loginError }}</p>
          <button
            class="mt-4 w-full rounded-lg bg-indigo-600 py-2.5 font-medium text-white hover:bg-indigo-500"
            @click="doLogin"
          >
            进入管理台
          </button>
        </div>
      </div>

      <template v-else>
        <!-- 顶部指标条 -->
        <div class="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <div class="rounded-xl border border-slate-700/50 bg-slate-800/60 p-3">
            <p class="text-xs text-slate-500">正在播放</p>
            <p class="mt-1 truncate text-sm font-medium text-white" :title="playing ? playing.name : ''">
              <span
                v-if="playing"
                class="mr-1 rounded px-1 py-0.5 align-middle text-[10px] font-semibold"
                :class="playing.platform === 'qq' ? 'bg-blue-500/20 text-blue-300' : 'bg-emerald-500/20 text-emerald-300'"
              >
                {{ playing.platform === 'qq' ? 'QQ' : '网易云' }}
              </span>
              {{ playing ? playing.name : '—' }}
            </p>
            <p class="truncate text-xs text-slate-400">{{ playing ? playing.artists.join(' / ') : '暂无播放' }}</p>
          </div>
          <div class="rounded-xl border border-slate-700/50 bg-slate-800/60 p-3">
            <p class="text-xs text-slate-500">播放器</p>
            <p class="mt-1 text-sm font-medium" :class="status?.player.running ? 'text-emerald-400' : 'text-slate-400'">
              {{ status?.player.running ? '● 运行中' : '○ 空闲' }}
              <span v-if="status?.player.paused" class="ml-1 text-amber-400">（已暂停）</span>
            </p>
          </div>
          <div class="rounded-xl border border-slate-700/50 bg-slate-800/60 p-3">
            <p class="text-xs text-slate-500">音量</p>
            <p class="mt-1 text-sm font-medium text-white">{{ status?.player.volume ?? '-' }} / 100</p>
          </div>
          <div class="rounded-xl border border-slate-700/50 bg-slate-800/60 p-3">
            <p class="text-xs text-slate-500">插播区</p>
            <p class="mt-1 text-sm font-medium text-white">{{ queue.length }} 首</p>
          </div>
          <div class="rounded-xl border border-slate-700/50 bg-slate-800/60 p-3">
            <p class="text-xs text-slate-500">当前播放源（{{ activePlaySource.provider }}）</p>
            <p class="mt-1 text-sm font-medium text-white">{{ activePlaySource.label }}</p>
          </div>
          <div class="rounded-xl border border-slate-700/50 bg-slate-800/60 p-3">
            <p class="text-xs text-slate-500">API 服务</p>
            <p class="mt-1 text-sm font-medium text-white">{{ fmtUptime(status?.uptime) }}</p>
            <p class="text-xs">
              <span :class="status?.services?.netease ? 'text-emerald-400' : 'text-red-400'">
                网易云 {{ status?.services?.netease ? '●' : '○' }}
              </span>
              <span class="ml-2" :class="status?.services?.qq ? 'text-blue-400' : 'text-red-400'">
                QQ {{ status?.services?.qq ? '●' : '○' }}
              </span>
            </p>
          </div>
        </div>

        <!-- 管理端点歌 -->
        <div class="mb-4 rounded-xl border border-slate-700/50 bg-slate-800/60 p-4">
          <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 class="text-sm font-semibold text-slate-300">🔍 管理端点歌</h2>
            <div class="flex gap-1 rounded-lg bg-slate-900 p-0.5">
              <button
                class="rounded-md px-2.5 py-1 text-xs font-medium transition"
                :class="adminSearchPlatform === 'netease' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200'"
                @click="switchAdminSearchPlatform('netease')"
              >
                🎵 网易云
              </button>
              <button
                class="rounded-md px-2.5 py-1 text-xs font-medium transition"
                :class="adminSearchPlatform === 'qq' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200'"
                @click="switchAdminSearchPlatform('qq')"
              >
                🐧 QQ音乐
              </button>
            </div>
          </div>
          <div class="flex gap-2">
            <input
              v-model="adminSearchKeyword"
              type="search"
              :placeholder="'搜索 ' + (adminSearchPlatform === 'qq' ? 'QQ音乐' : '网易云') + ' 歌曲 / 歌手…'"
              class="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-indigo-500"
              @keyup.enter="doAdminSearch"
            />
            <button
              class="shrink-0 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="adminSearching || !adminSearchEnabled"
              @click="doAdminSearch"
            >
              {{ adminSearching ? '搜索中…' : '搜索' }}
            </button>
          </div>
          <p v-if="adminSearchError" class="mt-2 text-xs text-red-400">{{ adminSearchError }}</p>
          <ul v-if="adminSearchResults.length" class="mt-3 max-h-72 divide-y divide-slate-700/60 overflow-y-auto rounded-lg bg-slate-900/50">
            <li v-for="song in adminSearchResults" :key="song.platform + '-' + song.songId" class="flex items-center gap-3 px-3 py-2.5">
              <img v-if="song.cover" :src="song.cover" class="h-10 w-10 shrink-0 rounded-lg object-cover" alt="" />
              <div v-else class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-700 text-lg">🎵</div>
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm text-white">{{ song.name }}</p>
                <p class="truncate text-xs text-slate-400">{{ song.artists.join(' / ') }} · {{ fmtSearchDuration(song.duration) }}</p>
              </div>
              <div class="flex shrink-0 gap-1.5">
                <button
                  class="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
                  :disabled="!!adminQueueingSongId"
                  @click="doAdminQueue(song)"
                >
                  {{ adminQueueingSongId === song.songId ? '点歌中…' : '点歌' }}
                </button>
                <button
                  class="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500"
                  @click="selectScheduleSong(song)"
                >
                  定时
                </button>
              </div>
            </li>
          </ul>
        </div>

        <!-- 定时播放 -->
        <div class="mb-4 rounded-xl border border-slate-700/50 bg-slate-800/60 p-4">
          <div class="mb-3 flex items-center justify-between gap-2">
            <div>
              <h2 class="text-sm font-semibold text-slate-300">⏰ 定时播放</h2>
              <p class="mt-1 text-xs text-slate-500">到点打断当前歌曲，播完后从头恢复原歌</p>
            </div>
            <button class="rounded-lg bg-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-600" @click="refreshSchedules">
              ⟳ 刷新
            </button>
          </div>

          <div v-if="scheduleDraftSong" class="rounded-lg border border-indigo-500/40 bg-indigo-950/30 p-3">
            <div class="flex items-center gap-3">
              <img v-if="scheduleDraftSong.cover" :src="scheduleDraftSong.cover" class="h-10 w-10 shrink-0 rounded-lg object-cover" alt="" />
              <div v-else class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-700 text-lg">🎵</div>
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm text-white">{{ scheduleDraftSong.name }}</p>
                <p class="truncate text-xs text-slate-400">{{ scheduleDraftSong.artists.join(' / ') }} · {{ scheduleDraftSong.platform === 'qq' ? 'QQ音乐' : '网易云' }}</p>
              </div>
              <button class="text-xs text-slate-400 hover:text-white" @click="clearScheduleDraft">取消</button>
            </div>
            <div class="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
              <label class="text-xs text-slate-400">
                重复
                <select v-model="scheduleRecurrence" class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-2 py-2 text-sm text-white outline-none">
                  <option value="daily">每天</option>
                  <option value="weekly">每周</option>
                </select>
              </label>
              <label class="text-xs text-slate-400">
                播放时间
                <input v-model="scheduleTime" type="time" class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-2 py-2 text-sm text-white outline-none" />
              </label>
              <div v-if="scheduleRecurrence === 'weekly'" class="text-xs text-slate-400 sm:col-span-1">
                每周几
                <div class="mt-1 flex flex-wrap gap-1.5">
                  <label v-for="day in WEEKDAYS" :key="day.value" class="cursor-pointer">
                    <input v-model.number="scheduleWeekdays" type="checkbox" :value="day.value" class="sr-only" />
                    <span class="inline-flex h-8 w-8 items-center justify-center rounded-lg border text-xs" :class="scheduleWeekdays.includes(day.value) ? 'border-indigo-500 bg-indigo-600 text-white' : 'border-slate-700 bg-slate-900 text-slate-400'">{{ day.label }}</span>
                  </label>
                </div>
              </div>
            </div>
            <div class="mt-3 flex justify-end gap-2">
              <button class="rounded-lg bg-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-600" @click="clearScheduleDraft">取消</button>
              <button class="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50" :disabled="scheduleSaving" @click="doSaveSchedule">
                {{ scheduleSaving ? '保存中…' : '添加定时任务' }}
              </button>
            </div>
          </div>
          <p v-else class="rounded-lg bg-slate-900/50 px-3 py-3 text-xs text-slate-500">先在上方搜索结果中点击“定时”，再设置重复方式和时间。</p>

          <div class="mt-3 max-h-72 space-y-2 overflow-y-auto">
            <div v-for="task in schedules" :key="task.id" class="flex items-center gap-3 rounded-lg bg-slate-900/60 px-3 py-2.5">
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm text-white">{{ task.name }}</p>
                <p class="truncate text-xs text-slate-400">{{ task.artists.join(' / ') }} · {{ task.platform === 'qq' ? 'QQ音乐' : '网易云' }}</p>
                <p class="mt-0.5 text-xs text-indigo-300">{{ task.time }} · {{ scheduleWeekdaysLabel(task) }}</p>
              </div>
              <button class="shrink-0 rounded-lg px-2.5 py-1.5 text-xs" :class="task.enabled ? 'bg-emerald-600/80 text-white hover:bg-emerald-500' : 'bg-slate-700 text-slate-400 hover:text-slate-200'" @click="doToggleSchedule(task)">
                {{ task.enabled ? '已启用' : '已停用' }}
              </button>
              <button class="shrink-0 rounded-lg bg-red-900/70 px-2.5 py-1.5 text-xs text-red-200 hover:bg-red-800" @click="doDeleteSchedule(task)">删除</button>
            </div>
            <p v-if="!schedules.length" class="py-3 text-center text-xs text-slate-600">暂无定时任务</p>
          </div>
        </div>

        <form class="rounded-xl border border-slate-700/50 bg-slate-800/60 p-4" @submit.prevent="saveControlSettings">
          <div class="mb-4 flex items-center justify-between gap-3">
            <div><h2 class="text-sm font-semibold text-slate-300">控制设置</h2><p class="mt-1 text-xs text-slate-500">调整点歌限额和播放偏好</p></div>
            <span v-if="controlDirty" class="text-xs text-amber-300">尚未保存</span>
          </div>
          <fieldset :disabled="controlSaving || !controlReady" class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <div>
              <label for="max-per-user" class="text-xs text-slate-300">每人点歌上限</label>
              <input id="max-per-user" v-model.number="controlDraft.maxPerUser" type="number" min="1" max="300" step="1" required class="mt-2 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white outline-none" @input="controlDirty = true" />
              <p class="mt-1 text-xs text-slate-500">1–300 首，只计算待播歌曲；同 IP 共享限额</p>
            </div>
            <div>
              <label for="max-user-queue" class="text-xs text-slate-300">点歌区总上限</label>
              <input id="max-user-queue" v-model.number="controlDraft.maxUserQueue" type="number" min="1" max="3000" step="1" required class="mt-2 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white outline-none" @input="controlDirty = true" />
              <p class="mt-1 text-xs text-slate-500">1–3000 首，所有用户共用</p>
            </div>
            <div>
              <label class="flex items-center gap-2 text-sm text-slate-300"><input v-model="controlDraft.autoStart" type="checkbox" @change="controlDirty = true" />启动自动播放</label>
              <p class="mt-2 text-xs text-slate-500">下次启动或重启主服务生效；关闭时等待点击开始播放</p>
            </div>
            <div>
              <label class="flex items-center gap-2 text-sm text-slate-300"><input v-model="controlDraft.loudnessNormalization" type="checkbox" @change="controlDirty = true" />响度均衡</label>
              <p class="mt-2 text-xs text-slate-500">减少歌曲间的音量差异，从下一首歌曲生效</p>
            </div>
          </fieldset>
          <div class="mt-4 flex flex-wrap items-center gap-3">
            <button type="submit" :disabled="controlSaving || !controlReady || !controlDirty" class="rounded-lg bg-emerald-600 px-4 py-2 text-sm text-white disabled:opacity-40">{{ controlSaving ? '保存中…' : '保存控制设置' }}</button>
            <button type="button" :disabled="controlSaving || !controlDirty" class="rounded-lg bg-slate-700 px-3 py-2 text-sm text-slate-300 disabled:opacity-40" @click="resetControlSettings">还原已保存</button>
            <p class="text-xs text-slate-500">限额立即生效。降低上限不会删除已排队歌曲，超限时暂停接受新的点歌。</p>
          </div>
        </form>

        <!-- 三栏主体 -->
        <div class="grid grid-cols-1 gap-4 xl:grid-cols-3">
          <!-- 左：播放控制 -->
          <div class="rounded-xl border border-slate-700/50 bg-slate-800/60 p-4">
            <h2 class="mb-3 text-sm font-semibold text-slate-300">播放控制</h2>
            <div class="flex items-center gap-2">
              <button
                class="flex-1 rounded-lg py-2 text-sm font-medium transition"
                :class="status?.player.running ? 'bg-slate-600 text-white hover:bg-slate-500' : 'bg-emerald-600 text-white hover:bg-emerald-500'"
                :disabled="pausePending"
                @click="doPause"
              >
                {{ !status?.player.running ? '▶ 开始播放' : status?.player.paused ? '▶ 继续' : '⏸ 暂停' }}
              </button>
              <button
                class="flex-1 rounded-lg bg-slate-600 py-2 text-sm font-medium text-white hover:bg-slate-500"
                @click="doSkip"
              >
                ⏭ 跳过
              </button>
            </div>
            <div class="mt-4">
              <div class="mb-1 flex justify-between text-xs text-slate-400">
                <span>音量</span><span class="text-slate-300">{{ status?.player.volume ?? 30 }}</span>
              </div>
              <input
                type="range" min="0" max="100" :value="status?.player.volume ?? 30"
                class="w-full accent-indigo-500"
                @input="doVolume($event.target.value)"
              />
            </div>
            <div class="mt-4">
              <div class="mb-1 text-xs text-slate-400">音频输出</div>
              <select
                :value="audioCurrent"
                class="w-full rounded-lg border border-slate-700 bg-slate-900 px-2 py-2 text-sm text-white outline-none"
                @change="doSetAudioDevice($event.target.value)"
              >
                <option value="auto">系统默认（自动）</option>
                <option v-for="d in audioDevices" :key="d.id" :value="d.id">{{ d.label }}</option>
              </select>
            </div>
            <div class="mt-4 grid grid-cols-2 gap-3">
              <div>
                <div class="mb-1 flex items-center justify-between text-xs text-slate-400">
                  <span>跳过条件</span>
                  <span class="text-slate-500">投票 {{ status?.skip?.votes ?? 0 }}/{{ status?.skip?.required ?? skipRequired }}</span>
                </div>
                <div class="flex gap-1.5">
                  <input
                    v-model.number="skipRequired"
                    type="number" min="1" max="100"
                    class="w-full rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-white outline-none"
                  />
                  <button
                    class="shrink-0 rounded-lg bg-indigo-600 px-2.5 py-1.5 text-xs text-white hover:bg-indigo-500"
                    @click="doSetSkipRequired"
                  >
                    保存
                  </button>
                </div>
              </div>
              <div>
                <div class="mb-1 text-xs text-slate-400">顶歌条件（每 IP 一首一次）</div>
                <div class="flex gap-1.5">
                  <input
                    v-model.number="boostRequired"
                    type="number" min="1" max="100"
                    class="w-full rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-white outline-none"
                  />
                  <button
                    class="shrink-0 rounded-lg bg-amber-600 px-2.5 py-1.5 text-xs text-white hover:bg-amber-500"
                    @click="doSetBoostRequired"
                  >
                    保存
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- 中：队列管理 -->
          <div class="flex max-h-[520px] flex-col overflow-hidden rounded-xl border border-slate-700/50 bg-slate-800/60 p-4">
            <div class="mb-2 flex items-center justify-between">
              <h2 class="text-sm font-semibold text-slate-300">队列管理（{{ queue.length }}）</h2>
              <button
                class="rounded-lg bg-red-600/80 px-3 py-1.5 text-xs text-white hover:bg-red-500"
                @click="doClear"
              >
                清空插播区
              </button>
            </div>
            <ul v-if="queue.length" class="min-h-0 max-h-[440px] flex-1 divide-y divide-slate-700/60 overflow-y-auto">
              <li v-for="(item, i) in queue" :key="item.platform + '-' + item.songId + '-' + i" class="flex items-center gap-3 py-2">
                <span class="w-5 shrink-0 text-center text-xs text-slate-500">{{ i + 1 }}</span>
                <div class="min-w-0 flex-1">
                  <p class="truncate text-sm text-white">
                    <span
                      class="mr-1 rounded px-1 py-0.5 align-middle text-[10px] font-semibold"
                      :class="item.platform === 'qq' ? 'bg-blue-500/20 text-blue-300' : 'bg-emerald-500/20 text-emerald-300'"
                    >
                      {{ item.platform === 'qq' ? 'QQ' : '网易云' }}
                    </span>
                    {{ item.name }}
                  </p>
                  <p class="truncate text-xs text-slate-400">
                    <span v-if="item.artists && item.artists.length">{{ item.artists.join(' / ') }} · </span>
                    {{ item.nickname || '匿名' }} 点的
                  </p>
                </div>
                <div class="flex shrink-0 flex-col gap-0.5">
                  <div class="flex gap-1">
                    <button
                      class="rounded bg-indigo-700 px-1.5 py-0.5 text-[10px] text-white hover:bg-indigo-600 disabled:opacity-30"
                      :disabled="i === 0"
                      title="置顶"
                      @click="doMoveQueue(i, 0)"
                    >
                      置顶
                    </button>
                    <button
                      class="rounded bg-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-slate-600 disabled:opacity-30"
                      :disabled="i === 0"
                      title="上移"
                      @click="doMoveQueue(i, i - 1)"
                    >
                      ↑
                    </button>
                    <button
                      class="rounded bg-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-slate-600 disabled:opacity-30"
                      :disabled="i === queue.length - 1"
                      title="下移"
                      @click="doMoveQueue(i, i + 1)"
                    >
                      ↓
                    </button>
                  </div>
                  <button
                    class="rounded bg-emerald-700 px-1.5 py-0.5 text-[10px] text-white hover:bg-emerald-600"
                    title="立即播放（切到当前）"
                    @click="doPlayNow(i)"
                  >
                    ▶播放
                  </button>
                </div>
                <button
                  class="shrink-0 rounded-md bg-red-600/80 px-2.5 py-1.5 text-xs text-white hover:bg-red-500"
                  @click="doRemove(item)"
                >
                  删除
                </button>
              </li>
            </ul>
            <p v-else class="py-6 text-center text-sm text-slate-600">插播区为空</p>
          </div>

          <!-- 右：播放源 + 歌单管理 -->
          <div class="flex flex-col gap-4">
            <div class="rounded-xl border border-slate-700/50 bg-slate-800/60 p-4">
              <h2 class="mb-3 text-sm font-semibold text-slate-300">
                播放源
                <span class="ml-1 rounded bg-emerald-500/15 px-1.5 py-0.5 align-middle text-[10px] font-medium text-emerald-400">
                  {{ activePlaySource.provider }}
                </span>
              </h2>
              <div class="admin-source-options grid grid-cols-2 gap-2">
                <button
                  class="rounded-lg py-2 text-sm font-medium transition"
                  :class="status?.playSource === 'playlist' ? 'bg-indigo-600 text-white' : 'bg-slate-700 text-slate-400 hover:bg-slate-600'"
                  @click="doSetPlaySource('playlist')"
                >
                  🎵 网易云歌单
                </button>
                <button
                  class="rounded-lg py-2 text-sm font-medium transition"
                  :class="status?.playSource === 'fm' ? 'bg-indigo-600 text-white' : 'bg-slate-700 text-slate-400 hover:bg-slate-600'"
                  @click="doSetPlaySource('fm')"
                >
                  ✨ 心动 FM
                </button>
                <button
                  class="rounded-lg py-2 text-sm font-medium transition"
                  :class="status?.playSource === 'qq-playlist' ? 'bg-indigo-600 text-white' : 'bg-slate-700 text-slate-400 hover:bg-slate-600'"
                  @click="doSetPlaySource('qq-playlist')"
                >
                  🎧 QQ歌单
                </button>
                <button
                  class="rounded-lg py-2 text-sm font-medium transition"
                  :class="status?.playSource === 'qq-radar' ? 'bg-indigo-600 text-white' : 'bg-slate-700 text-slate-400 hover:bg-slate-600'"
                  @click="doSetPlaySource('qq-radar')"
                >
                  📡 QQ 私人雷达
                </button>
              </div>
              <p v-if="status?.playSource === 'playlist' || status?.playSource === 'qq-playlist'" class="mt-3 truncate text-xs text-slate-500" :title="status?.playlistMeta?.name">
                当前歌单：{{ status?.playlistMeta?.name || '正在加载' }}（{{ status?.playlistMeta?.count || 0 }} 首）
              </p>
              <p v-else-if="status?.playSource === 'qq-radar'" class="mt-3 text-xs text-slate-500">
                QQ 私人雷达需要先完成 QQ 音乐登录。
              </p>
              <p v-else class="mt-3 text-xs text-slate-500">
                网易云心动 FM · 根据听歌偏好推荐
              </p>
            </div>

            <!-- 歌单管理：按平台管理预设歌单 -->
            <div class="flex flex-1 flex-col rounded-xl border border-slate-700/50 bg-slate-800/60 p-4">
              <h2 class="mb-2 text-sm font-semibold text-slate-300">
                歌单管理
                <span class="ml-1 rounded bg-emerald-500/15 px-1.5 py-0.5 align-middle text-[10px] font-medium text-emerald-400">
                  {{ playlistPlatformLabel }}歌单
                </span>
              </h2>
              <div class="mb-3 grid grid-cols-2 gap-2">
                <button v-for="platform in ['netease', 'qq']" :key="platform" class="rounded-lg px-3 py-2 text-sm transition disabled:opacity-40" :class="playlistPlatform === platform ? 'bg-indigo-600 text-white' : 'bg-slate-700 text-slate-400 hover:bg-slate-600'" :disabled="playlistBusy" @click="changePlaylistPlatform(platform)">{{ platform === 'qq' ? '🐧 QQ音乐' : '🎵 网易云' }}</button>
              </div>
              <p class="mb-3 truncate text-xs text-slate-500" :title="playlist.meta.name">已选歌单：{{ playlist.meta.name || '正在加载' }}（{{ playlist.meta.count || 0 }} 首）</p>
              <button v-if="playlistPlatform === 'qq'" class="mb-3 rounded-lg px-3 py-2 text-left text-sm transition" :class="presetSelected(0) ? 'bg-indigo-600/20 text-indigo-300 ring-1 ring-indigo-500' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'" :disabled="playlistBusy" @click="doSwitchPreset(0)">QQ 热歌榜 <span class="text-xs text-slate-500">默认</span><span v-if="presetActive(0)" class="ml-2 text-[10px] text-emerald-400">使用中</span><span v-else-if="presetSelected(0)" class="ml-2 text-[10px] text-emerald-400">已选择</span></button>
              <!-- 添加歌单 -->
              <div class="mb-3 flex gap-2">
                <input
                  v-model="newPlaylistId"
                  type="text"
                  class="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-white outline-none focus:border-indigo-500"
                  placeholder="输入歌单名称或粘贴分享链接"
                  maxlength="1000"
                  :disabled="playlistBusy"
                  @keydown.enter="doFindPlaylist"
                />
                <button
                  class="shrink-0 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm text-white hover:bg-indigo-500"
                  :disabled="playlistBusy || !newPlaylistId.trim()"
                  @click="doFindPlaylist"
                >
                  {{ playlistBusy ? '处理中…' : '搜索 / 添加' }}
                </button>
              </div>
              <p class="mb-2 text-xs text-slate-500">按名称搜索后点击“添加”；也可粘贴{{ playlistPlatformLabel }}分享链接，无需查找 ID。</p>
              <ul v-if="playlistResults.length" class="mb-3 max-h-56 shrink-0 divide-y divide-slate-700 overflow-y-auto">
                <li v-for="result in playlistResults" :key="result.id" class="flex items-center gap-2 py-2">
                  <div class="min-w-0 flex-1"><p class="truncate text-sm text-slate-200" :title="result.name">{{ result.name }}</p><p class="truncate text-xs text-slate-500">{{ result.creator }} · {{ result.count }} 首</p></div>
                  <button class="shrink-0 rounded bg-indigo-600 px-2 py-1 text-xs text-white disabled:opacity-40" :disabled="playlistBusy || presets.some(p => String(p.id) === String(result.id))" @click="doAddPreset(result.id)">{{ presets.some(p => String(p.id) === String(result.id)) ? '已添加' : '添加' }}</button>
                </li>
              </ul>
              <p v-else-if="playlistSearched" class="mb-3 text-xs text-slate-500">没有找到歌单，可换个名称或粘贴分享链接。</p>
              <!-- 预设列表 -->
              <ul v-if="presets.length" class="min-h-0 flex-1 divide-y divide-slate-700/60 overflow-y-auto">
                <li v-for="p in presets" :key="p.id" class="flex items-center gap-2 py-2">
                  <button
                    class="min-w-0 flex-1 truncate rounded-lg px-2 py-1.5 text-left text-sm transition"
                    :class="presetSelected(p.id) ? 'bg-indigo-600/20 text-indigo-300 ring-1 ring-indigo-500' : 'text-slate-200 hover:bg-slate-700/60'"
                    :title="'切换到此歌单：' + p.name"
                    :disabled="playlistBusy"
                    @click="doSwitchPreset(p.id)"
                  >
                    {{ p.name }}
                    <span v-if="presetActive(p.id)" class="ml-1 text-[10px] text-emerald-400">使用中</span>
                    <span v-else-if="presetSelected(p.id)" class="ml-1 text-[10px] text-emerald-400">已选择</span>
                  </button>
                  <button
                    class="shrink-0 rounded-md bg-slate-700 px-2 py-1 text-xs text-slate-400 hover:bg-red-600/70 hover:text-white"
                    title="删除此预设（不影响当前播放）"
                    @click="doRemovePreset(p.id)"
                  >
                    ✕
                  </button>
                </li>
              </ul>
              <p v-else class="py-4 text-center text-xs text-slate-600">暂无预设歌单，可搜索名称或粘贴分享链接添加</p>
            </div>
          </div>
        </div>

        <!-- 系统控制（全宽） -->
        <div class="mt-4 flex items-center justify-between rounded-xl border border-slate-700/50 bg-slate-800/60 p-4">
          <div>
            <h2 class="text-sm font-semibold text-slate-300">系统控制</h2>
            <p class="mt-0.5 text-xs text-slate-500">重启或关闭前会自动保存队列与用户数据</p>
          </div>
          <div class="flex gap-2">
            <button
              class="rounded-lg bg-amber-600/90 px-4 py-2 text-sm text-white hover:bg-amber-500"
              @click="doRestart"
            >
              🔄 重启服务
            </button>
            <button
              class="rounded-lg bg-red-600/90 px-4 py-2 text-sm text-white hover:bg-red-500"
              @click="doShutdown"
            >
              ⏻ 关闭服务
            </button>
          </div>
        </div>

        <!-- 平台账号与渠道（全宽） -->
        <div class="mt-4 rounded-xl border border-slate-700/50 bg-slate-800/60 p-4">
          <div class="mb-3 flex items-center justify-between">
            <h2 class="text-sm font-semibold text-slate-300">平台账号与渠道</h2>
            <button class="rounded-lg bg-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-600" @click="refreshCookieStatus">
              ⟳ 刷新状态
            </button>
          </div>
          <div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <!-- 网易云 -->
            <div class="rounded-lg border border-slate-700/50 bg-slate-900/40 p-3">
              <div class="mb-2 flex items-center justify-between">
                <span class="text-sm font-medium text-emerald-300">🎵 网易云</span>
                <div class="flex items-center gap-2 text-xs">
                  <span :class="cookieStatus?.netease?.account ? 'text-emerald-400' : 'text-amber-400'">
                    {{ cookieStatus?.netease?.account || (cookieStatus?.netease?.configured ? '已配置(未登录)' : '未配置') }}
                  </span>
                  <button
                    class="rounded-md px-2.5 py-1"
                    :class="status?.channels?.netease ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'bg-slate-600 text-white hover:bg-slate-500'"
                    @click="doToggleChannel('netease', !status?.channels?.netease)"
                  >
                    {{ status?.channels?.netease ? '开启中' : '已关闭' }}
                  </button>
                </div>
              </div>
              <button v-if="desktopLogin" class="rounded-lg bg-indigo-600 px-3 py-2 text-sm text-white hover:bg-indigo-500" @click="doPlatformLogin('netease')">登录网易云</button>
              <template v-else>
              <textarea
                v-model="neteaseCookieInput"
                rows="3"
                class="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-[11px] text-white outline-none focus:border-indigo-500"
                placeholder="粘贴网易云 Cookie（登录 music.163.com 复制，含 MUSIC_U）"
              ></textarea>
              <button class="mt-2 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs text-white hover:bg-indigo-500" @click="doSaveCookie('netease')">
                保存网易云 Cookie
              </button>
              </template>
            </div>
            <!-- QQ音乐 -->
            <div class="rounded-lg border border-slate-700/50 bg-slate-900/40 p-3">
              <div class="mb-2 flex items-center justify-between">
                <span class="text-sm font-medium text-blue-300">🐧 QQ音乐</span>
                <div class="flex items-center gap-2 text-xs">
                  <span :class="cookieStatus?.qq?.authenticated === true ? 'text-emerald-400' : 'text-amber-400'">
                    {{ !cookieStatus?.qq?.configured ? '未配置' : cookieStatus?.qq?.authenticated === true ? '已登录' : cookieStatus?.qq?.state === 'expired' ? '登录已过期' : '已保存，暂未验证' }}
                  </span>
                  <button
                    class="rounded-md px-2.5 py-1"
                    :class="status?.channels?.qq ? 'bg-blue-600 text-white hover:bg-blue-500' : 'bg-slate-600 text-white hover:bg-slate-500'"
                    @click="doToggleChannel('qq', !status?.channels?.qq)"
                  >
                    {{ status?.channels?.qq ? '开启中' : '已关闭' }}
                  </button>
                </div>
              </div>
              <button v-if="desktopLogin" class="rounded-lg bg-indigo-600 px-3 py-2 text-sm text-white hover:bg-indigo-500" @click="doPlatformLogin('qq')">登录QQ音乐</button>
              <p v-if="cookieStatus?.qq?.state === 'expired'" class="mt-2 text-xs text-amber-300" role="status">QQ 平台已使登录失效，原 Cookie 仍保留。桌面版会尝试从官方登录会话恢复；仍未恢复时请重新登录。</p>
              <p v-else-if="cookieStatus?.qq?.renewal?.state === 'failed'" class="mt-2 text-xs text-slate-400">最近自动续期未成功，原 Cookie 已保留；账号有效性以登录验证结果为准。</p>
              <template v-if="!desktopLogin">
              <textarea
                v-model="qqCookieInput"
                rows="3"
                class="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-[11px] text-white outline-none focus:border-blue-500"
                placeholder="粘贴 QQ 音乐 Cookie（登录 y.qq.com 复制，含 uin / qqmusic_key）"
              ></textarea>
              <button class="mt-2 rounded-lg bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-500" @click="doSaveCookie('qq')">
                保存 QQ Cookie
              </button>
              </template>
            </div>
          </div>
          <p v-if="platformLoginMessage" class="mt-3 text-sm text-emerald-300" role="status">{{ platformLoginMessage }}</p>
          <p v-if="desktopLogin" class="mt-2 text-xs text-slate-400">在程序内的官方页面登录，验证成功后自动保存并返回管理台。</p>
          <p class="mt-2 text-xs text-slate-600">
            渠道关闭后，用户端该平台搜索/点歌/榜单会提示"维护中"。Cookie 仅在管理台与本地保存。
          </p>
        </div>

        <!-- 用户名单（全宽表格） -->
        <div class="mt-4 rounded-xl border border-slate-700/50 bg-slate-800/60 p-4">
          <h2 class="mb-3 text-sm font-semibold text-slate-300">用户名单（{{ users.length }}）</h2>
          <div class="admin-table-wrap">
          <table class="w-full text-left text-sm">
            <thead>
              <tr class="border-b border-slate-700 text-xs text-slate-500">
                <th class="py-2 font-medium">用户</th>
                <th class="py-2 font-medium">IP 地址</th>
                <th class="py-2 font-medium">状态</th>
                <th class="py-2 text-right font-medium">队列中</th>
                <th class="py-2 text-right font-medium">首次出现</th>
                <th class="py-2 text-right font-medium">最近活跃</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-700/50">
              <tr v-for="u in users" :key="u.clientId" class="hover:bg-slate-700/30">
                <td class="py-2.5 text-slate-200">{{ u.nickname }}</td>
                <td class="py-2.5 font-mono text-slate-400">{{ u.ip || '—' }}</td>
                <td class="py-2.5">
                  <span
                    class="rounded px-2 py-0.5 text-xs"
                    :class="u.active ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-700 text-slate-500'"
                  >
                    {{ u.active ? '● 在线' : '○ 离线' }}
                  </span>
                </td>
                <td class="py-2.5 text-right text-slate-300">{{ u.queued }}</td>
                <td class="py-2.5 text-right text-slate-500">{{ fmtTime(u.firstSeen) }}</td>
                <td class="py-2.5 text-right text-slate-500">{{ fmtTime(u.lastSeen) }}</td>
              </tr>
            </tbody>
          </table>
          </div>
          <p v-if="!users.length" class="py-6 text-center text-sm text-slate-600">暂无用户记录</p>
        </div>

        <!-- 系统日志（全宽） -->
        <div class="mt-4 rounded-xl border border-slate-700/50 bg-slate-800/60 p-4">
          <div class="mb-2 flex items-center justify-between">
            <h2 class="text-sm font-semibold text-slate-300">系统日志（72h 自动清理）</h2>
            <button
              class="rounded-lg bg-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-600"
              @click="refreshLogs"
            >
              ⟳ 刷新
            </button>
          </div>
          <div class="max-h-72 overflow-y-auto rounded-lg bg-slate-950/60 p-2 font-mono text-xs leading-5">
            <p v-if="!logs.length" class="py-3 text-center text-slate-600">暂无日志</p>
            <p v-for="(l, i) in logs" :key="i" class="flex gap-2 whitespace-nowrap">
              <span class="shrink-0 text-slate-600">{{ fmtLogTime(l.ts) }}</span>
              <span class="shrink-0 w-10 text-center" :class="LEVEL_STYLE[l.level] || 'text-slate-300'">
                {{ l.level }}
              </span>
              <span class="shrink-0 text-slate-600">[{{ l.cat }}]</span>
              <span class="min-w-0 truncate text-slate-300">{{ l.msg }}</span>
            </p>
          </div>
        </div>
      </template>

      <!-- toast -->
      <div
        v-if="toast"
        class="toast-enter fixed bottom-8 left-1/2 z-50 -translate-x-1/2 rounded-full bg-slate-700 px-4 py-2 text-sm text-white shadow-xl"
      >
        {{ toast }}
      </div>
    </div>
  </div>
</template>

<style scoped>
:global(html),
:global(body),
:global(#app) { height: auto; min-height: 100%; }
:global(body) { overflow-x: hidden; overflow-y: auto; }

.admin-shell {
  --admin-bg: #101a18;
  --admin-panel: #1a2b24;
  --admin-panel-deep: #14211b;
  --admin-mint: #9ae6c5;
  --admin-gold: #edc68a;
  --admin-muted: #9eb5ac;
  --admin-line: #30463d;
  color: #e8f1ee;
  background:
    radial-gradient(ellipse at 84% 8%, #34534225, transparent 38rem),
    radial-gradient(ellipse at 10% 45%, #263f3222, transparent 36rem),
    var(--admin-bg);
  font-family: "Microsoft YaHei", system-ui, sans-serif;
}

.admin-frame { max-width: 1440px; padding: 34px clamp(18px, 4vw, 56px) 48px; }
.admin-hero { min-height: 238px; position: relative; overflow: hidden; }
.admin-eyebrow { margin: 0; color: #92b5a5; font-size: 10px; font-weight: 600; letter-spacing: 2px; }
.admin-hero h1 { margin: 14px 0 12px; color: #e8f1ee; font-size: clamp(32px, 4vw, 46px); font-weight: 600; line-height: 1.2; letter-spacing: 1px; }
.admin-hero h1 span { color: var(--admin-gold); }
.admin-subtitle { margin: 0; color: var(--admin-muted); font-size: 13px; line-height: 1.9; }
.admin-tags { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 17px; }
.admin-tags span { padding: 5px 10px; border: 1px solid var(--admin-line); border-radius: 30px; color: #b9cfc4; font-size: 10px; }
.admin-hero-aside { width: 290px; height: 238px; position: relative; display: grid; flex: 0 0 auto; place-items: center; }
.admin-orbit { position: absolute; width: 232px; height: 232px; border: 1px dashed #516f4960; border-radius: 50%; animation: admin-orbit 90s linear infinite reverse; }
.admin-record { width: 184px; height: 184px; display: grid; place-items: center; border: 1px solid #405446; border-radius: 50%; background: repeating-radial-gradient(circle, #17231f 0 2px, #29372e 3px, #131d18 4px 6px); box-shadow: 0 22px 42px #0008, inset 0 0 25px #0008; animation: admin-turn 32s linear infinite; }
.admin-record-label { width: 76px; height: 76px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; border: 6px solid #a8c790; border-radius: 50%; background: #c5deab; color: #223b28; }
.admin-record-label b { font-size: 9px; letter-spacing: 1px; }
.admin-record-label i { width: 9px; height: 9px; border: 2px solid #769460; border-radius: 50%; background: #101a18; }
.admin-record-label small { font-size: 5px; }
.admin-spark { position: absolute; top: 20px; right: 8px; color: var(--admin-gold); font-size: 24px; animation: admin-glimmer 4s ease-in-out infinite; }
.admin-record-caption { position: absolute; bottom: 0; display: flex; align-items: center; gap: 10px; padding: 8px 14px; border: 1px solid var(--admin-line); border-radius: 30px; background: #192921; color: #afc6b7; font-size: 10px; white-space: nowrap; }
.admin-equalizer { height: 14px; display: flex; align-items: center; gap: 3px; }
.admin-equalizer i { width: 2px; height: 10px; border-radius: 2px; background: var(--admin-mint); animation: admin-wave 1.3s ease-in-out infinite; }
.admin-equalizer i:nth-child(2) { animation-delay: .2s; }
.admin-equalizer i:nth-child(3) { animation-delay: .4s; }
.admin-equalizer i:nth-child(4) { animation-delay: .6s; }
.admin-equalizer i:nth-child(5) { animation-delay: .8s; }
.admin-address { margin-top: 13px; color: #8ea599; font-size: 10px; }
.admin-address strong { color: #c7e7d5; font: 11px Consolas, monospace; overflow-wrap: anywhere; }

/* Recolor existing utility-based cards to match the desktop homepage. */
.admin-shell [class~="bg-slate-800/60"] {
  border-color: var(--admin-line);
  background: linear-gradient(135deg, #1a2b24, #192720);
  box-shadow: 0 10px 24px #00000012;
}
.admin-shell [class~="bg-slate-900"] { border-color: #3c5948; background-color: #101c17; }
.admin-shell [class~="bg-slate-900/50"],
.admin-shell [class~="bg-slate-900/60"],
.admin-shell [class~="bg-slate-950/60"] { background-color: #101c17aa; }
.admin-shell [class~="border-slate-700"],
.admin-shell [class~="border-slate-700/50"],
.admin-shell [class~="divide-slate-700/50"] { border-color: var(--admin-line); }
.admin-shell [class~="text-white"] { color: #e8f1ee; }
.admin-shell [class~="text-slate-200"],
.admin-shell [class~="text-slate-300"] { color: #c9d8cf; }
.admin-shell [class~="text-slate-400"] { color: #afc3b7; }
.admin-shell [class~="text-slate-500"] { color: #8ea599; }
.admin-shell [class~="text-slate-600"] { color: #718878; }
.admin-shell [class~="text-indigo-300"],
.admin-shell [class~="text-indigo-400"] { color: var(--admin-mint); }
.admin-shell [class~="bg-indigo-600"] { background-color: var(--admin-mint); color: #153126; }
.admin-shell [class~="bg-indigo-500"] { background-color: #b7f2d8; color: #153126; }
.admin-shell [class~="bg-indigo-700"] { background-color: #2c4337; }
.admin-shell [class~="bg-indigo-950/30"] { background-color: #193125aa; }
.admin-shell [class~="border-indigo-500/40"] { border-color: #59816b; }
.admin-shell [class~="accent-indigo-500"] { accent-color: var(--admin-mint); }
.admin-shell button { transition: transform .2s ease, background-color .2s ease, border-color .2s ease, color .2s ease; }
.admin-shell button:hover:not(:disabled) { transform: translateY(-1px); }
.admin-shell button:focus-visible,
.admin-shell input:focus-visible,
.admin-shell select:focus-visible,
.admin-shell textarea:focus-visible { outline: 2px solid var(--admin-gold); outline-offset: 3px; }
.admin-shell input:not([type="range"]),
.admin-shell textarea,
.admin-shell select { border-color: #3c5948; background-color: #101c17; color: #edf6ef; }
.admin-shell input:not([type="range"]):focus,
.admin-shell textarea:focus,
.admin-shell select:focus { border-color: var(--admin-mint); box-shadow: 0 0 0 3px #9ae6c51a; }
.admin-shell ::selection { color: #153126; background: var(--admin-mint); }
.admin-login-card { border-color: var(--admin-line); background: linear-gradient(135deg, #1a2b24, #192720); }
.admin-source-options button { min-height: 42px; border: 1px solid #3a5345; }
.admin-table-wrap { overflow-x: auto; }
.admin-table-wrap table { min-width: 760px; }
.admin-shell tbody tr:hover { background-color: #29443680; }

@keyframes admin-turn { to { transform: rotate(360deg); } }
@keyframes admin-orbit { to { transform: rotate(360deg); } }
@keyframes admin-wave { 0%, 100% { transform: scaleY(.4); } 50% { transform: scaleY(1); } }
@keyframes admin-glimmer { 0%, 100% { opacity: .45; } 50% { opacity: 1; } }

@media (max-width: 760px) {
  .admin-frame { padding: 24px 16px 36px; }
  .admin-hero { min-height: 180px; }
  .admin-hero-aside { width: 145px; height: 180px; margin-right: -12px; transform: scale(.78); transform-origin: center right; }
  .admin-record-caption { bottom: 0; right: -6px; }
}
@media (max-width: 520px) {
  .admin-hero { align-items: flex-start; min-height: 160px; }
  .admin-hero-copy { position: relative; z-index: 1; }
  .admin-hero h1 { font-size: 31px; }
  .admin-hero-aside { position: absolute; top: -12px; right: -18px; width: 138px; opacity: .55; transform: scale(.67); }
  .admin-tags { max-width: 250px; }
}
@media (prefers-reduced-motion: reduce) {
  .admin-shell *, .admin-shell *::before, .admin-shell *::after { animation: none !important; transition: none !important; }
}
</style>
