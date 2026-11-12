const fs = require("node:fs");
const path = require("node:path");

const read = name => fs.readFileSync(path.join(__dirname, name), "utf8").replace(/^\uFEFF/, "");
const output = path.resolve(process.argv[2] ?? path.join(__dirname, "../../outputs/double-inverted-pendulum.html"));
const nominal = JSON.parse(read("trajectory-nominal.json"));
const libraries = ["mixed-seeds.json", "grid-completion-seeds.json", "refined-seeds.json"].map(name => JSON.parse(read(name)));
const seeds = [
  {...nominal, target: nominal.target.slice(1, 3)},
  ...libraries.flatMap(library => library.entries.filter(seed => seed.u.some(u => u !== 0)).map(seed => ({
    z0: [0, ...seed.q.map(a => Math.round(a / (Math.PI / 4)) * (Math.PI / 4)), 0, 0, 0],
    target: seed.goal.map(a => Math.round(a / (2 * Math.PI)) * 2 * Math.PI),
    dt: library.dt, controls: seed.u,
  }))),
];
const javascript = [
  ...["model.js", "controllers.js", "expression.js", "visuals.js"].map(read),
  "const SwingSeeds = Object.freeze(" + JSON.stringify(seeds) + ");",
  read("swing-projection.js"), read("swing-planner.js"), read("app.js"),
].join("\n\n");
const html = read("index.html")
  .replace("<!-- STYLE -->", () => "<style>\n" + read("style.css") + "\n</style>")
  .replace("<!-- GLOBAL PROOF -->", () => read("global-proof.html"))
  .replace("<!-- SCRIPTS -->", () => "<script>\n" + javascript + "\n</script>");
fs.mkdirSync(path.dirname(output), {recursive: true});
fs.writeFileSync(output, html, "utf8");
console.log(output + " (" + Buffer.byteLength(html) + " bytes)");
