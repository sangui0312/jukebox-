const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const config = require('../config');
const qq = require('../qq');
const netease = require('../netease');

test('provider requests abort promptly and QQ does not start a lower-quality fallback after pause', async () => {
  const requests=[];
  let received;
  const server=http.createServer((req,res)=>{requests.push(req.url);received?.();});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const original={qqApiBase:config.qqApiBase,neteaseApiBase:config.neteaseApiBase};
  config.qqApiBase=config.neteaseApiBase='http://127.0.0.1:'+server.address().port;
  try {
    for(const provider of [qq,netease]){
      const controller=new AbortController();
      const started=new Promise(resolve=>{received=resolve;});
      const pending=provider.getSongUrl('isolated-test',{signal:controller.signal});
      await started;
      controller.abort();
      await assert.rejects(pending,{name:'AbortError'});
    }
    assert.deepEqual(requests,['/song/url?id=isolated-test&type=320','/song/url?id=isolated-test']);
  } finally {
    Object.assign(config,original);
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
  }
});
