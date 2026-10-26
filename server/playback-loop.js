'use strict';

// One owner for loading, retries and mpv playback. Pausing invalidates every
// pending result, including providers which do not settle immediately on abort.
class PlaybackLoop {
  constructor({state,player,music,takeNext,checkLogin=async()=>null,broadcast=()=>{},report=()=>{},onStarted=()=>{},retryMs=1000,maxFailures=3}) {
    Object.assign(this,{state,player,music,takeNext,checkLogin,broadcast,report,onStarted,retryMs,maxFailures});
    this.active=false;this.failures=[];this.failureCount=0;this.player.setPaused(true);this.publish('idle');
  }
  publish(phase,message='') {
    this.state.playbackControl={active:this.active,phase,message,consecutiveFailures:this.failureCount};
    this.state.bump();this.broadcast();
  }
  invalidate() {clearTimeout(this.retry);this.retry=null;this.attempt?.controller.abort();this.attempt=null;}
  restoreFailures() {
    const restored=[];
    for(const selected of this.failures) {
      const item=selected.item;
      if(selected.fromUser && ![...restored,...this.state.userQueue].some(other=>other.platform===item.platform && String(other.songId)===String(item.songId)))restored.push(item);
    }
    this.state.userQueue.unshift(...restored);this.failures=[];
  }
  pause(message='') {
    this.active=false;this.invalidate();
    if(this.pending && this.failures.some(selected=>selected.item===this.pending.item)){this.pending=null;this.state.current=null;}
    this.restoreFailures();this.player.setPaused(true);
    this.publish(message?'blocked':'paused',message);
  }
  resume() {
    if(this.closed)return;
    this.failureCount=0;
    this.active=true;this.player.setPaused(false);
    if(this.player.isPlaying()){this.publish('playing');return;}
    if(!this.pending && this.state.current)this.pending={item:this.state.current,fromUser:!!this.state.current.requestedBy};
    this.publish('loading');return this.next();
  }
  async next() {
    if(!this.active || this.closed || this.attempt || this.retry || this.switching || this.player.isPlaying())return;
    const attempt={controller:new AbortController()};this.attempt=attempt;
    const signal=attempt.controller.signal;
    const current=()=>this.active && !this.closed && this.attempt===attempt && !signal.aborted;
    let selected;
    try {
      // Reserve the selection before an asynchronous provider yields control,
      // so pause/shutdown can retain the song already removed from the queue.
      const reserve=value=>{if(current() && value?.item){this.pending=value;this.state.current=value.item;}return value;};
      const result=this.pending || this.takeNext(signal,reserve);
      selected=result && typeof result.then==='function'?await result:result;
      if(!current())return;
      if(!selected?.item){this.active=false;this.state.current=null;this.player.setPaused(true);this.publish('idle');return;}
      this.pending=selected;this.state.current=selected.item;this.state.clearSkipVotes();this.publish('loading');
      const item=selected.item;
      const source=await this.music.getSongUrl(item.platform || 'netease',item.songId,{signal});
      if(!current())return;
      if(!source?.url)throw new Error('音源不可用（版权、会员权限、登录或网络异常）');
      await this.player.play(source.url,{signal});
      if(!current())return;
      this.pending=null;this.started=selected;this.publish('playing');this.onStarted(item,source);
    } catch(error) {
      if(current())await this.failed(selected,error,attempt);
    } finally {if(this.attempt===attempt)this.attempt=null;}
  }
  async failed(selected,error,attempt) {
    if(!this.active || this.closed || (attempt && this.attempt!==attempt))return;
    if(selected?.item)this.failures.push(selected);
    this.failureCount++;
    // Authentication failure stops on the first affected song. Other failures
    // yield to the event loop and stop after a short, bounded run of failures.
    let expired=false;
    try {
      const platform=selected?.item?.platform || (this.state.playSource?.startsWith('qq-')?'qq':'netease');
      const status=await this.checkLogin(platform,{signal:attempt?.controller.signal});
      expired=status?.state==='expired';
    } catch {}
    if(!this.active || this.closed || (attempt && this.attempt!==attempt))return;
    this.pending=null;this.state.current=null;this.started=null;
    const message=expired?'QQ音乐登录已失效，已暂停播放。请重新登录后点击继续。'
      :this.failureCount>=this.maxFailures?'连续播放失败，已自动暂停。请检查登录、网络或歌曲权限后点击继续。':'';
    this.report(selected?.item,error,message);
    if(message){this.pause(message);return;}
    this.publish('retrying','歌曲播放失败，稍后尝试下一首；可随时暂停。');
    this.retry=setTimeout(()=>{this.retry=null;this.next();},this.retryMs);this.retry.unref?.();
  }
  ended(error) {
    if(this.closed || this.switching)return;
    if(!this.active)return;
    // A synchronous mpv spawn error belongs to the in-flight attempt. Its late
    // provider completion must not replace the failure/retry status.
    const selected=this.started || this.pending;
    this.invalidate();this.pending=null;this.started=null;
    if(error){
      const attempt={controller:new AbortController()};this.attempt=attempt;
      this.failed(selected,error,attempt).catch(()=>this.pause('播放失败，已暂停，请检查播放器和音源。')).finally(()=>{if(this.attempt===attempt)this.attempt=null});return;
    }
    this.failures=[];this.failureCount=0;this.state.current=null;this.publish('loading');this.next();
  }
  async skip({resume=false}={}) {
    if(this.closed || this.switching)return;
    this.invalidate();this.pending=null;this.started=null;this.state.current=null;this.failures=[];this.failureCount=0;
    if(resume){this.active=true;this.player.setPaused(false);}
    this.switching=true;
    try{await this.player.stop();}finally{this.switching=false;}
    this.publish(this.active?'loading':'paused');return this.next();
  }
  shutdown() {this.pause();this.closed=true;}
}
module.exports=PlaybackLoop;
