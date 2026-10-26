/**
 * mpv 播放器封装（带 IPC：暂停/继续/音量）
 * 每首歌 spawn 一个 mpv 进程，通过 --input-ipc-server 暴露控制管道；
 * 播完进程自然退出触发 onEnd；跳过 = kill 进程。
 * Windows 用命名管道 \\.\pipe\jukebox-mpv，Linux/macOS 用 unix socket。
 */
const { spawn, execFile } = require('child_process');
const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');
const config = require('./config');

const instance = (process.env.JUKEBOX_INSTANCE_ID || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
const ipcSuffix = instance ? '-' + instance : '';
const fadeScript = path.join(os.tmpdir(), 'jukebox-fade' + ipcSuffix + '.lua');
const fadeSource = `local target = tonumber(mp.get_opt('jukebox-volume')) or 80
local stopping = nil
local transition = nil
local gain = 1
mp.register_script_message('jukebox-pause', function(value)
  local pausing = value == 'true'
  transition = { start = mp.get_time(), from = gain, to = pausing and 0 or 1 }
  if not pausing then
    mp.set_property_number('volume', target * gain)
    mp.set_property_bool('pause', false)
  end
end)
mp.register_script_message('jukebox-volume', function(value) target = tonumber(value) or target end)
mp.register_script_message('jukebox-fade-out', function() stopping = mp.get_time() end)
mp.add_periodic_timer(0.04, function()
  if transition then
    local elapsed = math.min(1, mp.get_time() - transition.start)
    gain = transition.from + (transition.to - transition.from) * elapsed
    if elapsed >= 1 then
      if transition.to == 0 then mp.set_property_bool('pause', true) end
      transition = nil
    end
  end
  local position = mp.get_property_number('time-pos')
  if not position then return end
  local factor = math.min(1, math.max(0, position))
  local duration = mp.get_property_number('duration')
  if duration then factor = math.min(factor, math.max(0, duration - position)) end
  if stopping then factor = math.min(factor, math.max(0, 1 - (mp.get_time() - stopping))) end
  mp.set_property_number('volume', target * factor * gain)
end)
`;
const IPC_NAME =
  process.platform === 'win32' ? '\\\\.\\pipe\\jukebox-mpv' + ipcSuffix : path.join(os.tmpdir(), 'jukebox-mpv' + ipcSuffix + '.sock');

class Player {
  constructor() {
    this.proc = null;
    this.children = new Set();
    this.stopping = false;
    this.ipc = null; // IPC 连接
    this.paused = false;
    this.manualPaused = false; // 主动暂停标记（管理端操作）；意外暂停(设备事件)不置位
    this.volume = config.volume;
    this.onEnd = null; // (err?) => void
    this._ended = false;
    this._generation = 0;
    this._ipcRetries = 0;
  }

  _track(child) {
    this.children.add(child);
    if (process.parentPort && child.pid) process.parentPort.postMessage({ type: 'player-spawn', pid: child.pid });
    child.once('close', () => {
      this.children.delete(child);
      if (process.parentPort && child.pid) process.parentPort.postMessage({ type: 'player-exit', pid: child.pid });
    });
  }

  /** 播放一个 URL（自动停掉上一个） */
  async play(url, {signal} = {}) {
    if (this.stopping || signal?.aborted) return;
    const generation = ++this._generation;
    await this.stop();
    if (generation !== this._generation || this.stopping || signal?.aborted) return;
    this._ended = false;
    this.paused = false;
    this.manualPaused = false;
    this._ipcRetries = 0;
    let proc;
    const args = ['--volume=0', '--no-terminal', '--vid=no', '--audio-display=no', '--force-window=no', '--osc=no', `--input-ipc-server=${IPC_NAME}`, `--script=${fadeScript}`, `--script-opts=jukebox-volume=${this.volume}`];
    // Normalize the decoded audio before user volume and fades. Live streams use
    // one-pass normalization; resample after the true-peak limiter to avoid a
    // 192 kHz device output. ReplayGain is disabled to avoid applying gain twice.
    if (config.loudnessNormalization !== false) {
      args.push('--af=lavfi=[loudnorm=I=-16:TP=-1.5:LRA=11:linear=false,aresample=48000]', '--replaygain=no');
    }
    if (config.audioDevice) args.push(`--audio-device=${config.audioDevice}`);
    args.push(url);
    try {
      fs.writeFileSync(fadeScript, fadeSource, 'utf8');
      proc = spawn(config.mpvPath, args, { stdio: 'ignore', windowsHide: true });
    } catch (e) {
      this._ended = true;
      if (this.onEnd) this.onEnd(new Error('mpv 启动失败: ' + e.message));
      return;
    }
    this.proc = proc;
    this._track(proc);
    proc.on('error', (err) => {
      if (generation !== this._generation) return;
      if (this.proc === proc) this.proc = null;
      if (!this.stopping && !this._ended) {
        this._ended = true;
        if (this.onEnd) this.onEnd(err);
      }
    });
    proc.on('exit', (code) => {
      if (generation !== this._generation) return;
      if (this.proc === proc) {
        this.proc = null;
        this._closeIpc();
      }
      if (!this.stopping && !this._ended) {
        this._ended = true;
        if (this.onEnd) this.onEnd(code ? new Error('mpv 播放失败（退出码 '+code+'）') : undefined);
      }
    });
    // 延迟连接 IPC（等 mpv 建立管道）
    this._connectIpc(proc);
  }

  _connectIpc(proc) {
    if (this.proc !== proc || this._ipcRetries >= 15) return;
    this._ipcRetries++;
    const conn = net.createConnection(IPC_NAME);
    conn.on('connect', () => {
      if (this.proc !== proc) return conn.destroy();
      this.ipc = conn;
      this._ipcRetries = 0;
      this._send(['script-message', 'jukebox-volume', String(this.volume)]);
      if (this.manualPaused) this._send(['script-message', 'jukebox-pause', 'true']);
    });
    conn.on('error', () => {
      conn.destroy();
      if (this.ipc === conn) this.ipc = null;
      if (this.proc === proc) setTimeout(() => this._connectIpc(proc), 200);
    });
    conn.on('close', () => {
      if (this.ipc === conn) this.ipc = null;
    });
  }

  _closeIpc() {
    if (this.ipc) {
      try {
        this.ipc.destroy();
      } catch (e) {
        /* ignore */
      }
      this.ipc = null;
    }
  }

  /** 发一条 IPC 命令（fire-and-forget） */
  _send(command) {
    if (!this.ipc) return false;
    try {
      this.ipc.write(JSON.stringify({ command }) + '\n');
      return true;
    } catch (e) {
      return false;
    }
  }

  /** 查询当前播放位置（秒）；失败/未播放返回 null */
  getTimePos() {
    return new Promise((resolve) => {
      if (!this.ipc) return resolve(null);
      let done = false;
      const cleanup = () => {
        if (done) return;
        done = true;
        if (this.ipc) this.ipc.off('data', onData);
        clearTimeout(timer);
      };
      const onData = (d) => {
        try {
          const text = d.toString().trim();
          const msg = JSON.parse(text.split('\n')[0]);
          if (msg.request_id === 711 && msg.error === 'success' && typeof msg.data === 'number') {
            cleanup();
            resolve(msg.data);
          }
        } catch (e) {
          /* 忽略无关数据 */
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(null);
      }, 1200);
      this.ipc.on('data', onData);
      try {
        this.ipc.write(JSON.stringify({ command: ['get_property', 'time-pos'], request_id: 711 }) + '\n');
      } catch (e) {
        cleanup();
        resolve(null);
      }
    });
  }

  /** 暂停/继续（管理端操作：记录主动意图，意外暂停不会被自动恢复逻辑误判为主动） */
  setPaused(paused) {
    this.paused = paused;
    this.manualPaused = paused;
    if (this._send(['script-message', 'jukebox-pause', String(paused)])) return true;
    return false;
  }

  /** 主动继续（手动恢复时清除主动暂停标记） */
  resume() {
    this.paused = false;
    this.manualPaused = false;
    this._send(['script-message', 'jukebox-pause', 'false']);
  }

  /** 查询 mpv 实际暂停状态（用于意外暂停检测） */
  getPaused() {
    return new Promise((resolve) => {
      if (!this.ipc) return resolve(null);
      let done = false;
      const cleanup = () => {
        if (done) return;
        done = true;
        if (this.ipc) this.ipc.off('data', onData);
        clearTimeout(timer);
      };
      const onData = (d) => {
        try {
          const text = d.toString().trim();
          const msg = JSON.parse(text.split('\n')[0]);
          if (msg.request_id === 712 && msg.error === 'success' && typeof msg.data === 'boolean') {
            cleanup();
            resolve(msg.data);
          }
        } catch (e) {
          /* ignore */
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(null);
      }, 1200);
      this.ipc.on('data', onData);
      try {
        this.ipc.write(JSON.stringify({ command: ['get_property', 'pause'], request_id: 712 }) + '\n');
      } catch (e) {
        cleanup();
        resolve(null);
      }
    });
  }

  /** 设置音量 0-100 */
  setVolume(v) {
    this.volume = Math.max(0, Math.min(100, Number(v) || 0));
    this._send(['script-message', 'jukebox-volume', String(this.volume)]);
  }

  /** 运行时切换音频输出设备（IPC，立即生效）；同时更新内存配置 */
  setAudioDevice(device) {
    config.audioDevice = device || '';
    if (this.ipc) {
      this._send(['set_property', 'audio-device', device || 'auto']);
    }
  }

  /** 停止（kill 进程；exit 事件触发 onEnd → 播下一首） */
  stop() {
    const proc = this.proc;
    if (!proc) return Promise.resolve();
    if (this.stopPromise) return this.stopPromise;
    const fading = this._send(['script-message', 'jukebox-fade-out']);
    this.stopPromise = new Promise(resolve => {
      const timer = setTimeout(() => { try { proc.kill(); } catch (_) { finish(); } }, fading ? 1000 : 0);
      const finish = () => {
        clearTimeout(timer);
        if (this.proc === proc) { this.proc = null; this._closeIpc(); }
        this.stopPromise = null;
        resolve();
      };
      proc.once('close', finish);
    });
    return this.stopPromise;
  }

  enumerateDevices(callback) {
    if (this.stopping) return callback(new Error('Service stopping'), '', '');
    const child = execFile(config.mpvPath, ['--audio-device=help'], { windowsHide: true, timeout: 5000 }, callback);
    this._track(child);
    return child;
  }

  shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.stopping = true;
    this.onEnd = null;
    this._closeIpc();
    this.shutdownPromise = Promise.all([...this.children].map(child => new Promise(resolve => {
      if (child.exitCode != null || child.signalCode != null) return resolve();
      child.once('close', resolve);
      try { child.kill(); } catch (_) { resolve(); }
    })));
    return this.shutdownPromise;
  }

  isPlaying() {
    return !!this.proc;
  }
}

module.exports = new Player();
