const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const net = require('node:net');
const player = require('../player');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('mpv nonzero exits report a failure once; normal completion remains successful', async () => {
  for (const code of [2,0]) {
    const child=new EventEmitter();
    const ended=[];
    const context={module:{exports:{}},process:{platform:process.platform,env:{}},setTimeout,clearTimeout,
      require(name){
        if(name==='./config')return {volume:30,mpvPath:'fixture',loudnessNormalization:false};
        if(name==='fs')return {writeFileSync(){}};
        if(name==='child_process')return {spawn:()=>child};
        return require(name);
      }};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../player.js'),'utf8'),context);
    const isolated=context.module.exports;
    isolated._connectIpc=()=>{};
    isolated.onEnd=error=>ended.push(error);
    await isolated.play('fixture');
    child.emit('exit',code); child.emit('exit',code);
    assert.equal(ended.length,1);
    if(code)assert.match(ended[0].message,/退出码 2/);
    else assert.equal(ended[0],undefined);
  }
});

test('a pause clicked before mpv IPC connects is sent when it connects', () => {
  const originalCreateConnection = net.createConnection;
  const sent = [];
  const conn = new EventEmitter();
  conn.write = (value) => sent.push(JSON.parse(value).command);
  conn.destroy = () => {};
  net.createConnection = () => conn;

  try {
    const proc = {};
    player.proc = proc;
    player.ipc = null;
    player.paused = false;
    player.manualPaused = false;
    player._ipcRetries = 0;
    player._connectIpc(proc);

    assert.equal(player.setPaused(true), false);
    conn.emit('connect');
    assert.deepEqual(sent.filter(command => command[1] === 'jukebox-pause'), [['script-message', 'jukebox-pause', 'true']]);
    assert.equal(player.paused, true);
  } finally {
    player.ipc = null;
    player.proc = null;
    player.paused = false;
    player.manualPaused = false;
    net.createConnection = originalCreateConnection;
  }
});
