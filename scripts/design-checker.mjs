#!/usr/bin/env node
/**
 * PiCode 设计规范的页面检查：给用户做的网页（或 ```viz 片段）过十条硬规则里能机器判断的那些。
 *
 *   node check-page.mjs page.html [more.html …]     有违规时逐条列出并以 1 退出
 *
 * 查：圆角档位、间距档位（偶数）、控件高度不许 36、字号档位、阴影只用令牌或 1px 细环、颜色和字体只取令牌、
 * 不加字距、动效只动 opacity / transform（悬停换色可以）且时长在档位里、文案不用破折号和省略号、
 * 完整页面要引用 tokens.css。查不出来的（单层描边、对齐、同行同高）仍要自己按 SKILL.md 对照。
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const RADII = new Set([0, 6, 8, 10, 14, 18]);
const SPACING = new Set([0, 1, 2, 4, 6, 8, 10, 12, 14, 16, 20, 24, 28, 32, 40, 48]);
const FONT_SIZES = new Set([10, 11, 12, 13, 14, 15, 16, 18, 20, 24, 28, 32, 40, 48]);
const DURATIONS = new Set([100, 150, 200, 220, 300]);
const MOTION_PROPS = new Set(["opacity", "transform", "translate", "scale", "rotate", "grid-template-rows",
  "background-color", "color", "border-color", "fill", "stroke", "visibility"]);
const KEYFRAME_PROPS = new Set(["opacity", "transform", "translate", "scale", "rotate", "offset", "visibility"]);
const SPACING_PROPS = /^(margin|padding)(-(top|right|bottom|left|inline|block)(-(start|end))?)?$|^(row-|column-)?gap$/;
const COLOR_WORDS = /\b(white|black|red|green|blue|gray|grey|yellow|orange|purple|pink|silver)\b/i;
const COLOR_LITERAL = /#[0-9a-f]{3,8}\b|\b(rgba?|hsla?|oklch|oklab|lab|lch|hwb|color)\(/i;

/** 去掉 var(...)（含嵌套与回退值）：令牌及其回退都算合规。 */
function stripVars(v) {
  let out = v;
  for (let guard = 0; guard < 20 && /var\(/.test(out); guard++) out = out.replace(/var\((?:[^()]|\([^()]*\))*\)/g, "");
  return out;
}
const px = (v) => [...stripVars(v).matchAll(/(-?\d*\.?\d+)px\b/g)].map((m) => Number(m[1]));

function lineAt(src, idx) {
  let n = 1;
  for (let i = 0; i < idx; i++) if (src.charCodeAt(i) === 10) n++;
  return n;
}

/** 页面里的 CSS 片段：<style> 块与 style="" 属性，带它们在原文里的起点。 */
function cssChunks(html) {
  const out = [];
  for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) out.push({ css: m[1], at: m.index + m[0].indexOf(m[1]) });
  for (const m of html.matchAll(/\sstyle\s*=\s*("([^"]*)"|'([^']*)')/gi)) {
    const css = m[2] ?? m[3] ?? "";
    out.push({ css, at: m.index + m[0].indexOf(css) });
  }
  return out;
}

/** 按顶层逗号拆（括号里的逗号不算：color-mix(in oklab, var(--a), …)）。 */
function splitTop(v) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of v) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** box-shadow 的一段拆成记号（var() 与 color-mix() 整体算一个）。 */
const shadowTokens = (part) => part.trim().match(/[a-z-]+\((?:[^()]|\([^()]*\))*\)|[^\s]+/gi) ?? [];
const isLength = (t) => /^-?\d*\.?\d+(px)?$/.test(t) || /^var\(/i.test(t);
/** 整段就是一个令牌（var(--elev-pop)）。 */
const isTokenShadow = (part) => /^var\(--[a-z0-9-]+\)$/i.test(part.trim());
/**
 * 细环：没有偏移、没有模糊，只有扩散（0 0 0 1px 当描边；状态点外的 3px 光晕也是环）。扩散写令牌也算。
 */
function isRing(part) {
  const t = shadowTokens(part).filter((x) => x.toLowerCase() !== "inset");
  const lens = [];
  for (const x of t) {
    if (lens.length < 4 && isLength(x)) lens.push(x);
    else break;
  }
  if (lens.length !== 4) return false;
  const zero = (x) => /^0(px)?$/.test(x);
  if (!zero(lens[0]) || !zero(lens[1]) || !zero(lens[2])) return false;
  const spread = lens[3];
  return /^var\(/i.test(spread) || Number.parseFloat(spread) <= 4;
}

function checkDecl(prop, value, add) {
  const v = value.trim();
  const bare = stripVars(v);
  if (/^border(-[a-z]+)*-radius$/.test(prop)) {
    for (const n of px(v)) if (!RADII.has(n) && n < 999) add("radius", `圆角 ${n}px 不在档位（0 6 8 10 14 18 或全圆）`);
  } else if (SPACING_PROPS.test(prop)) {
    for (const n of px(v)) {
      const ok = SPACING.has(n) || (n > 48 && n % 8 === 0);
      if (!ok) add("spacing", `${prop} ${n}px 不在间距档位（偶数 0 到 48，更大的用 8 的倍数）`);
    }
  } else if (prop === "height" || prop === "min-height") {
    if (px(v).includes(36)) add("control-height", "控件高度不许 36px，用 24 28 32 40");
  } else if (prop === "font-size") {
    if (/^(inherit|initial|unset|smaller|larger)$/.test(v) || !bare.trim()) return;
    const ns = px(v);
    if (!ns.length) add("font-size", `字号 ${v} 请用字阶令牌 var(--fs-*) 或档位里的 px`);
    for (const n of ns) if (!FONT_SIZES.has(n)) add("font-size", `字号 ${n}px 不在字阶`);
  } else if (prop === "box-shadow") {
    if (/^none$/i.test(v)) return;
    for (const part of splitTop(v)) {
      if (!isTokenShadow(part) && !isRing(part)) {
        add("shadow", "阴影只用 var(--elev-thumb / --elev-pop / --elev-dialog)，或不带偏移和模糊的细环（0 0 0 1px）当描边");
      }
    }
    return;
  } else if (prop === "font-family") {
    if (!/^inherit$/.test(v) && bare.replace(/[\s,]/g, "") !== "") add("font-family", "字体只用 var(--font-sans) 或 var(--font-mono)");
    return;
  } else if (prop === "letter-spacing") {
    // 规范自己的三档字距走令牌（--tracking-normal / -label / -title），写死的值一律不许。
    if (!/^(0|0px|0em|normal|inherit)$/.test(v) && !/^var\(--tracking-[a-z]+\)$/.test(v)) add("letter-spacing", "不加字距（中文尤其不要），需要时用 var(--tracking-*)");
  } else if (prop === "transition" || prop === "transition-property" || prop === "animation" || prop === "transition-duration" || prop === "animation-duration") {
    const parts = splitTop(v);
    for (const part of parts) {
      const p = stripVars(part).trim();
      if (prop === "transition" || prop === "transition-property") {
        const name = p.split(/\s+/)[0];
        if (name && !/^\d/.test(name) && !MOTION_PROPS.has(name) && name !== "none") add("motion-property", `动效只动 opacity 和 transform（悬停换色可以），不要过渡 ${name}`);
      }
      if (prop !== "transition-property") {
        const infinite = /\binfinite\b/.test(p);
        for (const m of p.matchAll(/(\d*\.?\d+)(ms|s)\b/g)) {
          const ms = m[2] === "s" ? Number(m[1]) * 1000 : Number(m[1]);
          if (ms === 0 || DURATIONS.has(ms) || (infinite && ms >= 600)) continue;
          add("motion-duration", `时长 ${ms}ms 不在档位（100 150 200 220 300）`);
          break;
        }
      }
    }
  }
  if (prop !== "box-shadow" && (COLOR_LITERAL.test(bare) || COLOR_WORDS.test(bare)) && !/^(content|grid|font-feature)/.test(prop)) {
    add("color", `${prop} 里写死了颜色，请用 var(--brand) var(--foreground) 等令牌`);
  }
}

function checkCss(css, at, src, out) {
  // 关键帧里只许动 opacity / transform。
  for (const kf of css.matchAll(/@keyframes\s+[\w-]+\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)) {
    for (const d of kf[1].matchAll(/([a-z-]+)\s*:/g)) {
      if (!KEYFRAME_PROPS.has(d[1])) {
        out.push({ rule: "motion-property", line: lineAt(src, at + kf.index + kf[0].indexOf(d[0])), message: `关键帧里不要动 ${d[1]}，只动 opacity 和 transform` });
      }
    }
  }
  const body = css.replace(/@keyframes\s+[\w-]+\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g, (m) => " ".repeat(m.length)).replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length));
  for (const d of body.matchAll(/(?:^|[;{\s])(-?-?[a-z][a-z-]*)\s*:\s*([^;{}]+)/g)) {
    const prop = d[1];
    if (prop.startsWith("--")) continue; // 自定义属性：只是起名，用到的地方再查
    const line = lineAt(src, at + d.index + d[0].indexOf(prop));
    checkDecl(prop.toLowerCase(), d[2], (rule, message) => out.push({ rule, line, message }));
  }
}

function checkCopy(html, out) {
  const masked = html.replace(/<(style|script|code|pre|textarea)[\s\S]*?<\/\1>/gi, (m) => m.replace(/[^\n]/g, " ")).replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
  for (const m of masked.matchAll(/>([^<]+)</g)) {
    const text = m[1];
    const hits = [];
    // `--ease-out`、`var(--brand)` 这类变量名里的两条横线不是破折号。
    if (/[—–]|--(?![a-z-])/i.test(text)) hits.push("破折号");
    if (/…|\.\.\./.test(text)) hits.push("省略号");
    if (hits.length) out.push({ rule: "copy", line: lineAt(html, m.index + 1), message: `文案里有${hits.join("和")}：「${text.trim().slice(0, 30)}」` });
  }
}

/** 检查一份 HTML。完整页面（有 <!doctype> 或 <html>）还要求引用 tokens.css；```viz 片段的令牌由预览框注入。 */
export function checkPage(html) {
  const out = [];
  for (const { css, at } of cssChunks(html)) checkCss(css, at, html, out);
  checkCopy(html, out);
  const standalone = /<!doctype|<html[\s>]/i.test(html);
  if (standalone && !/<link[^>]+href\s*=\s*["'][^"']*tokens\.css["']/i.test(html)) {
    out.push({ rule: "tokens", line: 1, message: "完整页面要引用 tokens.css（<link rel=\"stylesheet\" href=\"tokens.css\">），数值写 var(--*)" });
  }
  return out.sort((a, b) => a.line - b.line);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error("用法：node check-page.mjs page.html [more.html …]");
    process.exit(2);
  }
  let bad = 0;
  for (const f of files) {
    const found = checkPage(readFileSync(f, "utf8"));
    bad += found.length;
    for (const v of found) console.log(`${f}:${v.line}  [${v.rule}] ${v.message}`);
  }
  console.log(bad ? `共 ${bad} 处不合规，改完再跑一次。` : "全部合规。");
  process.exit(bad ? 1 : 0);
}
