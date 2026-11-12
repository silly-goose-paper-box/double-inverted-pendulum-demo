const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(process.argv[2] ?? path.resolve(__dirname, '../../outputs/double-inverted-pendulum.html'), 'utf8');
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
assert(scripts.length > 0, 'embedded scripts must be present');
assert(scripts.every(script => !/\bsrc=/.test(script[1])), 'JS must work offline');

const canvasMethods = 'arc beginPath clip closePath fill fillRect fillText lineTo moveTo rect restore roundRect save setLineDash setTransform stroke'.split(' ');
class Element {
  constructor(tag, attributes = '') {
    this.tagName = tag;
    this.attributes = new Map([...attributes.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key, value]) => [key, value]));
    this.children = [];
    this.dataset = Object.fromEntries([...this.attributes].filter(([key]) => key.startsWith('data-')).map(([key, value]) => [key.slice(5), value]));
    this.listeners = new Map();
    this.value = this.attributes.get('value') ?? '';
    this.textContent = '';
    this.hidden = /\bhidden\b/.test(attributes);
    this.disabled = false;
    this.checked = /(?:^|\s)checked(?:\s|$)/.test(attributes);
    this.paint = [];
    this.context = Object.fromEntries(canvasMethods.map(name => [name, (...args) => {
      assert(args.every(value => typeof value !== 'number' || Number.isFinite(value)), `${name} received nonfinite canvas coordinate`);
      if (name === 'setTransform') this.paint = [];
      if (name === 'stroke' || name === 'arc' || name === 'lineTo' || name === 'fillText') this.paint.push([name, ...args]);
    }]));
  }

  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getContext(type) { assert.equal(type, '2d'); return this.context; }
  getBoundingClientRect() { return { width: 820, height: this.attributes.get('id') === 'scene' ? 320 : 180 }; }
  addEventListener(event, listener) { this.listeners.set(event, [...this.listeners.get(event) ?? [], listener]); }
  fire(event) {
    assert(this.listeners.has(event), `${this.attributes.get('id') ?? this.tagName} missing listener for ${event}`);
    return this.listeners.get(event).map(listener => listener({ type: event, target: this }));
  }
  click() {
    if (this.tagName === 'a') { download = this; return []; }
    return this.disabled ? [] : this.fire('click');
  }
}

const elements = [...html.split(/<script\b/i)[0].matchAll(/<(\w+)([^<>]*)>/g)]
  .filter(([, , attributes]) => /\bid="|\bdata-initial="|\bdata-ref="/.test(attributes))
  .map(([, tag, attributes]) => new Element(tag, attributes));
const ids = new Map(elements.filter(element => element.attributes.has('id')).map(element => [element.attributes.get('id'), element]));
const el = id => { assert(ids.has(id), `shipped markup is missing #${id}`); return ids.get(id); };
for (const [, attributes, content] of html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
  const id = attributes.match(/\bid="([^"]+)"/)?.[1];
  const options = [...content.matchAll(/<option\b([^>]*)>([^<]*)<\/option>/gi)];
  if (!id || !options.length) continue;
  const selected = options.find(([, attributes]) => /\bselected\b/.test(attributes)) ?? options[0];
  el(id).value = selected[1].match(/\bvalue="([^"]+)"/)?.[1] ?? selected[2];
}

const document = {
  getElementById: el,
  createElement: tag => new Element(tag),
  querySelectorAll(selector) {
    const key = selector.match(/^\[data-(\w+)\]$/)?.[1];
    assert(key, `unrecognized selector ${selector}`);
    return elements.filter(element => key in element.dataset);
  },
};
const initialInputs = document.querySelectorAll('[data-initial]');
const refs = document.querySelectorAll('[data-ref]');
const chartIds = ['position', 'angles', 'velocity', 'angularVelocity', 'force'].map(name => 'chart-' + name);
const frames = new Map();
const timers = [];
let frameSequence = 0;
let clipboard;
let download;
let blob;
const sandbox = vm.createContext({
  document,
  window: new Element('window'),
  navigator: { clipboard: { writeText: async text => { clipboard = text; } } },
  requestAnimationFrame(callback) { frames.set(++frameSequence, callback); return frameSequence; },
  cancelAnimationFrame(id) { frames.delete(id); },
  Blob,
  URL: {
    createObjectURL(value) { blob = value; return 'blob:qa'; },
    revokeObjectURL() {},
  },
  setTimeout(callback, delay) { if (delay === 0) timers.push(callback); },
});
for (const [, , code] of scripts) vm.runInContext(code, sandbox, {filename: 'double-inverted-pendulum.html'});

const value = id => Number(el(id).textContent);
const status = () => el('status').dataset.mode;
const reset = () => el('reset').click();
const step = () => el('single-step').click();
const set = (id, value, event = 'input') => { el(id).value = String(value); el(id).fire(event); };
const select = id => set('controller', id, 'change');
const apply = () => el('apply-controller').click();
const tone = () => el('controller-result').dataset.tone;
function frame(now) {
  assert.equal(frames.size, 1, 'one animation frame must be queued');
  const [id, callback] = frames.entries().next().value;
  frames.delete(id);
  callback(now);
}

function finishPlan() {
  let iterations = 0;
  while (timers.length) {
    assert(iterations++ < 500, 'planner must respect its search budget');
    timers.shift()();
  }
}

async function csv() {
  el('export').click();
  assert.equal(download.download, 'double-inverted-pendulum.csv');
  assert.equal(download.href, 'blob:qa');
  const [header, ...data] = (await blob.text()).trim().split('\n');
  assert.equal(header.split(',').length, 10);
  const rows = data.map(row => row.split(',').map(Number));
  assert(rows.every(row => row.length === 10 && row.every(Number.isFinite)));
  return rows;
}

async function main() {
  const aRows = el('matrix-a').children[0].children[0].children;
  const bRows = el('matrix-b').children[0].children[0].children;
  assert.deepEqual(aRows.map(row => row.children.length), Array(6).fill(6));
  assert.deepEqual(bRows.map(row => row.children.length), Array(6).fill(1));
  assert.equal(aRows[0].children[3].textContent, '1.000000');
  assert.equal(aRows[4].children[1].textContent, '49.726552');
  assert.equal(bRows[5].children[0].textContent, '1.293103');
  assert.equal(el('plant-params').children.length, 20);
  await Promise.all(el('copy-matrices').click());
  assert.match(clipboard, /A = \[0, 0, 0, 1, 0, 0;/);
  assert.match(clipboard, /C = eye\(6\);\nD = zeros\(6,1\);/);

  const expected = ['lqr', 'pole', 'lqi', 'pid', 'mpc', 'observer', 'sliding', 'gain', 'open', 'custom'];
  assert.deepEqual(el('controller').children.map(node => node.value), ['swing', ...expected]);
  assert.equal(el('controller').value, 'swing');
  assert.equal(el('dynamics-type').disabled, true);
  assert.equal(status(), 'paused');
  assert.equal(value('time-value'), 0);
  assert.equal(value('t1-value'), -180);
  assert.equal(value('t2-value'), -180);
  const stillScene = JSON.stringify(el('scene').paint);

  el('play').click();
  assert.equal(el('play-label').textContent, '取消规划');
  el('play').click();
  finishPlan();
  assert.equal(status(), 'paused');
  assert.equal(frames.size, 0);
  el('play').click();
  finishPlan();
  assert.equal(el('status').textContent, '轨迹摆起');
  assert.match(el('controller-result').textContent, /摆起 2\.64 s/);
  frame(100);
  for (let i = 1; i <= 80; i += 1) frame(100 + 100 * i);
  assert.equal(el('status').textContent, '直立反馈');
  el('play').click();
  const swing = await csv();
  const swingTravel = Math.max(...swing.map(row => Math.abs(row[1])));
  const swingForce = Math.max(...swing.map(row => Math.abs(row[7])));
  assert(swingTravel > 1 && swingTravel < 1.05);
  assert(swingForce > 16 && swingForce < 17);
  assert(swing.at(-1).slice(1, 7).every(value => Math.abs(value) < 1e-5));

  el('proof-example').click();
  finishPlan();
  assert.equal(status(), 'error');
  assert.equal(el('status').textContent, '轨道约束不可满足');
  assert.match(el('controller-result').textContent, /右侧.*4\.488.*3\.760/);
  assert.equal(value('time-value'), 0);
  assert.equal(initialInputs[3].value, '14');
  assert.equal(frames.size, 0);
  const fromDown = [];
  assert.equal(el('auto-swing').checked, true);
  for (const id of ['swing', ...expected]) {
    select(id);
    el('controller-defaults').click();
    apply();
    el('initial-downward').click();
    assert.equal(value('t1-value'), -180);
    assert.equal(value('t2-value'), -180);
    assert.match(el('controller-result').textContent, /自动摆起/);
    if (id === 'open') assert.match(el('controller-result').textContent, /LQR 稳摆/);
    el('play').click();
    finishPlan();
    assert.equal(el('status').textContent, '轨迹摆起', id);
    frame(100);
    for (let i = 1; i <= 200; i++) frame(100 + 100 * i);
    assert.equal(el('status').textContent, '直立反馈', id);
    el('play').click();
    const rows = await csv();
    assert.equal(rows.at(-1)[0], 20);
    assert(rows.some(row => Math.abs(row[7]) > 1));
    for (const row of rows.slice(-1000)) {
      assert(Math.abs(row[1]) < 1e-4, id + ': position must settle');
      for (const angle of row.slice(2, 4)) {
        assert(Math.abs(Math.atan2(Math.sin(angle), Math.cos(angle))) < 1e-4, id + ': both rods must stay upright');
      }
      assert(row.slice(4, 7).every(speed => Math.abs(speed) < 1e-4), id + ': velocities must settle');
    }
    const travel = Math.max(...rows.map(row => Math.abs(row[1])));
    const force = Math.max(...rows.map(row => Math.abs(row[7])));
    assert(travel < 2.8 && force <= 36, id + ': respect system limits');
    fromDown.push({id, travel, force});
  }
  el('auto-swing').checked = false;
  el('auto-swing').fire('change');
  el('initial-upright').click();
  assert.equal(value('t1-value'), 4.58);
  for (const id of expected) {
    reset();
    select(id);
    assert.equal(tone(), 'pending');
    apply();
    assert.equal(tone(), 'ok', `${id}: ${el('controller-result').textContent}`);
    assert.equal(el('custom-fields').hidden, id !== 'custom');
    step();
    assert.equal(value('time-value'), 0.01, id);
    assert(Number.isFinite(value('u-value')), id);
    assert.notEqual(status(), 'error', id);
  }
  assert.notEqual(JSON.stringify(el('scene').paint), stillScene, 'animation must move drawing coordinates');
  for (const id of chartIds) assert(el(id).paint.some(([name]) => name === 'lineTo'), `${id} must draw traces/grid`);

  reset();
  set('custom-u', '2 + 10*s1');
  set('custom-ds1', '1');
  apply();
  assert.equal(tone(), 'ok');
  step();
  assert.equal(value('u-value'), 2);
  step();
  assert.equal(value('u-value'), 2.1);
  set('custom-u', '2 +');
  apply();
  assert.equal(tone(), 'error');
  assert.match(el('controller-result').textContent, /当前运行：自定义公式/);
  step();
  assert.equal(value('u-value'), 2.2, 'invalid edits must leave prior controller running');
  reset();
  step();
  assert.equal(value('u-value'), 2, 'reset must clear internal controller state');

  reset();
  set('custom-u', 'if(t >= 0.02, 1/0, 100)');
  apply();
  assert.equal(tone(), 'ok');
  step();
  assert.equal(value('u-value'), 36, 'actuator must saturate at +36 N');
  step();
  step();
  assert.equal(status(), 'error');
  assert.equal(el('play').disabled, true);
  assert.equal(value('time-value'), 0.02);
  reset();
  assert.equal(status(), 'paused');

  refs.find(node => node.dataset.ref === '0.25').click();
  assert.equal(el('reference-value').textContent, '0.25 m');
  assert.equal(el('reference').value, '0.25');
  const presetRow = (await csv()).at(-1);
  assert.equal(presetRow[8], 0.25);
  set('reference', -0.14);
  assert.equal((await csv()).at(-1)[8], -0.14);
  el('push-right').click();
  assert.match(el('status').textContent, /扰动/);
  step();
  assert.equal((await csv()).at(-1)[9], 8);

  select('open');
  apply();
  initialInputs[0].value = '2.8';
  el('apply-initial').click();
  assert.match(el('initial-error').textContent, /2\.8 m/);
  initialInputs[0].value = '0';
  initialInputs[1].value = '60';
  initialInputs[2].value = '-45';
  el('apply-initial').click();
  assert.equal(el('initial-error').textContent, '');
  assert.equal(value('time-value'), 0);
  assert.equal(value('t1-value'), 60);
  step();
  const nonlinear = (await csv()).at(-1);
  set('dynamics-type', 'linear', 'change');
  assert.equal(value('time-value'), 0);
  step();
  const linear = (await csv()).at(-1);
  assert(Math.abs(nonlinear[5] - linear[5]) > 0.01, 'dynamics choices must execute different state updates');
  set('dynamics-type', 'nonlinear', 'change');
  el('initial-downward').click();
  assert.equal(value('t1-value'), -180);
  el('initial-upright').click();
  assert.equal(value('t1-value'), 4.58);

  refs.find(node => node.dataset.ref === '0.25').click();
  select('lqr');
  apply();
  el('play').click();
  assert.equal(status(), 'running');
  assert.equal(el('single-step').disabled, true);
  frame(100);
  frame(140);
  assert.equal(value('time-value'), 0.04);
  el('play').click();
  assert.equal(frames.size, 0);
  assert.equal(value('time-value'), 0.04);
  assert.equal(status(), 'paused');
  el('speed').value = '4';
  el('play').click();
  frame(200);
  frame(240);
  assert.equal(value('time-value'), 0.20);
  el('play').click();
  el('speed').value = '1';
  reset();
  el('play').click();
  frame(300);
  for (let i = 1; i <= 120; i += 1) frame(300 + 100 * i);
  el('play').click();
  assert.equal(value('time-value'), 12);
  assert.equal(value('x-value'), 0.25);
  assert(Math.abs(value('t1-value')) < 0.1 && Math.abs(value('t2-value')) < 0.1);
  const trajectory = await csv();
  assert.equal(trajectory.length, 1201);
  assert.equal(trajectory.at(-1)[0], 12);
  reset();
  assert.equal((await csv()).length, 1);

  console.log(JSON.stringify({ controllers: ['swing', ...expected], plots: chartIds.length, matrices: ['6×6', '6×1'], stepSeconds: 0.01, swingTravel, swingForce, fromDown, swingFinalAt8s: swing.at(-1), finalLqrAt12s: trajectory.at(-1), nonlinearAngularRate: nonlinear[5], linearAngularRate: linear[5], tests: 'pass' }, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
