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
assert.ok(m.catalogLen >= 3);
assert.strictEqual(m.firstDate, 20190524);
assert.strictEqual(m.days.length, 8);
assert.strictEqual(m.days[0].date, 20190524);
assert.strictEqual(m.days[7].date, 20190531);

m.days.forEach(function (day) {
  assert.ok(day.n >= 0);
  if (!(day.flags & 1)) assert.ok(day.n >= 1, "real dump must have sats " + day.date);
  for (var i = 0; i < day.n; i++) {
    assert.ok(day.x[i] >= 0 && day.x[i] < 360, "x out of range " + day.x[i]);
    assert.ok(day.y[i] >= 0 && day.y[i] < 360, "y out of range " + day.y[i]);
    assert.ok(day.slot[i] >= 0 && day.slot[i] < m.catalogLen);
  }
});

assert.strictEqual(tl.angleDeg(0), 0);
assert.ok(Math.abs(tl.angleDeg(32768) - 180) < 1e-12);

var src = fs.readFileSync(path.join(__dirname, "timeline.js"), "utf8");
var html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
assert.ok(/PLAYBACK_FPS = 15/.test(src), "default playback is 15 fps");
assert.ok(/FPS_MIN = 1/.test(src) && /FPS_MAX = 15/.test(src), "player can vary 1–15 fps");
assert.ok(!/fps = j\.fps \|\| 30/.test(src), "player must not fall back to catalog 30 fps");
assert.ok(/data-tl-fps/.test(html) && /min="1"/.test(html) && /max="15"/.test(html), "speed control is 1–15");
assert.ok(/rMin = 3\.36/.test(src), "timeline 0-zoom radius is 3.36");
assert.ok(/rMin = 3\.36/.test(html), "today 0-zoom radius is 3.36");
assert.ok(/data-tl-scrub/.test(html) && /data-tl-date/.test(html), "scrub keeps data-tl-scrub / data-tl-date");
assert.ok(html.indexOf("data-tl-scrub-input") !== -1, "native range is a keyboard a11y fallback only");
assert.ok(!/<input[^>]*data-tl-scrub[\s>=]/.test(html), "visible scrub host is not a native range input");
assert.ok(/role="slider"/.test(html), "scrub stays a keyboard slider");
assert.ok(/transport-controls/.test(html), "play/stop/fps sit on their own row");
assert.ok(/alignToday/.test(src), "today overlays last packed frame coords");
assert.ok(typeof tl.scrubDaysPerPx === "function", "fine-scrub scale is exported");

var width = 400;
var nSteps = 2655;
var coarse = tl.scrubDaysPerPx(0, width, nSteps);
assert.ok(Math.abs(coarse - nSteps / width) < 1e-12, "on-track scrub is 1:1");
var far = tl.scrubDaysPerPx(tl.SCRUB_FINE_RANGE_PX, width, nSteps);
assert.ok(Math.abs(far - 1 / tl.SCRUB_DAY_STEP_PX) < 1e-12, "max vertical distance is one day per step");
var mid = tl.scrubDaysPerPx(tl.SCRUB_FINE_RANGE_PX * 0.5, width, nSteps);
assert.ok(mid < coarse && mid > far, "vertical-away interpolates toward day-by-day");
assert.strictEqual(tl.scrubKeyDelta("ArrowLeft"), -1, "arrow left is one day back");
assert.strictEqual(tl.scrubKeyDelta("ArrowRight"), 1, "arrow right is one day forward");
assert.strictEqual(tl.scrubKeyDelta("Home"), "start");
assert.strictEqual(tl.scrubKeyDelta("End"), "end");
assert.strictEqual(tl.scrubKeyDelta("a"), 0);

assert.strictEqual(tl.PACK_ID, "w10sm", "pack pin is w10sm");
assert.strictEqual(tl.withPack("/starlink/timeline/catalog.json"), "/starlink/timeline/catalog.json?v=w10sm");
assert.strictEqual(tl.withPack("/starlink/timeline/v1/2020-01.bin"), "/starlink/timeline/v1/2020-01.bin?v=w10sm");
assert.strictEqual(tl.withPack("/starlink/timeline/v1/2020-01.bin?v=w10sm"), "/starlink/timeline/v1/2020-01.bin?v=w10sm");
assert.ok(src.indexOf("force-cache") === -1, "bins must not force-cache");
assert.ok(/LOAD_ATTEMPTS = 3/.test(src), "retry failed month fetches 3 times");
assert.ok(/status === "failed"/.test(src), "file-load failure is failed, not missing");
assert.ok(!/status: "missing"/.test(src), "do not permanently mark a month missing");
assert.ok(/PREFETCH_MONTHS = 2/.test(src), "prefetch current + next 2 months");
assert.ok(/rec.status !== "ok"/.test(src), "play waits until the next month bin is ok");
assert.ok(/timeline\.js\?v=7/.test(html), "player script is timeline.js?v=7");
assert.ok(html.indexOf("catalog.json?v=w10sm") !== -1, "catalog url is pack-busted");
assert.ok(html.indexOf(".bin?v=w10sm") !== -1, "bin url is pack-busted");
assert.ok(/alignToday\(data\.sats\)\.then\(function \(\) \{ draw\(\); \}/.test(html), "Today waits for last packed frame before first draw");

console.log("timeline fixture decode: ok");
console.log("  magic=" + m.magic + " n_days=" + m.nDays + " catalog_len=" + m.catalogLen);
var d0 = m.days[0];
var xy0 = d0.n ? " x=" + d0.x[0].toFixed(4) + " y=" + d0.y[0].toFixed(4) : "";
console.log("  day0 dots=" + d0.n + " flags=" + d0.flags + xy0);
