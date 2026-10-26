const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const {spawn} = require('node:child_process');

test('real admin routes pause URL loading and show expired-login stop without consuming requests', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'jukebox-playback-http-'));
  const serverDir=path.join(root,'server'); fs.mkdirSync(serverDir);
  fs.writeFileSync(path.join(serverDir,'config.local.js'),"module.exports={adminKey:'isolated-test-key',autoStart:false};");
  fs.writeFileSync(path.join(serverDir,'state.json'),JSON.stringify({playSource:'qq-radar',userQueue:[1,2].map(songId=>({platform:'qq',songId,name:'test '+songId,requestedBy:'test-user'}))}));
  const probe=net.createServer(); await new Promise(r=>probe.listen(0,'127.0.0.1',r));
  const port=probe.address().port; await new Promise(r=>probe.close(r));
  const modulePath=name=>JSON.stringify(path.resolve(__dirname,'..',name));
  const code=`
    process.parentPort=new (require('events').EventEmitter)();
    process.parentPort.postMessage=()=>{};
    process.stdin.on('data',()=>process.parentPort.emit('message',{data:{type:'shutdown'}}));
    let calls=0;
    require(${modulePath('music.js')}).getSongUrl=async (_p,_id,{signal})=>{
      if(++calls===1)throw Error('isolated expired login');
      await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
    };
    require(${modulePath('qq.js')}).getLoginStatus=async()=>({state:'expired'});
    require(${modulePath('index.js')});
  `;
  const child=spawn(process.execPath,['-e',code],{env:{...process.env,JUKEBOX_DATA_DIR:root,JUKEBOX_MAIN_PORT:String(port),JUKEBOX_DESKTOP:'1'},stdio:['pipe','pipe','pipe']});
  let output=''; child.stdout.on('data',d=>output+=d); child.stderr.on('data',d=>output+=d);
  const exit=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  const api=async (route,body)=>{
    const response=await fetch('http://127.0.0.1:'+port+'/api/'+route,{headers:{'x-admin-key':'isolated-test-key','content-type':'application/json'},...(body?{method:'POST',body:JSON.stringify(body)}:{})});
    assert.equal(response.status,200); return response.json();
  };
  const waitFor=async predicate=>{
    for(let i=0;i<80;i++){
      try{const value=await api('admin/status');if(predicate(value))return value;}catch{}
      await new Promise(resolve=>setTimeout(resolve,25));
    }
    assert.fail('status timeout: '+output);
  };
  try {
    await waitFor(s=>s.playbackControl?.phase==='idle');
    await api('admin/pause',{paused:false});
    const blocked=await waitFor(s=>s.playbackControl.phase==='blocked');
    assert.equal(blocked.player.active,false);
    assert.equal(blocked.player.paused,true);
    assert.deepEqual(blocked.userQueue.map(s=>s.songId),[1,2]);
    await api('admin/pause',{paused:false});
    const loading=await waitFor(s=>s.playbackControl.phase==='loading');
    assert.equal(loading.player.active,true);
    assert.equal(loading.player.running,false);
    await api('admin/pause',{paused:true});
    const paused=await waitFor(s=>s.playbackControl.phase==='paused');
    assert.equal(paused.player.active,false);
    assert.equal(paused.player.paused,true);
    assert.equal(paused.current.songId,1);
    assert.deepEqual(paused.userQueue.map(s=>s.songId),[2]);
    child.stdin.write('shutdown');
    const result=await Promise.race([exit,new Promise((_,reject)=>setTimeout(()=>reject(Error('shutdown timeout')),4000).unref())]);
    assert.equal(result.code,0,output);
    const saved=JSON.parse(fs.readFileSync(path.join(serverDir,'state.json'),'utf8'));
    assert.equal(saved.current.songId,1);
    assert.deepEqual(saved.userQueue.map(s=>s.songId),[2]);
  } finally {
    child.kill(); await exit;
    fs.rmSync(root,{recursive:true,force:true});
  }
});
