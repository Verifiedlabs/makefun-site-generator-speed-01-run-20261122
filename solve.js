// Fast drop-in implementation of makefun-site 1.0.0.
// v4: Direct-to-UTF-8-Slab Zero-Alloc Markdown Engine, Direct UTF-8 JSON Output Arena,
// Zero-Alloc Card Slab Memoization, Single-Pass memmem Frontmatter, and Flat-Op Folded Templates.

import { writeSync } from 'node:fs';

const REPORT_FILE = 'build-report.txt';
const RESERVED_ROOT = ['posts', 'tags', 'page'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const INCLUDE_DEPTH = 8;
const SLUG_MAX = 64;

// ---------------------------------------------------------------- Escaping Tables & Helpers

const HEX = '0123456789abcdef';
const HEX_BYTES = new Uint8Array(16);
for (let i = 0; i < 16; i++) HEX_BYTES[i] = HEX.charCodeAt(i);

function ctrlEscape(c) {
  if (c === 10) return '\\n';
  if (c === 9) return '\\t';
  if (c === 13) return '\\r';
  if (c === 8) return '\\b';
  if (c === 12) return '\\f';
  return '\\u00' + HEX[(c >> 4) & 15] + HEX[c & 15];
}

function surrogateEscape(c) {
  return '\\u' + HEX[(c >> 12) & 15] + HEX[(c >> 8) & 15] + HEX[(c >> 4) & 15] + HEX[c & 15];
}

const HTML_TRIG = new Uint8Array(128);
HTML_TRIG[38] = 1; // &
HTML_TRIG[60] = 2; // <
HTML_TRIG[62] = 3; // >
HTML_TRIG[34] = 4; // "
HTML_TRIG[39] = 5; // '

const JSON_TRIG = new Uint8Array(128);
for (let i = 0; i < 32; i++) JSON_TRIG[i] = 1;
JSON_TRIG[34] = 2; // "
JSON_TRIG[92] = 3; // \

const HTML_JSON_TRIG = new Uint8Array(128);
for (let i = 0; i < 32; i++) HTML_JSON_TRIG[i] = 7;
HTML_JSON_TRIG[38] = 1;
HTML_JSON_TRIG[60] = 2;
HTML_JSON_TRIG[62] = 3;
HTML_JSON_TRIG[34] = 4;
HTML_JSON_TRIG[39] = 5;
HTML_JSON_TRIG[92] = 6;

const ESCAPABLE = new Uint8Array(128);
for (const ch of '\\`*_[]()#+-.!>') ESCAPABLE[ch.charCodeAt(0)] = 1;

const INLINE_TRIG_HTML = new Uint8Array(128);
INLINE_TRIG_HTML[38] = 1;
INLINE_TRIG_HTML[60] = 2;
INLINE_TRIG_HTML[62] = 3;
INLINE_TRIG_HTML[34] = 4;
INLINE_TRIG_HTML[39] = 5;
INLINE_TRIG_HTML[92] = 6;
INLINE_TRIG_HTML[96] = 7;
INLINE_TRIG_HTML[42] = 8;
INLINE_TRIG_HTML[91] = 9;

const INLINE_TRIG_JSON = new Uint8Array(128);
for (let i = 0; i < 32; i++) INLINE_TRIG_JSON[i] = 10;
INLINE_TRIG_JSON[38] = 1;
INLINE_TRIG_JSON[60] = 2;
INLINE_TRIG_JSON[62] = 3;
INLINE_TRIG_JSON[34] = 4;
INLINE_TRIG_JSON[39] = 5;
INLINE_TRIG_JSON[92] = 6;
INLINE_TRIG_JSON[96] = 7;
INLINE_TRIG_JSON[42] = 8;
INLINE_TRIG_JSON[91] = 9;

function escapeHtml(s) {
  return escapeHtmlRange(s, 0, s.length);
}

function escapeHtmlRange(s, start, end) {
  let last = start;
  let out = '';
  for (let i = start; i < end; i++) {
    const c = s.charCodeAt(i);
    if (c < 128) {
      const k = HTML_TRIG[c];
      if (k === 0) continue;
      if (i > last) out += s.slice(last, i);
      if (k === 1) out += '&amp;';
      else if (k === 2) out += '&lt;';
      else if (k === 3) out += '&gt;';
      else if (k === 4) out += '&quot;';
      else out += '&#39;';
      last = i + 1;
    }
  }
  if (last === start) return s.slice(start, end);
  return last < end ? out + s.slice(last, end) : out;
}

function escapeJson(s) {
  const len = s.length;
  let last = 0;
  let out = '';
  for (let i = 0; i < len; i++) {
    const c = s.charCodeAt(i);
    if (c < 128) {
      const k = JSON_TRIG[c];
      if (k === 0) continue;
      if (i > last) out += s.slice(last, i);
      if (k === 2) out += '\\"';
      else if (k === 3) out += '\\\\';
      else out += ctrlEscape(c);
      last = i + 1;
    } else if ((c & 0xf800) === 0xd800) {
      if (c <= 0xdbff && i + 1 < len) {
        const n = s.charCodeAt(i + 1);
        if (n >= 0xdc00 && n <= 0xdfff) {
          i++;
          continue;
        }
      }
      if (i > last) out += s.slice(last, i);
      out += surrogateEscape(c);
      last = i + 1;
    }
  }
  if (last === 0) return s;
  return last < len ? out + s.slice(last) : out;
}

function escapeHtmlJson(s) {
  const len = s.length;
  let last = 0;
  let out = '';
  for (let i = 0; i < len; i++) {
    const c = s.charCodeAt(i);
    if (c < 128) {
      const k = HTML_JSON_TRIG[c];
      if (k === 0) continue;
      if (i > last) out += s.slice(last, i);
      if (k === 1) out += '&amp;';
      else if (k === 2) out += '&lt;';
      else if (k === 3) out += '&gt;';
      else if (k === 4) out += '&quot;';
      else if (k === 5) out += '&#39;';
      else if (k === 6) out += '\\\\';
      else out += ctrlEscape(c);
      last = i + 1;
    } else if ((c & 0xf800) === 0xd800) {
      if (c <= 0xdbff && i + 1 < len) {
        const n = s.charCodeAt(i + 1);
        if (n >= 0xdc00 && n <= 0xdfff) {
          i++;
          continue;
        }
      }
      if (i > last) out += s.slice(last, i);
      out += surrogateEscape(c);
      last = i + 1;
    }
  }
  if (last === 0) return s;
  return last < len ? out + s.slice(last) : out;
}

// ---------------------------------------------------------------- Direct Byte Writers

function writeHtmlJsonRangeBytes(buf, off, s, start, end) {
  for (let i = start; i < end; i++) {
    const c = s.charCodeAt(i);
    if (c < 128) {
      const k = HTML_JSON_TRIG[c];
      if (k === 0) {
        buf[off++] = c;
      } else if (k === 1) {
        buf[off++] = 38; buf[off++] = 97; buf[off++] = 109; buf[off++] = 112; buf[off++] = 59;
      } else if (k === 2) {
        buf[off++] = 38; buf[off++] = 108; buf[off++] = 116; buf[off++] = 59;
      } else if (k === 3) {
        buf[off++] = 38; buf[off++] = 103; buf[off++] = 116; buf[off++] = 59;
      } else if (k === 4) {
        buf[off++] = 38; buf[off++] = 113; buf[off++] = 117; buf[off++] = 111; buf[off++] = 116; buf[off++] = 59;
      } else if (k === 5) {
        buf[off++] = 38; buf[off++] = 35; buf[off++] = 51; buf[off++] = 57; buf[off++] = 59;
      } else if (k === 6) {
        buf[off++] = 92; buf[off++] = 92;
      } else {
        buf[off++] = 92;
        if (c === 10) buf[off++] = 110;
        else if (c === 9) buf[off++] = 116;
        else if (c === 13) buf[off++] = 114;
        else if (c === 8) buf[off++] = 98;
        else if (c === 12) buf[off++] = 102;
        else {
          buf[off++] = 117; buf[off++] = 48; buf[off++] = 48;
          buf[off++] = HEX_BYTES[(c >> 4) & 15];
          buf[off++] = HEX_BYTES[c & 15];
        }
      }
    } else if (c < 0x800) {
      buf[off++] = 0xc0 | (c >> 6);
      buf[off++] = 0x80 | (c & 0x3f);
    } else if ((c & 0xf800) === 0xd800) {
      if (c <= 0xdbff && i + 1 < end) {
        const n = s.charCodeAt(i + 1);
        if (n >= 0xdc00 && n <= 0xdfff) {
          const cp = 0x10000 + (((c - 0xd800) << 10) | (n - 0xdc00));
          buf[off++] = 0xf0 | (cp >> 18);
          buf[off++] = 0x80 | ((cp >> 12) & 0x3f);
          buf[off++] = 0x80 | ((cp >> 6) & 0x3f);
          buf[off++] = 0x80 | (cp & 0x3f);
          i++;
          continue;
        }
      }
      buf[off++] = 92; buf[off++] = 117;
      buf[off++] = HEX_BYTES[(c >> 12) & 15];
      buf[off++] = HEX_BYTES[(c >> 8) & 15];
      buf[off++] = HEX_BYTES[(c >> 4) & 15];
      buf[off++] = HEX_BYTES[c & 15];
    } else {
      buf[off++] = 0xe0 | (c >> 12);
      buf[off++] = 0x80 | ((c >> 6) & 0x3f);
      buf[off++] = 0x80 | (c & 0x3f);
    }
  }
  return off;
}

function writeJsonBytes(buf, off, s) {
  const len = s.length;
  for (let i = 0; i < len; i++) {
    const c = s.charCodeAt(i);
    if (c < 128) {
      const k = JSON_TRIG[c];
      if (k === 0) {
        buf[off++] = c;
      } else if (k === 2) {
        buf[off++] = 92; buf[off++] = 34;
      } else if (k === 3) {
        buf[off++] = 92; buf[off++] = 92;
      } else {
        buf[off++] = 92;
        if (c === 10) buf[off++] = 110;
        else if (c === 9) buf[off++] = 116;
        else if (c === 13) buf[off++] = 114;
        else if (c === 8) buf[off++] = 98;
        else if (c === 12) buf[off++] = 102;
        else {
          buf[off++] = 117; buf[off++] = 48; buf[off++] = 48;
          buf[off++] = HEX_BYTES[(c >> 4) & 15];
          buf[off++] = HEX_BYTES[c & 15];
        }
      }
    } else if (c < 0x800) {
      buf[off++] = 0xc0 | (c >> 6);
      buf[off++] = 0x80 | (c & 0x3f);
    } else if ((c & 0xf800) === 0xd800) {
      if (c <= 0xdbff && i + 1 < len) {
        const n = s.charCodeAt(i + 1);
        if (n >= 0xdc00 && n <= 0xdfff) {
          const cp = 0x10000 + (((c - 0xd800) << 10) | (n - 0xdc00));
          buf[off++] = 0xf0 | (cp >> 18);
          buf[off++] = 0x80 | ((cp >> 12) & 0x3f);
          buf[off++] = 0x80 | ((cp >> 6) & 0x3f);
          buf[off++] = 0x80 | (cp & 0x3f);
          i++;
          continue;
        }
      }
      buf[off++] = 92; buf[off++] = 117;
      buf[off++] = HEX_BYTES[(c >> 12) & 15];
      buf[off++] = HEX_BYTES[(c >> 8) & 15];
      buf[off++] = HEX_BYTES[(c >> 4) & 15];
      buf[off++] = HEX_BYTES[c & 15];
    } else {
      buf[off++] = 0xe0 | (c >> 12);
      buf[off++] = 0x80 | ((c >> 6) & 0x3f);
      buf[off++] = 0x80 | (c & 0x3f);
    }
  }
  return off;
}

function writeAsciiBytes(buf, off, s) {
  const len = s.length;
  for (let i = 0; i < len; i++) buf[off++] = s.charCodeAt(i);
  return off;
}

// ---------------------------------------------------------------- Direct UTF-8 JSON Output Arena & Reusable Slabs

const ARENA_CAP = 4 * 1024 * 1024;

export function createJsonWriter(fd) {
  const buf = Buffer.allocUnsafe(ARENA_CAP);
  let off = 0;

  function flush() {
    if (off > 0) {
      writeSync(fd, buf, 0, off);
      off = 0;
    }
  }

  function writeByte(b) {
    if (off >= ARENA_CAP) flush();
    buf[off++] = b;
  }

  function writeBuf(chunk) {
    const n = chunk.length;
    if (n === 0) return;
    if (off + n <= ARENA_CAP) {
      buf.set(chunk, off);
      off += n;
    } else {
      flush();
      if (n <= ARENA_CAP) {
        buf.set(chunk, 0);
        off = n;
      } else {
        writeSync(fd, chunk, 0, n);
      }
    }
  }

  function writeSafeAscii(s) {
    const len = s.length;
    if (len === 0) return;
    if (off + len > ARENA_CAP) flush();
    if (len <= 96 && off + len <= ARENA_CAP) {
      off = writeAsciiBytes(buf, off, s);
    } else if (len * 3 <= ARENA_CAP) {
      if (off + len * 3 > ARENA_CAP) flush();
      off += buf.write(s, off, 'utf8');
    } else {
      flush();
      const b = Buffer.from(s, 'utf8');
      writeSync(fd, b, 0, b.length);
    }
  }

  function writeJsonEscaped(s) {
    const len = s.length;
    if (len === 0) return;
    const maxBytes = len * 6;
    if (off + maxBytes <= ARENA_CAP) {
      off = writeJsonBytes(buf, off, s);
    } else if (maxBytes <= ARENA_CAP) {
      flush();
      off = writeJsonBytes(buf, off, s);
    } else {
      flush();
      const b = Buffer.from(escapeJson(s), 'utf8');
      writeSync(fd, b, 0, b.length);
    }
  }

  function writeHtmlJsonEscaped(s) {
    const len = s.length;
    if (len === 0) return;
    const maxBytes = len * 6;
    if (off + maxBytes <= ARENA_CAP) {
      off = writeHtmlJsonRangeBytes(buf, off, s, 0, len);
    } else if (maxBytes <= ARENA_CAP) {
      flush();
      off = writeHtmlJsonRangeBytes(buf, off, s, 0, len);
    } else {
      flush();
      const b = Buffer.from(escapeHtmlJson(s), 'utf8');
      writeSync(fd, b, 0, b.length);
    }
  }

  function writeKeyOpen(key, first) {
    const maxNeed = key.length * 6 + 6;
    if (off + maxNeed > ARENA_CAP) flush();
    if (!first) buf[off++] = 44;
    buf[off++] = 34;
    off = writeJsonBytes(buf, off, key);
    buf[off++] = 34;
    buf[off++] = 58;
    buf[off++] = 34;
  }

  function writeValueClose() {
    if (off >= ARENA_CAP) flush();
    buf[off++] = 34;
  }

  return {
    flush,
    writeByte,
    writeBuf,
    writeSafeAscii,
    writeJsonEscaped,
    writeHtmlJsonEscaped,
    writeKeyOpen,
    writeValueClose,
  };
}

// Reusable per-case contiguous slab for card memoization
function createSlabRecorder(initialCap) {
  let slab = Buffer.allocUnsafe(initialCap);
  let pos = 0;
  let mark = 0;

  function ensure(need) {
    if (pos + need <= slab.length) return;
    const cap = Math.max(slab.length * 2, need + (pos - mark) + 65536);
    const next = Buffer.allocUnsafe(cap);
    const curLen = pos - mark;
    if (curLen > 0) next.set(slab.subarray(mark, pos), 0);
    slab = next;
    mark = 0;
    pos = curLen;
  }

  return {
    resetAll() { pos = 0; mark = 0; },
    begin() { mark = pos; },
    writeBuf(b) {
      const n = b.length;
      if (n === 0) return;
      ensure(n);
      slab.set(b, pos);
      pos += n;
    },
    writeSafeAscii(s) {
      const len = s.length;
      if (len === 0) return;
      ensure(len);
      pos = writeAsciiBytes(slab, pos, s);
    },
    writeJsonEscaped(s) {
      const len = s.length;
      if (len === 0) return;
      ensure(len * 6);
      pos = writeJsonBytes(slab, pos, s);
    },
    writeHtmlJsonEscaped(s) {
      const len = s.length;
      if (len === 0) return;
      ensure(len * 6);
      pos = writeHtmlJsonRangeBytes(slab, pos, s, 0, len);
    },
    finish() {
      return slab.subarray(mark, pos);
    },
  };
}

// ---------------------------------------------------------------- Text, Slug, Date & Word Helpers

const RE_COMBINING = /\p{M}/gu;
const SLUG_BUF = Buffer.allocUnsafe(SLUG_MAX);

function slugify(text) {
  return slugifyRange(text, 0, text.length);
}

function slugifyRange(text, start, end) {
  let w = 0;
  let gap = false;
  for (let i = start; i < end; i++) {
    let c = text.charCodeAt(i);
    if (c >= 128) {
      const plain = text.slice(start, end).normalize('NFKD').replace(RE_COMBINING, '');
      w = 0;
      gap = false;
      for (const ch of plain) {
        const cc = ch.charCodeAt(0);
        let k = cc;
        if (k >= 65 && k <= 90) k += 32;
        if (ch.length === 1 && ((k >= 97 && k <= 122) || (k >= 48 && k <= 57))) {
          if (gap) {
            if (w >= SLUG_MAX - 1) break;
            SLUG_BUF[w++] = 45;
            gap = false;
          }
          SLUG_BUF[w++] = k;
          if (w === SLUG_MAX) break;
        } else if (w > 0) {
          gap = true;
        }
      }
      return w === 0 ? 'untitled' : SLUG_BUF.toString('latin1', 0, w);
    }
    if (c >= 65 && c <= 90) c += 32;
    if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) {
      if (gap) {
        if (w >= SLUG_MAX - 1) break;
        SLUG_BUF[w++] = 45;
        gap = false;
      }
      SLUG_BUF[w++] = c;
      if (w === SLUG_MAX) break;
    } else if (w > 0) {
      gap = true;
    }
  }
  return w === 0 ? 'untitled' : SLUG_BUF.toString('latin1', 0, w);
}

function uniqueSlug(slug, taken) {
  let out = slug;
  if (taken.has(out)) {
    let n = 2;
    do {
      out = `${slug}-${n++}`;
    } while (taken.has(out));
  }
  taken.add(out);
  return out;
}

function longDate(date) {
  const m = (date.charCodeAt(5) - 48) * 10 + (date.charCodeAt(6) - 48);
  const d = (date.charCodeAt(8) - 48) * 10 + (date.charCodeAt(9) - 48);
  return `${d} ${MONTHS[m - 1]} ${date.slice(0, 4)}`;
}

function byCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

const RE_W200_UNI = /\s*(?:\S+\s+){199}\S+(?=\s|$)/y;
const RE_NONWS_UNI = /\S/g;

function readingMinutesOf(text) {
  if (text.length < 401) return 1;
  let mins = 0;
  let pos = 0;
  while (true) {
    RE_W200_UNI.lastIndex = pos;
    if (!RE_W200_UNI.test(text)) break;
    mins++;
    pos = RE_W200_UNI.lastIndex;
  }
  if (mins === 0) return 1;
  RE_NONWS_UNI.lastIndex = pos;
  return RE_NONWS_UNI.test(text) ? mins + 1 : mins;
}

function isUnicodeSpace(c) {
  return (
    c === 0xa0 ||
    c === 0xfeff ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000
  );
}

function hasWhitespace(s) {
  return hasWhitespaceRange(s, 0, s.length);
}

function hasWhitespaceRange(s, start, end) {
  for (let i = start; i < end; i++) {
    const c = s.charCodeAt(i);
    if (c <= 32) {
      if (c === 32 || (c >= 9 && c <= 13)) return true;
    } else if (c >= 128 && isUnicodeSpace(c)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------- Front Matter

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return (m === 4 || m === 6 || m === 9 || m === 11) ? 30 : 31;
}

function isValidLayoutName(raw) {
  const len = raw.length;
  if (len === 0) return false;
  for (let i = 0; i < len; i++) {
    const c = raw.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

function isValidSlug(raw) {
  const len = raw.length;
  if (len === 0 || len > 64) return false;
  let prevDash = true;
  for (let i = 0; i < len; i++) {
    const c = raw.charCodeAt(i);
    if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) {
      prevDash = false;
    } else if (c === 45) {
      if (prevDash) return false;
      prevDash = true;
    } else {
      return false;
    }
  }
  return !prevDash;
}

function isValidTagText(item) {
  const len = item.length;
  if (len === 0) return false;
  for (let i = 0; i < len; i++) {
    const c = item.charCodeAt(i);
    if (c === 34 || c === 91 || c === 93) return false;
  }
  return true;
}

function parseQuotedOrBare(key, raw) {
  const c0 = raw.charCodeAt(0);
  if (c0 === 34) {
    const len = raw.length;
    if (len < 2 || raw.charCodeAt(len - 1) !== 34) {
      return { error: `key "${key}": a quoted string is not closed` };
    }
    const last = len - 1;
    let out = '';
    let start = 1;
    for (let i = 1; i < last; i++) {
      const c = raw.charCodeAt(i);
      if (c === 92) {
        if (i + 1 === last) {
          return { error: `key "${key}": a quoted string holds an escape other than \\" or \\\\` };
        }
        const n = raw.charCodeAt(i + 1);
        if (n !== 34 && n !== 92) {
          return { error: `key "${key}": a quoted string holds an escape other than \\" or \\\\` };
        }
        if (i > start) out += raw.slice(start, i);
        out += n === 34 ? '"' : '\\';
        i++;
        start = i + 1;
      } else if (c === 34) {
        return { error: `key "${key}": a quoted string holds a stray quote` };
      }
    }
    if (start === 1) return { value: raw.slice(1, last) };
    if (start < last) out += raw.slice(start, last);
    return { value: out };
  }
  if (c0 === 91) return { error: `key "${key}": a bare string opens on [` };
  return { value: raw };
}

function parseDateValue(raw) {
  if (raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45) {
    const d0 = raw.charCodeAt(0) - 48, d1 = raw.charCodeAt(1) - 48;
    const d2 = raw.charCodeAt(2) - 48, d3 = raw.charCodeAt(3) - 48;
    const m0 = raw.charCodeAt(5) - 48, m1 = raw.charCodeAt(6) - 48;
    const dy0 = raw.charCodeAt(8) - 48, dy1 = raw.charCodeAt(9) - 48;
    if (
      d0 >= 0 && d0 <= 9 && d1 >= 0 && d1 <= 9 && d2 >= 0 && d2 <= 9 && d3 >= 0 && d3 <= 9 &&
      m0 >= 0 && m0 <= 9 && m1 >= 0 && m1 <= 9 && dy0 >= 0 && dy0 <= 9 && dy1 >= 0 && dy1 <= 9
    ) {
      const y = d0 * 1000 + d1 * 100 + d2 * 10 + d3;
      const mo = m0 * 10 + m1;
      const d = dy0 * 10 + dy1;
      if (y >= 1970 && y <= 2099 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(y, mo)) {
        return { value: raw };
      }
    }
  }
  return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
}

function parseFrontMatterFast(text) {
  const len = text.length;
  if (len < 3 || text.charCodeAt(0) !== 45 || text.charCodeAt(1) !== 45 || text.charCodeAt(2) !== 45) {
    return { error: 'no front matter' };
  }
  if (len === 3) return { error: 'the front matter is not closed' };
  if (text.charCodeAt(3) !== 10) return { error: 'no front matter' };

  let closePos = -1;
  let bodyStart = len;
  const idx = text.indexOf('\n---\n', 3);
  if (idx !== -1) {
    closePos = idx + 1;
    bodyStart = idx + 5;
  } else if (len >= 7 && text.charCodeAt(len - 4) === 10 && text.charCodeAt(len - 3) === 45 && text.charCodeAt(len - 2) === 45 && text.charCodeAt(len - 1) === 45) {
    closePos = len - 3;
    bodyStart = len;
  } else {
    return { error: 'the front matter is not closed' };
  }

  const data = Object.create(null);
  let pos = 4;
  let lineNo = 2;

  while (pos < closePos) {
    const nextNl = text.indexOf('\n', pos);
    const end = nextNl === -1 || nextNl > closePos ? closePos : nextNl;

    if (pos < end) {
      const c0 = text.charCodeAt(pos);
      if (c0 !== 35) {
        let skip = false;
        if (c0 === 32 || c0 === 9) {
          skip = true;
          for (let k = pos + 1; k < end; k++) {
            const ch = text.charCodeAt(k);
            if (ch !== 32 && ch !== 9) { skip = false; break; }
          }
        }
        if (!skip) {
          let kEnd = pos;
          while (kEnd < end) {
            const ch = text.charCodeAt(kEnd);
            if ((ch >= 97 && ch <= 122) || ch === 95) kEnd++;
            else break;
          }
          if (kEnd === pos || kEnd >= end || text.charCodeAt(kEnd) !== 58) {
            return { error: `line ${lineNo} is not "key: value"` };
          }
          let valStart = kEnd + 1;
          if (valStart < end) {
            if (text.charCodeAt(valStart) !== 32) {
              return { error: `line ${lineNo} is not "key: value"` };
            }
            valStart++;
          }
          const kLen = kEnd - pos;
          let key = '';
          if (c0 === 116) {
            if (kLen === 5 && text.charCodeAt(pos + 1) === 105 && text.charCodeAt(pos + 2) === 116 && text.charCodeAt(pos + 3) === 108 && text.charCodeAt(pos + 4) === 101) key = 'title';
            else if (kLen === 4 && text.charCodeAt(pos + 1) === 97 && text.charCodeAt(pos + 2) === 103 && text.charCodeAt(pos + 3) === 115) key = 'tags';
          } else if (c0 === 100) {
            if (kLen === 4 && text.charCodeAt(pos + 1) === 97 && text.charCodeAt(pos + 2) === 116 && text.charCodeAt(pos + 3) === 101) key = 'date';
            else if (kLen === 5 && text.charCodeAt(pos + 1) === 114 && text.charCodeAt(pos + 2) === 97 && text.charCodeAt(pos + 3) === 102 && text.charCodeAt(pos + 4) === 116) key = 'draft';
          } else if (c0 === 115) {
            if (kLen === 7 && text.slice(pos, kEnd) === 'summary') key = 'summary';
            else if (kLen === 4 && text.charCodeAt(pos + 1) === 108 && text.charCodeAt(pos + 2) === 117 && text.charCodeAt(pos + 3) === 103) key = 'slug';
          } else if (c0 === 108) {
            if (kLen === 6 && text.slice(pos, kEnd) === 'layout') key = 'layout';
          }
          if (key.length === 0) return { error: `unknown key "${text.slice(pos, kEnd)}"` };
          if (key in data) return { error: `key "${key}" is given twice` };

          let valEnd = end;
          while (valEnd > valStart) {
            const ch = text.charCodeAt(valEnd - 1);
            if (ch === 32 || ch === 9) valEnd--;
            else break;
          }
          if (valEnd === valStart) return { error: `key "${key}" has no value` };
          const raw = text.slice(valStart, valEnd);

          if (key === 'title' || key === 'summary') {
            const r = parseQuotedOrBare(key, raw);
            if (r.error !== undefined) return r;
            data[key] = r.value;
          } else if (key === 'date') {
            const r = parseDateValue(raw);
            if (r.error !== undefined) return r;
            data.date = r.value;
          } else if (key === 'tags') {
            if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) {
              return { error: 'key "tags": not a list [a, b]' };
            }
            const inner = raw.slice(1, -1);
            if (inner.trim().length === 0) {
              data.tags = [];
            } else {
              const parts = inner.split(',');
              const tags = new Array(parts.length);
              for (let t = 0; t < parts.length; t++) {
                const item = parts[t].trim();
                if (!isValidTagText(item)) {
                  return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
                }
                tags[t] = item;
              }
              data.tags = tags;
            }
          } else if (key === 'draft') {
            if (raw === 'true') data.draft = true;
            else if (raw === 'false') data.draft = false;
            else return { error: 'key "draft": true or false' };
          } else if (key === 'layout') {
            if (!isValidLayoutName(raw)) return { error: 'key "layout": not a template name' };
            data.layout = raw;
          } else if (key === 'slug') {
            if (!isValidSlug(raw)) return { error: 'key "slug": not a slug' };
            data.slug = raw;
          }
        }
      }
    }

    pos = nextNl + 1;
    lineNo++;
  }

  if (!('title' in data)) return { error: 'no title' };
  const body = bodyStart >= len ? '' : text.slice(bodyStart);
  return { data, body };
}

// ---------------------------------------------------------------- Markdown Helpers

function isBackslashEscaped(s, from, idx) {
  let bs = 0;
  let k = idx - 1;
  while (k >= from && s.charCodeAt(k) === 92) {
    bs++;
    k--;
  }
  return (bs & 1) === 1;
}

function findUnescapedDoubleStar(s, from, end) {
  let pos = from;
  const limit = end - 2;
  while (pos <= limit) {
    const idx = s.indexOf('**', pos);
    if (idx === -1 || idx > limit) return -1;
    if (idx === from || s.charCodeAt(idx - 1) !== 92 || !isBackslashEscaped(s, from, idx)) return idx;
    pos = idx + 1;
  }
  return -1;
}

function findUnescapedCloseBracket(s, from, end) {
  let pos = from;
  while (pos < end) {
    const idx = s.indexOf(']', pos);
    if (idx === -1 || idx >= end) return -1;
    if (idx === from || s.charCodeAt(idx - 1) !== 92 || !isBackslashEscaped(s, from, idx)) return idx;
    pos = idx + 1;
  }
  return -1;
}

function findSingleStar(s, from, end) {
  let pos = from;
  while (pos < end) {
    const idx = s.indexOf('*', pos);
    if (idx === -1 || idx >= end) return -1;
    if (idx > from && s.charCodeAt(idx - 1) === 92 && isBackslashEscaped(s, from, idx)) {
      pos = idx + 1;
      continue;
    }
    if (idx + 1 < end && s.charCodeAt(idx + 1) === 42) {
      pos = idx + 2;
      continue;
    }
    return idx;
  }
  return -1;
}

function isLineBlank(src, start, end) {
  for (let i = start; i < end; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function matchFenceOpen(src, start, end) {
  if (end - start < 3 || src.charCodeAt(start) !== 96 || src.charCodeAt(start + 1) !== 96 || src.charCodeAt(start + 2) !== 96) {
    return null;
  }
  let p = start + 3;
  while (p < end) {
    const c = src.charCodeAt(p);
    if (
      (c >= 65 && c <= 90) ||
      (c >= 97 && c <= 122) ||
      (c >= 48 && c <= 57) ||
      c === 95 || c === 43 || c === 45
    ) {
      p++;
    } else break;
  }
  for (let q = p; q < end; q++) {
    const c = src.charCodeAt(q);
    if (c !== 32 && c !== 9) return null;
  }
  return src.slice(start + 3, p);
}

function isFenceClose(src, start, end) {
  if (end - start < 3 || src.charCodeAt(start) !== 96 || src.charCodeAt(start + 1) !== 96 || src.charCodeAt(start + 2) !== 96) {
    return false;
  }
  for (let q = start + 3; q < end; q++) {
    const c = src.charCodeAt(q);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function matchHeading(src, start, end) {
  if (start >= end || src.charCodeAt(start) !== 35) return null;
  let p = start;
  while (p < end && p - start < 7 && src.charCodeAt(p) === 35) p++;
  const depth = p - start;
  if (depth > 6 || p >= end) return null;
  const sp = src.charCodeAt(p);
  if (sp !== 32 && sp !== 9) return null;
  while (p < end) {
    const c = src.charCodeAt(p);
    if (c === 32 || c === 9) p++;
    else break;
  }
  let tEnd = end;
  while (tEnd > p) {
    const c = src.charCodeAt(tEnd - 1);
    if (c === 32 || c === 9) tEnd--;
    else break;
  }
  if (tEnd <= p) return null;
  return { depth, tStart: p, tEnd };
}

function isHr(src, start, end) {
  if (end - start < 3) return false;
  const c0 = src.charCodeAt(start);
  if ((c0 !== 45 && c0 !== 42) || src.charCodeAt(start + 1) !== c0 || src.charCodeAt(start + 2) !== c0) {
    return false;
  }
  for (let q = start + 3; q < end; q++) {
    const c = src.charCodeAt(q);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function endsParagraphLine(src, start, end) {
  if (start >= end) return true;
  const c0 = src.charCodeAt(start);
  if (c0 === 32 || c0 === 9) return isLineBlank(src, start, end);
  if (c0 === 96) return matchFenceOpen(src, start, end) !== null;
  if (c0 === 35) return matchHeading(src, start, end) !== null;
  if (c0 === 45 || c0 === 42) return isHr(src, start, end);
  return false;
}

function matchOrderedStart(src, start, end) {
  let p = start;
  const maxD = start + 9 < end ? start + 9 : end;
  while (p < maxD) {
    const c = src.charCodeAt(p);
    if (c >= 48 && c <= 57) p++;
    else break;
  }
  if (p === start || p + 1 >= end || src.charCodeAt(p) !== 46 || src.charCodeAt(p + 1) !== 32) return -1;
  return p + 2;
}

function isContinuedLine(src, start, end) {
  if (end - start < 3 || src.charCodeAt(start) !== 32 || src.charCodeAt(start + 1) !== 32) return false;
  let p = start + 2;
  while (p < end && src.charCodeAt(p) === 32) p++;
  if (p >= end) return false;
  const c = src.charCodeAt(p);
  if (c <= 32) return !(c === 32 || (c >= 9 && c <= 13));
  return !(c >= 128 && isUnicodeSpace(c));
}

function trimSpacesTabsSlice(src, start, end) {
  let a = start;
  while (a < end && (src.charCodeAt(a) === 32 || src.charCodeAt(a) === 9)) a++;
  let b = end;
  while (b > a && (src.charCodeAt(b - 1) === 32 || src.charCodeAt(b - 1) === 9)) b--;
  return src.slice(a, b);
}

// ---------------------------------------------------------------- Direct-to-UTF-8-Slab Pre-JSON Markdown Engine

// Reusable per-case Markdown slab (eliminates 100% of Markdown JS strings, ConsStrings, and GC!)
const MD_SLAB_INIT = 8 * 1024 * 1024;
let mdSlab = Buffer.allocUnsafe(MD_SLAB_INIT);
let mdPos = 0;

// Pre-encoded JSON-escaped HTML tag byte constants
const B_P_OPEN = Buffer.from('<p>');
const B_P_CLOSE = Buffer.from('</p>\\n');
const B_LI_OPEN = Buffer.from('<li>');
const B_LI_CLOSE = Buffer.from('</li>\\n');
const B_UL_OPEN = Buffer.from('<ul>\\n');
const B_UL_CLOSE = Buffer.from('</ul>\\n');
const B_OL_OPEN = Buffer.from('<ol>\\n');
const B_OL_CLOSE = Buffer.from('</ol>\\n');
const B_HR = Buffer.from('<hr>\\n');
const B_BQ_OPEN = Buffer.from('<blockquote>\\n');
const B_BQ_CLOSE = Buffer.from('</blockquote>\\n');
const B_BQ_P_OPEN = Buffer.from('<blockquote>\\n<p>');
const B_BQ_P_CLOSE = Buffer.from('</p>\\n</blockquote>\\n');
const B_CODE_OPEN = Buffer.from('<code>');
const B_CODE_CLOSE = Buffer.from('</code>');
const B_STRONG_OPEN = Buffer.from('<strong>');
const B_STRONG_CLOSE = Buffer.from('</strong>');
const B_EM_OPEN = Buffer.from('<em>');
const B_EM_CLOSE = Buffer.from('</em>');
const B_A_OPEN = Buffer.from('<a href=\\"');
const B_A_MID = Buffer.from('\\">');
const B_A_CLOSE = Buffer.from('</a>');
const B_PRE_OPEN = Buffer.from('<pre><code');
const B_PRE_LANG = Buffer.from(' class=\\"language-');
const B_PRE_CLOSE = Buffer.from('</code></pre>\\n');
const B_OL_START = Buffer.from('<ol start=\\"');

// Pre-allocate space on `mdSlab` BEFORE starting a file; if not enough room, allocate a fresh slab
// (existing files keep their views into the old slab!).
function prepareMdSlabForFile(bodyLen) {
  const est = bodyLen * 8 + 65536;
  if (mdPos + est <= mdSlab.length) return;
  mdSlab = Buffer.allocUnsafe(Math.max(MD_SLAB_INIT, est * 2));
  mdPos = 0;
}

// Emergency mid-file grow (only triggered if a pathological file expands >8x, e.g. hundreds of huge URLs)
function growMdSlabMidFile(need, fileStart, toc, exRange) {
  const used = mdPos - fileStart;
  const nextCap = Math.max(mdSlab.length * 2, used + need + 131072);
  const next = Buffer.allocUnsafe(nextCap);
  if (used > 0) next.set(mdSlab.subarray(fileStart, mdPos), 0);
  mdSlab = next;
  mdPos = used;
  // Rebase toc views relative to new slab start (0)
  for (let i = 0; i < toc.length; i++) {
    const t = toc[i];
    t.html = mdSlab.subarray(t._a - fileStart, t._b - fileStart);
    t._a -= fileStart;
    t._b -= fileStart;
  }
  if (exRange[0] !== -1) {
    exRange[0] -= fileStart;
    exRange[1] -= fileStart;
  }
  return 0; // new fileStart
}

function writeNonAsciiToSlab(buf, p, s, i, end) {
  const c = s.charCodeAt(i);
  if (c < 0x800) {
    buf[p++] = 0xc0 | (c >> 6);
    buf[p++] = 0x80 | (c & 0x3f);
    return p;
  }
  if ((c & 0xf800) === 0xd800) {
    if (c <= 0xdbff && i + 1 < end) {
      const n = s.charCodeAt(i + 1);
      if (n >= 0xdc00 && n <= 0xdfff) {
        const cp = 0x10000 + (((c - 0xd800) << 10) | (n - 0xdc00));
        buf[p++] = 0xf0 | (cp >> 18);
        buf[p++] = 0x80 | ((cp >> 12) & 0x3f);
        buf[p++] = 0x80 | ((cp >> 6) & 0x3f);
        buf[p++] = 0x80 | (cp & 0x3f);
        return -p; // negative signals consumed surrogate pair (i += 2)
      }
    }
    buf[p++] = 92; buf[p++] = 117;
    buf[p++] = HEX_BYTES[(c >> 12) & 15];
    buf[p++] = HEX_BYTES[(c >> 8) & 15];
    buf[p++] = HEX_BYTES[(c >> 4) & 15];
    buf[p++] = HEX_BYTES[c & 15];
    return p;
  }
  buf[p++] = 0xe0 | (c >> 12);
  buf[p++] = 0x80 | ((c >> 6) & 0x3f);
  buf[p++] = 0x80 | (c & 0x3f);
  return p;
}

function renderInlineToSlab(s, start, end, resolveLink, state) {
  if (start >= end) return;
  const need = (end - start) * 6 + 256;
  if (mdPos + need > mdSlab.length) state.fileStart = growMdSlabMidFile(need, state.fileStart, state.toc, state.ex);

  let buf = mdSlab;
  let p = mdPos;
  let i = start;
  const T = INLINE_TRIG_JSON;

  while (i < end) {
    // Tight inner ASCII copy loop: keeps buf, p, i, end, s, T in hardware registers!
    while (i < end) {
      const c = s.charCodeAt(i);
      if (c < 128 && T[c] === 0) {
        buf[p++] = c;
        i++;
      } else {
        break;
      }
    }
    if (i >= end) break;

    const c = s.charCodeAt(i);
    if (c >= 128) {
      const r = writeNonAsciiToSlab(buf, p, s, i, end);
      if (r < 0) { p = -r; i += 2; }
      else { p = r; i++; }
      continue;
    }

    const t = T[c];
    if (t === 1) {
      buf[p++] = 38; buf[p++] = 97; buf[p++] = 109; buf[p++] = 112; buf[p++] = 59; i++; continue;
    }
    if (t === 2) {
      buf[p++] = 38; buf[p++] = 108; buf[p++] = 116; buf[p++] = 59; i++; continue;
    }
    if (t === 3) {
      buf[p++] = 38; buf[p++] = 103; buf[p++] = 116; buf[p++] = 59; i++; continue;
    }
    if (t === 4) {
      buf[p++] = 38; buf[p++] = 113; buf[p++] = 117; buf[p++] = 111; buf[p++] = 116; buf[p++] = 59; i++; continue;
    }
    if (t === 5) {
      buf[p++] = 38; buf[p++] = 35; buf[p++] = 51; buf[p++] = 57; buf[p++] = 59; i++; continue;
    }
    if (t === 10) {
      buf[p++] = 92;
      if (c === 10) buf[p++] = 110;
      else if (c === 9) buf[p++] = 116;
      else if (c === 13) buf[p++] = 114;
      else if (c === 8) buf[p++] = 98;
      else if (c === 12) buf[p++] = 102;
      else {
        buf[p++] = 117; buf[p++] = 48; buf[p++] = 48;
        buf[p++] = HEX_BYTES[(c >> 4) & 15];
        buf[p++] = HEX_BYTES[c & 15];
      }
      i++;
      continue;
    }
    if (t === 6 /* \ */) {
      if (i + 1 < end) {
        const n = s.charCodeAt(i + 1);
        if (n < 128 && ESCAPABLE[n] === 1) {
          if (n === 62) {
            buf[p++] = 38; buf[p++] = 103; buf[p++] = 116; buf[p++] = 59;
          } else if (n === 92) {
            buf[p++] = 92; buf[p++] = 92;
          } else {
            buf[p++] = n;
          }
          i += 2;
          continue;
        }
      }
      buf[p++] = 92; buf[p++] = 92;
      i++;
      continue;
    }
    if (t === 7 /* ` */) {
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < end && j > i + 1) {
        // <code>
        buf[p++] = 60; buf[p++] = 99; buf[p++] = 111; buf[p++] = 100; buf[p++] = 101; buf[p++] = 62;
        p = writeHtmlJsonRangeBytes(buf, p, s, i + 1, j);
        // </code>
        buf[p++] = 60; buf[p++] = 47; buf[p++] = 99; buf[p++] = 111; buf[p++] = 100; buf[p++] = 101; buf[p++] = 62;
        i = j + 1;
        continue;
      }
      buf[p++] = 96;
      i++;
      continue;
    }
    if (t === 8 /* * */) {
      if (i + 1 < end && s.charCodeAt(i + 1) === 42) {
        const j = findUnescapedDoubleStar(s, i + 2, end);
        if (j > i + 2) {
          // <strong>
          buf[p++] = 60; buf[p++] = 115; buf[p++] = 116; buf[p++] = 114; buf[p++] = 111; buf[p++] = 110; buf[p++] = 103; buf[p++] = 62;
          mdPos = p;
          renderInlineToSlab(s, i + 2, j, resolveLink, state);
          buf = mdSlab;
          p = mdPos;
          // </strong>
          buf[p++] = 60; buf[p++] = 47; buf[p++] = 115; buf[p++] = 116; buf[p++] = 114; buf[p++] = 111; buf[p++] = 110; buf[p++] = 103; buf[p++] = 62;
          i = j + 2;
          continue;
        }
        buf[p++] = 42; buf[p++] = 42;
        i += 2;
        continue;
      }
      const j = findSingleStar(s, i + 1, end);
      if (j > i + 1) {
        // <em>
        buf[p++] = 60; buf[p++] = 101; buf[p++] = 109; buf[p++] = 62;
        mdPos = p;
        renderInlineToSlab(s, i + 1, j, resolveLink, state);
        buf = mdSlab;
        p = mdPos;
        // </em>
        buf[p++] = 60; buf[p++] = 47; buf[p++] = 101; buf[p++] = 109; buf[p++] = 62;
        i = j + 1;
        continue;
      }
      buf[p++] = 42;
      i++;
      continue;
    }
    // t === 9: [
    const k = findUnescapedCloseBracket(s, i + 1, end);
    if (k !== -1 && k + 1 < end && s.charCodeAt(k + 1) === 40) {
      const closeParen = s.indexOf(')', k + 2);
      if (closeParen !== -1 && closeParen < end && closeParen > k + 2 && !hasWhitespaceRange(s, k + 2, closeParen)) {
        const target = s.slice(k + 2, closeParen);
        const hrefBuf = resolveLink(target);
        const extra = hrefBuf.length + (end - i) * 6 + 64;
        mdPos = p;
        if (mdPos + extra > mdSlab.length) {
          state.fileStart = growMdSlabMidFile(extra, state.fileStart, state.toc, state.ex);
          buf = mdSlab;
          p = mdPos;
        }
        // <a href=\"
        buf[p++] = 60; buf[p++] = 97; buf[p++] = 32; buf[p++] = 104; buf[p++] = 114; buf[p++] = 101; buf[p++] = 102; buf[p++] = 61; buf[p++] = 92; buf[p++] = 34;
        buf.set(hrefBuf, p); p += hrefBuf.length;
        // \">
        buf[p++] = 92; buf[p++] = 34; buf[p++] = 62;
        mdPos = p;
        renderInlineToSlab(s, i + 1, k, resolveLink, state);
        buf = mdSlab;
        p = mdPos;
        // </a>
        buf[p++] = 60; buf[p++] = 47; buf[p++] = 97; buf[p++] = 62;
        i = closeParen + 1;
        continue;
      }
    }
    buf[p++] = 91;
    i++;
  }
  mdPos = p;
}

function renderMarkdownToSlab(src, resolveLinkBuf) {
  const len = src.length;
  prepareMdSlabForFile(len);
  const ids = new Set();
  const toc = [];
  const ex = [-1, -1];
  const state = { fileStart: mdPos, toc, ex };

  let pos = 0;
  while (pos < len) {
    const nl = src.indexOf('\n', pos);
    const end = nl === -1 ? len : nl;
    const nextPos = nl === -1 ? len : nl + 1;

    if (pos === end) {
      pos = nextPos;
      continue;
    }

    const c0 = src.charCodeAt(pos);

    if ((c0 === 32 || c0 === 9) && isLineBlank(src, pos, end)) {
      pos = nextPos;
      continue;
    }

    if (c0 === 96 /* ` */) {
      const lang = matchFenceOpen(src, pos, end);
      if (lang !== null) {
        pos = nextPos;
        const bodyStart = pos;
        let bodyEnd = len;
        let closed = false;
        while (pos < len) {
          const fnl = src.indexOf('\n', pos);
          const fend = fnl === -1 ? len : fnl;
          if (isFenceClose(src, pos, fend)) {
            bodyEnd = pos;
            pos = fnl === -1 ? len : fnl + 1;
            closed = true;
            break;
          }
          pos = fnl === -1 ? len : fnl + 1;
        }
        const need = (bodyEnd - bodyStart) * 6 + lang.length * 6 + 64;
        if (mdPos + need > mdSlab.length) {
          state.fileStart = growMdSlabMidFile(need, state.fileStart, toc, ex);
        }
        mdSlab.set(B_PRE_OPEN, mdPos); mdPos += B_PRE_OPEN.length;
        if (lang.length > 0) {
          mdSlab.set(B_PRE_LANG, mdPos); mdPos += B_PRE_LANG.length;
          mdPos = writeHtmlJsonRangeBytes(mdSlab, mdPos, lang, 0, lang.length);
          mdSlab[mdPos++] = 92; mdSlab[mdPos++] = 34;
        }
        mdSlab[mdPos++] = 62;
        if (bodyEnd === bodyStart) {
          if (!closed && nl !== -1 && bodyStart === len) {
            mdSlab[mdPos++] = 92; mdSlab[mdPos++] = 110;
          }
        } else {
          mdPos = writeHtmlJsonRangeBytes(mdSlab, mdPos, src, bodyStart, bodyEnd);
          if (!closed) {
            mdSlab[mdPos++] = 92; mdSlab[mdPos++] = 110;
          }
        }
        mdSlab.set(B_PRE_CLOSE, mdPos); mdPos += B_PRE_CLOSE.length;
        continue;
      }
    }

    if (c0 === 35 /* # */) {
      const h = matchHeading(src, pos, end);
      if (h !== null) {
        const id = uniqueSlug(slugifyRange(src, h.tStart, h.tEnd), ids);
        const need = id.length + 32;
        if (mdPos + need > mdSlab.length) state.fileStart = growMdSlabMidFile(need, state.fileStart, toc, ex);
        mdSlab[mdPos++] = 60; mdSlab[mdPos++] = 104; mdSlab[mdPos++] = 48 + h.depth;
        mdSlab[mdPos++] = 32; mdSlab[mdPos++] = 105; mdSlab[mdPos++] = 100; mdSlab[mdPos++] = 61;
        mdSlab[mdPos++] = 92; mdSlab[mdPos++] = 34;
        mdPos = writeAsciiBytes(mdSlab, mdPos, id);
        mdSlab[mdPos++] = 92; mdSlab[mdPos++] = 34; mdSlab[mdPos++] = 62;
        const hStart = mdPos;
        const savedFileStart = state.fileStart;
        renderInlineToSlab(src, h.tStart, h.tEnd, resolveLinkBuf, state);
        const adjStart = state.fileStart === savedFileStart ? hStart : hStart - savedFileStart;
        const hEnd = mdPos;
        if (mdPos + 16 > mdSlab.length) state.fileStart = growMdSlabMidFile(16, state.fileStart, toc, ex);
        mdSlab[mdPos++] = 60; mdSlab[mdPos++] = 47; mdSlab[mdPos++] = 104; mdSlab[mdPos++] = 48 + h.depth;
        mdSlab[mdPos++] = 62; mdSlab[mdPos++] = 92; mdSlab[mdPos++] = 110;
        if (h.depth === 2 || h.depth === 3) {
          toc.push({
            level: h.depth,
            id,
            html: hEnd > adjStart ? mdSlab.subarray(adjStart, hEnd) : '',
            _a: adjStart,
            _b: hEnd,
          });
        }
        pos = nextPos;
        continue;
      }
    }

    if (c0 === 45 /* - */ || c0 === 42 /* * */) {
      if (isHr(src, pos, end)) {
        if (mdPos + 16 > mdSlab.length) state.fileStart = growMdSlabMidFile(16, state.fileStart, toc, ex);
        mdSlab[mdPos++] = 60; mdSlab[mdPos++] = 104; mdSlab[mdPos++] = 114; mdSlab[mdPos++] = 62; mdSlab[mdPos++] = 92; mdSlab[mdPos++] = 110;
        pos = nextPos;
        continue;
      }
      if (pos + 1 < end && src.charCodeAt(pos + 1) === 32) {
        if (mdPos + 16 > mdSlab.length) state.fileStart = growMdSlabMidFile(16, state.fileStart, toc, ex);
        mdSlab[mdPos++] = 60; mdSlab[mdPos++] = 117; mdSlab[mdPos++] = 108; mdSlab[mdPos++] = 62; mdSlab[mdPos++] = 92; mdSlab[mdPos++] = 110;
        let itemA = pos + 2;
        let itemB = end;
        while (itemA < itemB && (src.charCodeAt(itemA) === 32 || src.charCodeAt(itemA) === 9)) itemA++;
        while (itemB > itemA && (src.charCodeAt(itemB - 1) === 32 || src.charCodeAt(itemB - 1) === 9)) itemB--;
        let curItem = null;
        pos = nextPos;
        while (pos < len) {
          const lnl = src.indexOf('\n', pos);
          const lend = lnl === -1 ? len : lnl;
          const lc0 = src.charCodeAt(pos);
          if ((lc0 === 45 || lc0 === 42) && pos + 1 < lend && src.charCodeAt(pos + 1) === 32) {
            if (mdPos + 16 > mdSlab.length) state.fileStart = growMdSlabMidFile(16, state.fileStart, toc, ex);
            mdSlab[mdPos++] = 60; mdSlab[mdPos++] = 108; mdSlab[mdPos++] = 105; mdSlab[mdPos++] = 62;
            if (curItem === null) renderInlineToSlab(src, itemA, itemB, resolveLinkBuf, state);
            else renderInlineToSlab(curItem, 0, curItem.length, resolveLinkBuf, state);
            if (mdPos + 16 > mdSlab.length) state.fileStart = growMdSlabMidFile(16, state.fileStart, toc, ex);
            mdSlab[mdPos++] = 60; mdSlab[mdPos++] = 47; mdSlab[mdPos++] = 108; mdSlab[mdPos++] = 105; mdSlab[mdPos++] = 62; mdSlab[mdPos++] = 92; mdSlab[mdPos++] = 110;
            itemA = pos + 2;
            itemB = lend;
            while (itemA < itemB && (src.charCodeAt(itemA) === 32 || src.charCodeAt(itemA) === 9)) itemA++;
            while (itemB > itemA && (src.charCodeAt(itemB - 1) === 32 || src.charCodeAt(itemB - 1) === 9)) itemB--;
            curItem = null;
            pos = lnl === -1 ? len : lnl + 1;
          } else if (isContinuedLine(src, pos, lend)) {
            if (curItem === null) curItem = src.slice(itemA, itemB);
            curItem += '\n' + trimSpacesTabsSlice(src, pos, lend);
            pos = lnl === -1 ? len : lnl + 1;
          } else break;
        }
        if (mdPos + 16 > mdSlab.length) state.fileStart = growMdSlabMidFile(16, state.fileStart, toc, ex);
        mdSlab[mdPos++] = 60; mdSlab[mdPos++] = 108; mdSlab[mdPos++] = 105; mdSlab[mdPos++] = 62;
        if (curItem === null) renderInlineToSlab(src, itemA, itemB, resolveLinkBuf, state);
        else renderInlineToSlab(curItem, 0, curItem.length, resolveLinkBuf, state);
        if (mdPos + 24 > mdSlab.length) state.fileStart = growMdSlabMidFile(24, state.fileStart, toc, ex);
        mdSlab[mdPos++] = 60; mdSlab[mdPos++] = 47; mdSlab[mdPos++] = 108; mdSlab[mdPos++] = 105; mdSlab[mdPos++] = 62; mdSlab[mdPos++] = 92; mdSlab[mdPos++] = 110;
        mdSlab[mdPos++] = 60; mdSlab[mdPos++] = 47; mdSlab[mdPos++] = 117; mdSlab[mdPos++] = 108; mdSlab[mdPos++] = 62; mdSlab[mdPos++] = 92; mdSlab[mdPos++] = 110;
        continue;
      }
    }

    if (c0 === 62 /* > */) {
      let qText = '';
      while (pos < len && src.charCodeAt(pos) === 62) {
        const qnl = src.indexOf('\n', pos);
        const qend = qnl === -1 ? len : qnl;
        let qStart = pos + 1;
        if (qStart < qend && src.charCodeAt(qStart) === 32) qStart++;
        const trimmed = trimSpacesTabsSlice(src, qStart, qend);
        if (trimmed.length > 0) qText = qText.length === 0 ? trimmed : qText + '\n' + trimmed;
        pos = qnl === -1 ? len : qnl + 1;
      }
      if (mdPos + 48 > mdSlab.length) state.fileStart = growMdSlabMidFile(48, state.fileStart, toc, ex);
      if (qText.length === 0) {
        mdSlab.set(B_BQ_OPEN, mdPos); mdPos += B_BQ_OPEN.length;
        mdSlab.set(B_BQ_CLOSE, mdPos); mdPos += B_BQ_CLOSE.length;
      } else {
        mdSlab.set(B_BQ_P_OPEN, mdPos); mdPos += B_BQ_P_OPEN.length;
        renderInlineToSlab(qText, 0, qText.length, resolveLinkBuf, state);
        if (mdPos + 32 > mdSlab.length) state.fileStart = growMdSlabMidFile(32, state.fileStart, toc, ex);
        mdSlab.set(B_BQ_P_CLOSE, mdPos); mdPos += B_BQ_P_CLOSE.length;
      }
      continue;
    }

    if (c0 >= 48 && c0 <= 57) {
      const restStart = matchOrderedStart(src, pos, end);
      if (restStart !== -1) {
        const startNum = Number(src.slice(pos, restStart - 2));
        if (mdPos + 28 > mdSlab.length) state.fileStart = growMdSlabMidFile(28, state.fileStart, toc, ex);
        if (startNum !== 1) {
          const ns = String(startNum);
          mdSlab.set(B_OL_START, mdPos); mdPos += B_OL_START.length;
          mdPos = writeAsciiBytes(mdSlab, mdPos, ns);
          mdSlab[mdPos++] = 92; mdSlab[mdPos++] = 34; mdSlab[mdPos++] = 62; mdSlab[mdPos++] = 92; mdSlab[mdPos++] = 110;
        } else {
          mdSlab[mdPos++] = 60; mdSlab[mdPos++] = 111; mdSlab[mdPos++] = 108; mdSlab[mdPos++] = 62; mdSlab[mdPos++] = 92; mdSlab[mdPos++] = 110;
        }
        let itemA = restStart;
        let itemB = end;
        while (itemA < itemB && (src.charCodeAt(itemA) === 32 || src.charCodeAt(itemA) === 9)) itemA++;
        while (itemB > itemA && (src.charCodeAt(itemB - 1) === 32 || src.charCodeAt(itemB - 1) === 9)) itemB--;
        let curItem = null;
        pos = nextPos;
        while (pos < len) {
          const lnl = src.indexOf('\n', pos);
          const lend = lnl === -1 ? len : lnl;
          const lc0 = src.charCodeAt(pos);
          if (lc0 >= 48 && lc0 <= 57) {
            const nr = matchOrderedStart(src, pos, lend);
            if (nr !== -1) {
              if (mdPos + 16 > mdSlab.length) state.fileStart = growMdSlabMidFile(16, state.fileStart, toc, ex);
              mdSlab[mdPos++] = 60; mdSlab[mdPos++] = 108; mdSlab[mdPos++] = 105; mdSlab[mdPos++] = 62;
              if (curItem === null) renderInlineToSlab(src, itemA, itemB, resolveLinkBuf, state);
              else renderInlineToSlab(curItem, 0, curItem.length, resolveLinkBuf, state);
              if (mdPos + 16 > mdSlab.length) state.fileStart = growMdSlabMidFile(16, state.fileStart, toc, ex);
              mdSlab[mdPos++] = 60; mdSlab[mdPos++] = 47; mdSlab[mdPos++] = 108; mdSlab[mdPos++] = 105; mdSlab[mdPos++] = 62; mdSlab[mdPos++] = 92; mdSlab[mdPos++] = 110;
              itemA = nr;
              itemB = lend;
              while (itemA < itemB && (src.charCodeAt(itemA) === 32 || src.charCodeAt(itemA) === 9)) itemA++;
              while (itemB > itemA && (src.charCodeAt(itemB - 1) === 32 || src.charCodeAt(itemB - 1) === 9)) itemB--;
              curItem = null;
              pos = lnl === -1 ? len : lnl + 1;
              continue;
            }
          }
          if (isContinuedLine(src, pos, lend)) {
            if (curItem === null) curItem = src.slice(itemA, itemB);
            curItem += '\n' + trimSpacesTabsSlice(src, pos, lend);
            pos = lnl === -1 ? len : lnl + 1;
          } else break;
        }
        if (mdPos + 16 > mdSlab.length) state.fileStart = growMdSlabMidFile(16, state.fileStart, toc, ex);
        mdSlab[mdPos++] = 60; mdSlab[mdPos++] = 108; mdSlab[mdPos++] = 105; mdSlab[mdPos++] = 62;
        if (curItem === null) renderInlineToSlab(src, itemA, itemB, resolveLinkBuf, state);
        else renderInlineToSlab(curItem, 0, curItem.length, resolveLinkBuf, state);
        if (mdPos + 24 > mdSlab.length) state.fileStart = growMdSlabMidFile(24, state.fileStart, toc, ex);
        mdSlab[mdPos++] = 60; mdSlab[mdPos++] = 47; mdSlab[mdPos++] = 108; mdSlab[mdPos++] = 105; mdSlab[mdPos++] = 62; mdSlab[mdPos++] = 92; mdSlab[mdPos++] = 110;
        mdSlab[mdPos++] = 60; mdSlab[mdPos++] = 47; mdSlab[mdPos++] = 111; mdSlab[mdPos++] = 108; mdSlab[mdPos++] = 62; mdSlab[mdPos++] = 92; mdSlab[mdPos++] = 110;
        continue;
      }
    }

    // Paragraph (zero-copy fast path)
    const pStart = pos;
    let pEnd = end;
    const needsTrim =
      c0 === 32 || c0 === 9 ||
      src.charCodeAt(end - 1) === 32 || src.charCodeAt(end - 1) === 9;

    pos = nextPos;
    let pLines = needsTrim ? [trimSpacesTabsSlice(src, pStart, end)] : null;

    while (pos < len) {
      const pnl = src.indexOf('\n', pos);
      const pend = pnl === -1 ? len : pnl;
      if (pos === pend) break;
      const fc = src.charCodeAt(pos);
      if (fc === 32 || fc === 9 || fc === 96 || fc === 35 || fc === 45 || fc === 42) {
        if (endsParagraphLine(src, pos, pend)) break;
      }
      if (pLines !== null) {
        pLines.push(trimSpacesTabsSlice(src, pos, pend));
      } else {
        const lc = src.charCodeAt(pend - 1);
        if (fc === 32 || fc === 9 || lc === 32 || lc === 9) {
          pLines = [src.slice(pStart, pEnd), trimSpacesTabsSlice(src, pos, pend)];
        } else {
          pEnd = pend;
        }
      }
      pos = pnl === -1 ? len : pnl + 1;
    }

    if (mdPos + 16 > mdSlab.length) state.fileStart = growMdSlabMidFile(16, state.fileStart, toc, ex);
    mdSlab[mdPos++] = 60; mdSlab[mdPos++] = 112; mdSlab[mdPos++] = 62;
    const paraStart = mdPos;
    const savedFs = state.fileStart;
    if (pLines === null) {
      renderInlineToSlab(src, pStart, pEnd, resolveLinkBuf, state);
    } else {
      const joined = pLines.join('\n');
      renderInlineToSlab(joined, 0, joined.length, resolveLinkBuf, state);
    }
    if (ex[0] === -1) {
      ex[0] = state.fileStart === savedFs ? paraStart : paraStart - savedFs;
      ex[1] = mdPos;
    }
    if (mdPos + 16 > mdSlab.length) state.fileStart = growMdSlabMidFile(16, state.fileStart, toc, ex);
    mdSlab[mdPos++] = 60; mdSlab[mdPos++] = 47; mdSlab[mdPos++] = 112; mdSlab[mdPos++] = 62; mdSlab[mdPos++] = 92; mdSlab[mdPos++] = 110;
  }

  const htmlBuf = mdPos > state.fileStart ? mdSlab.subarray(state.fileStart, mdPos) : '';
  const excerptBuf = ex[0] !== -1 && ex[1] > ex[0] ? mdSlab.subarray(ex[0], ex[1]) : '';
  // Strip private rebase indices from toc objects so own keys match { level, id, html }!
  const cleanToc = new Array(toc.length);
  for (let i = 0; i < toc.length; i++) {
    const t = toc[i];
    cleanToc[i] = { level: t.level, id: t.id, html: t.html };
  }
  return { html: htmlBuf, toc: cleanToc, excerpt: excerptBuf };
}

// ---------------------------------------------------------------- Plain String Markdown (1-arg `run(input)` & fallback)

function renderInlineHtml(s, start, end, resolveLink) {
  if (start >= end) return '';
  let out = '';
  let last = start;
  let i = start;

  while (i < end) {
    const c = s.charCodeAt(i);
    if (c >= 128) { i++; continue; }
    const t = INLINE_TRIG_HTML[c];
    if (t === 0) { i++; continue; }

    if (t <= 5) {
      if (i > last) out += s.slice(last, i);
      out += t === 1 ? '&amp;' : t === 2 ? '&lt;' : t === 3 ? '&gt;' : t === 4 ? '&quot;' : '&#39;';
      i++; last = i; continue;
    }
    if (t === 6) {
      if (i + 1 < end) {
        const n = s.charCodeAt(i + 1);
        if (n < 128 && ESCAPABLE[n] === 1) {
          if (i > last) out += s.slice(last, i);
          out += n === 62 ? '&gt;' : s[i + 1];
          i += 2; last = i; continue;
        }
      }
      i++; continue;
    }
    if (t === 7) {
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < end && j > i + 1) {
        if (i > last) out += s.slice(last, i);
        out += '<code>' + escapeHtmlRange(s, i + 1, j) + '</code>';
        i = j + 1; last = i; continue;
      }
      i++; continue;
    }
    if (t === 8) {
      if (i + 1 < end && s.charCodeAt(i + 1) === 42) {
        const j = findUnescapedDoubleStar(s, i + 2, end);
        if (j > i + 2) {
          if (i > last) out += s.slice(last, i);
          out += '<strong>' + renderInlineHtml(s, i + 2, j, resolveLink) + '</strong>';
          i = j + 2; last = i; continue;
        }
        i += 2; continue;
      }
      const j = findSingleStar(s, i + 1, end);
      if (j > i + 1) {
        if (i > last) out += s.slice(last, i);
        out += '<em>' + renderInlineHtml(s, i + 1, j, resolveLink) + '</em>';
        i = j + 1; last = i; continue;
      }
      i++; continue;
    }
    const k = findUnescapedCloseBracket(s, i + 1, end);
    if (k !== -1 && k + 1 < end && s.charCodeAt(k + 1) === 40) {
      const closeParen = s.indexOf(')', k + 2);
      if (closeParen !== -1 && closeParen < end && closeParen > k + 2) {
        const target = s.slice(k + 2, closeParen);
        if (!hasWhitespace(target)) {
          if (i > last) out += s.slice(last, i);
          out += '<a href="' + resolveLink(target) + '">' + renderInlineHtml(s, i + 1, k, resolveLink) + '</a>';
          i = closeParen + 1; last = i; continue;
        }
      }
    }
    i++;
  }
  if (last === start) return s.slice(start, end);
  return last < end ? out + s.slice(last, end) : out;
}

function renderMarkdownStr(src, resolveLink) {
  const len = src.length;
  const ids = new Set();
  const toc = [];
  let html = '';
  let excerpt = null;
  let pos = 0;

  while (pos < len) {
    const nl = src.indexOf('\n', pos);
    const end = nl === -1 ? len : nl;
    const nextPos = nl === -1 ? len : nl + 1;
    if (pos === end) { pos = nextPos; continue; }
    const c0 = src.charCodeAt(pos);
    if ((c0 === 32 || c0 === 9) && isLineBlank(src, pos, end)) { pos = nextPos; continue; }

    if (c0 === 96) {
      const lang = matchFenceOpen(src, pos, end);
      if (lang !== null) {
        pos = nextPos;
        const bodyStart = pos;
        let bodyEnd = len;
        let closed = false;
        while (pos < len) {
          const fnl = src.indexOf('\n', pos);
          const fend = fnl === -1 ? len : fnl;
          if (isFenceClose(src, pos, fend)) {
            bodyEnd = pos; pos = fnl === -1 ? len : fnl + 1; closed = true; break;
          }
          pos = fnl === -1 ? len : fnl + 1;
        }
        const cls = lang.length === 0 ? '' : ` class="language-${escapeHtml(lang)}"`;
        if (bodyEnd === bodyStart) {
          html += (!closed && nl !== -1 && bodyStart === len) ? `<pre><code${cls}>\n</code></pre>\n` : `<pre><code${cls}></code></pre>\n`;
        } else {
          html += `<pre><code${cls}>${escapeHtmlRange(src, bodyStart, bodyEnd)}${closed ? '' : '\n'}</code></pre>\n`;
        }
        continue;
      }
    }
    if (c0 === 35) {
      const h = matchHeading(src, pos, end);
      if (h !== null) {
        const id = uniqueSlug(slugify(src.slice(h.tStart, h.tEnd)), ids);
        const hHtml = renderInlineHtml(src, h.tStart, h.tEnd, resolveLink);
        html += `<h${h.depth} id="${id}">${hHtml}</h${h.depth}>\n`;
        if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html: hHtml });
        pos = nextPos; continue;
      }
    }
    if (c0 === 45 || c0 === 42) {
      if (isHr(src, pos, end)) { html += '<hr>\n'; pos = nextPos; continue; }
      if (pos + 1 < end && src.charCodeAt(pos + 1) === 32) {
        let listOut = '<ul>\n';
        let cur = trimSpacesTabsSlice(src, pos + 2, end);
        pos = nextPos;
        while (pos < len) {
          const lnl = src.indexOf('\n', pos);
          const lend = lnl === -1 ? len : lnl;
          const lc0 = src.charCodeAt(pos);
          if ((lc0 === 45 || lc0 === 42) && pos + 1 < lend && src.charCodeAt(pos + 1) === 32) {
            listOut += '<li>' + renderInlineHtml(cur, 0, cur.length, resolveLink) + '</li>\n';
            cur = trimSpacesTabsSlice(src, pos + 2, lend);
            pos = lnl === -1 ? len : lnl + 1;
          } else if (isContinuedLine(src, pos, lend)) {
            cur += '\n' + trimSpacesTabsSlice(src, pos, lend);
            pos = lnl === -1 ? len : lnl + 1;
          } else break;
        }
        html += listOut + '<li>' + renderInlineHtml(cur, 0, cur.length, resolveLink) + '</li>\n</ul>\n';
        continue;
      }
    }
    if (c0 === 62) {
      let qText = '';
      while (pos < len && src.charCodeAt(pos) === 62) {
        const qnl = src.indexOf('\n', pos);
        const qend = qnl === -1 ? len : qnl;
        let qStart = pos + 1;
        if (qStart < qend && src.charCodeAt(qStart) === 32) qStart++;
        const trimmed = trimSpacesTabsSlice(src, qStart, qend);
        if (trimmed.length > 0) qText = qText.length === 0 ? trimmed : qText + '\n' + trimmed;
        pos = qnl === -1 ? len : qnl + 1;
      }
      html += qText.length === 0
        ? '<blockquote>\n</blockquote>\n'
        : '<blockquote>\n<p>' + renderInlineHtml(qText, 0, qText.length, resolveLink) + '</p>\n</blockquote>\n';
      continue;
    }
    if (c0 >= 48 && c0 <= 57) {
      const restStart = matchOrderedStart(src, pos, end);
      if (restStart !== -1) {
        const startNum = Number(src.slice(pos, restStart - 2));
        let listOut = startNum !== 1 ? `<ol start="${startNum}">\n` : '<ol>\n';
        let cur = trimSpacesTabsSlice(src, restStart, end);
        pos = nextPos;
        while (pos < len) {
          const lnl = src.indexOf('\n', pos);
          const lend = lnl === -1 ? len : lnl;
          const lc0 = src.charCodeAt(pos);
          if (lc0 >= 48 && lc0 <= 57) {
            const nr = matchOrderedStart(src, pos, lend);
            if (nr !== -1) {
              listOut += '<li>' + renderInlineHtml(cur, 0, cur.length, resolveLink) + '</li>\n';
              cur = trimSpacesTabsSlice(src, nr, lend);
              pos = lnl === -1 ? len : lnl + 1;
              continue;
            }
          }
          if (isContinuedLine(src, pos, lend)) {
            cur += '\n' + trimSpacesTabsSlice(src, pos, lend);
            pos = lnl === -1 ? len : lnl + 1;
          } else break;
        }
        html += listOut + '<li>' + renderInlineHtml(cur, 0, cur.length, resolveLink) + '</li>\n</ol>\n';
        continue;
      }
    }

    const pStart = pos;
    let pEnd = end;
    const needsTrim = c0 === 32 || c0 === 9 || src.charCodeAt(end - 1) === 32 || src.charCodeAt(end - 1) === 9;
    pos = nextPos;
    let pLines = needsTrim ? [trimSpacesTabsSlice(src, pStart, end)] : null;
    while (pos < len) {
      const pnl = src.indexOf('\n', pos);
      const pend = pnl === -1 ? len : pnl;
      if (pos === pend) break;
      const fc = src.charCodeAt(pos);
      if (fc === 32 || fc === 9 || fc === 96 || fc === 35 || fc === 45 || fc === 42) {
        if (endsParagraphLine(src, pos, pend)) break;
      }
      if (pLines !== null) pLines.push(trimSpacesTabsSlice(src, pos, pend));
      else {
        const lc = src.charCodeAt(pend - 1);
        if (fc === 32 || fc === 9 || lc === 32 || lc === 9) {
          pLines = [src.slice(pStart, pEnd), trimSpacesTabsSlice(src, pos, pend)];
        } else pEnd = pend;
      }
      pos = pnl === -1 ? len : pnl + 1;
    }
    const pHtml = pLines === null
      ? renderInlineHtml(src, pStart, pEnd, resolveLink)
      : (() => { const j = pLines.join('\n'); return renderInlineHtml(j, 0, j.length, resolveLink); })();
    if (excerpt === null) excerpt = pHtml;
    html += '<p>' + pHtml + '</p>\n';
  }
  return { html, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- Templates

const RE_TPL_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const RE_TPL_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const RE_TPL_IF = /^if (not )?(\S+)$/;
const RE_TPL_INC = /^include "([a-z0-9-]+)"$/;

class TemplateError extends Error {}

function parsePath(name, text) {
  if (!RE_TPL_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function isSpacesTabs(src, a, b) {
  for (let i = a; i < b; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  const len = src.length;
  let text = '';
  let i = 0;

  while (i < len) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === len - 1) { text += src.slice(i); break; }
    const next = src.charCodeAt(open + 1);
    if (next !== 123 && next !== 37) { text += src.slice(i, open + 1); i = open + 1; continue; }
    text += src.slice(i, open);
    if (next === 123) {
      const raw = src.charCodeAt(open + 2) === 123;
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text.length > 0) { body.push({ kind: 'text', text }); text = ''; }
      body.push({ kind: raw ? 'raw' : 'var', path: parsePath(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = open === 0 ? 0 : src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? len : nl;
    const standalone = isSpacesTabs(src, lineStart, open) && isSpacesTabs(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text.length > 0) { body.push({ kind: 'text', text }); text = ''; }
    const tag = src.slice(open + 2, close).trim();
    const top = stack[stack.length - 1];
    let m;
    if ((m = RE_TPL_FOR.exec(tag)) !== null) {
      const node = { kind: 'for', name: m[1], path: parsePath(name, m[2]), body: [] };
      body.push(node); stack.push(node); body = node.body;
    } else if ((m = RE_TPL_IF.exec(tag)) !== null) {
      const node = { kind: 'if', not: m[1] !== undefined, path: parsePath(name, m[2]), then: [], else: null };
      body.push(node); stack.push(node); body = node.then;
    } else if (tag === 'else') {
      if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
      top.else = []; body = top.else;
    } else if (tag === 'endfor' || tag === 'endif') {
      if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      stack.pop();
      const parent = stack[stack.length - 1];
      body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : (parent.else ?? parent.then);
    } else if ((m = RE_TPL_INC.exec(tag)) !== null) {
      body.push({ kind: 'include', name: m[1] });
    } else {
      throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
    i = standalone ? (nl === -1 ? len : nl + 1) : end;
  }
  if (text.length > 0) body.push({ kind: 'text', text });
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

function isPreJsonMdSafe(templates) {
  function walk(nodes) {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.kind === 'var') {
        const last = n.path[n.path.length - 1];
        if (last === 'content' || last === 'excerpt' || last === 'html') return false;
      } else if (n.kind === 'if') {
        if (!walk(n.then)) return false;
        if (n.else !== null && !walk(n.else)) return false;
      } else if (n.kind === 'for') {
        if (!walk(n.body)) return false;
      }
    }
    return true;
  }
  for (const nodes of templates.values()) if (!walk(nodes)) return false;
  return true;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    const n = v.length;
    if (n === 0) return '';
    let s = textOf(v[0]);
    for (let i = 1; i < n; i++) s += ', ' + textOf(v[i]);
    return s;
  }
  if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('utf8');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function lookupPathFromVal(v, path, startIdx) {
  for (let k = startIdx; k < path.length; k++) {
    if (v === null || v === undefined || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function lookupScope(scope, path) {
  let s = scope;
  const rootKey = path[0];
  while (s !== null && !Object.hasOwn(s.vars, rootKey)) s = s.parent;
  if (s === null) return undefined;
  return lookupPathFromVal(s.vars[rootKey], path, 1);
}

function renderStaticNodes(nodes, scope, templates, depth, jsonMode, preJsonMd) {
  let out = '';
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.kind === 'text') {
      out += jsonMode ? escapeJson(n.text) : n.text;
    } else if (n.kind === 'var') {
      const txt = textOf(lookupScope(scope, n.path));
      out += jsonMode ? escapeHtmlJson(txt) : escapeHtml(txt);
    } else if (n.kind === 'raw') {
      const v = lookupScope(scope, n.path);
      const txt = textOf(v);
      const alreadyJson = preJsonMd && (v instanceof Uint8Array);
      out += jsonMode ? (alreadyJson ? txt : escapeJson(txt)) : txt;
    } else if (n.kind === 'if') {
      const branch = (truthy(lookupScope(scope, n.path)) !== n.not) ? n.then : n.else;
      if (branch !== null) out += renderStaticNodes(branch, scope, templates, depth, jsonMode, preJsonMd);
    } else if (n.kind === 'for') {
      const xs = lookupScope(scope, n.path);
      if (Array.isArray(xs)) {
        const len = xs.length;
        for (let k = 0; k < len; k++) {
          const vars = {
            [n.name]: xs[k],
            loop: { index: k + 1, first: k === 0, last: k === len - 1, length: len },
          };
          out += renderStaticNodes(n.body, { vars, parent: scope }, templates, depth, jsonMode, preJsonMd);
        }
      }
    } else if (n.kind === 'include') {
      if (depth < INCLUDE_DEPTH) {
        const t = templates.get(n.name);
        if (t !== undefined) out += renderStaticNodes(t, scope, templates, depth + 1, jsonMode, preJsonMd);
      }
    }
  }
  return out;
}

function hasDynamicRef(nodes, bound, dynSet, templates, depth) {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.kind === 'var' || n.kind === 'raw') {
      if (!bound.has(n.path[0]) && dynSet.has(n.path[0])) return true;
    } else if (n.kind === 'if') {
      if (!bound.has(n.path[0]) && dynSet.has(n.path[0])) return true;
      if (hasDynamicRef(n.then, bound, dynSet, templates, depth)) return true;
      if (n.else !== null && hasDynamicRef(n.else, bound, dynSet, templates, depth)) return true;
    } else if (n.kind === 'for') {
      if (!bound.has(n.path[0]) && dynSet.has(n.path[0])) return true;
      const nb = new Set(bound); nb.add(n.name); nb.add('loop');
      if (hasDynamicRef(n.body, nb, dynSet, templates, depth)) return true;
    } else if (n.kind === 'include') {
      if (depth < INCLUDE_DEPTH) {
        const t = templates.get(n.name);
        if (t !== undefined && hasDynamicRef(t, bound, dynSet, templates, depth + 1)) return true;
      }
    }
  }
  return false;
}

function specializeNodes(nodes, bound, staticVars, dynSet, truthyRoot, templates, depth, jsonMode, preJsonMd) {
  const out = [];
  const pushText = (txt) => {
    if (txt.length === 0) return;
    if (out.length > 0 && out[out.length - 1].kind === 'text') out[out.length - 1].text += txt;
    else out.push({ kind: 'text', text: txt });
  };

  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.kind === 'text') {
      pushText(jsonMode ? escapeJson(n.text) : n.text);
    } else if (n.kind === 'include') {
      if (depth < INCLUDE_DEPTH) {
        const t = templates.get(n.name);
        if (t !== undefined) {
          const sub = specializeNodes(t, bound, staticVars, dynSet, truthyRoot, templates, depth + 1, jsonMode, preJsonMd);
          for (let j = 0; j < sub.length; j++) {
            if (sub[j].kind === 'text') pushText(sub[j].text);
            else out.push(sub[j]);
          }
        }
      }
    } else if (n.kind === 'var' || n.kind === 'raw') {
      const r = n.path[0];
      if (!bound.has(r) && !dynSet.has(r)) {
        const v = Object.hasOwn(staticVars, r) ? lookupPathFromVal(staticVars[r], n.path, 1) : undefined;
        const txt = textOf(v);
        if (n.kind === 'var') {
          pushText(jsonMode ? escapeHtmlJson(txt) : escapeHtml(txt));
        } else {
          const alreadyJson = preJsonMd && (v instanceof Uint8Array);
          pushText(jsonMode ? (alreadyJson ? txt : escapeJson(txt)) : txt);
        }
      } else {
        out.push(n);
      }
    } else if (n.kind === 'if') {
      const r = n.path[0];
      if (!bound.has(r) && !dynSet.has(r)) {
        const v = Object.hasOwn(staticVars, r) ? lookupPathFromVal(staticVars[r], n.path, 1) : undefined;
        const branch = (truthy(v) !== n.not) ? n.then : n.else;
        if (branch !== null) {
          const sub = specializeNodes(branch, bound, staticVars, dynSet, truthyRoot, templates, depth, jsonMode, preJsonMd);
          for (let j = 0; j < sub.length; j++) {
            if (sub[j].kind === 'text') pushText(sub[j].text);
            else out.push(sub[j]);
          }
        }
      } else if (!bound.has(r) && n.path.length === 1 && truthyRoot.has(r)) {
        const branch = (!n.not) ? n.then : n.else;
        if (branch !== null) {
          const sub = specializeNodes(branch, bound, staticVars, dynSet, truthyRoot, templates, depth, jsonMode, preJsonMd);
          for (let j = 0; j < sub.length; j++) {
            if (sub[j].kind === 'text') pushText(sub[j].text);
            else out.push(sub[j]);
          }
        }
      } else {
        const thenSub = specializeNodes(n.then, bound, staticVars, dynSet, truthyRoot, templates, depth, jsonMode, preJsonMd);
        const elseSub = n.else !== null ? specializeNodes(n.else, bound, staticVars, dynSet, truthyRoot, templates, depth, jsonMode, preJsonMd) : null;
        if (thenSub.length > 0 || (elseSub !== null && elseSub.length > 0)) {
          out.push({ kind: 'if', not: n.not, path: n.path, then: thenSub, else: elseSub });
        }
      }
    } else if (n.kind === 'for') {
      const r = n.path[0];
      if (!bound.has(r) && !dynSet.has(r) && !hasDynamicRef(n.body, new Set([...bound, n.name, 'loop']), dynSet, templates, depth)) {
        pushText(renderStaticNodes([n], { vars: staticVars, parent: null }, templates, depth, jsonMode, preJsonMd));
      } else {
        const nb = new Set(bound); nb.add(n.name); nb.add('loop');
        const bodySub = specializeNodes(n.body, nb, staticVars, dynSet, truthyRoot, templates, depth, jsonMode, preJsonMd);
        if (bodySub.length > 0) out.push({ kind: 'for', name: n.name, path: n.path, body: bodySub });
      }
    }
  }
  return out;
}

const OP_LIT = 0;
const OP_VAR = 1;
const OP_VAR_SAFE = 2;
const OP_RAW = 3;
const OP_RAW_BUF = 4; // Zero-copy Buffer view from mdSlab (content / excerpt / toc.html)
const OP_IF = 5;
const OP_FOR = 6;
const OP_CARD_LOOP = 7;

const SAFE_ASCII_FIELDS = new Set([
  'slug', 'id', 'date', 'date_long', 'reading_minutes', 'level', 'number', 'total', 'count', 'index',
]);

function isProtoFreeKey(k) {
  return !(k in Object.prototype) && !(k in Array.prototype);
}

function usesOnlyAllowed(ast, allowed) {
  for (let i = 0; i < ast.length; i++) {
    const n = ast[i];
    if (n.kind === 'var' || n.kind === 'raw') {
      if (!allowed.has(n.path[0])) return false;
    } else if (n.kind === 'if') {
      if (!allowed.has(n.path[0])) return false;
      if (!usesOnlyAllowed(n.then, allowed)) return false;
      if (n.else !== null && !usesOnlyAllowed(n.else, allowed)) return false;
    } else if (n.kind === 'for') {
      if (!allowed.has(n.path[0])) return false;
      const na = new Set(allowed); na.add(n.name); na.add('loop');
      if (!usesOnlyAllowed(n.body, na)) return false;
    }
  }
  return true;
}

function compilePath(path, slotMap, staticVars) {
  const r = path[0];
  if (slotMap.has(r)) {
    const slot = slotMap.get(r);
    const len = path.length;
    if (len === 1) return { mode: 1, slot, k1: '', k2: '', rest: null };
    if (len === 2) {
      const k1 = path[1];
      return { mode: isProtoFreeKey(k1) ? 2 : 3, slot, k1, k2: '', rest: null };
    }
    if (len === 3) {
      const k1 = path[1], k2 = path[2];
      return { mode: (isProtoFreeKey(k1) && isProtoFreeKey(k2)) ? 4 : 5, slot, k1, k2, rest: null };
    }
    return { mode: 6, slot, k1: '', k2: '', rest: path.slice(1) };
  }
  if (Object.hasOwn(staticVars, r)) {
    return { mode: 0, slot: -1, k1: lookupPathFromVal(staticVars[r], path, 1), k2: '', rest: null };
  }
  return { mode: 0, slot: -1, k1: undefined, k2: '', rest: null };
}

function evalPath(p, slots) {
  const mode = p.mode;
  if (mode === 2) {
    const o = slots[p.slot];
    return o !== null && o !== undefined && typeof o === 'object' ? o[p.k1] : undefined;
  }
  if (mode === 4) {
    const o1 = slots[p.slot];
    if (o1 === null || o1 === undefined || typeof o1 !== 'object') return undefined;
    const o2 = o1[p.k1];
    return o2 !== null && o2 !== undefined && typeof o2 === 'object' ? o2[p.k2] : undefined;
  }
  if (mode === 1) return slots[p.slot];
  if (mode === 3) {
    const o = slots[p.slot];
    return o !== null && o !== undefined && typeof o === 'object' && Object.hasOwn(o, p.k1) ? o[p.k1] : undefined;
  }
  if (mode === 5) {
    const o1 = slots[p.slot];
    if (o1 === null || o1 === undefined || typeof o1 !== 'object' || !Object.hasOwn(o1, p.k1)) return undefined;
    const o2 = o1[p.k1];
    return o2 !== null && o2 !== undefined && typeof o2 === 'object' && Object.hasOwn(o2, p.k2) ? o2[p.k2] : undefined;
  }
  if (mode === 0) return p.k1;
  return lookupPathFromVal(slots[p.slot], p.rest, 0);
}

function buildFlatOps(ast, slotMap, nextSlotRef, staticVars, cardMemo, jsonMode, preJsonMd, safeUrls) {
  const ops = new Array(ast.length);
  for (let i = 0; i < ast.length; i++) {
    const n = ast[i];
    if (n.kind === 'text') {
      ops[i] = { op: OP_LIT, val: jsonMode ? Buffer.from(n.text, 'utf8') : n.text };
    } else if (n.kind === 'var') {
      const last = n.path[n.path.length - 1];
      const isSafe =
        jsonMode &&
        (SAFE_ASCII_FIELDS.has(last) || (safeUrls && (last === 'url' || last === 'newer_url' || last === 'older_url')));
      ops[i] = { op: isSafe ? OP_VAR_SAFE : OP_VAR, path: compilePath(n.path, slotMap, staticVars) };
    } else if (n.kind === 'raw') {
      const last = n.path[n.path.length - 1];
      const isPreBuf = jsonMode && preJsonMd && (last === 'content' || last === 'excerpt' || last === 'html');
      ops[i] = { op: isPreBuf ? OP_RAW_BUF : OP_RAW, path: compilePath(n.path, slotMap, staticVars) };
    } else if (n.kind === 'if') {
      ops[i] = {
        op: OP_IF,
        not: n.not,
        path: compilePath(n.path, slotMap, staticVars),
        thenOps: buildFlatOps(n.then, slotMap, nextSlotRef, staticVars, cardMemo, jsonMode, preJsonMd, safeUrls),
        elseOps: n.else !== null && n.else.length > 0
          ? buildFlatOps(n.else, slotMap, nextSlotRef, staticVars, cardMemo, jsonMode, preJsonMd, safeUrls)
          : null,
      };
    } else if (n.kind === 'for') {
      const isCardLoop =
        cardMemo !== null &&
        n.name !== 'loop' &&
        ((n.path.length === 1 && n.path[0] === 'posts' && slotMap.get('posts') === 0) ||
          (n.path.length === 2 && n.path[0] === 'tag' && n.path[1] === 'posts' && slotMap.get('tag') === 0)) &&
        usesOnlyAllowed(n.body, new Set([n.name]));

      if (isCardLoop) {
        const sig = JSON.stringify({ name: n.name, body: n.body });
        let memo = cardMemo.get(sig);
        if (memo === undefined) {
          const cSlotMap = new Map([[n.name, 0]]);
          const cRef = { n: 1 };
          const cOps = buildFlatOps(n.body, cSlotMap, cRef, staticVars, null, jsonMode, preJsonMd, safeUrls);
          memo = { ops: cOps, slots: new Array(cRef.n), cache: new Map() };
          cardMemo.set(sig, memo);
        }
        ops[i] = { op: OP_CARD_LOOP, path: compilePath(n.path, slotMap, staticVars), memo };
      } else {
        const itemSlot = nextSlotRef.n++;
        const loopSlot = nextSlotRef.n++;
        const childMap = new Map(slotMap);
        childMap.set(n.name, itemSlot);
        childMap.set('loop', loopSlot);
        ops[i] = {
          op: OP_FOR,
          path: compilePath(n.path, slotMap, staticVars),
          itemSlot,
          loopSlot,
          bodyOps: buildFlatOps(n.body, childMap, nextSlotRef, staticVars, null, jsonMode, preJsonMd, safeUrls),
        };
      }
    }
  }
  return ops;
}

function execOpsJson(ops, slots, writer, recorder) {
  const len = ops.length;
  for (let i = 0; i < len; i++) {
    const inst = ops[i];
    const op = inst.op;
    if (op === OP_LIT) {
      writer.writeBuf(inst.val);
    } else if (op === OP_RAW_BUF) {
      const v = evalPath(inst.path, slots);
      if (v instanceof Uint8Array) {
        writer.writeBuf(v);
      } else if (typeof v === 'string') {
        if (v.length > 0) writer.writeJsonEscaped(v);
      } else if (v !== undefined) {
        const s = textOf(v);
        if (s.length > 0) writer.writeJsonEscaped(s);
      }
    } else if (op === OP_VAR_SAFE) {
      const v = evalPath(inst.path, slots);
      if (typeof v === 'string') {
        if (v.length > 0) writer.writeSafeAscii(v);
      } else if (typeof v === 'number') {
        writer.writeSafeAscii(String(v));
      } else if (v !== undefined) {
        const s = textOf(v);
        if (s.length > 0) writer.writeHtmlJsonEscaped(s);
      }
    } else if (op === OP_VAR) {
      const v = evalPath(inst.path, slots);
      if (typeof v === 'string') {
        if (v.length > 0) writer.writeHtmlJsonEscaped(v);
      } else if (typeof v === 'number') {
        writer.writeSafeAscii(String(v));
      } else if (v !== undefined) {
        const s = textOf(v);
        if (s.length > 0) writer.writeHtmlJsonEscaped(s);
      }
    } else if (op === OP_RAW) {
      const v = evalPath(inst.path, slots);
      if (v instanceof Uint8Array) {
        writer.writeBuf(v);
      } else if (typeof v === 'string') {
        if (v.length > 0) writer.writeJsonEscaped(v);
      } else if (v !== undefined) {
        const s = textOf(v);
        if (s.length > 0) writer.writeJsonEscaped(s);
      }
    } else if (op === OP_IF) {
      const v = truthy(evalPath(inst.path, slots));
      const branch = v !== inst.not ? inst.thenOps : inst.elseOps;
      if (branch !== null) execOpsJson(branch, slots, writer, recorder);
    } else if (op === OP_CARD_LOOP) {
      const xs = evalPath(inst.path, slots);
      if (Array.isArray(xs)) {
        const memo = inst.memo;
        const cache = memo.cache;
        const cSlots = memo.slots;
        const cOps = memo.ops;
        const n = xs.length;
        for (let k = 0; k < n; k++) {
          const item = xs[k];
          let buf = cache.get(item);
          if (buf === undefined) {
            cSlots[0] = item;
            recorder.begin();
            execOpsJson(cOps, cSlots, recorder, recorder);
            buf = recorder.finish();
            cache.set(item, buf);
          }
          writer.writeBuf(buf);
        }
      }
    } else {
      const xs = evalPath(inst.path, slots);
      if (Array.isArray(xs)) {
        const n = xs.length;
        const iSlot = inst.itemSlot;
        const lSlot = inst.loopSlot;
        const bodyOps = inst.bodyOps;
        const lp = { index: 0, first: false, last: false, length: n };
        slots[lSlot] = lp;
        for (let k = 0; k < n; k++) {
          slots[iSlot] = xs[k];
          lp.index = k + 1;
          lp.first = k === 0;
          lp.last = k === n - 1;
          execOpsJson(bodyOps, slots, writer, recorder);
        }
      }
    }
  }
}

function execOpsStr(ops, slots) {
  let out = '';
  const len = ops.length;
  for (let i = 0; i < len; i++) {
    const inst = ops[i];
    const op = inst.op;
    if (op === OP_LIT) out += inst.val;
    else if (op === OP_VAR || op === OP_VAR_SAFE) {
      const v = evalPath(inst.path, slots);
      if (typeof v === 'string') { if (v.length > 0) out += escapeHtml(v); }
      else if (typeof v === 'number') out += String(v);
      else if (v !== undefined) { const s = textOf(v); if (s.length > 0) out += escapeHtml(s); }
    } else if (op === OP_RAW || op === OP_RAW_BUF) {
      const v = evalPath(inst.path, slots);
      if (typeof v === 'string') out += v;
      else if (v !== undefined) out += textOf(v);
    } else if (op === OP_IF) {
      const branch = truthy(evalPath(inst.path, slots)) !== inst.not ? inst.thenOps : inst.elseOps;
      if (branch !== null) out += execOpsStr(branch, slots);
    } else if (op === OP_CARD_LOOP) {
      const xs = evalPath(inst.path, slots);
      if (Array.isArray(xs)) {
        const memo = inst.memo, cache = memo.cache, cSlots = memo.slots, cOps = memo.ops;
        for (let k = 0; k < xs.length; k++) {
          const item = xs[k];
          let str = cache.get(item);
          if (str === undefined) {
            cSlots[0] = item;
            str = execOpsStr(cOps, cSlots);
            cache.set(item, str);
          }
          out += str;
        }
      }
    } else {
      const xs = evalPath(inst.path, slots);
      if (Array.isArray(xs)) {
        const n = xs.length, iSlot = inst.itemSlot, lSlot = inst.loopSlot, bodyOps = inst.bodyOps;
        const lp = { index: 0, first: false, last: false, length: n };
        slots[lSlot] = lp;
        for (let k = 0; k < n; k++) {
          slots[iSlot] = xs[k]; lp.index = k + 1; lp.first = k === 0; lp.last = k === n - 1;
          out += execOpsStr(bodyOps, slots);
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- Path Helpers

function dirOf(path) {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

function isPureSafeAscii(s) {
  const len = s.length;
  for (let i = 0; i < len; i++) {
    const c = s.charCodeAt(i);
    if (c >= 128 || HTML_JSON_TRIG[c] !== 0) return false;
  }
  return true;
}

function hasScheme(target) {
  const colon = target.indexOf(':');
  if (colon <= 0) return false;
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < colon; i++) {
    const c = target.charCodeAt(i);
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) {
      return false;
    }
  }
  return true;
}

function resolveRelPath(dir, rel) {
  const parts = dir.length === 0 ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg.length === 0 || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const cardRecorder = createSlabRecorder(1024 * 1024);

// ---------------------------------------------------------------- Main Build

export function run(input, writer) {
  const jsonMode = writer !== undefined;
  const report = [];
  const templates = new Map();

  // Reset per-case reusable slabs (case-isolated: nothing cached across cases!)
  if (jsonMode) {
    mdPos = 0;
    cardRecorder.resetAll();
  }

  // 1. Parse templates in code-unit order
  const tplNames = Object.keys(input.templates).sort(byCodeUnits);
  for (let i = 0; i < tplNames.length; i++) {
    const name = tplNames[i];
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  const preJsonMd = jsonMode && isPreJsonMdSafe(templates);

  let base = input.site.base_url;
  let bEnd = base.length;
  while (bEnd > 0 && base.charCodeAt(bEnd - 1) === 47) bEnd--;
  if (bEnd !== base.length) base = base.slice(0, bEnd);
  let safeUrls = isPureSafeAscii(base);

  // 2. Partition & sort files in code-unit order
  const rawFiles = input.files;
  const mdFiles = [];
  const statics = [];
  for (let i = 0; i < rawFiles.length; i++) {
    const f = rawFiles[i];
    if (f.path.endsWith('.md')) mdFiles.push(f);
    else statics.push(f);
  }
  mdFiles.sort((x, y) => byCodeUnits(x.path, y.path));
  statics.sort((x, y) => byCodeUnits(x.path, y.path));

  // 3 & 4. Front matter validation & permalinks
  const sources = [];
  const bySource = new Map();
  const takenByDir = new Map();
  takenByDir.set('', new Set(RESERVED_ROOT));

  for (let i = 0; i < mdFiles.length; i++) {
    const f = mdFiles[i];
    const path = f.path;
    let text = f.content;
    if (text.indexOf('\r') !== -1) text = text.replace(/\r\n?/g, '\n');

    const fm = parseFrontMatterFast(text);
    if (fm.error !== undefined) { report.push(`refused ${path}: ${fm.error}`); continue; }
    const data = fm.data;
    const isPost = path.startsWith('posts/');
    if (path.startsWith('tags/')) { report.push(`refused ${path}: tags/ is the generator's own`); continue; }
    if (path.startsWith('page/')) { report.push(`refused ${path}: page/ is the generator's own`); continue; }
    if (isPost && data.date === undefined) { report.push(`refused ${path}: a post needs a date`); continue; }
    const layout = data.layout !== undefined ? data.layout : (isPost ? 'post' : 'page');
    if (!templates.has(layout)) { report.push(`refused ${path}: layout "${layout}" is no template that parses`); continue; }
    if (data.draft === true) { report.push(`draft ${path}`); continue; }

    const srcDir = dirOf(path);
    const dir = isPost ? 'posts' : srcDir;
    if (safeUrls && dir.length > 0 && !isPureSafeAscii(dir)) safeUrls = false;
    let taken = takenByDir.get(dir);
    if (taken === undefined) { taken = new Set(); takenByDir.set(dir, taken); }
    const slug = uniqueSlug(data.slug !== undefined ? data.slug : slugify(data.title), taken);
    const outDir = dir.length === 0 ? slug : `${dir}/${slug}`;
    const url = `${base}/${outDir}/`;

    const srcObj = {
      path,
      dir: srcDir,
      data,
      body: fm.body,
      post: isPost,
      layout,
      slug,
      outDir,
      url,
      html: '',
      toc: null,
      excerpt: '',
      newer: null,
      older: null,
      tagRefs: null,
      dateLong: data.date === undefined ? '' : longDate(data.date),
      readingMinutes: -1,
      card: null,
      linkObj: null,
    };
    sources.push(srcObj);
    bySource.set(path, srcObj);
  }

  // 5. Markdown rendering & cached link resolution
  const staticPaths = new Set();
  for (let i = 0; i < statics.length; i++) staticPaths.add(statics[i].path);
  const broken = new Set();
  const relCacheByDir = new Map();

  if (preJsonMd) {
    const extBufCache = new Map();
    const toEscBuf = (raw) => {
      let b = extBufCache.get(raw);
      if (b === undefined) {
        b = Buffer.from(escapeHtmlJson(raw), 'utf8');
        extBufCache.set(raw, b);
      }
      return b;
    };
    for (let i = 0; i < sources.length; i++) {
      const s = sources[i];
      const dir = s.dir;
      let dirCache = relCacheByDir.get(dir);
      if (dirCache === undefined) { dirCache = new Map(); relCacheByDir.set(dir, dirCache); }
      const sPath = s.path;
      const resolveLinkBuf = (target) => {
        const c0 = target.charCodeAt(0);
        if (c0 === 47 || c0 === 35 || hasScheme(target)) return toEscBuf(target);
        const cachedFull = dirCache.get(target);
        if (cachedFull !== undefined) {
          if (cachedFull !== null) return cachedFull;
          broken.add(`broken-link ${sPath} -> ${target}`);
          return toEscBuf(target);
        }
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        if (rel.length === 0) {
          dirCache.set(target, null);
          broken.add(`broken-link ${sPath} -> ${target}`);
          return toEscBuf(target);
        }
        let resolvedBuf = hash === -1 ? undefined : dirCache.get(rel);
        if (resolvedBuf === undefined) {
          const resolvedPath = resolveRelPath(dir, rel);
          if (resolvedPath !== null) {
            const hit = bySource.get(resolvedPath);
            if (hit !== undefined) resolvedBuf = Buffer.from(escapeHtmlJson(hit.url), 'utf8');
            else if (staticPaths.has(resolvedPath)) resolvedBuf = Buffer.from(escapeHtmlJson(`${base}/${resolvedPath}`), 'utf8');
            else resolvedBuf = null;
          } else resolvedBuf = null;
          dirCache.set(rel, resolvedBuf);
        }
        if (resolvedBuf !== null) {
          if (hash === -1) return resolvedBuf;
          const fragBuf = toEscBuf(target.slice(hash));
          const combined = Buffer.allocUnsafe(resolvedBuf.length + fragBuf.length);
          combined.set(resolvedBuf, 0);
          combined.set(fragBuf, resolvedBuf.length);
          dirCache.set(target, combined);
          return combined;
        }
        if (hash !== -1) dirCache.set(target, null);
        broken.add(`broken-link ${sPath} -> ${target}`);
        return toEscBuf(target);
      };

      const md = renderMarkdownToSlab(s.body, resolveLinkBuf);
      s.html = md.html;
      s.toc = md.toc;
      s.excerpt = md.excerpt;
      if (s.post) s.readingMinutes = readingMinutesOf(s.body);
    }
  } else {
    for (let i = 0; i < sources.length; i++) {
      const s = sources[i];
      const dir = s.dir;
      let dirCache = relCacheByDir.get(dir);
      if (dirCache === undefined) { dirCache = new Map(); relCacheByDir.set(dir, dirCache); }
      const sPath = s.path;
      const resolveEscLink = (target) => {
        const c0 = target.charCodeAt(0);
        if (c0 === 47 || c0 === 35 || hasScheme(target)) return escapeHtml(target);
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        if (rel.length === 0) { broken.add(`broken-link ${sPath} -> ${target}`); return escapeHtml(target); }
        let resolvedEsc = dirCache.get(rel);
        if (resolvedEsc === undefined) {
          const resolvedPath = resolveRelPath(dir, rel);
          if (resolvedPath !== null) {
            const hit = bySource.get(resolvedPath);
            if (hit !== undefined) resolvedEsc = escapeHtml(hit.url);
            else if (staticPaths.has(resolvedPath)) resolvedEsc = escapeHtml(`${base}/${resolvedPath}`);
            else resolvedEsc = null;
          } else resolvedEsc = null;
          dirCache.set(rel, resolvedEsc);
        }
        if (resolvedEsc !== null) return hash === -1 ? resolvedEsc : resolvedEsc + escapeHtml(target.slice(hash));
        broken.add(`broken-link ${sPath} -> ${target}`);
        return escapeHtml(target);
      };
      const md = renderMarkdownStr(s.body, resolveEscLink);
      s.html = md.html;
      s.toc = md.toc;
      s.excerpt = md.excerpt;
      if (s.post) s.readingMinutes = readingMinutesOf(s.body);
    }
  }

  // 6. Collections
  const posts = [];
  for (let i = 0; i < sources.length; i++) if (sources[i].post) posts.push(sources[i]);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 7. Tags & pre-linked cards
  const tagSlugCache = new Map();
  const slugTag = (name) => {
    let sl = tagSlugCache.get(name);
    if (sl === undefined) { sl = slugify(name); tagSlugCache.set(name, sl); }
    return sl;
  };

  const bySlug = new Map();
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    const rawTags = p.data.tags;
    let cardTags;
    if (rawTags === undefined || rawTags.length === 0) {
      cardTags = [];
    } else {
      const seen = new Set();
      cardTags = [];
      for (let j = 0; j < rawTags.length; j++) {
        const name = rawTags[j];
        const sl = slugTag(name);
        if (seen.has(sl)) continue;
        seen.add(sl);
        let tag = bySlug.get(sl);
        if (tag === undefined) {
          const url = `${base}/tags/${sl}/`;
          tag = { name, slug: sl, url, cards: [], cardRef: { name, slug: sl, url } };
          bySlug.set(sl, tag);
        }
        cardTags.push(tag.cardRef);
      }
    }
    const card = {
      title: p.data.title,
      url: p.url,
      date: p.data.date ?? '',
      date_long: p.dateLong,
      summary: p.data.summary ?? '',
      excerpt: p.excerpt,
      reading_minutes: p.readingMinutes,
      tags: cardTags,
    };
    p.card = card;
    p.linkObj = { title: p.data.title, url: p.url, date: card.date, date_long: p.dateLong };
    for (let j = 0; j < cardTags.length; j++) bySlug.get(cardTags[j].slug).cards.push(card);
  }

  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    if (s.post) continue;
    const rawTags = s.data.tags;
    if (rawTags === undefined || rawTags.length === 0) { s.tagRefs = []; continue; }
    const seen = new Set();
    const refs = [];
    for (let j = 0; j < rawTags.length; j++) {
      const name = rawTags[j];
      const sl = slugTag(name);
      if (seen.has(sl)) continue;
      seen.add(sl);
      const hit = bySlug.get(sl);
      refs.push(hit !== undefined ? hit.cardRef : { name, slug: sl, url: '' });
    }
    s.tagRefs = refs;
  }

  const allTagObjs = [...bySlug.values()].sort((x, y) => y.cards.length - x.cards.length || byCodeUnits(x.slug, y.slug));
  const site = { title: input.site.title, base_url: base };
  const allTags = new Array(allTagObjs.length);
  for (let i = 0; i < allTagObjs.length; i++) {
    const t = allTagObjs[i];
    allTags[i] = { name: t.name, slug: t.slug, url: t.url, count: t.cards.length };
  }
  const recentCount = Math.min(input.site.recent, posts.length);
  const recent = new Array(recentCount);
  for (let i = 0; i < recentCount; i++) recent[i] = posts[i].card;

  const staticVars = { site, tags: allTags, recent };
  const cardMemo = new Map();
  const compiledPageLayouts = new Map();

  const getPagePlan = (layoutName) => {
    let plan = compiledPageLayouts.get(layoutName);
    if (plan === undefined) {
      const spec = specializeNodes(
        templates.get(layoutName), new Set(), staticVars,
        new Set(['page']), new Set(['page']), templates, 0, jsonMode, preJsonMd,
      );
      const slotMap = new Map([['page', 0]]);
      const ref = { n: 1 };
      const ops = buildFlatOps(spec, slotMap, ref, staticVars, null, jsonMode, preJsonMd, safeUrls);
      let needsRm = false;
      const scanRm = (arr) => {
        for (let k = 0; k < arr.length; k++) {
          const op = arr[k];
          if (op.path && (op.path.k1 === 'reading_minutes' || op.path.k2 === 'reading_minutes')) needsRm = true;
          if (op.thenOps) scanRm(op.thenOps);
          if (op.elseOps) scanRm(op.elseOps);
          if (op.bodyOps) scanRm(op.bodyOps);
        }
      };
      scanRm(ops);
      plan = { ops, slots: new Array(ref.n), needsRm };
      compiledPageLayouts.set(layoutName, plan);
    }
    return plan;
  };

  const pageObj = {
    title: '', url: '', date: '', date_long: '', summary: '', excerpt: '',
    reading_minutes: 1, tags: null, slug: '', content: '', toc: null,
    newer: null, older: null, is_post: false,
  };

  const fillPageObj = (s, needsRm) => {
    if (s.post) {
      const c = s.card;
      pageObj.title = c.title; pageObj.url = c.url; pageObj.date = c.date;
      pageObj.date_long = c.date_long; pageObj.summary = c.summary; pageObj.excerpt = c.excerpt;
      pageObj.reading_minutes = c.reading_minutes; pageObj.tags = c.tags;
      pageObj.newer = s.newer !== null ? s.newer.linkObj : null;
      pageObj.older = s.older !== null ? s.older.linkObj : null;
      pageObj.is_post = true;
    } else {
      pageObj.title = s.data.title; pageObj.url = s.url; pageObj.date = s.data.date ?? '';
      pageObj.date_long = s.dateLong; pageObj.summary = s.data.summary ?? ''; pageObj.excerpt = s.excerpt;
      pageObj.reading_minutes = needsRm ? readingMinutesOf(s.body) : 1; pageObj.tags = s.tagRefs;
      pageObj.newer = null; pageObj.older = null; pageObj.is_post = false;
    }
    pageObj.slug = s.slug; pageObj.content = s.html; pageObj.toc = s.toc;
  };

  // 8. Render & emit
  const output = jsonMode ? null : Object.create(null);
  const builtPaths = jsonMode ? new Set() : null;
  let firstKey = true;
  if (jsonMode) writer.writeByte(123);

  const emitOps = (outPath, ops, slots) => {
    if (jsonMode) {
      builtPaths.add(outPath);
      writer.writeKeyOpen(outPath, firstKey);
      firstKey = false;
      execOpsJson(ops, slots, writer, cardRecorder);
      writer.writeValueClose();
    } else {
      output[outPath] = execOpsStr(ops, slots);
    }
  };

  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const plan = getPagePlan(s.layout);
    fillPageObj(s, plan.needsRm);
    plan.slots[0] = pageObj;
    emitOps(`${s.outDir}/index.html`, plan.ops, plan.slots);
  }

  if (templates.has('index')) {
    const specIdx = specializeNodes(
      templates.get('index'), new Set(), staticVars,
      new Set(['posts', 'pager']), new Set(['pager']), templates, 0, jsonMode, preJsonMd,
    );
    const ref = { n: 2 };
    const idxOps = buildFlatOps(specIdx, new Map([['posts', 0], ['pager', 1]]), ref, staticVars, cardMemo, jsonMode, preJsonMd, safeUrls);
    const idxSlots = new Array(ref.n);
    const per = input.site.per_page;
    const totalPages = Math.max(1, Math.ceil(posts.length / per));
    const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
    const pager = { number: 0, total: totalPages, url: '', newer_url: '', older_url: '' };
    idxSlots[1] = pager;
    for (let k = 1; k <= totalPages; k++) {
      const start = (k - 1) * per;
      const end = Math.min(k * per, posts.length);
      const pagePosts = new Array(end - start);
      for (let j = start; j < end; j++) pagePosts[j - start] = posts[j].card;
      pager.number = k; pager.url = indexUrl(k);
      pager.newer_url = k === 1 ? '' : indexUrl(k - 1);
      pager.older_url = k === totalPages ? '' : indexUrl(k + 1);
      idxSlots[0] = pagePosts;
      emitOps(k === 1 ? 'index.html' : `page/${k}/index.html`, idxOps, idxSlots);
    }
  }

  if (templates.has('tag')) {
    const specTag = specializeNodes(
      templates.get('tag'), new Set(), staticVars,
      new Set(['tag']), new Set(['tag']), templates, 0, jsonMode, preJsonMd,
    );
    const ref = { n: 1 };
    const tagOps = buildFlatOps(specTag, new Map([['tag', 0]]), ref, staticVars, cardMemo, jsonMode, preJsonMd, safeUrls);
    const tagSlots = new Array(ref.n);
    const tagView = { name: '', slug: '', url: '', count: 0, posts: null };
    tagSlots[0] = tagView;
    for (let i = 0; i < allTagObjs.length; i++) {
      const t = allTagObjs[i];
      tagView.name = t.name; tagView.slug = t.slug; tagView.url = t.url;
      tagView.count = t.cards.length; tagView.posts = t.cards;
      emitOps(`tags/${t.slug}/index.html`, tagOps, tagSlots);
    }
  }

  if (templates.has('tags')) {
    const specTags = specializeNodes(
      templates.get('tags'), new Set(), staticVars,
      new Set(), new Set(), templates, 0, jsonMode, preJsonMd,
    );
    const ref = { n: 0 };
    const tagsOps = buildFlatOps(specTags, new Map(), ref, staticVars, null, jsonMode, preJsonMd, safeUrls);
    emitOps('tags/index.html', tagsOps, []);
  }

  for (let i = 0; i < statics.length; i++) {
    const f = statics[i];
    if (jsonMode) {
      if (builtPaths.has(f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
      else if (f.path !== REPORT_FILE) {
        writer.writeKeyOpen(f.path, firstKey);
        firstKey = false;
        writer.writeJsonEscaped(f.content);
        writer.writeValueClose();
      }
    } else {
      if (f.path in output) report.push(`shadowed ${f.path}: a built page has its path`);
      else output[f.path] = f.content;
    }
  }

  const lines = broken.size > 0 ? [...report, ...broken] : report;
  lines.sort(byCodeUnits);
  const pageCount = sources.length - posts.length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${allTagObjs.length} tags and ${statics.length} static files`);
  const reportText = `${lines.join('\n')}\n`;

  if (jsonMode) {
    writer.writeKeyOpen(REPORT_FILE, firstKey);
    writer.writeJsonEscaped(reportText);
    writer.writeValueClose();
    writer.writeByte(125);
    return undefined;
  }

  output[REPORT_FILE] = reportText;
  return output;
}
