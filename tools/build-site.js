#!/usr/bin/env node
'use strict';
// Assembles the source of the documentation site (GitHub Pages) from the files in this repository.
//
//   node tools/build-site.js [--out site-src]
//
// The site is the README (as the home page), docs/, assets/ and examples/, with the links
// rewritten so they work from inside the site: a link to another page stays a page link, a link
// to a file that is not on the site (action.yml, core/, a test README) becomes a link to the file
// on GitHub. mkdocs.yml at the root then builds the site from the output folder.
//
// Run by the Pages workflow and by CI (which builds the site in strict mode, so a broken link
// fails the build). Nothing here is committed.

const fs = require('node:fs');
const path = require('node:path');

const repository = path.resolve(__dirname, '..');
const GITHUB = 'https://github.com/ZanattaMichael/Dsc.PipelineRunnerActions/blob/main/';
// What is copied onto the site, besides the pages.
const COPIED = ['assets', 'examples'];

function argument(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : fallback;
}

// Where a link found in `fromFile` (a path relative to the repository root, forward slashes)
// should point on the site. Returns the rewritten target.
function rewriteTarget(target, fromFile) {
  if (/^([a-z]+:|#|\/\/)/i.test(target)) return target;
  const [pathPart, hash = ''] = target.split('#', 2);
  const anchor = hash ? `#${hash}` : '';
  if (pathPart === '') return target;
  const fromDirectory = path.posix.dirname(fromFile);
  const resolved = path.posix.normalize(path.posix.join(fromDirectory, pathPart)).replace(/^\.\//, '');
  if (resolved.startsWith('..')) return target;

  // Pages: README.md is the home page; docs/*.md live at the site root.
  if (resolved === 'README.md') return `index.md${anchor}`;
  const page = /^docs\/([^/]+\.md)$/.exec(resolved);
  if (page) return `${page[1]}${anchor}`;
  // A folder has no page on the site: it is browsed on GitHub.
  if (isDirectory(resolved)) return `${GITHUB.replace('/blob/', '/tree/')}${resolved}${anchor}`;
  // Files copied onto the site keep their place.
  if (COPIED.some((folder) => resolved.startsWith(`${folder}/`))) return `${resolved}${anchor}`;
  // Anything else is on GitHub.
  return `${GITHUB}${resolved}${anchor}`;
}

function isDirectory(relative) {
  const absolute = path.join(repository, relative);
  return fs.existsSync(absolute) && fs.statSync(absolute).isDirectory();
}

// Rewrites the links of one Markdown file: [text](target), <img src="target"> and
// <source srcset="target">.
function rewriteLinks(markdown, fromFile) {
  let text = markdown.replace(/(!?\[[^\]]*\]\()([^)\s]+)(\s+"[^"]*")?(\))/g, (match, open, target, title, close) => `${open}${rewriteTarget(target, fromFile)}${title || ''}${close}`);
  text = text.replace(/((?:src|srcset|href)=")([^"]+)(")/g, (match, open, target, close) => `${open}${rewriteTarget(target, fromFile)}${close}`);
  return text;
}

// The home page: the README with the links rewritten, under the site's own title.
function homePage(readme) {
  return rewriteLinks(readme, 'README.md');
}

function copyDirectory(source, destination) {
  fs.cpSync(source, destination, { recursive: true });
}

function build(out) {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'index.md'), homePage(fs.readFileSync(path.join(repository, 'README.md'), 'utf8')));
  const pages = ['index.md'];
  for (const entry of fs.readdirSync(path.join(repository, 'docs')).sort()) {
    if (!entry.endsWith('.md')) continue;
    const markdown = fs.readFileSync(path.join(repository, 'docs', entry), 'utf8');
    fs.writeFileSync(path.join(out, entry), rewriteLinks(markdown, `docs/${entry}`));
    pages.push(entry);
  }
  for (const folder of COPIED) copyDirectory(path.join(repository, folder), path.join(out, folder));
  return pages;
}

if (require.main === module) {
  const out = path.resolve(argument('out', 'site-src'));
  const pages = build(out);
  console.log(`${pages.length} pages and ${COPIED.join(', ')} written to ${out}`);
}

module.exports = { GITHUB, COPIED, rewriteTarget, rewriteLinks, homePage, build };
