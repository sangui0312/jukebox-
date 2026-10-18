const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const GlobalCookie=require('../util/globalCookie'),routes=require('../routes/user');
test('QQ HTTP middleware restores persisted cookies and refreshed credentials bypass old URL cache',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-http-cookie-'));
 try{
 const script=`(async()=>{
 const assert=require('node:assert/strict'),http=require('node:http');
 const cookie=require('./util/globalCookie')(require('./paths').dataDir);cookie.updateUserCookie({uin:'123',qqmusic_key:'first-fixture'});
 const axiosPath=require.resolve('axios');let received=[];
 require.cache[axiosPath]={id:axiosPath,filename:axiosPath,loaded:true,exports:async options=>{
 assert(/(?:qqmusic_key|qm_keyst)=/.test(options.headers.Cookie));received.push(options.headers.Cookie);
 if(options.data?.req?.method==='GetLoginUserInfo')return {data:{code:0,req:{code:0,data:{info:{nick:'fixture'}}}}};
 return {data:{req_0:{data:{midurlinfo:[{purl:'fixture.mp3'}],sip:['https://audio.example.test/']}}}};
 }};
 global.useDataStatistics=false;global.PORT=0;const app=require('./app');const server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));global.PORT=server.address().port;
 const base='http://127.0.0.1:'+global.PORT;
 try{
 let status=await(await fetch(base+'/user/loginStatus')).json();assert.equal(status.authenticated,true);
 let url=await(await fetch(base+'/song/url?id=fixture&type=128')).json();assert.equal(url.result,100);assert(received.at(-1).includes('first-fixture'));
 cookie.updateUserCookie({uin:'123',qm_keyst:'second-fixture'});
 url=await(await fetch(base+'/song/url?id=fixture&type=128')).json();assert.equal(url.result,100);assert(received.at(-1).includes('second-fixture'));
 }finally{app.locals.shutdown();await new Promise(r=>server.close(r));}
 })().catch(()=>{process.exitCode=1});`;
 const result=require('node:child_process').spawnSync(process.execPath,['-e',script],{cwd:path.resolve(__dirname,'..'),env:{...process.env,JUKEBOX_DATA_DIR:dir,JUKEBOX_DESKTOP:'1'},encoding:'utf8',timeout:15000});
 assert.equal(result.status,0,result.stderr);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('atomic cookie files recover in a new process store after corruption or removal',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-recover-'));
 try{
 const store=GlobalCookie(dir),cookie={uin:'123',qqmusic_key:'key=fixture'};
 store.updateUserCookie(cookie);store.updateAllCookies({'123':cookie});
 for(const damage of [file=>fs.writeFileSync(file,'{broken'),file=>fs.rmSync(file,{force:true}),file=>fs.writeFileSync(file,'{}')]){
  damage(store.files.user);assert.deepEqual(GlobalCookie(dir).userCookie(),cookie);
 }
 fs.writeFileSync(store.files.all,'{broken');assert.deepEqual(GlobalCookie(dir).allCookies(),{'123':cookie});
 assert.throws(()=>store.updateUserCookie({uin:'123'}));
 assert.deepEqual(store.userCookie(),cookie);
 assert.equal(fs.readdirSync(dir).some(name=>name.endsWith('.tmp')),false);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('external updates reload, cookie parsing preserves equals, and disk failures are reported',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-write-'));
 try{
 const store=GlobalCookie(dir);let body;
 const res={send(value){body=value},set(){}};
 routes['/setCookie']({req:{body:{data:'uin=o123;qqmusic_key=key=with=equals;login_type=1'}},res,globalCookie:store});
 assert.equal(body.result,100);assert.equal(GlobalCookie(dir).userCookie().qqmusic_key,'key=with=equals');
 fs.writeFileSync(store.files.user,JSON.stringify({uin:'123',qm_keyst:'external'}));const future=new Date(Date.now()+1000);fs.utimesSync(store.files.user,future,future);assert.equal(store.userCookie().qm_keyst,'external');
 routes['/setCookie']({req:{body:{data:'uin=123'}},res,globalCookie:store});assert.equal(body.result,400);
 routes['/setCookie']({req:{body:{data:'uin=123;qqmusic_key=fixture'}},res,globalCookie:{allCookies:()=>({}),updateUserCookie(){throw Error('disk failure')}}});assert.equal(body.result,500);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('automatic recovery cannot overwrite a more recent explicit login',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-race-'));
 try{
 const store=GlobalCookie(dir);store.updateUserCookie({uin:'123',qqmusic_key:'fresh'});
 let result;routes['/setCookie']({req:{body:{data:'uin=123; qqmusic_key=stale',expectedFingerprint:GlobalCookie.fingerprint({uin:'123',qqmusic_key:'old'})}},res:{send(v){result=v}},globalCookie:store});
 assert.equal(result.result,409);assert.equal(store.userCookie().qqmusic_key,'fresh');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('login status distinguishes expiration, network failure and valid credentials without disclosing cookies',async()=>{
 for(const [response,state,authenticated] of [[{code:0,req:{code:0,data:{info:{nick:'fixture'}}}},'valid',true],[{code:0,req:{code:1000}},'expired',false],[{code:500},'unknown',null],[null,'unreachable',null]]){
 let output;
 await routes['/loginStatus']({res:{send(v){output=v}},globalCookie:{userCookie:()=>({uin:'123',qqmusic_key:'never-output-fixture'})},request:async(_request,options)=>{assert.equal(options.useSavedCookie,true);if(!response)throw Error('offline');return response;}});
 assert.equal(output.state,state);assert.equal(output.authenticated,authenticated);assert(!JSON.stringify(output).includes('never-output-fixture'));
 }
});
test('local QQ requests use saved credentials by default and honor explicit ownCookie isolation',async()=>{
 const axiosPath=require.resolve('../node_modules/axios'),original=require.cache[axiosPath];
 let headers;
 require.cache[axiosPath]={id:axiosPath,filename:axiosPath,loaded:true,exports:async options=>{headers=options.headers;return {data:{ok:true}}}};
 const requestPath=require.resolve('../util/request');delete require.cache[requestPath];
 try{
 const factory=require('../util/request');
 const store={userCookie:()=>({uin:'123',qqmusic_key:'saved-fixture'})};
 await factory({query:{},cookies:{}},{}, {globalCookie:store})({url:'https://example.test'});
 assert(headers.Cookie.includes('qqmusic_key=saved-fixture'));
 await factory({query:{ownCookie:1},cookies:{uin:'456',qqmusic_key:'explicit-fixture'}},{},{globalCookie:store})({url:'https://example.test'});
 assert(headers.Cookie.includes('explicit-fixture'));assert(!headers.Cookie.includes('saved-fixture'));
 }finally{if(original)require.cache[axiosPath]=original;else delete require.cache[axiosPath];delete require.cache[requestPath];}
});
