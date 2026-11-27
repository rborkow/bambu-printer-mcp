import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import JSZip from 'jszip';
import { parseStringPromise } from 'xml2js';
import { SolidcraftEngine, SOLIDCRAFT_DEFAULT_CLI } from '../dist/solidcraft-engine.js';
import { trackedMkdtemp } from './support/temp.mjs';

async function fixture(t, mode = '') {
  const dir = await trackedMkdtemp(path.join(tmpdir(), 'solidcraft-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const cli = path.join(dir, 'fake-cli'), design = path.join(dir, 'design.sc');
  await fs.writeFile(design, 'saved design');
  const archive = new JSZip();
  archive.file('3D/3dmodel.model','<model><resources><object id="1" type="model"><mesh/></object></resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 5 6 7"/></build></model>');
  await fs.writeFile(path.join(dir,'mesh.3mf'),await archive.generateAsync({type:'nodebuffer'}));
  await fs.writeFile(cli, '#!' + process.execPath + '\n' + `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(path.join(dir, 'argv'))}, JSON.stringify(args)+'\\n');
fs.writeFileSync(${JSON.stringify(path.join(dir, 'pid'))}, String(process.pid));
const value = flag => args[args.indexOf(flag)+1];
if (args[0] === '--version') { console.log('0.50.0'); process.exit(0); }
if (args[0] === 'run') {
  if (${JSON.stringify(mode)} === 'fail') process.exit(2);
  fs.copyFileSync(value('--in'), value('--save'));
  fs.copyFileSync(${JSON.stringify(path.join(dir,'mesh.3mf'))}, value('--out'));
}
if (args[0] === 'eval') fs.writeFileSync(value('--json-out'), JSON.stringify({
 bodies:[{name:'Base', volume_mm3:12, bbox:{min:[0,0,0],max:[2,2,3]}}],
 total:{volume_mm3:12}
}));
if (args[0] === 'snapshot') fs.writeFileSync(value('--out'), 'PNG');
if (${JSON.stringify(mode)} === 'linger') { process.on('SIGTERM',()=>{}); setInterval(()=>{},1000); }
`);
  await fs.chmod(cli, 0o755);
  const old = process.env.SOLIDCRAFT_CLI;
  process.env.SOLIDCRAFT_CLI = cli;
  t.after(() => { if (old === undefined) delete process.env.SOLIDCRAFT_CLI; else process.env.SOLIDCRAFT_CLI = old; });
  return { dir, design, engine: new SolidcraftEngine([dir]) };
}

test('SolidCraft argv, parameters, preview, measurements and placement hint', async t => {
  const {dir, design, engine} = await fixture(t);
  const expression = '12 + 3; $(touch SHOULD_NOT_EXIST)';
  const result = await engine.export({design_path:design, parameters:{width:expression}, quality:'finest', preview:true});
  const calls = (await fs.readFile(path.join(dir,'argv'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map(c=>c[0]), ['run','eval','snapshot']);
  assert.equal(calls[0][calls[0].indexOf('--param')+1], 'width='+expression);
  assert.equal(calls[0][calls[0].indexOf('--quality')+1], 'finest');
  assert.equal(calls[1][calls[1].indexOf('--in')+1], result.evaluated_design_path);
  assert.equal(calls[2][calls[2].indexOf('--in')+1], result.evaluated_design_path);
  assert.equal(result.next.arguments.arrange, true);
  assert.equal(result.next.arguments.stl_path, result.path);
  assert.equal(result.volume_mm3,12);
  assert.deepEqual(result.bbox,{min:[0,0,0],max:[2,2,3]});
  assert.ok(result.preview_path);
  const zipped = await JSZip.loadAsync(await fs.readFile(result.path));
  const grouped = await parseStringPromise(await zipped.file('3D/3dmodel.model').async('string'));
  assert.deepEqual(grouped.model.resources[0].object.at(-1).components[0].component[0].$,
    {objectid:'1',transform:'1 0 0 0 1 0 0 0 1 5 6 7'});
  assert.equal(grouped.model.build[0].item.length,1);
  assert.equal((await engine.status()).version,'0.50.0');
  const again = await engine.export({design_path:design,format:'stl'});
  assert.notEqual(again.path, result.path);
  assert.equal(again.next.arguments.arrange,true);
});
test('rejects output roots including symlink escapes before running', async t => {
  const {dir,design,engine} = await fixture(t);
  await fs.symlink(path.dirname(dir),path.join(dir,'escape'));
  await assert.rejects(engine.export({design_path:design,output_dir:path.join(dir,'escape')}),/outside allowed/);
  await assert.rejects(fs.stat(path.join(dir,'argv')),/ENOENT/);
});
test('validates design files, parameters and executable overrides', async t => {
  const {dir,design,engine} = await fixture(t);
  await assert.rejects(engine.export({design_path:path.join(dir,'absent.sc')}),/regular/);
  await fs.mkdir(path.join(dir,'folder.sc'));
  await assert.rejects(engine.export({design_path:path.join(dir,'folder.sc')}),/regular/);
  await assert.rejects(engine.export({design_path:design,parameters:{'bad=name':'2'}}),/parameter/);
  const previous = process.env.MCP_ALLOW_EXECUTABLE_ARG;
  delete process.env.MCP_ALLOW_EXECUTABLE_ARG;
  try { await assert.rejects(engine.export({design_path:design,executable:'/bin/true'}),/MCP_ALLOW_EXECUTABLE_ARG/); }
  finally { if(previous !== undefined) process.env.MCP_ALLOW_EXECUTABLE_ARG=previous; }
});
test('missing CLI produces actionable status and export error', async t => {
  const {dir,design,engine} = await fixture(t);
  process.env.SOLIDCRAFT_CLI=path.join(dir,'missing');
  await assert.rejects(engine.export({design_path:design}),/not installed.*SOLIDCRAFT_CLI/);
  assert.equal((await engine.status()).installed,false);
});
test('timeout kills child even after output and never accepts partial files', async t => {
  const {dir,design,engine} = await fixture(t,'linger');
  await assert.rejects(engine.export({design_path:design,timeout_ms:500}),/child killed.*unverified/);
  const pid = Number(await fs.readFile(path.join(dir,'pid'),'utf8'));
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
});
test('cancellation kills a running child without replay', async t => {
  const {dir,design,engine} = await fixture(t,'linger');
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(),500);
  try { await assert.rejects(engine.export({design_path:design},controller.signal),/cancelled/); }
  finally { clearTimeout(timer); }
  const pid = Number(await fs.readFile(path.join(dir,'pid'),'utf8'));
  // Abort settles the callback after terminating this direct CLI child.
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  assert.equal((await fs.readFile(path.join(dir,'argv'),'utf8')).trim().split('\n').length,1);
});
test('failed CLI does not proceed to measurement', async t => {
  const {dir,design,engine} = await fixture(t,'fail');
  await assert.rejects(engine.export({design_path:design}),/SolidCraft failed/);
  assert.equal((await fs.readFile(path.join(dir,'argv'),'utf8')).trim().split('\n').length,1);
});
test('real CLI exports two root bodies with original relative coordinates', {timeout:60000}, async t => {
  try { await fs.access(SOLIDCRAFT_DEFAULT_CLI); } catch { t.skip('SolidCraft CLI not installed'); return; }
  const {dir,engine} = await fixture(t);
  process.env.SOLIDCRAFT_CLI=SOLIDCRAFT_DEFAULT_CLI;
  const script = path.join(dir,'build.json'), design=path.join(dir,'two.sc');
  await fs.writeFile(script,JSON.stringify([
    {command:'solid.box',params:{length:20,width:20,height:3,body_name:'Base'}},
    {command:'solid.box',params:{length:6,width:6,height:5,corner:[7,7,3],operation:'new',body_name:'Boss'}}
  ]));
  await promisify(execFile)(SOLIDCRAFT_DEFAULT_CLI,['run',script,'--save',design,'--quiet'],{timeout:20000,killSignal:'SIGKILL'});
  const result = await engine.export({design_path:design,timeout_ms:30000,preview:true});
  assert.equal(result.bodies.length,2);
  assert.equal(result.volume_mm3,1380);
  assert.equal(result.next.arguments.arrange,true);
  const zip = await JSZip.loadAsync(await fs.readFile(result.path));
  const xml = await zip.file('3D/3dmodel.model').async('string');
  const meshes = [...xml.matchAll(/<object\b[^>]*>([\s\S]*?)<\/object>/g)].map(m=> {
    const vertices=[...m[1].matchAll(/<vertex\s+x="([^"]+)"\s+y="([^"]+)"\s+z="([^"]+)"/g)].map(v=>v.slice(1).map(Number));
    return {min:[0,1,2].map(i=>Math.min(...vertices.map(v=>v[i]))),max:[0,1,2].map(i=>Math.max(...vertices.map(v=>v[i])))};
  });
  assert.deepEqual(meshes.slice(0,2),[{min:[0,0,0],max:[20,20,3]},{min:[7,7,3],max:[13,13,8]}]);
  assert.equal([...xml.matchAll(/<item\b/g)].length,1);
  const parsed = await parseStringPromise(xml);
  assert.equal(parsed.model.resources[0].object.at(-1).components[0].component.length,2);
  const plate = await engine.export({design_path:design,preserve_plate:true});
  assert.equal(plate.next.arguments.arrange,false);
  assert.ok((await fs.stat(result.preview_path)).size>100);
});

test('objects: separate keeps each body its own 3MF object and refuses conflicting options', async t => {
  const {design, engine} = await fixture(t);
  const result = await engine.export({design_path:design, objects:'separate'});
  const model = await parseStringPromise(await (await JSZip.loadAsync(await fs.readFile(result.path))).file('3D/3dmodel.model').async('string'));
  assert.equal(model.model.build[0].item.length, 1);
  assert.equal(model.model.build[0].item[0].$.objectid, '1', 'build items are left as SolidCraft wrote them');
  assert.equal(model.model.resources[0].object.length, 1, 'no assembly object is added');
  assert.equal(result.next.arguments.arrange, true);
  assert.equal(result.next.objects, 'separate');
  await assert.rejects(engine.export({design_path:design, objects:'separate', preserve_plate:true}), /cannot be combined/);
  await assert.rejects(engine.export({design_path:design, objects:'separate', format:'stl'}), /3MF only/);
  await assert.rejects(engine.export({design_path:design, objects:'loose'}), /assembly or separate/);
});
