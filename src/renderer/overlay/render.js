'use strict';

// Markdown-lite renderer for the overlay: enough for the shapes the prompt asks
// for (bullets, bold, headings, inline code, fenced blocks, rules). Fenced code
// gets a language badge and C++ syntax colours, because answers to coding
// problems are pinned to C++17 and are read at a glance during a call.
//
// Loaded as a plain script by the overlay and required directly by the tests,
// so it stays dependency-free and works without a build step.
(function (root) {
  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function inline(s) {
    return s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  }

  // -------------------------------------------------------------- C++ colour
  const CPP_KEYWORDS = new Set(
    ('alignas alignof asm auto break case catch class concept const consteval constexpr constinit ' +
      'const_cast continue co_await co_return co_yield decltype default delete do dynamic_cast else enum ' +
      'explicit export extern for friend goto if inline mutable namespace new noexcept operator private ' +
      'protected public register reinterpret_cast requires return sizeof static static_assert static_cast ' +
      'struct switch template this thread_local throw try typedef typeid typename union using virtual ' +
      'volatile while').split(' ')
  );

  const CPP_TYPES = new Set(
    ('void bool char char8_t char16_t char32_t double float int long short signed unsigned wchar_t ' +
      'size_t ssize_t ptrdiff_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t ' +
      'string wstring vector array deque list forward_list map multimap unordered_map set multiset ' +
      'unordered_set stack queue priority_queue pair tuple bitset optional variant function ' +
      'shared_ptr unique_ptr weak_ptr string_view span initializer_list less greater ' +
      'int64_t uint64_t nullptr_t').split(' ')
  );

  const CPP_LITERAL_WORDS = new Set(['true', 'false', 'nullptr', 'NULL']);

  // Comment, string/char, preprocessor line, number, identifier — in that order,
  // so a keyword inside a string or comment is never coloured.
  const CPP_TOKEN =
    /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(^[ \t]*#[A-Za-z_]+)|\b(0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?[fFlLuUzZ]*)\b|([A-Za-z_]\w*)/gm;

  function highlightCpp(code) {
    let out = '';
    let last = 0;
    let m;
    CPP_TOKEN.lastIndex = 0;

    while ((m = CPP_TOKEN.exec(code)) !== null) {
      if (m.index > last) out += escapeHtml(code.slice(last, m.index));
      last = m.index + m[0].length;

      if (m[1]) out += `<span class="tok-com">${escapeHtml(m[1])}</span>`;
      else if (m[2]) out += `<span class="tok-str">${escapeHtml(m[2])}</span>`;
      else if (m[3]) out += `<span class="tok-pre">${escapeHtml(m[3])}</span>`;
      else if (m[4]) out += `<span class="tok-num">${escapeHtml(m[4])}</span>`;
      else {
        const word = m[5];
        const isCall = /^[ \t]*\(/.test(code.slice(last));
        if (CPP_KEYWORDS.has(word)) out += `<span class="tok-kw">${word}</span>`;
        else if (CPP_LITERAL_WORDS.has(word)) out += `<span class="tok-lit">${word}</span>`;
        else if (CPP_TYPES.has(word)) out += `<span class="tok-type">${word}</span>`;
        else if (isCall) out += `<span class="tok-fn">${word}</span>`;
        else if (/^[A-Z][A-Za-z0-9_]*$/.test(word)) out += `<span class="tok-type">${word}</span>`;
        else out += escapeHtml(word);
      }
    }
    if (last < code.length) out += escapeHtml(code.slice(last));
    return out;
  }

  const CPP_LANGS = new Set(['cpp', 'c++', 'cxx', 'cc', 'c', 'objc', 'objcpp', 'h', 'hpp']);
  const looksLikeCpp = (src) =>
    /#\s*include\s*<|\bstd::|\bint\s+main\s*\(|^\s*(class|struct)\s+\w+\s*\{/m.test(src);

  /** One fenced block: language badge on top, coloured body underneath. */
  function codeBlock(lang, code) {
    const tag = String(lang || '').toLowerCase();
    if (tag === 'mermaid') return `<pre><code class="mermaid">${escapeHtml(code)}</code></pre>`;

    const isCpp = CPP_LANGS.has(tag) || (!tag && looksLikeCpp(code));
    const label = isCpp ? 'C++' : tag ? tag.toUpperCase() : 'code';
    const body = isCpp ? highlightCpp(code) : escapeHtml(code);
    return (
      `<div class="code"><div class="code-head">${escapeHtml(label)}</div>` +
      `<pre><code class="cpp">${body}</code></pre></div>`
    );
  }

  function render(md) {
    const lines = String(md).split('\n');
    const out = [];
    let codeLines = null;
    let inList = false;
    let lang = '';

    const closeList = () => {
      if (inList) {
        out.push('</ul>');
        inList = false;
      }
    };

    for (const line of lines) {
      if (line.startsWith('```')) {
        if (codeLines === null) {
          closeList();
          lang = line.slice(3).trim();
          codeLines = [];
        } else {
          out.push(codeBlock(lang, codeLines.join('\n')));
          codeLines = null;
          lang = '';
        }
        continue;
      }
      // Streaming: a block that has not closed yet is rendered as it stands.
      if (codeLines !== null) {
        codeLines.push(line);
        continue;
      }
      if (/^\s*[-*]\s+/.test(line)) {
        if (!inList) {
          out.push('<ul>');
          inList = true;
        }
        out.push(`<li>${inline(escapeHtml(line.replace(/^\s*[-*]\s+/, '')))}</li>`);
        continue;
      }
      closeList();
      if (/^#{1,6}\s/.test(line)) {
        out.push(`<h3>${inline(escapeHtml(line.replace(/^#{1,6}\s+/, '')))}</h3>`);
      } else if (/^\s*(\*\s*\*\s*\*|---)\s*$/.test(line)) {
        out.push('<hr/>');
      } else if (line.trim() === '') {
        continue;
      } else {
        out.push(`<p>${inline(escapeHtml(line))}</p>`);
      }
    }
    closeList();
    if (codeLines !== null) out.push(codeBlock(lang, codeLines.join('\n')));
    return out.join('');
  }

  root.CloudyRender = { render, highlightCpp, codeBlock, escapeHtml };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) module.exports = globalThis.CloudyRender;
