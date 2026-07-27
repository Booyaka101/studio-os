import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Static integrity checks over every EJS view: a mechanical edit once landed the CSRF
// hidden input INSIDE a form's action attribute, breaking submit URLs and leaking markup
// as visible text. Route tests miss this because they POST directly instead of
// submitting rendered forms — so the views themselves are the contract checked here.

const VIEWS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'views');
const CSRF_INPUT = '<input type="hidden" name="_csrf" value="<%= csrfToken %>">';
// A <form ...> open tag; EJS blocks are consumed whole so their '>' does not end the tag.
const FORM_OPEN = /<form\b(?:<%[\s\S]*?%>|[^>])*>/g;

const ejsFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? ejsFiles(p) : e.name.endsWith('.ejs') ? [p] : [];
});

for (const file of ejsFiles(VIEWS)) {
  const rel = path.relative(VIEWS, file);
  const src = fs.readFileSync(file, 'utf8');

  test(`view integrity: ${rel}`, () => {
    assert.ok(!/(?:action|href|value|name|class)="[^"]*<(?:input|button|select)/.test(src),
      'tag markup nested inside an attribute value');

    for (const m of src.matchAll(FORM_OPEN)) {
      const tag = m[0];
      if (!/method\s*=\s*"post"/i.test(tag)) continue;
      const after = src.slice(m.index + tag.length);
      assert.ok(after.startsWith(CSRF_INPUT),
        `POST form lacks the CSRF input immediately after its open tag: ${tag.slice(0, 80)}`);
    }
  });
}
