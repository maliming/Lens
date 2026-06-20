// Wraps every case-insensitive occurrence of `query` inside `root`'s text nodes
// with a <mark> element. Walks the live DOM after render — markdown body is
// `dangerouslySetInnerHTML` so we can't pre-process the text without risking
// wrapping into a tag attribute or breaking already-escaped entities.
//
// Skips text inside <script>, <style>, <code>, <pre>, and existing <mark> nodes —
// `<code>`/`<pre>` because highlight.js has already split tokens into nested
// spans and inserting <mark> between them visibly breaks syntax coloring;
// inline matches inside paragraphs / lists / headings are the common case
// users care about anyway. Empty / whitespace-only queries are a no-op.
//
// Returns the list of inserted <mark> elements in document order so the caller
// can index across the whole conversation for prev/next navigation.
export function highlightDom(root: HTMLElement, query: string): HTMLElement[] {
  const trimmed = query.trim();
  if (!trimmed) return [];

  // Escape regex metacharacters — `q` is user input, treated as a literal.
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let re: RegExp;
  try { re = new RegExp(escaped, 'gi'); }
  catch { return []; }

  // Skip <code> to protect highlight.js token spans inside markdown ``` ``` blocks
  // (inserting <mark> between them breaks syntax coloring). <pre> is NOT skipped
  // — tool messages render via CodeBlock as <pre><span>…</span></pre> with no
  // hljs, so we still want to wrap matches there. Plain inline `code` spans
  // stay un-highlighted; acceptable, search-in-code-blocks is uncommon.
  const skipTags = new Set(['SCRIPT', 'STYLE', 'CODE', 'MARK']);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const value = n.nodeValue;
      if (!value) return NodeFilter.FILTER_REJECT;
      // Walk up — anything inside a skipped tag is rejected.
      let p: Node | null = n.parentNode;
      while (p && p !== root) {
        if (p.nodeType === Node.ELEMENT_NODE && skipTags.has((p as Element).tagName)) {
          return NodeFilter.FILTER_REJECT;
        }
        p = p.parentNode;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  // Collect first; mutating the tree mid-walk invalidates the walker.
  const targets: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) targets.push(node as Text);

  const marks: HTMLElement[] = [];
  for (const textNode of targets) {
    const value = textNode.nodeValue || '';
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    let last = 0;
    let frag: DocumentFragment | null = null;
    while ((m = re.exec(value)) !== null) {
      if (!frag) frag = document.createDocumentFragment();
      if (m.index > last) frag.appendChild(document.createTextNode(value.slice(last, m.index)));
      const mark = document.createElement('mark');
      mark.textContent = m[0];
      frag.appendChild(mark);
      marks.push(mark);
      last = m.index + m[0].length;
      // Zero-width match safety — empty regex matches won't happen here (we
      // bail on blank query), but defend anyway against pathological cases.
      if (m[0].length === 0) re.lastIndex++;
    }
    if (frag) {
      if (last < value.length) frag.appendChild(document.createTextNode(value.slice(last)));
      textNode.parentNode?.replaceChild(frag, textNode);
    }
  }
  return marks;
}
