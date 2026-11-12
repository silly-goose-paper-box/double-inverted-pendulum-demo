const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(process.argv.slice(2).find(arg => arg !== '--grid') ?? path.resolve(__dirname, '../../outputs/double-inverted-pendulum.html'), 'utf8');
const js = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const {Plant, SwingPlanner, SwingSeeds} = vm.runInNewContext(
  js.slice(0, js.indexOf('(() => {\n  const byId')) + '\n({Plant, SwingPlanner, SwingSeeds})', {Math});

const rad = angle => angle * Math.PI / 180;
const down = [0, -Math.PI, -Math.PI, 0, 0, 0];
let passive = down;
for (let i = 0; i < 200; i++) passive = Plant.step(passive, 0, 0.005);
assert(passive.every((value, i) => Math.abs(value - down[i]) < 1e-12));

for (const direction of [-1, 1]) {
  const state = [...down];
  state[3] = direction * 14;
  const result = SwingPlanner.plan(state, 0, SwingSeeds).next();
  assert(result.done);
  const proof = result.value.obstruction;
  assert.equal(proof.direction, direction);
  assert(Math.abs(proof.time - 17.976 / 36) < 1e-9);
  assert(Math.abs(proof.bound - 4.488008) < 1e-9);
  assert(Math.abs(proof.room - 3.76) < 1e-9);
}
assert.equal(SwingPlanner.viableObstruction(down), null);

function exercise(name, state, ref) {
  const started = performance.now();
  const task = SwingPlanner.plan(state, ref, SwingSeeds);
  let result = task.next();
  while (!result.done) result = task.next();
  const solution = result.value;
  if (!solution?.trajectory) {
    console.log(`${name} ${solution?.obstruction ? 'obstructed' : 'inconclusive'} (${Math.round(performance.now() - started)} ms)`);
    return false;
  }
  const tracker = SwingPlanner.build();
  tracker.setPlan(solution);
  let z = state;
  let maxX = Math.abs(z[0]);
  let maxU = 0;
  const count = solution.trajectory.length + 1000;
  for (let i = 0; i < count; i++) {
    const command = tracker.run({z, ref, dt: 0.01, t: i / 100});
    const u = Math.max(-Plant.params.forceLimit, Math.min(Plant.params.forceLimit, command));
    maxU = Math.max(maxU, Math.abs(u));
    for (let j = 0; j < 2; j++) {
      z = Plant.step(z, u, 0.005);
      assert(z.every(Number.isFinite));
      maxX = Math.max(maxX, Math.abs(z[0]));
    }
  }
  assert(maxX < Plant.params.railLimit, name + ': tracker crossed the rail');
  assert(maxU <= Plant.params.forceLimit, name + ': actuator exceeded its bound');
  const error = SwingPlanner.principalState(z);
  error[0] -= ref;
  assert(error.every(value => Math.abs(value) < 0.005), name + ': did not settle near upright');
  console.log(`${name} ${solution.seconds.toFixed(2)} s, |x|max=${maxX.toFixed(3)} m, |u|max=${maxU.toFixed(2)} N (${Math.round(performance.now() - started)} ms)`);
  return true;
}

const tests = [
  ['down/down', down, 0],
  ['equivalent wrapped angles', [0, Math.PI, 3 * Math.PI, 0, 0, 0], 0],
  ['upright capture', [0.03, 0.07, -0.05, 0.06, 0.05, -0.06], 0.25],
  ['down/up', [0, -Math.PI, 0, 0, 0, 0], 0],
  ['up/down', [0, 0, -Math.PI, 0, 0, 0], 0],
  ['opposed angles', [0, rad(-90), rad(90), 0, 0, 0], 0],
  ['opposed angles moving', [0.12, rad(35), rad(-105), -0.16, 0.24, -0.30], 0.18],
  ['down/down with position command', [0.2, -Math.PI, -Math.PI, 0, 0, 0], -0.25],
];
if (process.argv.includes('--grid')) {
  for (let a = -180; a < 180; a += 45) {
    for (let b = -180; b < 180; b += 45) tests.push([`grid ${a}/${b}`, [0, rad(a), rad(b), 0, 0, 0], 0]);
  }
}

const passed = tests.map(args => exercise(...args));
console.log(`${passed.filter(Boolean).length}/${passed.length} trajectories settled. Analytic obstruction and passive equilibrium checks passed.`);
assert(passed.every(Boolean), 'all requested replay scenarios must settle');
