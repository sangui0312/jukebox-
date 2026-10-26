'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const PlaybackLoop = require('../playback-loop');

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const song = id => ({platform:'qq', songId:id, name:'song '+id, requestedBy:'listener'});
function fixture(options = {}) {
  const state = {current:null, userQueue:[song(1),song(2),song(3),song(4)], bump(){}, clearSkipVotes(){}};
  const player = {
    running:false, plays:[], manualPaused:false,
    setPaused(value){this.manualPaused=value;},
    isPlaying(){return this.running;},
    async play(url,{signal}){if(!signal.aborted){this.plays.push(url);this.running=true;}},
    async stop(){this.running=false;}
  };
  const calls=[];
  const music={async getSongUrl(platform,id,options){calls.push({id,signal:options.signal});return {url:'audio:'+id};}};
  const loop=new PlaybackLoop({state,player,music,retryMs:1000,
    takeNext(signal,reserve){return reserve({item:state.userQueue.shift(),fromUser:true});},
    ...options});
  return {state,player,music,calls,loop};
}

test('pause aborts URL loading; late completion cannot play; resume retains the song', async t => {
  const f=fixture(); t.after(()=>f.loop.shutdown());
  const delayed=deferred(); let signal;
  f.music.getSongUrl=async (_platform,id,options)=>{signal=options.signal;return delayed.promise;};
  const loading=f.loop.resume();
  assert.equal(f.state.playbackControl.active,true);
  assert.equal(f.player.isPlaying(),false);
  f.loop.pause();
  assert.equal(signal.aborted,true);
  delayed.resolve({url:'late'}); await loading;
  assert.deepEqual(f.player.plays,[]);
  assert.equal(f.player.manualPaused,true);
  assert.equal(f.state.current.songId,1);
  f.music.getSongUrl=async (_platform,id)=>({url:'resumed:'+id});
  await f.loop.resume();
  assert.deepEqual(f.player.plays,['resumed:1']);
  assert.deepEqual(f.state.userQueue.map(s=>s.songId),[2,3,4]);
});

test('pause between queue reservation and asynchronous selection completion keeps the song', async t => {
  const f=fixture(); t.after(()=>f.loop.shutdown());
  const selected=deferred();
  f.loop.takeNext=(_signal,reserve)=>{reserve({item:f.state.userQueue.shift(),fromUser:true});return selected.promise;};
  const loading=f.loop.resume(); f.loop.pause();
  selected.resolve(f.loop.pending); await loading;
  assert.equal(f.state.current.songId,1);
  assert.deepEqual(f.player.plays,[]);
  f.music.getSongUrl=async ()=>({url:'retained'});
  await f.loop.resume();
  assert.deepEqual(f.player.plays,['retained']);
});

test('confirmed expired QQ login stops immediately and preserves the entire user queue', async t => {
  const f=fixture({checkLogin:async()=>({state:'expired'})}); t.after(()=>f.loop.shutdown());
  f.music.getSongUrl=async ()=>{throw Error('missing URL');};
  await f.loop.resume();
  assert.equal(f.state.playbackControl.phase,'blocked');
  assert.match(f.state.playbackControl.message,/登录已失效/);
  assert.equal(f.loop.failureCount,1);
  assert.equal(f.loop.retry,null);
  assert.equal(f.player.manualPaused,true);
  assert.deepEqual(f.state.userQueue.map(s=>s.songId),[1,2,3,4]);
  await f.loop.next();
  assert.equal(f.loop.failureCount,1);
  f.music.getSongUrl=async ()=>({url:'fresh-login'});
  await f.loop.resume();
  assert.equal(f.state.playbackControl.phase,'playing');
});

test('repeated playback failures are paced and stop at three with queue order preserved', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(); t.after(()=>f.loop.shutdown());
  let attempts=0;
  f.music.getSongUrl=async ()=>{attempts++;throw Error('network failure');};
  await f.loop.resume();
  assert.equal(attempts,1);
  t.mock.timers.tick(999); await tick(); assert.equal(attempts,1);
  t.mock.timers.tick(1); await tick(); assert.equal(attempts,2);
  t.mock.timers.tick(1000); await tick(); assert.equal(attempts,3);
  assert.equal(f.state.playbackControl.phase,'blocked');
  assert.deepEqual(f.state.userQueue.map(s=>s.songId),[1,2,3,4]);
  t.mock.timers.tick(60000); await tick(); assert.equal(attempts,3);
});

test('manual pause cancels scheduled retries, and new requests do not restart playback', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(); t.after(()=>f.loop.shutdown());
  let attempts=0;
  f.music.getSongUrl=async ()=>{attempts++;throw Error('failure');};
  await f.loop.resume(); f.loop.pause();
  f.state.userQueue.push(song(5)); await f.loop.next();
  t.mock.timers.tick(60000); await tick();
  assert.equal(attempts,1);
  assert.deepEqual(f.state.userQueue.map(s=>s.songId),[1,2,3,4,5]);
  assert.equal(f.state.playbackControl.active,false);
});

test('a late authentication response cannot stop newer playback after pause and resume', async t => {
  const status=deferred(); const f=fixture({checkLogin:()=>status.promise}); t.after(()=>f.loop.shutdown());
  f.music.getSongUrl=async ()=>{throw Error('failure');};
  const old=f.loop.resume(); await tick(); f.loop.pause();
  f.music.getSongUrl=async ()=>({url:'new'});
  await f.loop.resume(); status.resolve({state:'expired'}); await old;
  assert.equal(f.state.playbackControl.phase,'playing');
  assert.equal(f.player.manualPaused,false);
  assert.deepEqual(f.state.userQueue.map(s=>s.songId),[2,3,4]);
});

test('radar failures without a selected song are bounded and check the QQ login', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const platforms=[];
  const f=fixture({takeNext:async()=>{throw Error('radar unavailable');},checkLogin:async platform=>{platforms.push(platform);return {state:'unknown'};}});
  t.after(()=>f.loop.shutdown()); f.state.playSource='qq-radar';
  await f.loop.resume();
  t.mock.timers.tick(1000); await tick();
  t.mock.timers.tick(1000); await tick();
  assert.equal(f.state.playbackControl.phase,'blocked');
  assert.deepEqual(platforms,['qq','qq','qq']);
});

test('mpv errors use the same bounded retry loop; natural completion advances normally', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(); t.after(()=>f.loop.shutdown());
  await f.loop.resume();
  for(let i=0;i<3;i++){
    f.player.running=false; f.loop.ended(Error('mpv exit 2')); await tick();
    if(i<2){t.mock.timers.tick(1000);await tick();}
  }
  assert.equal(f.state.playbackControl.phase,'blocked');
  assert.deepEqual(f.state.userQueue.map(s=>s.songId),[1,2,3,4]);
  await f.loop.resume();
  f.player.running=false; f.loop.ended(); await tick();
  assert.equal(f.state.current.songId,2);
  assert.equal(f.loop.failureCount,0);
});

test('skip while paused stays paused; explicit play-now resumes; shutdown aborts loading', async t => {
  const f=fixture(); t.after(()=>f.loop.shutdown());
  await f.loop.skip(); assert.equal(f.state.playbackControl.active,false);
  assert.deepEqual(f.player.plays,[]);
  await f.loop.skip({resume:true}); assert.deepEqual(f.player.plays,['audio:1']);
  await f.player.stop();
  const delayed=deferred(); let signal;
  f.music.getSongUrl=async (_p,_id,opts)=>{signal=opts.signal;return delayed.promise;};
  const pending=f.loop.next(); f.loop.shutdown();
  assert.equal(signal.aborted,true);
  delayed.resolve({url:'shutdown-late'}); await pending;
  assert.deepEqual(f.player.plays,['audio:1']);
});
