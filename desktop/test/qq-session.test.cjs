const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),crypto=require('node:crypto');
const {QQLoginKeeper,persistQQSession,cookieHeader}=require('../netease-login.cjs');
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fixture({valid=true,configured=true,identity='123'}={}){
 const cookies=new EventEmitter();cookies.get=async()=>[{name:'uin',value:'123',domain:'.qq.com',session:true},{name:'qqmusic_key',value:'new-fixture',domain:'.y.qq.com',session:true}];
 let persisted=0,saved=0;
 cookies.set=async value=>{assert(value.expirationDate>Date.now()/1000);persisted++};cookies.flushStore=async()=>{};
 const keeper=new QQLoginKeeper({session:{cookies},readStatus:async()=>({configured,authenticated:false,state:'expired',fingerprint:'old-fingerprint',accountIdentity:hash(identity)}),verify:async()=>valid,save:async(header,expected)=>{assert.equal(expected,'old-fingerprint');assert(header.includes('new-fixture'));saved++;return true},refreshSession:async()=>{},report(){}});
 keeper.active=true;return {keeper,cookies,saved:()=>saved,persisted:()=>persisted};
}
test('verified QQ browser session repairs saved login and persists temporary cookies',async()=>{
 const f=fixture();try{await f.keeper.check();assert.equal(f.saved(),1);assert.equal(f.persisted(),2)}finally{f.keeper.stop()}
});
test('invalid browser sessions and different accounts never replace the selected account',async()=>{
 for(const options of [{valid:false},{identity:'456'}]){const f=fixture(options);try{await f.keeper.check();assert.equal(f.saved(),0)}finally{f.keeper.stop()}}
});
test('stop and manual-login suspension prevent in-flight session recovery writes',async()=>{
 for(const stopped of [true,false]){
 const f=fixture();let resolve;f.keeper.verify=()=>new Promise(r=>{resolve=r});
 const pending=f.keeper.check();await new Promise(r=>setImmediate(r));
 if(stopped)f.keeper.stop();else f.keeper.enabled=()=>false;
 resolve(true);await pending;assert.equal(f.saved(),0);f.keeper.stop();
 }
});
test('QQ cookie selection prefers music scope, ignores expired and unrelated cookies',()=>{
 const header=cookieHeader([{name:'uin',value:'123',domain:'.qq.com'}, {name:'qqmusic_key',value:'fresh',domain:'.y.qq.com'}, {name:'qqmusic_key',value:'broad-old',domain:'.qq.com'}, {name:'qqmusic_key',value:'expired',domain:'y.qq.com',expirationDate:1}, {name:'secret',value:'other',domain:'notqq.com'}],'qq');
 assert(header.includes('qqmusic_key=fresh'));assert(!header.includes('expired'));assert(!header.includes('secret'));
});
test('persistent cookies retain their original expiration and only session cookies are promoted',async()=>{
 const written=[];await persistQQSession({cookies:{get:async()=>[{name:'qqmusic_key',value:'fixture',domain:'.qq.com',expirationDate:9999999999,session:false},{name:'uin',value:'123',domain:'.qq.com',session:true}],set:async value=>written.push(value)}});
 assert.deepEqual(written.map(c=>c.name),['uin']);
});
