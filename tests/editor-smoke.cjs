/* Optional end-to-end test. See tests/README.md for dependencies and usage. */
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const media = ['Afterlight.mp4', 'Pulse-120.wav'].map(name => path.join(root, 'examples', name));
const args = process.argv.slice(2);
assert(args.length === 0 || (args.length === 2 && args[0] === '--screenshot'), 'Usage: node tests/editor-smoke.cjs [--screenshot FILE.png]');
const screenshot = args[1] && path.resolve(args[1]);
const blockedHosts = new Set(), unavailable = new Set(), unexpected = [];

async function importPair(page, useExample = false) {
  await page.locator('#styleSel').selectOption('glow');
  if (useExample) await page.locator('#openExample').click();
  else {
    const chooser = page.waitForEvent('filechooser');
    await page.locator('#emptyAdd').click();
    await (await chooser).setFiles(media);
  }
  await page.locator('#aiAuto').waitFor({ timeout: 45000 });
  const list = await page.locator('#mediaList').innerText();
  assert.match(list, /Afterlight\.mp4/);
  assert.match(list, /Pulse-120\.wav/);
  assert.match(list, /3 scenes/i);
  assert.match(list, /soundtrack.*120 BPM/i);
  assert(await page.locator('#trackVideo .clip-item').count() > 0, 'No video clips after analysis');
  assert(await page.locator('#aiPanel [data-toggle]').count() > 0, 'No editable suggestions');
  return { clips: await page.locator('#trackVideo .clip-item').count(), track: await page.locator('#beatInfo').innerText() };
}

async function checkFormat(page, value, ratio) {
  await page.waitForFunction(({value, ratio}) => {
    const c = document.querySelector('#preview');
    return document.querySelector('#formatSel').value === value &&
      Math.abs(c.clientWidth / c.clientHeight - ratio) < 0.02 &&
      Math.abs(c.width / c.height - ratio) < 0.02;
  }, {value, ratio});
  return page.locator('#preview').evaluate(c => ({
    css: [c.clientWidth, c.clientHeight], buffer: [c.width, c.height],
  }));
}

async function exerciseFormats(page) {
  const original = await checkFormat(page, 'orig', 16/9);
  const suggested = await page.locator('#aiPanel .sugg .st').allTextContents();
  assert.equal(await page.evaluate(() => window.sakuga.project.media.find(m => m.kind === 'video').fps), 24);
  await page.locator('#formatSel').selectOption('1:1');
  await checkFormat(page, '1:1', 1);
  await page.locator('#undoBtn').click();
  await checkFormat(page, 'orig', 16/9);
  await page.locator('#redoBtn').click();
  await checkFormat(page, '1:1', 1);
  await page.locator('#undoBtn').click();
  await checkFormat(page, 'orig', 16/9);
  assert.deepEqual(await page.locator('#aiPanel .sugg .st').allTextContents(), suggested);
  return original;
}

async function run() {
  let browser, server;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sakuga-public-smoke-'));
  try {
    let origin = process.env.SAKUGA_BASE_URL;
    if (!origin) {
      server = spawn(process.env.PYTHON || 'python3', ['-B', path.join(root, 'serve.py'), '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
      server.stderr.resume();
      origin = await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.once('exit', code => reject(new Error('serve.py stopped: ' + code)));
        server.stdout.once('data', data => {
          const match = data.toString().match(/http:\/\/127\.0\.0\.1:\d+/);
          if (match) resolve(match[0]);
          else reject(new Error('No loopback address from serve.py'));
        });
      });
    }
    const base = new URL(origin);
    assert.equal(base.hostname, '127.0.0.1', 'Use a loopback preview for this test');
    if (!base.pathname.endsWith('/')) base.pathname += '/';
    browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH || undefined, channel: process.env.CHROME_CHANNEL || undefined, headless: true, ignoreDefaultArgs: ['--disable-gpu'],
      args: ['--enable-webgl', '--enable-unsafe-swiftshader']
    });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    const localOnly = route => {
      const target = new URL(route.request().url());
      if (target.origin === base.origin) return route.continue();
      blockedHosts.add(target.hostname);
      return route.abort();
    };
    await context.route(/^https?:\/\//, localOnly);
    const page = await context.newPage();
    page.setDefaultTimeout(9000);
    page.on('pageerror', e => unexpected.push(e.message));
    page.on('response', response => { if (response.status() >= 400) unavailable.add(new URL(response.url()).pathname); });
    const requested = [];
    page.on('request', request => requested.push(new URL(request.url())));
    await page.goto(base.href);
    assert.match(await page.title(), /Sakuga Studio/i);
    await page.locator('#styleSel option').first().waitFor({ state: 'attached' });
    assert(await page.getByRole('button', { name: 'Choose files' }).isVisible(), 'No usable import control');
    assert(await page.getByRole('button', { name: 'Auto-edit', exact: true }).isVisible());
    assert(!requested.some(url => url.pathname.includes('/vendor/')), 'MP4 libraries loaded on startup');
    const initialFonts = requested.filter(url => url.hostname === 'fonts.googleapis.com').flatMap(url => url.searchParams.getAll('family'));
    assert.deepEqual(initialFonts.map(face => face.split(':')[0]), ['Inter']);
    const first = await importPair(page, true);
    const desktop = await exerciseFormats(page);
    assert.equal(requested.filter(url => url.pathname.endsWith('/mp4box.all.min.js')).length, 1);
    await page.locator('#playBtn').click();
    await page.waitForFunction(() => /^0:0[1-9]|^0:00\.[3-9]/.test(document.querySelector('#timecode').textContent));
    if (await page.locator('#playBtn.playing').count()) await page.locator('#playBtn').click();
    const ruler = page.locator('#tlRuler');
    const rulerBounds = await ruler.boundingBox();
    await ruler.click({ position: { x: Math.floor(rulerBounds.width * 0.59), y: 9 } });
    await page.locator('#toasts .toast').last().waitFor({ state: 'detached' });
    await page.waitForTimeout(250);
    if (screenshot) {
      await page.setViewportSize({width: 1480, height: 940});
      await checkFormat(page, 'orig', 16/9);
      await page.screenshot({ path: screenshot });
      await page.setViewportSize({width: 1440, height: 900});
    }

    await page.getByRole('button', { name: 'Effects', exact: true }).click();
    const fx = page.locator('#trackFx .item');
    const initialFx = await fx.count();
    await page.locator('#fxGrid [data-fx=zoom]').click();
    assert.equal(await fx.count(), initialFx + 1);
    await page.locator('#undoBtn').click();
    assert.equal(await fx.count(), initialFx);
    await page.locator('#redoBtn').click();
    assert.equal(await fx.count(), initialFx + 1);

    await page.locator('[data-tab="text"]').click();
    await page.locator('#textGrid [data-ts="jp"]').click();
    assert(await page.locator('#trackText .item').count() > 0);
    assert(requested.some(url => url.hostname === 'fonts.googleapis.com' && url.searchParams.getAll('family').includes('Noto Sans JP:wght@900')));
    assert(!requested.some(url => url.pathname.endsWith('/mp4-muxer.min.js')), 'Muxer loaded before export');
    await page.locator('#exportBtn').click();
    assert.equal(await page.locator('#exFps .on').textContent(), 'Match footage (24 fps)');
    await page.locator('#exRes [data-i="1"]').click();
    await page.locator('#exQ [data-v=std]').click();
    await page.locator('#exCover').check();
    assert(await page.locator('#exSong').isChecked(), 'Original synthetic soundtrack is not selected');
    const download = page.waitForEvent('download', { timeout: 120000 });
    await page.locator('#exGo').click();
    const result = await download;
    assert.match(result.suggestedFilename(), /\.mp4$/i);
    const output = path.join(temp, 'edited.mp4');
    await result.saveAs(output);
    const streams = JSON.parse(execFileSync('ffprobe', ['-v','error','-show_entries',
      'stream=codec_type,codec_name,width,height,duration,nb_frames','-of','json', output])).streams;
    const video = streams.find(s => s.codec_type === 'video'), audio = streams.find(s => s.codec_type === 'audio');
    assert(video && video.codec_name === 'h264' && video.width === 1280 && video.height === 720, 'Unexpected video stream');
    assert.equal(Number(video.nb_frames), 96, 'Unexpected frame count for the four-second, 24 fps fixture');
    assert(Math.abs(Number(video.duration) - 4) < 1/24, 'Exported timeline duration changed');
    assert(audio?.codec_name === 'aac' && Number(audio.duration) > 0.8, 'Missing exported soundtrack');
    assert(Math.abs(Number(video.duration) - Number(audio.duration)) < 0.2, 'Streams end at different times');
    const sums = execFileSync('ffmpeg', ['-v','error','-i',output,'-an','-vf','fps=4,scale=72:40','-f','framemd5','-'], { encoding: 'utf8' });
    assert(new Set(sums.split('\n').filter(s => /^0,/.test(s)).map(s => s.split(',').at(-1))).size > 2, 'Exported image is static');
    const samples = execFileSync('ffmpeg', ['-v','error','-i',output,'-map','0:a:0','-ar','8000','-ac','1','-f','s16le','-']);
    let peak = 0;
    for (let i = 0; i + 1 < samples.length; i += 2) peak = Math.max(peak, Math.abs(samples.readInt16LE(i)));
    assert(peak > 100, 'Exported soundtrack is silent');
    const cover = page.locator('#exDone .cover-row img');
    await cover.waitFor({timeout: 45000});
    assert(await cover.evaluate(async img => { await img.decode(); return img.naturalHeight > img.naturalWidth; }));
    assert.equal(requested.filter(url => url.pathname.endsWith('/mp4-muxer.min.js')).length, 1);
    await page.reload();
    await page.locator('#emptyAdd').waitFor();
    const second = await importPair(page);
    assert.equal(second.clips, first.clips, 'Re-import generated a different clip count after refresh');
    const phone = await browser.newContext({
      viewport: {width: 390, height: 844}, hasTouch: true, isMobile: true, deviceScaleFactor: 3,
    });
    await phone.route(/^https?:\/\//, localOnly);
    const mobilePage = await phone.newPage();
    mobilePage.on('pageerror', e => unexpected.push(e.message));
    await mobilePage.goto(base.href);
    await importPair(mobilePage, true);
    const mobile = await exerciseFormats(mobilePage);
    for (const mediaName of ['Afterlight.mp4', 'Pulse-120.wav']) {
      await mobilePage.locator('#mediaList .media-item').filter({hasText:mediaName}).locator('[data-remove]').tap();
    }
    await mobilePage.locator('#openExample').waitFor();
    await checkFormat(mobilePage, 'orig', 9/16);
    await importPair(mobilePage, true);
    await checkFormat(mobilePage, 'orig', 16/9);
    await phone.close();
    assert.deepEqual(unexpected, [], 'Uncaught browser errors');
    const broken = [...unavailable].filter(s => /\.(?:js|css|html|wasm)$/.test(s));
    assert.deepEqual(broken, [], 'Local app resources failed to load');
    console.log(JSON.stringify({browser: browser.version(), desktop, mobile, clips: first.clips, beat: first.track,
      export: streams, audioPeak: peak, blockedExternalHosts: [...blockedHosts].sort(), unavailable: [...unavailable].sort()}, null, 2));
  } finally {
    if (browser) await browser.close();
    if (server) server.kill();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
