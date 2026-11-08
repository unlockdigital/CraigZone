const assert = require('node:assert/strict');
const path = require('node:path');
const values = {};
const today = new Date().toISOString().slice(0,10);
values.craigZoneDiagnosticsV1 = {version:1,days:{[today]:{actions:{switches:7},failures:{}}}};
global.browser = {
  runtime:{getManifest:()=>({version:'0.3.0',permissions:['storage']}),getURL:()=> 'chrome-extension://synthetic/',sendNativeMessage:()=>{throw new Error('portable build must omit native messaging');}},
  storage:{local:{get:async(key)=>({[key]:values[key]}),set:async(data)=>Object.assign(values,data),remove:async(key)=>{delete values[key];}}}
};
require(path.resolve(__dirname,'extension/diagnostics.js'));
(async()=>{
  const d=global.CraigZoneDiagnostics;
  d.record('edits');d.size(3);d.size(10);d.permission('denied');d.permission('https://private.example');
  const data=await d.get(),row=data.days[today];
  assert.equal(data.version,2);
  assert.equal(row.actions.switches,7,'migration preserves existing counts');
  assert.deepEqual(row.builds,['unknown','0.3.0'],'legacy activity keeps its unknown build marker');
  assert.deepEqual(row.browsers,['unknown','chromium']);
  assert.deepEqual(row.sessionSizes,{'3':1});
  assert.deepEqual(row.permissions,{denied:1});
  assert.match(data.updatedAt,/T\d{2}:\d{2}:00\.000Z$/);
  assert.equal(data.status.mirror,'disabled');
  assert.equal(JSON.stringify(data).includes('private.example'),false);
  assert.deepEqual(await d.clear(),{ok:true,storageCleared:true,mirrorCleared:true});
  assert.deepEqual((await d.get()).days,{});
  console.log('Diagnostics migration, build attribution, size buckets and portable privacy checks passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
