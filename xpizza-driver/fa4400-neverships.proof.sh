#!/usr/bin/env bash
# fa4400-neverships.proof.sh — MUTANT proof that the brand-orange never-ship guards are load-bearing. For each gap
# Codex r1 flagged, inject the threat into index.html and assert the matching test turns RED; a clean tree is GREEN.
# Reversible: index.html is backed up and restored via a trap (no git stash/checkout — uncommitted work is untouched).
# Covers the STATIC half (fa4400-neverships.test.js) and the BROWSER half (fa4400-render.browser.test.js). The browser
# mutants need a headless Chrome; if none resolves they are reported SKIP (not PASS). Run: bash fa4400-neverships.proof.sh
set -u
cd "$(dirname "$0")"
TMP="$(mktemp -d)"
cp index.html "$TMP/index.html.bak"
restore() { cp "$TMP/index.html.bak" index.html; }
cleanup() { restore; rm -rf "$TMP"; }
trap cleanup EXIT

STATIC=(node fa4400-neverships.test.js)
BROWSER=(node fa4400-render.browser.test.js)
fail=0
run() { "$@" >/dev/null 2>&1; echo $?; }

expect() { # $1=label $2=GREEN|RED $3=exit
  if { [ "$2" = GREEN ] && [ "$3" -eq 0 ]; } || { [ "$2" = RED ] && [ "$3" -ne 0 ]; }; then
    echo "PASS  [$2]  $1  (exit=$3)"; else echo "FAIL  [want $2]  $1  (exit=$3)"; fail=1; fi
}

# node mutators (operate on index.html; each preceded by restore)
ins_before_style1() { node -e 'const fs=require("fs"),f="index.html";let s=fs.readFileSync(f,"utf8");const i=s.indexOf("</style>");s=s.slice(0,i)+process.argv[1]+"\n"+s.slice(i);fs.writeFileSync(f,s);' "$1"; }
ins_before_style2() { node -e 'const fs=require("fs"),f="index.html";let s=fs.readFileSync(f,"utf8");const a=s.indexOf("</style>"),b=s.indexOf("</style>",a+1);const i=b<0?a:b;s=s.slice(0,i)+process.argv[1]+"\n"+s.slice(i);fs.writeFileSync(f,s);' "$1"; }
ins_inline() { node -e 'const fs=require("fs"),f="index.html";let s=fs.readFileSync(f,"utf8");const b=s.indexOf("<body");const j=s.indexOf(">",b)+1;s=s.slice(0,j)+process.argv[1]+s.slice(j);fs.writeFileSync(f,s);' "$1"; }
set_accent() { node -e 'const fs=require("fs"),f="index.html";let s=fs.readFileSync(f,"utf8");s=s.replace("--accent: #2F5FB8;","--accent: "+process.argv[1]+";");fs.writeFileSync(f,s);' "$1"; }

echo "== clean tree =="
restore; expect "static: clean" GREEN "$(run "${STATIC[@]}")"

echo "== STATIC mutants (fa4400-neverships.test.js) =="
# P2: grouped-selector bypass — a dot selector grouped with a slide selector must NOT launder the orange
restore; ins_before_style1 '.rchip.xp .rdot, .slide-confirm .slide-thumb { background: linear-gradient(90deg,#FA4400,#fff); }'
expect "grouped selector .rdot + .slide-thumb with orange" RED "$(run "${STATIC[@]}")"
# P2: baseline exemption must cover ONLY the --accent declaration, not other orange on the same line/rule
restore; ins_before_style1 '.leak { --accent: #FA4400; background: #FA4400; }'
expect "second orange decl beside --accent on one rule" RED "$(run "${STATIC[@]}")"
# P2 + rgb-form: a later orange override as rgb() must be caught (proper parse, not just hex)
restore; ins_before_style1 '.leak2 { background: rgb(250, 68, 0); }'
expect "orange as rgb(250,68,0)" RED "$(run "${STATIC[@]}")"
# P2: orange in the SECOND <style> block must be caught (all blocks scanned)
restore; ins_before_style2 '.leak3 { color: #fa4400; }'
expect "orange in the second <style> block (lowercase)" RED "$(run "${STATIC[@]}")"
# P2: inline orange must be caught
restore; ins_inline '<div style="background:#FA4400"></div>'
expect "inline style orange" RED "$(run "${STATIC[@]}")"
# higher-specificity :root override is NOT exempt (only bare :root --accent is)
restore; ins_before_style1 ':root:not(.zzz) { --accent: #FA4400; }'
expect "higher-specificity :root:not(.zzz) --accent orange" RED "$(run "${STATIC[@]}")"
restore; expect "static: restored clean" GREEN "$(run "${STATIC[@]}")"

echo "== BROWSER mutants (fa4400-render.browser.test.js) =="
if CHS_OK=$(node -e 'import("node:fs").then(fs=>{const {existsSync,readdirSync}=fs;const {join}=require("node:path");const {homedir}=require("node:os");for(const e of [process.env.CHROME_HEADLESS_SHELL,process.env.CHROME])if(e&&existsSync(e)){console.log(e);process.exit(0)}const r=join(homedir(),".cache","puppeteer","chrome-headless-shell");if(existsSync(r))for(const v of readdirSync(r))for(const sub of readdirSync(join(r,v))){const b=join(r,v,sub,"chrome-headless-shell");if(existsSync(b)){console.log(b);process.exit(0)}}process.exit(7)})' 2>/dev/null); then
  restore; expect "browser: clean" GREEN "$(run "${BROWSER[@]}")"
  # P1: --accent regressed to brand-orange (hex) → accent + every track render orange
  restore; set_accent '#FA4400'; expect "winning --accent = #FA4400 (hex)" RED "$(run "${BROWSER[@]}")"
  # P1: regressed as rgb() form
  restore; set_accent 'rgb(250,68,0)'; expect "winning --accent = rgb(250,68,0)" RED "$(run "${BROWSER[@]}")"
  # P1: a higher-specificity later override wins the cascade → orange
  restore; ins_before_style2 ':root:not(.zzz) { --accent: #FA4400; }'; expect "higher-specificity override wins → orange" RED "$(run "${BROWSER[@]}")"
  restore; expect "browser: restored clean" GREEN "$(run "${BROWSER[@]}")"
else
  echo "SKIP  browser mutants — no chrome-headless-shell resolved (set CHROME_HEADLESS_SHELL)"
fi

restore
echo
[ "$fail" -eq 0 ] && echo "ALL MUTANTS KILLED (exit 0)" || echo "SOME EXPECTATIONS UNMET (exit 1)"
exit "$fail"
