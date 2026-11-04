import { marked } from "marked";
import DOMPurify from "dompurify";

// Model output is untrusted. Keep it inert, including remote images and HTML forms.
export function render(text) {
  return DOMPurify.sanitize(marked.parse(String(text || ""), { gfm: true, breaks: false }), {
    ALLOWED_TAGS: ["p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "em", "del", "s", "blockquote", "ul", "ol", "li", "pre", "code", "table", "thead", "tbody", "tr", "th", "td", "a", "input"],
    ALLOWED_ATTR: ["href", "title", "class", "start", "align", "type", "checked", "disabled"],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });
}
