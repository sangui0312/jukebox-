'use strict';
const crypto = require('crypto');
const fingerprint = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function cookieHeader(cookies, platform = 'netease') {
  if (platform === 'qq') {
    const fields = Object.fromEntries(cookies.filter(cookie => /(^|\.)qq\.com$/.test(cookie.domain) && cookie.value && (!cookie.expirationDate || cookie.expirationDate > Date.now()/1000))
      .sort((a,b) => a.domain.replace(/^\./,'').length-b.domain.replace(/^\./,'').length || (a.path || '/').length-(b.path || '/').length).map(cookie => [cookie.name, cookie.value]));
    const uin = String(Number(fields.login_type) === 2 ? fields.wxuin || '' : fields.uin || '').replace(/\D/g, '');
    if (!uin || !(fields.qqmusic_key || fields.qm_keyst)) return '';
    fields.uin = uin;
    return Object.entries(fields).map(([name, value]) => name + '=' + value).join('; ');
  }
  const matching = cookies.filter(cookie => ['163.com', 'music.163.com'].includes(cookie.domain.replace(/^\./, '')));
  if (!matching.some(cookie => cookie.name === 'MUSIC_U' && cookie.value)) return '';
  return matching.map(cookie => cookie.name + '=' + cookie.value).join('; ');
}
async function persistQQSession(session) {
  // 只保存本机浏览器会话，不能改变 QQ 服务端的凭据有效期。
  if (!session.cookies.set) return;
  for (const cookie of await session.cookies.get({})) {
    if (!/(^|\.)qq\.com$/.test(cookie.domain) || !cookie.value || (!cookie.session && cookie.expirationDate)) continue;
    await session.cookies.set({url:'https://' + cookie.domain.replace(/^\./,'') + (cookie.path || '/'),name:cookie.name,value:cookie.value,
      domain:cookie.domain,path:cookie.path || '/',secure:cookie.secure,httpOnly:cookie.httpOnly,sameSite:cookie.sameSite,
      expirationDate:Date.now()/1000 + 30*24*60*60});
  }
}
async function verifyQQLogin(cookie, request = fetch) {
  const response = await request('https://u.y.qq.com/cgi-bin/musicu.fcg', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Referer: 'https://y.qq.com/', Cookie: cookie },
    body: JSON.stringify({ comm: { ct: 24, cv: 0, format: 'json' }, req: { module: 'music.UserInfo.userInfoServer', method: 'GetLoginUserInfo', param: {} } }),
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error('验证失败');
  const result = await response.json();
  return result.code === 0 && result.req?.code === 0 && !!result.req.data?.info ? cookie : false;
}
class NeteaseLogin {
  constructor({ session, verify, save, report, platform = 'netease' }) { Object.assign(this, { session, verify, save, report, platform }); this.changed = () => this.schedule(); }
  start() { this.active = true; this.session.cookies.on('changed', this.changed); this.schedule(); }
  stop() { this.active = false; clearTimeout(this.timer); this.session.cookies.removeListener('changed', this.changed); }
  schedule() { clearTimeout(this.timer); if (this.active) this.timer = setTimeout(() => this.capture(), 700); }
  async capture() {
    if (!this.active || this.busy) return;
    this.busy = true;
    try {
      const cookie = cookieHeader(await this.session.cookies.get(this.platform === 'qq' ? {} : { url: 'https://music.163.com/' }), this.platform);
      if (!cookie) return;
      const account = await this.verify(cookie);
      if (!this.active) return;
      if (!account) { this.report('等待登录完成，或在页面中重新登录。'); return; }
      if (this.platform === 'qq') await persistQQSession(this.session);
      await this.session.cookies.flushStore();
      if (!this.active) return;
      await this.save(typeof account === 'string' ? account : cookie);
      if (this.active) { this.stop(); this.report('登录成功，账号信息已自动保存。', true); }
    } catch { if (this.active) this.report('登录信息暂未验证成功，请稍后点击重新检查。'); }
    finally { this.busy = false; if (this.active) { clearTimeout(this.timer); this.timer = setTimeout(() => this.capture(), 3000); } }
  }
}
class QQLoginKeeper {
  constructor({session,readStatus,verify=verifyQQLogin,save,refreshSession,report,enabled=()=>true}) {
    Object.assign(this,{session,readStatus,verify,save,refreshSession,report,enabled});
    this.changed = (_event,cookie) => {
      if (cookie && /(^|\.)qq\.com$/.test(cookie.domain) && ['qqmusic_key','qm_keyst','uin','wxuin'].includes(cookie.name)) this.schedule();
    };
  }
  start() {
    if(this.active)return;
    this.active=true;this.session.cookies.on('changed',this.changed);
    this.timer=setTimeout(()=>this.check(),1500);
    this.health=setInterval(()=>this.check(),10*60*1000);
    this.renew=setInterval(()=>this.check({refresh:true}),4*60*60*1000);
    for(const timer of [this.timer,this.health,this.renew])timer.unref?.();
  }
  schedule() {clearTimeout(this.timer);if(this.active){this.timer=setTimeout(()=>this.check({changed:true}),1000);this.timer.unref?.();}}
  async check({changed=false,refresh=false}={}) {
    if(!this.active || this.busy || !this.enabled())return;
    this.busy=true;
    try {
      const status=await this.readStatus();
      if(!this.active || !this.enabled())return;
      if(status.authenticated===true && !changed && !refresh)return;
      let cookies=await this.session.cookies.get({});
      let candidate=cookieHeader(cookies,'qq');
      let verified=false;
      if((refresh || status.authenticated===false) && cookies.some(cookie=>/(^|\.)qq\.com$/.test(cookie.domain) && cookie.value && ['qqmusic_key','qm_keyst','p_skey'].includes(cookie.name))) {
        // 先尝试已有会话；无效时再让官方页面自行恢复，绝不提交扫码/账号操作。
        if(refresh || !candidate || !(verified=await this.verify(candidate))) {
          await this.refreshSession();
          if(!this.active || !this.enabled())return;
          cookies=await this.session.cookies.get({});candidate=cookieHeader(cookies,'qq');
        }
      }
      if(!this.active || !this.enabled())return;
      if(!candidate) {if(status.state==='expired')this.report('QQ音乐登录已过期，请在管理台重新登录。');return;}
      const fields=Object.fromEntries(candidate.split('; ').map(part=>{const pos=part.indexOf('=');return [part.slice(0,pos),part.slice(pos+1)]}));
      if(status.configured && status.accountIdentity!==fingerprint(fields.uin))return;
      if(fingerprint(fields)===status.fingerprint && status.authenticated===true)return;
      if(!verified && !await this.verify(candidate)) {if(status.state==='expired')this.report('QQ音乐登录已过期，官方会话也未恢复，请重新登录。');return;}
      if(!this.active || !this.enabled())return;
      await persistQQSession(this.session);await this.session.cookies.flushStore();
      if(!this.active || !this.enabled())return;
      if(await this.save(candidate,status.fingerprint))this.report('QQ音乐已从官方登录会话自动恢复，凭据已保存。');
    } catch {if(this.active)this.report('QQ音乐会话检查暂未完成，已保留原账号信息。');}
    finally {this.busy=false;}
  }
  stop() {this.active=false;clearTimeout(this.timer);clearInterval(this.health);clearInterval(this.renew);this.session.cookies.removeListener('changed',this.changed);}
}
module.exports = { NeteaseLogin, cookieHeader, verifyQQLogin, persistQQSession, QQLoginKeeper };
