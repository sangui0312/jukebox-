/**
 * 全局 Cookie 管理（读写 QQMusicApi/data/*.json）
 *
 * 修复历史故障根因：
 *  1. 原实现使用了未声明的 jsonFile（未 require）→ 抛 ReferenceError 被 catch 吞掉
 *     → userCookie 永远为空 → QQ 播放链接接口 400，只能靠 /user/setCookie 热更新救回
 *  2. 原实现用相对路径 'data/cookie.json'，依赖进程 cwd
 *  3. 原实现只在模块加载时读一次，之后文件被改也不重载
 *
 * 现实现：绝对路径 + 按 mtime 自动重载，管理台/外部改写 cookie.json 后立即生效。
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DEFAULT_DATA_DIR = path.join(__dirname, '..', 'data');

/** 文件型 JSON 存储：带 mtime 缓存，文件一变就重载 */
function makeStore(file, validate = value => value && typeof value === 'object' && !Array.isArray(value)) {
  let cache = {};
  let mtime = -1;
  let loaded = false;

  return {
    read() {
      try {
        const st = fs.statSync(file);
        if (st.mtimeMs !== mtime) {
          const next = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (!validate(next)) throw new Error('Invalid cookie file');
          cache = next;
          loaded = true;
          mtime = st.mtimeMs;
        }
      } catch (err) {
        // 新进程也能恢复备份；运行期间读取失败则保留最后可用值。
        if (!loaded) {
          try {
            const backup = JSON.parse(fs.readFileSync(file + '.bak', 'utf8'));
            if (validate(backup)) {cache = backup; loaded = true;}
          } catch {}
        }
      }
      return cache;
    },
    write(v) {
      const next = v || {};
      if (!validate(next)) throw new Error('Invalid cookie data');
      fs.mkdirSync(path.dirname(file), {recursive: true});
      // 每个文件先完整写入并刷盘，再替换，避免退出或断电留下半个 JSON。
      const write = target => {
        const temporary = target + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp';
        let fd;
        try {
          fd = fs.openSync(temporary, 'wx', 0o600);
          fs.writeFileSync(fd, JSON.stringify(next, null, 2));
          fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
          fs.renameSync(temporary, target);
        } finally { if (fd !== undefined) fs.closeSync(fd); fs.rmSync(temporary, {force:true}); }
      };
      write(file);
      cache = next;
      loaded = true;
      mtime = fs.statSync(file).mtimeMs;
      // 主文件已成功提交；备份不可写不能把成功登录伪报为失败。
      try { write(file + '.bak'); } catch {}
    },
  };
}

module.exports = (dataDir = DEFAULT_DATA_DIR) => {
  const ALL_COOKIES_FILE = path.join(dataDir, 'allCookies.json');
  const USER_COOKIE_FILE = path.join(dataDir, 'cookie.json');
  const allStore = makeStore(ALL_COOKIES_FILE);
  const userStore = makeStore(USER_COOKIE_FILE, value => !!value && typeof value === 'object' && !!value.uin && !!(value.qqmusic_key || value.qm_keyst));

  return {
    allCookies: () => allStore.read(),
    userCookie: () => userStore.read(),
    updateAllCookies: (v) => allStore.write(v),
    updateUserCookie: (v) => userStore.write(v),
    files: { all: ALL_COOKIES_FILE, user: USER_COOKIE_FILE }, // 便于排查
  };
};
module.exports.fingerprint = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
