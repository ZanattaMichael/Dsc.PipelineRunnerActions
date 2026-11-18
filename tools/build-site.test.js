'use strict';
// Tests of the documentation site builder. Run with:  node --test tools/build-site.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { GITHUB, rewriteTarget, rewriteLinks, build } = require('./build-site.js');

test('links between pages stay page links, from the README and from a guide', () => {
  assert.equal(rewriteTarget('docs/settings.md', 'README.md'), 'settings.md');
  assert.equal(rewriteTarget('docs/settings.md#outputs', 'README.md'), 'settings.md#outputs');
  assert.equal(rewriteTarget('settings.md', 'docs/gitlab.md'), 'settings.md');
  assert.equal(rewriteTarget('../README.md', 'docs/gitlab.md'), 'index.md');
  assert.equal(rewriteTarget('../README.md#what-you-need', 'docs/gitlab.md'), 'index.md#what-you-need');
});

test('assets and example files stay on the site', () => {
  assert.equal(rewriteTarget('assets/logo.svg', 'README.md'), 'assets/logo.svg');
  assert.equal(rewriteTarget('../assets/logo-gitlab.svg', 'docs/gitlab.md'), 'assets/logo-gitlab.svg');
  assert.equal(rewriteTarget('../examples/other/bitbucket-pipelines.yml', 'docs/other-platforms.md'), 'examples/other/bitbucket-pipelines.yml');
});

test('folders and files that are not on the site are linked on GitHub', () => {
  assert.equal(rewriteTarget('action.yml', 'README.md'), `${GITHUB}action.yml`);
  assert.equal(rewriteTarget('../core/settings.json', 'docs/other-platforms.md'), `${GITHUB}core/settings.json`);
  assert.equal(rewriteTarget('examples', 'README.md'), `${GITHUB.replace('/blob/', '/tree/')}examples`);
  assert.equal(rewriteTarget('../examples/github-actions', 'docs/github-actions.md'), `${GITHUB.replace('/blob/', '/tree/')}examples/github-actions`);
  assert.equal(rewriteTarget('../tests/integration/gitlab/README.md', 'docs/contributing.md'), `${GITHUB}tests/integration/gitlab/README.md`);
});

test('absolute links and anchors are left alone', () => {
  for (const target of ['https://example.test/x', 'mailto:a@b.test', '#section', '//cdn.test/x']) assert.equal(rewriteTarget(target, 'docs/x.md'), target);
});

test('Markdown links, images and HTML sources are all rewritten', () => {
  const markdown = 'See [settings](docs/settings.md "the settings") and ![logo](assets/logo.svg).\n<img src="assets/logo.svg" alt=""> <source srcset="assets/header-dark.svg"> <a href="action.yml">x</a>';
  const rewritten = rewriteLinks(markdown, 'README.md');
  assert.equal(rewritten, `See [settings](settings.md "the settings") and ![logo](assets/logo.svg).\n<img src="assets/logo.svg" alt=""> <source srcset="assets/header-dark.svg"> <a href="${GITHUB}action.yml">x</a>`);
});

test('the site source holds the home page, every guide, the assets and the examples, with no link into the repository left', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dscpr-site-'));
  const pages = build(out);
  assert.ok(pages.includes('index.md'));
  const guides = fs.readdirSync(path.join(__dirname, '..', 'docs')).filter((entry) => entry.endsWith('.md'));
  for (const guide of guides) assert.ok(pages.includes(guide), `${guide} is not on the site`);
  assert.ok(fs.existsSync(path.join(out, 'assets', 'logo.svg')));
  assert.ok(fs.existsSync(path.join(out, 'assets', 'site.css')));
  assert.ok(fs.existsSync(path.join(out, 'examples', 'github-actions')));
  for (const page of pages) {
    const text = fs.readFileSync(path.join(out, page), 'utf8');
    assert.doesNotMatch(text, /\]\((\.\.\/|docs\/)/, `${page} still links into the repository`);
  }
  fs.rmSync(out, { recursive: true, force: true });
});

test('every page the navigation lists exists on the site', () => {
  const navigation = fs.readFileSync(path.join(__dirname, '..', 'mkdocs.yml'), 'utf8');
  const listed = [...navigation.matchAll(/:\s+([a-z-]+\.md)\s*$/gm)].map((match) => match[1]);
  assert.ok(listed.length >= 10);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dscpr-site-'));
  const pages = build(out);
  for (const page of listed) assert.ok(pages.includes(page), `${page} is in the navigation but not on the site`);
  for (const page of pages) assert.ok(listed.includes(page), `${page} is on the site but not in the navigation`);
  fs.rmSync(out, { recursive: true, force: true });
});
