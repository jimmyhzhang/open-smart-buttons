// Present authentic app captures on reusable GitHub canvases. The source screenshots stay intact.
import { chromium } from 'playwright-core';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFile, unlink } from 'node:fs/promises';
const dir = dirname(fileURLToPath(import.meta.url));
const mark = `<svg viewBox="0 0 36 36" aria-hidden="true"><rect width="36" height="36" rx="10" fill="currentColor"/><g fill="var(--paper)"><rect x="8" y="9" width="8" height="7" rx="2"/><rect x="20" y="9" width="8" height="7" rx="2" opacity=".5"/><rect x="8" y="20" width="8" height="7" rx="2" opacity=".5"/><rect x="20" y="20" width="8" height="7" rx="2"/></g></svg>`;
const shots = [
  { id: 'workspace-light', kind: 'hero', title: 'Your Mac, one press away.', desc: 'Create useful buttons with AI, ready-made groups, and your coding agents.', image: 'workspace-light', label: 'Open Smart Buttons workspace, light appearance' },
  { id: 'workspace-dark', kind: 'hero', dark: true, title: 'Your Mac, one press away.', desc: 'Create useful buttons with AI, ready-made groups, and your coding agents.', image: 'workspace-dark', label: 'Open Smart Buttons workspace, dark appearance' },
  { id: 'ai-create', kind: 'detail', num: '01', eyebrow: 'CREATE WITH AI', title: 'Start with<br>a sentence.', desc: 'Describe what a key should do. Let your agent choose the action, icon, and setup.', notes: ['Use Claude Code or Codex.', 'Refine a button in the same place.', 'Check the setup before you run it.'], image: 'ai-create-detail', label: 'Actual AI creation composer in the Mac app' },
  { id: 'presets', kind: 'presets', num: '02', eyebrow: 'PRESET BUTTON GROUPS', title: 'A whole workflow.<br>One click.', desc: 'Start with Developer, Meetings, Media, or Everyday Mac. Make every key your own.', image: 'presets-device', secondary: 'presets-picker', label: 'Developer page created with a preset group' },
  { id: 'agent', kind: 'detail', num: '03', eyebrow: 'PROMPTS & PROJECT SKILLS', title: 'Give your agent<br>a button.', desc: 'Run a saved prompt with Codex or Claude Code. Follow its progress and read the result here.', notes: ['Your existing CLI sign-in.', 'Your project instructions and skills.', 'Background or interactive Terminal.'], image: 'agent-detail', label: 'A real Codex project skill with completed test results' },
  { id: 'manual', kind: 'detail manual', num: '04', eyebrow: 'MANUAL SETUP', title: 'Make the<br>details yours.', desc: 'Pick the action, choose its icon and color, and tune the settings in one focused view.', notes: ['Clear action-specific settings.', 'A live button preview.', 'Keep creating or edit what you have.'], image: 'manual-detail', label: 'Actual action setup dialog, captured in Electron' },
  { id: 'social-preview', kind: 'social', title: 'Your Mac.<br>One press away.', desc: 'AI, presets, and coding agents<br>on your programmable buttons.', image: 'social-device', label: 'Actual device preview from the Mac app' },
];
const css = `
.canvas {
  color:var(--ink);
}

* {
  box-sizing:border-box;
}

html,body {
  margin:0;
  width:100%;
  height:100%;
  overflow:hidden;
}

body {
  --ink:#142c31;
  --muted:#566c70;
  --accent:#14766e;
  --paper:#f1f6f4;
  font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display",system-ui,sans-serif;
  background:var(--paper);
  color:var(--ink);
}

.canvas {
  position:relative;
  width:1600px;
  height:1040px;
  overflow:hidden;
  background:radial-gradient(ellipse at 18% 8%,#d8eee7 0,transparent 46%),radial-gradient(ellipse at 92% 78%,#e0e8f8 0,transparent 50%),#f4f7f5;
}

.brand {
  position:absolute;
  top:48px;
  left:88px;
  display:flex;
  gap:14px;
  align-items:center;
  font-size:25px;
  font-weight:650;
  letter-spacing:-.6px;
}

.brand svg {
  width:36px;
  height:36px;
  color:var(--accent);
}

.badge {
  position:absolute;
  right:88px;
  top:51px;
  border:1px solid #b9cfca;
  border-radius:999px;
  padding:8px 15px;
  font-size:16px;
  color:var(--accent);
  font-weight:600;
  letter-spacing:.3px;
}

.copy {
  position:absolute;
  left:100px;
  top:224px;
  width:550px;
}

.eyebrow {
  font-size:15px;
  letter-spacing:2.4px;
  color:var(--accent);
  font-weight:650;
  margin-bottom:30px;
}

.copy h1 {
  font-size:76px;
  line-height:1.04;
  letter-spacing:-3.5px;
  font-weight:680;
  margin:0 0 28px;
}

.desc {
  font-size:25px;
  line-height:1.48;
  letter-spacing:-.5px;
  color:var(--muted);
  max-width:500px;
}

.notes {
  display:grid;
  gap:18px;
  margin-top:39px;
  font-size:19px;
  color:var(--ink);
}

.notes p {
  margin:0;
  display:flex;
  align-items:center;
  gap:13px;
}

.notes i {
  height:6px;
  width:6px;
  border-radius:50%;
  background:var(--accent);
  opacity:.7;
}

.detail .capture {
  position:absolute;
  left:813px;
  top:150px;
  width:650px;
  height:810px;
  display:flex;
  align-items:center;
  justify-content:center;
}

.detail .capture img {
  max-width:100%;
  max-height:100%;
  object-fit:contain;
  border-radius:22px;
  box-shadow:0 22px 55px #294a3b17,0 2px 5px #162d3612;
}

.foot {
  position:absolute;
  bottom:35px;
  left:100px;
  font-size:14px;
  letter-spacing:.1px;
  color:#586f73;
}

.index {
  position:absolute;
  bottom:33px;
  right:90px;
  font-size:14px;
  letter-spacing:1px;
  color:#586f73;
}

.manual .capture {
  left:844px;
  top:130px;
  width:580px;
  height:840px;
}

.manual .copy {
  width:620px;
  top:246px;
}

.hero.canvas {
  height:1230px;
}

.hero .brand {
  top:36px;
  left:106px;
}

.hero .badge {
  right:106px;
  top:39px;
}

.hero h1 {
  position:absolute;
  top:92px;
  left:106px;
  margin:0;
  font-size:70px;
  letter-spacing:-3px;
  line-height:1.1;
  font-weight:680;
}

.hero .desc {
  position:absolute;
  top:180px;
  left:108px;
  margin:0;
  max-width:1300px;
  font-size:25px;
}

.hero .capture {
  position:absolute;
  left:104px;
  top:240px;
  width:1392px;
}

.hero img {
  display:block;
  width:1392px;
  height:932px;
}

.hero .foot {
  left:109px;
  bottom:29px;
}

.dark {
  --ink:#edf7f3;
  --muted:#a9bfba;
  --accent:#6bd6bf;
  --paper:#102327;
  background:radial-gradient(ellipse at 15% 0,#1b4b43 0,transparent 48%),radial-gradient(ellipse at 95% 78%,#232f4b 0,transparent 50%),#0e1c20;
}

.dark .badge {
  border-color:#35534f;
}

.dark .foot {
  color:#9bb6b0;
}

.presets .copy {
  top:195px;
  left:100px;
  width:560px;
}

.presets .copy h1 {
  font-size:66px;
}

.presets .copy .desc {
  max-width:530px;
  font-size:24px;
}

.presets .device {
  position:absolute;
  left:715px;
  top:300px;
  width:825px;
}

.presets .device img {
  width:100%;
  border-radius:28px;
  box-shadow:0 22px 60px #31485b1c;
}

.presets .picker {
  position:absolute;
  top:600px;
  left:100px;
  width:560px;
}

.presets .picker img {
  width:100%;
  border-radius:18px;
  box-shadow:0 15px 35px #35574610;
}

.presets .small-label {
  font-size:13px;
  letter-spacing:1.4px;
  font-weight:650;
  color:var(--accent);
  margin-bottom:14px;
}

.social.canvas {
  width:1280px;
  height:640px;
}

.social .brand {
  left:64px;
  top:49px;
  font-size:23px;
}

.social .badge {
  right:64px;
  top:51px;
  font-size:14px;
}

.social .copy {
  left:64px;
  top:160px;
  width:590px;
}

.social h1 {
  font-size:76px;
  line-height:1.04;
  letter-spacing:-3px;
}

.social .desc {
  font-size:22px;
  max-width:500px;
  line-height:1.5;
}

.social .capture {
  position:absolute;
  left:640px;
  top:172px;
  width:600px;
}

.social .capture img {
  width:100%;
  border-radius:24px;
  box-shadow:0 20px 45px #31485b1b;
}

.social .foot {
  left:64px;
  bottom:38px;
  font-size:14px;
}
`;
function documentFor(s) {
  const brand = `<div class="brand">${mark}<span>Open Smart Buttons</span></div><div class="badge">macOS&nbsp; · &nbsp;Open source</div>`;
  const image = (name) => `<img src="raw/${name}.png" alt="${s.label}">`;
  let content;
  if (s.kind==='hero') content=`<h1>${s.title}</h1><p class="desc">${s.desc}</p><div class="capture">${image(s.image)}</div>`;
  else if (s.kind==='presets') content=`<div class="copy"><div class="eyebrow">${s.eyebrow}</div><h1>${s.title}</h1><p class="desc">${s.desc}</p></div><div class="device"><div class="small-label">DEVELOPER PAGE · READY TO PERSONALIZE</div>${image(s.image)}</div><div class="picker"><div class="small-label">CHOOSE A GROUP</div>${image(s.secondary)}</div>`;
  else content=`<div class="copy">${s.eyebrow?`<div class="eyebrow">${s.eyebrow}</div>`:''}<h1>${s.title}</h1><p class="desc">${s.desc}</p>${s.notes?`<div class="notes">${s.notes.map(n=>`<p><i></i>${n}</p>`).join('')}</div>`:''}</div><div class="capture">${image(s.image)}</div>`;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Open Smart Buttons — ${s.id}</title><style>${css}</style><div class="canvas ${s.kind}${s.dark?' dark':''}">${brand}${content}<div class="foot">${s.id==='agent'?'Actual project skill and test result.':''}${s.kind==='hero'?'AI creation &nbsp; / &nbsp; Preset groups &nbsp; / &nbsp; Claude Code &amp; Codex':''}${s.kind==='social'?'github.com/jimmyhzhang/open-smart-buttons':''}</div>${s.num?`<div class="index">${s.num} / OPEN SMART BUTTONS</div>`:''}</div></html>`;
}
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-background-networking','--disable-component-update']});
try {
  const context=await browser.newContext({viewport:{width:1600,height:1230},deviceScaleFactor:1});
  await context.route('**/*',route=>/^(file:|data:)/.test(route.request().url())?route.continue():route.abort());
  for (const s of shots) {
    const file = join(dir, '.frame-' + s.id + '.html');
    const page = await context.newPage();
    try {
      await writeFile(file, documentFor(s));
      await page.setViewportSize(s.kind === 'social' ? {width:1280,height:640} : s.kind === 'hero' ? {width:1600,height:1230} : {width:1600,height:1040});
      await page.goto(pathToFileURL(file).href);
      await page.evaluate(() => Promise.all([...document.images].map(i => i.decode())));
      await page.screenshot({path:join(dir,s.id+'.png'),animations:'disabled'});
      console.log(s.id + '.png');
    } finally {
      await page.close();
      await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
} finally {await browser.close();}
