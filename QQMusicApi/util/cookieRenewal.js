'use strict';

module.exports = function cookieRenewal({ globalCookie, url, request = fetch, report = console.log }) {
  let busy = false;
  let stopped = false;
  let controller;
  let status = {state:'waiting', checkedAt:null, renewedAt:null};
  async function refresh() {
    if (busy || stopped) return;
    const cookie = { ...globalCookie.userCookie() };
    if (!cookie.uin || !(cookie.qm_keyst || cookie.qqmusic_key) || Number(cookie.login_type) === 2 || (!cookie.psrf_qqopenid && cookie.wxopenid)) return;
    busy = true;
    status = {...status,state:'refreshing',checkedAt:new Date().toISOString()};
    controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await request(url(), {
        headers: { Cookie: Object.entries(cookie).map(([name, value]) => name + '=' + value).join('; ') },
        signal: controller.signal
      });
      const result = await response.json();
      if (!response.ok || result.result !== 100 || typeof result.data?.musickey !== 'string' || !result.data.musickey) throw new Error('刷新失败');
      if (stopped || JSON.stringify(globalCookie.userCookie()) !== JSON.stringify(cookie)) return;
      const renewed = { ...cookie, qm_keyst: result.data.musickey, qqmusic_key: result.data.musickey };
      const all = { ...globalCookie.allCookies(), [cookie.uin]: renewed };
      globalCookie.updateAllCookies(all);
      globalCookie.updateUserCookie(renewed);
      status = {...status,state:'renewed',renewedAt:new Date().toISOString()};
      report('QQ音乐登录自动续期成功，新密钥已保存。');
    } catch (_) {
      if (!stopped) { status = {...status,state:'failed'}; report('QQ音乐自动续期未成功，已保留原 Cookie；登录是否有效以账号验证结果为准。'); }
    } finally {
      clearTimeout(timeout);
      busy = false;
    }
  }
  const startup = setTimeout(refresh, 1000);
  const interval = setInterval(refresh, 4 * 60 * 60 * 1000);
  startup.unref();
  interval.unref();
  return { refresh, snapshot: () => ({...status}), stop() { stopped = true; clearTimeout(startup); clearInterval(interval); controller?.abort(); } };
};
