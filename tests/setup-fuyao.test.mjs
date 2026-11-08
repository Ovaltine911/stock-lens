import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { validateFuyaoKey, createFuyaoSetupServer, inspectFuyaoConfig } from '../scripts/setup-fuyao.mjs';
const fakeKey='mock-fuyao-test-credential';
const response = payload => new Response(JSON.stringify(payload));
const validPayload = { code:0, data:{item:[{thscode:'600519.SH'}]} };

test('扶摇验证只调用官方单股端点，不将密钥放URL或返回数据', async()=>{
  const config=await validateFuyaoKey(fakeKey,{fetchImpl:async(url,options)=>{
    assert.equal(url,'https://fuyao.aicubes.cn/api/a-share/valuations/snapshot?thscodes=600519.SH');
    assert.equal(options.headers['X-api-key'],fakeKey);
    assert.equal(options.redirect,'error');
    return response(validPayload);
  }});
  assert.equal(config.FUYAO_API_KEY,fakeKey);
  assert.equal(config.checkedEndpoint,'/api/a-share/valuations/snapshot');
});
test('HTTP200业务失败不当作授权通过',async()=>{
  await assert.rejects(()=>validateFuyaoKey(fakeKey,{fetchImpl:async()=>response({code:2003,msg:fakeKey})}),e=>e.status===422&&!e.message.includes(fakeKey));
});
test('无效格式、缺数据和错误证券代码拒绝',async()=>{
  await assert.rejects(()=>validateFuyaoKey('bad'),/密钥格式/);
  for(const payload of [{},{code:0,data:{}},{code:0,data:{item:[{thscode:'000001.SZ'}]}}]){
    await assert.rejects(()=>validateFuyaoKey(fakeKey,{fetchImpl:async()=>response(payload)}));
  }
});
test('认证和网络失败不泄露上游原文',async()=>{
  await assert.rejects(()=>validateFuyaoKey(fakeKey,{fetchImpl:async()=>new Response(fakeKey,{status:401})}),e=>e.status===401&&!e.message.includes(fakeKey));
  await assert.rejects(()=>validateFuyaoKey(fakeKey,{fetchImpl:async()=>{throw new Error(fakeKey)}}),e=>e.status===502&&!e.message.includes(fakeKey));
});
test('扶摇独立保存不修改模型配置，接口不返回密钥并有跨站保护',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'fuyao-setup-'));
  const configPath=path.join(dir,'fuyao.json');
  const modelPath=path.join(dir,'model.json');
  await writeFile(modelPath,'{"sentinel":"do-not-change"}');
  const server=createFuyaoSetupServer({configPath,validate:key=>validateFuyaoKey(key,{fetchImpl:async()=>response(validPayload)})});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(dir,{recursive:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  const state=await(await fetch(base+'/status')).json();assert.equal(state.configured,false);
  const post=origin=>fetch(base+'/configure',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Setup-CSRF':state.csrf},body:JSON.stringify({key:fakeKey})});
  assert.equal((await post('https://untrusted.example')).status,403);
  const saved=await post(base);assert.equal(saved.status,200);assert.ok(!(await saved.text()).includes(fakeKey));
  assert.equal((await stat(configPath)).mode&0o777,0o600);
  assert.deepEqual(JSON.parse(await readFile(modelPath,'utf8')),{sentinel:'do-not-change'});
  const after=await(await fetch(base+'/status')).text();assert.ok(!after.includes(fakeKey));assert.equal(JSON.parse(after).configured,true);
  assert.equal((await post(base)).status,409);
  assert.equal((await fetch(base+'/.local/fuyao.json')).status,404);
});
test('损坏配置不被当成不存在覆盖',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'fuyao-config-'));
  t.after(()=>rm(dir,{recursive:true}));
  const file=path.join(dir,'fuyao.json');await writeFile(file,'{broken');
  await assert.rejects(()=>inspectFuyaoConfig(file),/不会自动覆盖/);
});
