// Generates the logo family in assets/ (SVG sources, PNG renders and the README headers).
//
//   npm install --no-save opentype.js playwright   (playwright only for the PNG renders)
//   node tools/build-logos.js
//
// Every logo is the Dsc.PipelineRunner mark (three configuration layers merging into a pipeline
// that ends in a check mark) with a round badge in the corner. The badge colour and glyph say
// which integration it is. The glyphs are plain shapes drawn here; no third-party logo is used.
//
// The header wordmarks are converted to outlines, so they render the same everywhere without a
// web font. That needs Inter (Bold and Regular) installed; set INTER_DIR to its folder.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'assets');
fs.mkdirSync(out, { recursive: true });

const white = (d, extra = '') => `<path d="${d}" fill="none" stroke="#ffffff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"${extra}/>`;

// Badge centre (196,196), radius 46. Glyphs are drawn around that centre.
const VARIANTS = {
  '': {
    name: 'Dsc.PipelineRunner Actions', badge: '#0f172a',
    about: 'a lightning bolt: run it as a pipeline step',
    glyph: '<path d="M203 166 L176 201 L193 201 L187 227 L216 189 L198 189 Z" fill="#9ff3d0" stroke="#9ff3d0" stroke-width="4" stroke-linejoin="round"/>',
  },
  'github-actions': {
    name: 'Dsc.PipelineRunner for GitHub Actions', badge: '#24292f',
    about: 'a play button in a ring: a workflow run',
    glyph: '<circle cx="196" cy="196" r="24" fill="none" stroke="#ffffff" stroke-width="7"/><path d="M189 184 L208 196 L189 208 Z" fill="#ffffff" stroke="#ffffff" stroke-width="4" stroke-linejoin="round"/>',
  },
  'azure-devops': {
    name: 'Dsc.PipelineRunner for Azure DevOps', badge: '#0078d4',
    about: 'a continuous loop: plan, build, release',
    glyph: white('M196 196 C 188 182, 168 182, 168 196 C 168 210, 188 210, 196 196 C 204 182, 224 182, 224 196 C 224 210, 204 210, 196 196 Z'),
  },
  'gitlab': {
    name: 'Dsc.PipelineRunner for GitLab CI/CD', badge: '#e24329',
    about: 'a merge: two branches joining',
    glyph: white('M180 176 L180 216') + white('M180 196 C 196 196, 200 186, 212 186') +
      '<circle cx="180" cy="176" r="8" fill="#ffffff"/><circle cx="180" cy="216" r="8" fill="#ffffff"/><circle cx="214" cy="186" r="8" fill="#ffffff"/>',
  },
  'circleci': {
    name: 'Dsc.PipelineRunner for CircleCI', badge: '#04aa51',
    about: 'a ring around a dot: one job in a workflow',
    glyph: '<circle cx="196" cy="196" r="23" fill="none" stroke="#ffffff" stroke-width="7" stroke-dasharray="118 27" stroke-linecap="round" transform="rotate(200 196 196)"/><circle cx="196" cy="196" r="8" fill="#ffffff"/>',
  },
  'jenkins': {
    name: 'Dsc.PipelineRunner for Jenkins', badge: '#c62a2a',
    about: 'a cog: an automation server',
    glyph: (() => {
      let teeth = '';
      for (let i = 0; i < 8; i++) {
        const a = (Math.PI / 4) * i;
        const p = (r) => `${(196 + Math.cos(a) * r).toFixed(1)} ${(196 + Math.sin(a) * r).toFixed(1)}`;
        teeth += `M${p(19)} L${p(27)} `;
      }
      return `<circle cx="196" cy="196" r="15" fill="none" stroke="#ffffff" stroke-width="7"/>` + white(teeth.trim(), '');
    })(),
  },
  'generic': {
    name: 'Dsc.PipelineRunner for any pipeline', badge: '#475569',
    about: 'a shell prompt: run the step script anywhere',
    glyph: white('M176 182 L192 196 L176 210') + white('M200 210 L218 210'),
  },
};

const mark = (dark) => {
  const line = dark ? 'url(#flow)' : '#ffffff';
  const check = dark ? '#5eead4' : '#9ff3d0';
  const defs = dark
    ? '<linearGradient id="flow" gradientUnits="userSpaceOnUse" x1="44" y1="0" x2="214" y2="0"><stop offset="0" stop-color="#3194d7"/><stop offset="1" stop-color="#5eead4"/></linearGradient>'
    : '<linearGradient id="tile" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0e66b5"/><stop offset="1" stop-color="#249ee2"/></linearGradient>';
  const dots = dark ? '#3194d7' : '#ffffff';
  // The mark sits a little up and to the left of where it is in the module's logo, to leave the corner to the badge.
  return `<defs>${defs}</defs>
  <rect x="8" y="8" width="240" height="240" rx="56" fill="${dark ? '#0f172a' : 'url(#tile)'}"/>
  <g transform="translate(-6 -22)">
    <g fill="none" stroke="${line}" stroke-width="12" stroke-linecap="round" stroke-linejoin="round">
      <path d="M44 94 C 82 94, 88 128, 120 128"/><path d="M44 128 L 120 128"/><path d="M44 162 C 82 162, 88 128, 120 128"/><path d="M120 128 L 142 128"/>
    </g>
    <g fill="${dots}"><circle cx="44" cy="94" r="8"/><circle cx="44" cy="128" r="8"/><circle cx="44" cy="162" r="8"/></g>
    <path d="M140 128 L 166 154 L 214 100" fill="none" stroke="${check}" stroke-width="19" stroke-linecap="round" stroke-linejoin="round"/>
  </g>`;
};

const logo = (key, dark) => {
  const v = VARIANTS[key];
  const ring = dark ? '#0b1220' : '#ffffff';
  const badge = dark && v.badge === '#0f172a' ? '#1e293b' : v.badge;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-labelledby="t d">
  <title id="t">${v.name}</title>
  <desc id="d">The Dsc.PipelineRunner mark (three configuration layers merge into a pipeline that ends in a check mark) with a badge showing ${v.about}.</desc>
  ${mark(dark)}
  <circle cx="196" cy="196" r="52" fill="${ring}"/>
  <circle cx="196" cy="196" r="45" fill="${badge}"/>
  ${v.glyph}
</svg>
`;
};

const written = [];
for (const key of Object.keys(VARIANTS)) {
  const base = key ? `logo-${key}` : 'logo';
  fs.writeFileSync(path.join(out, `${base}.svg`), logo(key, false));
  fs.writeFileSync(path.join(out, `${base}-dark.svg`), logo(key, true));
  written.push(base);
}

// README header: the main logo and an outlined wordmark.
const header = () => {
  const opentype = require('opentype.js');
  const dir = process.env.INTER_DIR || '/usr/share/fonts/opentype/inter/';
  const bold = opentype.loadSync(path.join(dir, 'Inter-Bold.otf'));
  const regular = opentype.loadSync(path.join(dir, 'Inter-Regular.otf'));
  const A = 'Dsc.PipelineRunner', B = ' Actions';
  const TAG = 'One pipeline step for GitHub Actions, Azure DevOps, GitLab, CircleCI and Jenkins';
  const TS = 50, GS = 20, ICON = 120, x0 = ICON + 32;
  const wA = bold.getAdvanceWidth(A, TS), wB = regular.getAdvanceWidth(B, TS), wT = regular.getAdvanceWidth(TAG, GS);
  const width = Math.ceil(x0 + Math.max(wA + wB, wT) + 4);
  const d = (font, text, x, y, size) => font.getPath(text, x, y, size).toPathData(2);
  const inner = (dark) => logo('', dark).replace(/<svg[^>]*>/, '').replace('</svg>', '').replace(/<title id="t">.*?<\/title>/s, '').replace(/<desc id="d">.*?<\/desc>/s, '');
  const make = (dark, c) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${ICON}" width="${width}" height="${ICON}" role="img" aria-labelledby="t d">
  <title id="t">Dsc.PipelineRunner Actions</title>
  <desc id="d">${TAG}</desc>
  <svg x="0" y="0" width="${ICON}" height="${ICON}" viewBox="0 0 256 256">${inner(dark)}</svg>
  <path fill="${c.title}" d="${d(bold, A, x0, 62, TS)}"/>
  <path fill="${c.accent}" d="${d(regular, B, x0 + wA, 62, TS)}"/>
  <path fill="${c.tag}" d="${d(regular, TAG, x0, 98, GS)}"/>
</svg>
`;
  fs.writeFileSync(path.join(out, 'header-light.svg'), make(false, { title: '#0f172a', accent: '#0b5cad', tag: '#475569' }));
  fs.writeFileSync(path.join(out, 'header-dark.svg'), make(true, { title: '#f8fafc', accent: '#5cc2f2', tag: '#94a3b8' }));
};

// PNG renders: 512 px of every light logo, and the 256 px Azure DevOps extension icon.
const renders = async () => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const shot = async (svgFile, pngFile, size) => {
    await page.setViewportSize({ width: size, height: size });
    const svg = fs.readFileSync(svgFile, 'utf8');
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
    await page.screenshot({ path: pngFile, omitBackground: true });
  };
  for (const base of written) await shot(path.join(out, `${base}.svg`), path.join(out, `${base}-512.png`), 512);
  await shot(path.join(out, 'logo-azure-devops.svg'), path.join(root, 'azure-devops/images/extension-icon.png'), 256);
  await browser.close();
};

(async () => {
  try { header(); } catch (error) { console.warn(`Header not rebuilt (${error.message}).`); }
  try { await renders(); } catch (error) { console.warn(`PNG renders not rebuilt (${error.message}).`); }
  console.log(`Wrote ${written.length} logos to assets/.`);
})();
