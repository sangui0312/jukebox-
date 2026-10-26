const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

for (const [name,source] of [
  ['missing config file',null],
  ['missing threshold fields',"module.exports={adminKey:'fixture-admin',volume:37,neteaseCookie:'fixture-value'};\n// retained comment\n"],
  ['quoted keys and existing overrides',"module.exports={adminKey:'fixture-admin','skipRequired':8,\"boostRequired\":3,volume:37,neteaseCookie:'fixture-value'};\nmodule.exports.skipRequired=9;\n// retained comment\n"]
]) {
  test('vote thresholds persist across a new process with '+name, () => {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jukebox-votes-'));
    const cfg=path.join(dir,'server/config.local.js'); fs.mkdirSync(path.dirname(cfg));
    if(source!==null)fs.writeFileSync(cfg,source);
    const run=code=>{
      const result=spawnSync(process.execPath,['-e',code],{cwd:path.resolve(__dirname,'../..'),env:{...process.env,JUKEBOX_DATA_DIR:dir},encoding:'utf8',timeout:15000});
      assert.equal(result.status,0,result.stderr); return result.stdout;
    };
    try {
      run(`
        const assert=require('node:assert/strict'),fs=require('node:fs');
        const config=require('./server/config'),state=require('./server/state');
        config.adminKey='fixture-admin';
        const cfg=require('./server/paths').configPath;
        const read=()=>fs.existsSync(cfg)?fs.readFileSync(cfg,'utf8'):null;
        let broadcasts=0;
        const router=require('./server/routes')({emit(){broadcasts++;}},{},()=>{},{});
        const post=(kind,required,key='fixture-admin')=>{
          const route=router.stack.find(l=>l.route?.path==='/admin/'+kind+'-config' && l.route.methods.post).route;
          let status=200,data;
          const req={body:{required},get:()=>key},res={status(n){status=n;return this;},json(v){data=v;return this;}};
          route.stack[0].handle(req,res,()=>route.stack[1].handle(req,res));return {status,data};
        };
        const original=read();
        for(const kind of ['skip','boost']){
          assert.equal(post(kind,4,'wrong').status,401);
          for(const value of [0,101,1.5,null,'invalid',Infinity])assert.equal(post(kind,value).status,400);
          assert.equal(read(),original);
        }
        assert.equal(broadcasts,0);
        assert.equal(post('skip',5).status,200);
        assert.equal(post('boost',2).status,200);
        assert.equal(post('skip',7).status,200);
        assert.equal(config.skipRequired,7);assert.equal(state.skipRequired,7);assert.equal(config.boostRequired,2);
        assert.equal(read().split('BEGIN JUKEBOX_VOTE_SETTINGS').length-1,1);
        // Other admin settings use a separate block; neither save may erase the other.
        const route=router.stack.find(l=>l.route?.path==='/admin/control-settings').route;
        const req={body:{maxPerUser:4,maxUserQueue:20,autoStart:false,loudnessNormalization:true},get:()=> 'fixture-admin'};
        let status=200;const res={status(n){status=n;return this;},json(){return this;}};
        route.stack[0].handle(req,res,()=>route.stack[1].handle(req,res));assert.equal(status,200);
        assert.equal(post('boost',6).status,200);
        const saved=read(),count=broadcasts;
        for(const kind of ['skip','boost'])for(const operation of ['writeFileSync','renameSync']){
          const originalOperation=fs[operation];
          fs[operation]=function(file,...args){if(String(file).endsWith('.votes.tmp'))throw Error('simulated write failure');return originalOperation.call(this,file,...args);};
          try{assert.equal(post(kind,10).status,500);}finally{fs[operation]=originalOperation;}
          assert.equal(read(),saved);assert.equal(broadcasts,count);
          assert.equal(state.skipRequired,7);assert.equal(config.skipRequired,7);assert.equal(config.boostRequired,6);
          assert.equal(fs.existsSync(cfg+'.votes.tmp'),false);
        }
      `);
      const result=JSON.parse(run(`
        const config=require('./server/config'),state=require('./server/state');
        process.stdout.write(JSON.stringify({skip:state.skipRequired,boost:state.snapshot().boostRequired,maxPerUser:config.maxPerUser}));
      `));
      assert.deepEqual(result,{skip:7,boost:6,maxPerUser:4});
      const saved=fs.readFileSync(cfg,'utf8');
      if(source!==null){
        assert.ok(saved.startsWith(source),'existing configuration and comments must remain intact');
        const persisted=JSON.parse(run(`const c=require('./server/config');process.stdout.write(JSON.stringify({volume:c.volume,cookie:c.neteaseCookie,key:c.adminKey}));`));
        assert.deepEqual(persisted,{volume:37,cookie:'fixture-value',key:'fixture-admin'});
      }
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
  });
}
