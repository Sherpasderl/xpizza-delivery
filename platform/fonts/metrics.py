#!/usr/bin/env python3
# ── PLAN-forms-fonts-preconnect r6.1 §2.1 — the METRIC-MATCHED FALLBACK numbers, as a committed step ─────────────────────
# capp F4 computed its size-adjust / ascent / descent / line-gap overrides by hand ("fontTools over a Spanish UI sample")
# and committed only the numbers. This file is that step, made reproducible:
#   • pinned fontTools (FONTTOOLS_PIN) and the pinned sample (sample.es.txt, its sha256 recorded in the manifest);
#   • the formula F4's own numbers satisfy (verified: Red Hat Text 400 vs Arial ⇒ ascent·size = hhea ascent/upm):
#       size-adjust     = avgAdvance(face @ weight, sample) / avgAdvance(fallback, sample)      (advances in em)
#       ascent-override = (hhea.ascent / upm) / size-adjust;   descent-override = (|hhea.descent| / upm) / size-adjust
#       line-gap-override = (hhea.lineGap / upm) / size-adjust
#     a variable face is INSTANCED at the requested weight first (fontTools.varLib.instancer).
#
#   python3 -P platform/fonts/metrics.py --derive <surface>   reads the REAL fallback fonts (macOS system files, or the pinned
#                                                             downloads named in the manifest), records their inputs WITH
#                                                             provenance, and writes the computed overrides into the manifest
#   python3 -P platform/fonts/metrics.py --check              OFFLINE: recomputes every override from the committed hosted woff2 +
#                                                             the recorded fallback inputs; any difference fails (exit 1)
# Hosted faces are read from the surface's first site (the sites are byte-identical; build-fonts.mjs --check enforces it).
import hashlib, json, os, sys

FONTTOOLS_PIN = '4.67.0'
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
MANIFEST = os.path.join(HERE, 'fonts.manifest.json')


def die(msg):
    print(f'metrics: FAILED — {msg}', file=sys.stderr)
    sys.exit(1)


try:
    import fontTools
    from fontTools.ttLib import TTFont
    from fontTools.varLib import instancer
except ImportError:
    die(f'fontTools {FONTTOOLS_PIN} is required (pip install fonttools=={FONTTOOLS_PIN} brotli)')
if fontTools.version != FONTTOOLS_PIN:
    die(f'fontTools {fontTools.version} != pinned {FONTTOOLS_PIN}')


def sha256(path):
    with open(path, 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()


def sample_text(man):
    s = man['sample']
    p = os.path.join(HERE, s['file'])
    if sha256(p) != s['sha256']:
        die(f"{s['file']} changed (sha256 != manifest) — a new sample is a deliberate re-derive (--derive)")
    with open(p, encoding='utf-8') as f:
        return ''.join(ch for ch in f.read() if not ch.isspace())


def font_inputs(path, weight, text):
    f = TTFont(path)
    if 'fvar' in f:
        f = instancer.instantiateVariableFont(f, {'wght': weight})
    upm = f['head'].unitsPerEm
    cmap = f.getBestCmap()
    hm = f['hmtx']
    adv = [hm[cmap[ord(c)]][0] for c in text if ord(c) in cmap]
    missing = sorted({c for c in text if ord(c) not in cmap})
    if missing:
        die(f'{os.path.basename(path)} @{weight} lacks sample glyphs {"".join(missing)!r} — the sample must be inside the face')
    h = f['hhea']
    return {'upm': upm, 'avgAdvanceEm': round(sum(adv) / len(adv) / upm, 6),
            'ascentEm': round(h.ascent / upm, 6), 'descentEm': round(-h.descent / upm, 6), 'lineGapEm': round(h.lineGap / upm, 6)}


def fetch_pinned(src):
    """A fallback with no macOS copy (Roboto / Noto Serif = Android): Google Fonts' own file at a VERSIONED url, verified
    against the recorded sha256 (when one is recorded). Downloaded to a temp dir only; never committed."""
    # curl, not urllib: it uses the system trust store (some Python builds ship without CA certs); TLS stays verified.
    import subprocess, tempfile
    d = tempfile.mkdtemp(prefix='fontsrc-')
    p = os.path.join(d, 'src.woff2')
    subprocess.run(['curl', '-sSf', '--max-time', '30', '-o', p, src['url']], check=True)
    return p


def overrides(face, fb):
    size = face['avgAdvanceEm'] / fb['avgAdvanceEm']
    pct = lambda v: f'{v * 100:.2f}%'
    return {'size-adjust': pct(size), 'ascent-override': pct(face['ascentEm'] / size),
            'descent-override': pct(face['descentEm'] / size), 'line-gap-override': pct(face['lineGapEm'] / size)}


def hosted_latin(man, surface, family):
    s = man['surfaces'][surface]
    slug = s['families'][family]['slug']
    d = os.path.join(ROOT, s['sites'][0], 'fonts')
    hits = sorted(n for n in os.listdir(d) if n.startswith(f'{slug}-latin.') and n.endswith('.woff2'))
    if len(hits) != 1:
        die(f'{surface}: expected one {slug}-latin.*.woff2 in {d}, found {hits}')
    return os.path.join(d, hits[0])


def compute(man, surface, derive):
    s = man['surfaces'][surface]
    text = sample_text(man)
    out = {}
    for family, fam in s['families'].items():
        face_path = hosted_latin(man, surface, family)
        for fb in fam['fallbacks']:
            face = font_inputs(face_path, fb['metricsAt'], text)
            src = man['systemFonts'][fb['against']]
            if derive:
                p = fetch_pinned(src) if src.get('url') else os.path.expanduser(src['path'])
                if not os.path.exists(p):
                    die(f"--derive needs {src.get('path') or src.get('url')} ({fb['against']})")
                if src.get('sha256') and sha256(p) != src['sha256']:
                    die(f"{fb['against']}: sha256 differs from the recorded pin — a different OS/font version; re-pin deliberately")
                src['sha256'] = sha256(p)
                src['inputs'] = font_inputs(p, src.get('instanceAt', fb['metricsAt']), text)
            if 'inputs' not in src:
                die(f"{fb['against']} has no recorded inputs — run --derive")
            key = f"{fb['name']}|{fb['weights']}"
            out[key] = {'face': face, 'against': fb['against'], 'overrides': overrides(face, src['inputs'])}
    return out


def main():
    args = sys.argv[1:]
    with open(MANIFEST, encoding='utf-8') as f:
        man = json.load(f)
    if args[:1] == ['--derive'] and len(args) == 2:
        surface = args[1]
        man['surfaces'][surface]['metrics'] = compute(man, surface, True)
        with open(MANIFEST, 'w', encoding='utf-8') as f:
            f.write(json.dumps(man, indent=2, ensure_ascii=False) + '\n')
        print(f'metrics: derived {surface} → fonts.manifest.json')
        return
    if args == ['--check']:
        bad = []
        for surface, s in man['surfaces'].items():
            if 'metrics' not in s:
                continue
            fresh = compute(man, surface, False)
            if fresh != s['metrics']:
                bad.append(surface)
        if bad:
            die(f'recomputed overrides differ from the manifest for {bad}')
        print('metrics: OK (every override recomputes from the committed faces + recorded fallback inputs)')
        return
    die('usage: metrics.py --derive <surface> | --check')


if __name__ == '__main__':
    main()
