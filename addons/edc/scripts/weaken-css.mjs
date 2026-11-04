// The add-on's style sheet is injected after the POS's. Its utilities have the same weight as the POS's, so a plain
// add-on rule (e.g. .flex-col) would win over a POS screen-size rule (e.g. lg:flex-row) on POS screens: Settings once
// stacked its menu above the page. Here every selector in the add-on's utilities layer is wrapped in :where(), which
// gives it zero specificity: the add-on's classes still style its own screens, but any POS rule that disagrees wins.
// Pseudo-elements (::before, ::placeholder...) stay outside :where(), where CSS requires them.

/** Wraps one selector list: ".a:hover, .b::before" -> ":where(.a:hover), :where(.b)::before". */
export function weakenSelector(list) {
  return splitTop(list, ',').map((sel) => {
    const s = sel.trim();
    if (!s) return s;
    const m = /^(.*?)(::[a-zA-Z-]+(?:\([^)]*\))?)$/.exec(s);
    return m && m[1] ? `:where(${m[1]})${m[2]}` : m ? s : `:where(${s})`;
  }).join(',');
}

/** Splits on a character at the top level (not inside brackets, parentheses or strings). */
function splitTop(text, ch) {
  const out = [];
  let depth = 0, quote = null, start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') { i++; continue; }
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ch && depth === 0) { out.push(text.slice(start, i)); start = i + 1; }
  }
  out.push(text.slice(start));
  return out;
}

/** Index of the "}" that closes the block opened at text[open] === "{". */
function closing(text, open) {
  let depth = 0, quote = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') { i++; continue; }
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  throw new Error('unbalanced CSS');
}

/** Rewrites a block's contents: rule selectors weakened; @media/@supports recursed; @keyframes, @property left alone. */
function weakenBlock(text) {
  let out = '', i = 0;
  while (i < text.length) {
    const open = indexOfTop(text, '{', i);
    if (open < 0) { out += text.slice(i); break; }
    const prelude = text.slice(i, open);
    const close = closing(text, open);
    const body = text.slice(open + 1, close);
    const p = prelude.trim();
    if (p.startsWith('@media') || p.startsWith('@supports') || p.startsWith('@container') || p.startsWith('@layer')) out += `${prelude}{${weakenBlock(body)}}`;
    else if (p.startsWith('@')) out += `${prelude}{${body}}`; // @keyframes, @property, @font-face
    else out += `${weakenSelector(prelude)}{${body}}`;
    i = close + 1;
  }
  return out;
}

function indexOfTop(text, ch, from) {
  let quote = null;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') { i++; continue; }
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === ch) return i;
  }
  return -1;
}

/** Weakens the selectors inside every "@layer utilities{...}" block of a Tailwind build; the rest is unchanged. */
export function weakenUtilities(css) {
  let out = '', i = 0;
  for (;;) {
    const at = css.indexOf('@layer utilities{', i);
    if (at < 0) return out + css.slice(i);
    const open = at + '@layer utilities'.length;
    const close = closing(css, open);
    out += css.slice(i, open) + '{' + weakenBlock(css.slice(open + 1, close)) + '}';
    i = close + 1;
  }
}
