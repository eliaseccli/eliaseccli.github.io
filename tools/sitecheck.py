#!/usr/bin/env python3
"""On-demand health check for eliaseccli.com.

  python3 tools/sitecheck.py               # static + browser checks against a local server
  python3 tools/sitecheck.py --static      # repo-only checks (fast, no browser)
  python3 tools/sitecheck.py --base https://eliaseccli.com   # browser checks against live

Prints ERROR / WARN / INFO lines; exits 1 if any ERROR. Checklist: /workspace/self-checks/site.md
"""
import argparse, collections, functools, hashlib, http.server, os, re, subprocess, sys, threading, urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKIP_DIRS = {".git", "vendor", "node_modules", "__pycache__"}
PRIVATE = ("/projects/", "/secret/")          # password / unlisted: must be noindex, not in sitemap
ORBIT_FAVICON = ("/spacex/",)                 # pages that use the SpaceX orbit-dot favicon
HEAD_OK = {"/projects/unlock.js", "/starlink/state.js", "/secret/secret.js"}  # must run before first paint (gates; Starlink view classes)
NO_ZOOM_OK = {"/spacex/", "/projects/planet/", "/projects/plop/", "/projects/muse/"}  # globe/game gestures: pinch zoom off on purpose
TITLE_SUFFIX = re.compile(r"\s[·\-–—|]\s*Elias\b")
AXE = Path.home() / ".cache/sitecheck/axe.min.js"
issues = collections.Counter()
CORPUS_NAMES = set()

def say(level, where, msg):
    issues[level] += 1
    print(f"{level:5} {where}: {msg}")

def files(*exts):
    for p in sorted(ROOT.rglob("*")):
        if p.is_file() and not SKIP_DIRS & set(p.relative_to(ROOT).parts) and (not exts or p.suffix in exts):
            yield p

def url_of(p):
    rel = "/" + p.relative_to(ROOT).as_posix()
    return rel[: -len("index.html")] if rel.endswith("/index.html") else rel

@functools.cache
def soup(p):
    from bs4 import BeautifulSoup
    return BeautifulSoup(p.read_text(encoding="utf-8"), "lxml")

def is_redirect(s):
    return bool(s.find("meta", attrs={"http-equiv": re.compile("refresh", re.I)}))

def meta(s, **attrs):
    m = s.find("meta", attrs=attrs)
    return m.get("content", "") if m else None

def resolve(base_url, ref):
    """Local file for a same-site reference, or None if external / not a file ref."""
    u = urllib.parse.urlsplit(ref)
    if u.scheme in ("http", "https"):
        if u.netloc not in ("eliaseccli.com", "www.eliaseccli.com"):
            return None
    elif u.scheme or ref.startswith(("#", "//")) or not u.path:
        return None
    path = urllib.parse.urljoin(base_url, u.path)
    f = ROOT / urllib.parse.unquote(path).lstrip("/")
    return f / "index.html" if path.endswith("/") else f

def nav_items():
    return re.findall(r'\["(/[^"]*)",\s*"([^"]+)"\]', (ROOT / "nav.js").read_text())

# ---------------------------------------------------------------- static checks
def check_pages():
    pages = [p for p in files(".html") if p.name == "index.html"]
    sitemap = set(re.findall(r"<loc>https://eliaseccli\.com(/[^<]*)</loc>", (ROOT / "sitemap.xml").read_text()))
    icon_sets = {}
    for p in pages:
        u, s = url_of(p), soup(p)
        private, redirect = u.startswith(PRIVATE), is_redirect(s)
        robots = (meta(s, name="robots") or "").lower()
        title = s.title.get_text(strip=True) if s.title else ""
        for label, val in (("title", title), ("og:title", meta(s, property="og:title")), ("twitter:title", meta(s, name="twitter:title"))):
            if val and TITLE_SUFFIX.search(val):
                say("ERROR", u, f'{label} has an "Elias" suffix: {val!r}')
        if not title:
            say("ERROR", u, "missing <title>")
        if not (s.html and s.html.get("lang")):
            say("WARN", u, "missing <html lang>")
        if private or redirect:
            if "noindex" not in robots:
                say("ERROR", u, "private/redirect page without <meta name=robots content=noindex>")
            if u in sitemap:
                say("ERROR", u, "private/redirect page listed in sitemap.xml")
        else:
            if "noindex" in robots:
                say("ERROR", u, "public page is noindex")
            if u not in sitemap:
                say("ERROR", u, "public page missing from sitemap.xml")
            canon = s.find("link", rel="canonical")
            if not canon or canon.get("href") != "https://eliaseccli.com" + u:
                say("ERROR", u, f"canonical should be https://eliaseccli.com{u}")
            for key in ("description",):
                if not meta(s, name=key):
                    say("WARN", u, f"missing meta {key}")
            for key in ("og:title", "og:description", "og:image", "og:url"):
                if not meta(s, property=key):
                    say("WARN", u, f"missing {key}")
            if meta(s, property="og:url") not in (None, "https://eliaseccli.com" + u):
                say("ERROR", u, "og:url does not match the page URL")
        if not redirect:
            if not meta(s, name="viewport"):
                say("ERROR", u, "missing viewport meta")
            hrefs = [l.get("href", "") for l in s.find_all("link", rel=lambda r: r and ("icon" in r or "apple-touch-icon" in r))]
            icons = tuple(sorted(urllib.parse.urljoin(u, h) for h in hrefs))
            want = "/spacex/" if u.startswith(ORBIT_FAVICON) else "/"
            if not icons or any(urllib.parse.urlsplit(h).path.rsplit("/", 1)[0] + "/" != want for h in icons):
                say("ERROR", u, f"favicons should all come from {want}: {icons}")
            if len(set(icons)) != len(icons):
                say("WARN", u, "duplicate favicon <link>")
            icon_sets.setdefault(want, collections.Counter())[icons] += 1
            check_nav(u, s, p)
            check_head_perf(u, s)
            for sc in s.find_all("script", src=False):
                if sc.get("type") != "application/ld+json" and sc.get_text(strip=True):
                    say("WARN", u, "inline <script>: move it into a versioned .js file (cacheable, one source)")
            for img in s.find_all("img"):
                if img.get("alt") is None:
                    say("WARN", u, f"<img> without alt: {img.get('src')}")
    for want, sets in icon_sets.items():
        if len(sets) > 1:
            say("ERROR", "favicons", f"{want}* pages use {len(sets)} different icon sets: {dict(sets)}")
    for loc in sitemap:
        if not resolve("/", loc).exists():
            say("ERROR", "sitemap.xml", f"{loc} does not exist")
    if "Sitemap:" not in (ROOT / "robots.txt").read_text():
        say("WARN", "robots.txt", "no Sitemap line")

def check_nav(u, s, p):
    nav = s.find(attrs={"data-nav": True})
    if not nav:
        return
    lst = nav.find(id="nav-list")
    if lst is None or lst.find("li"):
        say("ERROR", u, "nav list must be empty <ul id=nav-list>; items come from /nav.js")
    if not s.find("script", src=re.compile(r"^/nav\.js\?v=")):
        say("ERROR", u, "menu page does not load /nav.js?v=")
    if not s.find("link", href=re.compile(r"^/nav\.css\?v=")):
        say("ERROR", u, "menu page does not load /nav.css?v=")

def check_head_perf(u, s):
    head = s.head
    if not head:
        return
    for sc in head.find_all("script", src=True):
        if not (sc.has_attr("defer") or sc.has_attr("async") or sc.get("type") == "module" or urllib.parse.urlsplit(urllib.parse.urljoin(u, sc["src"])).path in HEAD_OK):
            say("WARN", u, f"render-blocking script in <head>: {sc['src']}")

def refs_in_html(p):
    s, base = soup(p), url_of(p)
    for tag, attr in (("a", "href"), ("link", "href"), ("script", "src"), ("img", "src"), ("source", "src"), ("source", "srcset"), ("video", "poster")):
        for el in s.find_all(tag):
            v = el.get(attr)
            if v:
                yield base, v.split()[0], tag

def refs_in_text(p):
    """url(...) in CSS, static import/fetch/new Worker/new URL string literals in JS."""
    base = url_of(p)
    text = p.read_text(encoding="utf-8", errors="ignore")
    pats = [r"url\(\s*['\"]?([^'\")]+)"] if p.suffix == ".css" else [
        r"""(?:import|from)\s*\(?\s*["']([./][^"']+)["']""", r"""fetch\(\s*["']([./][^"'$`]+)["']""",
        r"""new\s+(?:Worker|URL)\(\s*["']([./][^"']+)["']"""]
    for pat in pats:
        for m in re.finditer(pat, text):
            if not m.group(1).startswith("data:"):
                yield base, m.group(1), "css" if p.suffix == ".css" else "js"

def check_links():
    refs = collections.defaultdict(set)   # asset path -> {(page, version)}
    srcs = [(p, refs_in_html(p)) for p in files(".html")] + [(p, refs_in_text(p)) for p in files(".css", ".js")]
    for p, it in srcs:
        for base, ref, kind in it:
            f = resolve(base, ref)
            if f is None or ref.endswith("/") and kind in ("js", "css"):
                continue
            if not f.exists():
                say("ERROR", url_of(p), f"broken {kind} reference: {ref}")
                continue
            if f.suffix in (".css", ".js", ".json") and kind in ("link", "script", "js", "css"):
                v = urllib.parse.parse_qs(urllib.parse.urlsplit(ref).query).get("v", [None])[0]
                refs[f].add((url_of(p), v))
    for f, uses in sorted(refs.items()):
        name = "/" + f.relative_to(ROOT).as_posix()
        versions = {v for _, v in uses}
        if None in versions and f.suffix != ".json" and "vendor" not in f.parts:
            say("WARN", name, f"loaded without ?v= cache-bust by {sorted(u for u, v in uses if v is None)}")
        if len(versions - {None}) > 1:
            say("ERROR", name, f"loaded with different ?v= versions: {sorted(uses, key=str)}")
        for page, v in uses:
            if v and stale(f, v, page):
                say("ERROR", name, f"changed after its ?v={v} was set (bump it, referenced from {page})")

def git(*a):
    return subprocess.run(["git", "-C", str(ROOT), *a], capture_output=True, text=True).stdout.strip()

def stale(f, v, page):
    """Asset committed (or edited) after the commit that introduced its current ?v= in the referencing file."""
    rel, src = f.relative_to(ROOT).as_posix(), page_file(page)
    needle = f"{f.name}?v={v}"
    if git("status", "--porcelain", "--", src):        # reference edited, not committed yet
        added = [l for l in git("diff", "HEAD", "--", src).splitlines() if l.startswith("+")]
        if not any(needle in l for l in added):
            return bool(git("status", "--porcelain", "--", rel))
        return False
    changed = git("log", "-1", "--format=%ct", "--", rel)
    bumped = git("log", "-1", "--format=%ct", "-S", needle, "--", src)
    return bool(git("status", "--porcelain", "--", rel)) or bool(changed and bumped and int(changed) > int(bumped))

def page_file(u):
    return u.lstrip("/") + "index.html" if u.endswith("/") else u.lstrip("/")

def check_duplication():
    """Identical CSS rules and identical 6-line code windows shared by different files."""
    rules = collections.defaultdict(set)
    windows = collections.defaultdict(set)
    for p in files(".css", ".html", ".js"):
        text = p.read_text(encoding="utf-8", errors="ignore")
        if p.suffix == ".html":
            text = "\n".join(re.findall(r"<(?:style|script)[^>]*>(.*?)</(?:style|script)>", text, re.S))
        if any(len(l) > 400 for l in text.splitlines()):
            continue  # minified
        name = "/" + p.relative_to(ROOT).as_posix()
        if p.suffix in (".css", ".html"):
            for sel, body in re.findall(r"([^{}]+)\{([^{}]+)\}", text):
                body = " ".join(body.split())
                if body.count(";") >= 3:
                    rules[(" ".join(sel.split()), body)].add(name)
        lines = [" ".join(l.split()) for l in text.splitlines()]
        lines = [l for l in lines if len(l) > 12 and not l.startswith(("//", "/*", "*"))]
        for i in range(len(lines) - 5):
            windows[hashlib.sha1("\n".join(lines[i:i + 6]).encode()).hexdigest()].add((name, i))
    dup_rules = collections.Counter()
    for (sel, _), where in rules.items():
        if len(where) > 1:
            dup_rules[tuple(sorted(where))] += 1
    for where, n in dup_rules.most_common():
        if n >= 3:  # a couple of shared base rules (html/body/.stars) per page is fine; more means a shared file
            say("WARN", "duplication", f"{n} identical CSS rule(s) in {', '.join(where)}")
    pairs = collections.Counter()
    for occ in windows.values():
        names = sorted({n for n, _ in occ})
        for a in range(len(names)):
            for b in range(a + 1, len(names)):
                pairs[(names[a], names[b])] += 1
    for (a, b), n in pairs.most_common():
        if n >= 20:
            say("WARN", "duplication", f"~{n + 5} duplicated code lines shared by {a} and {b}")

def check_dead_files():
    global CORPUS_NAMES
    corpus = "\n".join(p.read_text(encoding="utf-8", errors="ignore") for p in files(".html", ".css", ".js", ".json", ".py", ".yml", ".md", ".txt", ".xml", ".webmanifest") if p.stat().st_size < 3_000_000)
    exempt = re.compile(r"^(CNAME|robots\.txt|sitemap\.xml|README\.md|LICENSE.*|OFL\.txt|\.gitignore|\.gitkeep|favicon\.ico|apple-touch-icon\.png)$|^\.github/|^tools/|^starlink/refresh/|^starlink/timeline/v1/|(^|/)test_[^/]*$")
    CORPUS_NAMES = {p.name for p in files() if p.name in corpus}
    dead = collections.defaultdict(list)
    for p in files():
        rel = p.relative_to(ROOT).as_posix()
        if not (exempt.search(p.name) or exempt.search(rel)) and p.name not in corpus:
            dead[str(p.parent.relative_to(ROOT))].append(p)
    for d, ps in sorted(dead.items()):
        kb = sum(p.stat().st_size for p in ps) // 1024
        names = ", ".join(p.name for p in ps[:4]) + (f" (+{len(ps) - 4} more)" if len(ps) > 4 else "")
        say("WARN", f"/{d}/", f"not referenced anywhere, {kb} KB - dead? {names}")

def check_sizes():
    for p in files():
        if p.name not in CORPUS_NAMES:
            continue
        kb = p.stat().st_size // 1024
        rel = "/" + p.relative_to(ROOT).as_posix()
        if kb > 1500 and not rel.startswith(("/starlink/timeline/", "/projects/muse/vendor/")):
            say("INFO", rel, f"large file: {kb} KB")

def check_tests():
    """Repo unit tests that run offline: Starlink timeline decode (node) and refresh pipeline (unittest)."""
    runs = [(["node", "test_decode.js"], "starlink/test_decode.js"),
            ([sys.executable, "-m", "unittest", "discover", "-s", "refresh", "-t", ".", "-p", "test_*.py"], "starlink/refresh tests")]
    for cmd, name in runs:
        try:
            r = subprocess.run(cmd, cwd=ROOT / "starlink", capture_output=True, text=True, timeout=600,
                               env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            say("INFO", name, f"not run: {e}")
            continue
        if r.returncode:
            out = (r.stdout + r.stderr).strip().splitlines() or ["(no output)"]
            why = next((l for l in out if re.search(r"^\w*Error\b|^FAIL", l)), out[-1])
            say("ERROR", name, "failing: " + why.strip()[:200])

# ---------------------------------------------------------------- browser checks
def serve():
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass
    handler = functools.partial(Quiet, directory=str(ROOT))
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{srv.server_port}"

UNLOCK = """try{if(location.pathname.startsWith('/projects/')&&location.pathname!=='/projects/'){
localStorage.setItem('projects.ok','<p>check</p>');localStorage.setItem('projects.ok.exp',String(Date.now()+36e5));}}catch(e){}"""
NOISE = re.compile(r"cloudflareinsights|static\.cloudflareinsights|ERR_FAILED|favicon\.ico")

def check_browser(base, only):
    from playwright.sync_api import sync_playwright
    pages = [url_of(p) for p in files(".html") if p.name == "index.html" and not is_redirect(soup(p))]
    if only:
        pages = [u for u in pages if u in only]
    expected = nav_items()
    axe = AXE.read_text() if AXE.exists() else None
    if not axe:
        say("INFO", "a11y", f"axe-core not found at {AXE}; skipping contrast/label audit")
    origin = urllib.parse.urlsplit(base).netloc
    with sync_playwright() as pw:
        exe = "/opt/google/chrome/chrome" if os.path.exists("/opt/google/chrome/chrome") else None
        browser = pw.chromium.launch(executable_path=exe, args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        for label, opts in (("desktop", dict(viewport={"width": 1280, "height": 800})),
                            ("phone", dict(viewport={"width": 402, "height": 874}, device_scale_factor=3, is_mobile=True, has_touch=True))):
            ctx = browser.new_context(**opts)
            ctx.add_init_script(UNLOCK)
            for u in pages:
                pg, problems = ctx.new_page(), []
                pg.on("pageerror", lambda e: problems.append(f"JS exception: {e}"))
                pg.on("console", lambda m: m.type == "error" and not NOISE.search(m.text) and problems.append(f"console: {m.text[:200]}"))
                pg.on("response", lambda r: r.status >= 400 and urllib.parse.urlsplit(r.url).netloc == origin and problems.append(f"HTTP {r.status} {r.url}"))
                pg.on("requestfailed", lambda r: urllib.parse.urlsplit(r.url).netloc == origin and not NOISE.search(r.failure or "") and problems.append(f"failed {r.url} {r.failure}"))
                try:
                    pg.goto(base + u, wait_until="load", timeout=60000)
                    pg.wait_for_timeout(2500)
                except Exception as e:
                    problems.append(f"load: {e}")
                where = f"{u} [{label}]"
                for msg in problems:
                    say("ERROR", where, msg)
                if pg.query_selector("[data-nav]"):
                    got = pg.eval_on_selector_all("#nav-list a", "as => as.map(a => [a.getAttribute('href'), a.textContent.trim()])")
                    if [tuple(x) for x in got] != expected:
                        say("ERROR", where, f"menu items {got} != nav.js")
                    elif not pg.query_selector("#nav-list a[aria-current]"):
                        say("WARN", where, "no menu item marked aria-current")
                    pg.click("[data-nav-btn]"); pg.wait_for_timeout(250)
                    if pg.eval_on_selector("#nav-list", "l => l.hidden"):
                        say("ERROR", where, "menu does not open")
                    pg.keyboard.press("Escape"); pg.wait_for_timeout(150)
                    if not pg.eval_on_selector("#nav-list", "l => l.hidden"):
                        say("ERROR", where, "Escape does not close the menu")
                if label == "desktop":
                    kb = pg.evaluate("performance.getEntriesByType('resource').concat(performance.getEntriesByType('navigation')).reduce((s,e)=>s+(e.decodedBodySize||0),0)/1024")
                    say("INFO", u, f"page weight on load: {kb:,.0f} KB")
                    if axe:
                        try:
                            pg.add_script_tag(content=axe)
                            res = pg.evaluate("axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa']},resultTypes:['violations']}).then(r=>r.violations.map(v=>[v.id,v.impact,v.nodes.length,v.nodes.slice(0,3).map(n=>n.target.join(' '))]))")
                            for vid, impact, n, targets in res:
                                if vid == "meta-viewport" and u in NO_ZOOM_OK:
                                    continue
                                say("WARN", where, f"a11y {vid} ({impact}) x{n}: {targets}")
                        except Exception as e:
                            say("INFO", where, f"axe failed: {str(e)[:120]}")
                pg.close()
            ctx.close()
        browser.close()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--static", action="store_true", help="skip browser checks")
    ap.add_argument("--base", help="base URL for browser checks (default: local server on the repo)")
    ap.add_argument("--pages", help="comma-separated page paths for browser checks, e.g. /,/starlink/")
    a = ap.parse_args()
    check_pages(); check_links(); check_duplication(); check_dead_files(); check_sizes(); check_tests()
    if not a.static:
        check_browser((a.base or serve()).rstrip("/"), set(a.pages.split(",")) if a.pages else None)
    print(f"\n{issues['ERROR']} errors, {issues['WARN']} warnings, {issues['INFO']} info")
    sys.exit(1 if issues["ERROR"] else 0)

if __name__ == "__main__":
    main()
