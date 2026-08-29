var assert = require("assert");
var fs = require("fs");
var path = require("path");
var tl = require("./timeline.js");

var buf = fs.readFileSync(path.join(__dirname, "timeline/v1/2019-05.bin"));
var ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
var m = tl.decodeMonth(ab);

assert.strictEqual(m.magic, "STLK");
assert.strictEqual(m.version, 1);
assert.strictEqual(m.year, 2019);
assert.strictEqual(m.month, 5);
assert.strictEqual(m.nDays, 8);
assert.strictEqual(m.catalogLen, 3);
assert.strictEqual(m.firstDate, 20190524);
assert.strictEqual(m.days.length, 8);
assert.strictEqual(m.days[0].date, 20190524);
assert.strictEqual(m.days[7].date, 20190531);
assert.strictEqual(m.days[0].n, 1);
assert.strictEqual(m.days[1].n, 2);
assert.strictEqual(m.days[2].n, 3);
assert.strictEqual(m.days[7].n, 3);

m.days.forEach(function (day) {
  assert.ok(day.n >= 1);
  for (var i = 0; i < day.n; i++) {
    assert.ok(day.x[i] >= 0 && day.x[i] < 360, "x out of range " + day.x[i]);
    assert.ok(day.y[i] >= 0 && day.y[i] < 360, "y out of range " + day.y[i]);
    assert.ok(day.slot[i] >= 0 && day.slot[i] < m.catalogLen);
  }
});

assert.ok(Math.abs(m.days[0].x[0] - 40) < 0.02);
assert.ok(Math.abs(m.days[0].y[0] - 80) < 0.02);
assert.strictEqual(tl.angleDeg(0), 0);
assert.ok(Math.abs(tl.angleDeg(32768) - 180) < 1e-12);

console.log("timeline fixture decode: ok");
console.log("  magic=" + m.magic + " n_days=" + m.nDays + " catalog_len=" + m.catalogLen);
console.log("  day0 dots=" + m.days[0].n + " x=" + m.days[0].x[0].toFixed(4) + " y=" + m.days[0].y[0].toFixed(4));
