import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ==================== 新增：2Captcha 配置 (ESM 兼容) ====================
import { Solver } from '@2captcha/captcha-solver';
import dotenv from 'dotenv';

const scriptDir = dirname(fileURLToPath(import.meta.url));
dotenv.config({
  path: [
    resolve(process.cwd(), '.env'),
    resolve(scriptDir, '../.env'),
    resolve(scriptDir, '../../../../../.env')
  ],
  quiet: true
});

const CAPTCHA_API_KEY = process.env.SUNO_2CAPTCHA_KEY || process.env.TWOCAPTCHA_KEY;

if (!CAPTCHA_API_KEY) {
  console.warn('⚠️ 未检测到 2Captcha API Key (SUNO_2CAPTCHA_KEY)，将使用手动验证码模式');
}

const solver = CAPTCHA_API_KEY ? new Solver(CAPTCHA_API_KEY) : null;
// =====================================================================

const args = process.argv.slice(2);
const CAPTCHA_ERROR_CODE = 'SUNO_CAPTCHA_REQUIRED';

const redactSensitiveMessage = (value) => {
  let message = String(value ?? '');
  if (CAPTCHA_API_KEY) {
    message = message.split(CAPTCHA_API_KEY).join('[redacted]');
  }
  return message
    .replace(/([?&](?:key|apikey|api_key)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/ob_(?:key|at|rt)_[A-Za-z0-9_-]+/g, '[redacted-token]');
};

class SunoCaptchaRequiredError extends Error {
  constructor(message) {
    super(`${CAPTCHA_ERROR_CODE}: ${redactSensitiveMessage(message)}`);
    this.name = 'SunoCaptchaRequiredError';
    this.code = CAPTCHA_ERROR_CODE;
  }
}

const printFatalError = (error) => {
  console.error(
    JSON.stringify({
      code: error?.code || 'SUNO_BROWSER_ERROR',
      error: redactSensitiveMessage(error?.message || String(error))
    })
  );
  process.exit(1);
};

process.on('uncaughtException', printFatalError);
process.on('unhandledRejection', printFatalError);

const optionsWithValues = new Set([
  '--batch',
  '--captcha-rounds',
  '--dir',
  '--endpoint',
  '--files',
  '--poll-ms',
  '--screenshots',
  '--state',
  '--storage-state',
  '--jitter-ms',
  '--max-scrolls',
  '--post-submit-wait-ms',
  '--submit-attempts',
  '--submit-gap-ms',
  '--timeout-ms',
  '--versions'
]);

const readArg = (name) => {
  const prefix = `${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);

  const index = args.indexOf(name);
  if (index !== -1) return args[index + 1];

  return undefined;
};

const positionalArgs = () => {
  const values = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith('--')) {
      if (!arg.includes('=') && optionsWithValues.has(arg)) index += 1;
      continue;
    }
    values.push(arg);
  }

  return values;
};

const section = (text, heading) => {
  const pattern = new RegExp(`(?:^|\\n)## ${heading}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`);
  return text.match(pattern)?.[1]?.trim();
};

const keyValueSection = (value) => {
  const result = {};
  for (const line of String(value || '').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/);
    if (!match) continue;
    result[match[1].toLowerCase().replace(/-/g, '_')] = match[2];
  }
  return result;
};

const sanitizeFilename = (value) => value.replace(/[\\/:*?"<>|]/g, '-');

const slugify = (value) =>
  sanitizeFilename(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);

const uniquePath = (path) => {
  if (args.includes('--overwrite') || !existsSync(path)) return path;

  const extension = extname(path);
  const base = path.slice(0, -extension.length);
  let counter = 2;
  let candidate = path;

  while (existsSync(candidate)) {
    candidate = `${base} ${counter}${extension}`;
    counter += 1;
  }

  return candidate;
};

const parseDuration = (value) => {
  const match = (value || '').trim().match(/^(\d+)[:：](\d{2})$/);
  if (!match) return null;
  return Number.parseInt(match[1], 10) * 60 + Number.parseInt(match[2], 10);
};

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

const parseNonNegativeInteger = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const parsePositiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const actionJitterMs = parseNonNegativeInteger(
  readArg('--jitter-ms') || process.env.SUNO_BATCH_ACTION_JITTER_MS || '500',
  500
);

const randomActionDelay = async () => {
  if (actionJitterMs <= 0) return;
  await sleep(Math.floor(Math.random() * (actionJitterMs + 1)));
};

const humanAction = async (action) => {
  await randomActionDelay();
  const result = await action();
  await randomActionDelay();
  return result;
};

const humanClick = (locator, options) => humanAction(() => locator.click(options));

const humanFill = (locator, value, options) => humanAction(() => locator.fill(value, options));

const humanKeyPress = (page, key, options) => humanAction(() => page.keyboard.press(key, options));

const humanMouseClick = (page, x, y, options) => humanAction(() => page.mouse.click(x, y, options));

const detectCaptchaRequired = async (page) =>
  page
    .evaluate(() => {
      const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
      const visible = (el) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const text = normalize(document.body?.innerText || '');
      const textRequiresCaptcha = [
        /verify (that )?you.?re human/i,
        /are you human/i,
        /human verification/i,
        /complete .*captcha/i,
        /captcha required/i,
        /security check/i,
        /unusual traffic/i,
        /checking if the site connection is secure/i,
        /drag .*shape/i,
        /fits? the outline/i,
        /shape .*outline/i
      ].some((pattern) => pattern.test(text));
      const frames = [...document.querySelectorAll('iframe')]
        .filter(visible)
        .map((frame) => ({
          src: frame.getAttribute('src') || '',
          title: frame.getAttribute('title') || '',
          ariaLabel: frame.getAttribute('aria-label') || ''
        }));
      const hasCaptchaFrame = frames.some((frame) =>
        /hcaptcha|recaptcha|captcha|challenge/i.test(`${frame.src} ${frame.title} ${frame.ariaLabel}`)
      );

      return {
        required: textRequiresCaptcha || hasCaptchaFrame,
        textExcerpt: text.slice(0, 500),
        frames: frames.slice(0, 5)
      };
    })
    .catch(() => ({ required: false, textExcerpt: '', frames: [] }));

const visibleHcaptchaChallengeFrame = async (page) => {
  const challengeSrcs = await page
    .evaluate(() => {
      const visible = (el) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };

      return [...document.querySelectorAll('iframe')]
        .filter(visible)
        .map((iframe) => iframe.getAttribute('src') || '')
        .filter((src) => /hcaptcha.*frame=challenge|frame=challenge.*hcaptcha/i.test(src));
    })
    .catch(() => []);

  for (const src of challengeSrcs.reverse()) {
    const frame = page.frames().find((candidate) => candidate.url() === src);
    if (frame) return frame;
  }

  return page.frames().find((candidate) => /hcaptcha.*frame=challenge|frame=challenge.*hcaptcha/i.test(candidate.url())) || null;
};

const visibleHcaptchaChallengeFrameElement = async (page) => {
  const challengeFrames = await page
    .evaluate(() => {
      const visible = (el) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };

      return [...document.querySelectorAll('iframe')]
        .map((iframe, index) => ({
          index,
          src: iframe.getAttribute('src') || '',
          title: iframe.getAttribute('title') || '',
          ariaLabel: iframe.getAttribute('aria-label') || ''
        }))
        .filter(
          (frame) =>
            /hcaptcha.*frame=challenge|frame=challenge.*hcaptcha/i.test(frame.src) ||
            /hcaptcha.*challenge|captcha.*challenge/i.test(`${frame.src} ${frame.title} ${frame.ariaLabel}`)
        )
        .filter((frame) => visible(document.querySelectorAll('iframe')[frame.index]));
    })
    .catch(() => []);

  const selected = challengeFrames.at(-1);
  if (!selected) return null;

  const locator = page.locator('iframe').nth(selected.index);
  const box = await locator.boundingBox().catch(() => null);
  if (!box) return null;

  return { ...selected, locator, box };
};

const captchaDebugPath = (screenshotPath, suffix) =>
  screenshotPath ? screenshotPath.replace(/\.png$/i, suffix) : null;

const writeCaptchaDebug = (screenshotPath, suffix, content) => {
  const path = captchaDebugPath(screenshotPath, suffix);
  if (!path) return;
  writeFileSync(path, content);
};

const parseGridAnswer = (answer, maxTile) => {
  const value = typeof answer === 'string' ? answer : String(answer ?? '');
  if (/No_matching_images|no matching/i.test(value)) return { skip: true, tiles: [] };

  const tiles = [
    ...new Set(
      [...value.matchAll(/\d+/g)]
        .map((match) => Number.parseInt(match[0], 10))
        .filter((number) => Number.isFinite(number) && number >= 1 && number <= maxTile)
    )
  ];

  return { skip: false, tiles };
};

const inspectHcaptchaChallenge = async (frame) =>
  frame
    .evaluate(() => {
      const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
      const visible = (el) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const text = normalize(document.body?.innerText || '');
      const taskCount = document.querySelectorAll('.task-grid .task[role="button"]').length;
      const moveButtons = [...document.querySelectorAll('button, [role="button"], [aria-label], [title]')]
        .filter(visible)
        .map((el) => normalize(`${el.textContent || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`))
        .filter((label) => /move/i.test(label));
      const draggableCount = [...document.querySelectorAll('[draggable="true"], [aria-grabbed], [class*="drag" i], [class*="move" i]')]
        .filter(visible).length;
      const imageCount = [...document.querySelectorAll('img, canvas, svg')].filter(visible).length;
      const prompt =
        normalize(document.querySelector('.challenge-header')?.innerText || '') ||
        text.match(/drag[^.?!]+(?:outline|shape)[^.?!]*/i)?.[0] ||
        text.slice(0, 160);
      const isDragShape =
        /drag .*shape|shape .*fits? .*outline|fits? the outline|drag .*outline/i.test(text) ||
        (moveButtons.length > 0 && /shape|outline/i.test(text));

      return {
        type: taskCount > 0 ? 'grid' : isDragShape ? 'drag-shape' : 'unknown',
        prompt,
        taskCount,
        moveButtonCount: moveButtons.length,
        draggableCount,
        imageCount,
        buttonLabels: moveButtons.slice(0, 6),
        textExcerpt: text.slice(0, 500)
      };
    })
    .catch((error) => ({
      type: 'unknown',
      prompt: '',
      taskCount: 0,
      moveButtonCount: 0,
      draggableCount: 0,
      imageCount: 0,
      buttonLabels: [],
      textExcerpt: '',
      error: error.message
    }));

const parseCoordinatePoints = (answer) => {
  if (Array.isArray(answer)) {
    return answer
      .map((point) => ({
        x: Number(point?.x ?? point?.X ?? point?.left),
        y: Number(point?.y ?? point?.Y ?? point?.top)
      }))
      .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  }

  if (answer && typeof answer === 'object') {
    if (Array.isArray(answer.coordinates)) return parseCoordinatePoints(answer.coordinates);
    if (Array.isArray(answer.points)) return parseCoordinatePoints(answer.points);

    const point = {
      x: Number(answer.x ?? answer.X ?? answer.left),
      y: Number(answer.y ?? answer.Y ?? answer.top)
    };
    return Number.isFinite(point.x) && Number.isFinite(point.y) ? [point] : [];
  }

  const value = String(answer ?? '');
  const points = [...value.matchAll(/x\s*=?\s*(-?\d+(?:\.\d+)?)\D+?y\s*=?\s*(-?\d+(?:\.\d+)?)/gi)]
    .map((match) => ({
      x: Number.parseFloat(match[1]),
      y: Number.parseFloat(match[2])
    }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));

  return points;
};

const dragMouse = async (page, from, to) => {
  const mid = {
    x: from.x + (to.x - from.x) * 0.55,
    y: from.y + (to.y - from.y) * 0.35
  };

  await page.mouse.move(from.x, from.y, { steps: 8 });
  await page.mouse.down();
  await page.waitForTimeout(250);
  await page.mouse.move(mid.x, mid.y, { steps: 16 });
  await page.mouse.move(to.x, to.y, { steps: 22 });
  await page.waitForTimeout(200);
  await page.mouse.up();
};

const defaultDragSourceForTarget = (target, frameBox) => {
  const candidateCenters = [
    { x: frameBox.width * 0.82, y: frameBox.height * 0.32 },
    { x: frameBox.width * 0.82, y: frameBox.height * 0.58 }
  ];
  return candidateCenters.sort(
    (a, b) => Math.abs(a.y - target.y) - Math.abs(b.y - target.y)
  )[0];
};

const solveHcaptchaDragShapeChallenge = async ({ page, frame, challenge, screenshotPath, round }) => {
  if (typeof solver?.coordinates !== 'function') {
    throw new Error('当前 2Captcha SDK 不支持 coordinates captcha');
  }

  const frameElement = await visibleHcaptchaChallengeFrameElement(page);
  if (!frameElement) throw new Error('无法定位可见的 hCaptcha challenge iframe');

  const frameBuffer = await frameElement.locator.screenshot({ timeout: 10_000 });
  const frameImageBase64 = frameBuffer.toString('base64');
  writeCaptchaDebug(screenshotPath, `-hcaptcha-drag-shape-round-${round}.png`, frameBuffer);
  writeCaptchaDebug(
    screenshotPath,
    `-hcaptcha-drag-shape-challenge-round-${round}.json`,
    `${JSON.stringify({ frame: { src: frameElement.src, box: frameElement.box }, challenge }, null, 2)}\n`
  );

  console.error(`🔄 正在用 2Captcha coordinates 解决 hCaptcha 形状拖拽第 ${round} 轮...`);

  const result = await solver.coordinates({
    body: frameImageBase64,
    lang: 'en',
    textinstructions:
      `This is an hCaptcha drag-and-drop challenge. ` +
      `Instruction: "${challenge.prompt || 'Drag the shape that fits the outline'}". ` +
      `Return exactly two coordinates on this screenshot: first the center of the draggable shape on the right, ` +
      `second the center of the matching outline/drop target on the left.`
  });
  const points = parseCoordinatePoints(result.data);

  writeCaptchaDebug(
    screenshotPath,
    `-hcaptcha-drag-shape-result-round-${round}.json`,
    `${JSON.stringify({ id: result.id, data: result.data, points }, null, 2)}\n`
  );

  if (points.length < 2) {
    if (points.length !== 1) {
      throw new Error(`2Captcha coordinates 未返回拖拽起点和终点: ${JSON.stringify(result.data)}`);
    }

    const targetOnly = points[0];
    console.error(
      `⚠️ 2Captcha coordinates 只返回目标点: (${Math.round(targetOnly.x)}, ${Math.round(targetOnly.y)})，继续询问右侧拖拽源...`
    );
    const sourceResult = await solver.coordinates({
      body: frameImageBase64,
      lang: 'en',
      textinstructions:
        `This is an hCaptcha drag-and-drop challenge. The matching outline/drop target is already identified ` +
        `at coordinate (${Math.round(targetOnly.x)}, ${Math.round(targetOnly.y)}) on this screenshot. ` +
        `Return exactly one coordinate: the center of the draggable shape on the right panel that fits that outline. ` +
        `Do not return the outline coordinate.`
    });
    const sourcePoints = parseCoordinatePoints(sourceResult.data);
    writeCaptchaDebug(
      screenshotPath,
      `-hcaptcha-drag-shape-source-result-round-${round}.json`,
      `${JSON.stringify({ id: sourceResult.id, data: sourceResult.data, sourcePoints, targetOnly }, null, 2)}\n`
    );

    const sourceOnly = sourcePoints.find((point) => point.x > frameElement.box.width * 0.55);
    if (sourceOnly) {
      points.unshift(sourceOnly);
    } else {
      const fallbackSource = defaultDragSourceForTarget(targetOnly, frameElement.box);
      console.error(
        `⚠️ 未拿到右侧拖拽源，使用右侧候选 fallback: (${Math.round(fallbackSource.x)}, ${Math.round(fallbackSource.y)})`
      );
      points.unshift(fallbackSource);
    }
  }

  const [firstPoint, secondPoint] = points;
  const [source, target] =
    firstPoint.x > secondPoint.x ? [firstPoint, secondPoint] : [secondPoint, firstPoint];
  const from = {
    x: frameElement.box.x + source.x,
    y: frameElement.box.y + source.y
  };
  const to = {
    x: frameElement.box.x + target.x,
    y: frameElement.box.y + target.y
  };

  console.error(
    `✅ 2Captcha coordinates 返回拖拽点: (${Math.round(source.x)}, ${Math.round(source.y)}) -> ` +
      `(${Math.round(target.x)}, ${Math.round(target.y)})`
  );

  await dragMouse(page, from, to);
  await page.waitForTimeout(1_500);

  const submitCandidates = [
    frame.getByRole('button', { name: /verify|submit|check|done/i }).first(),
    frame.locator('[role="button"]').filter({ hasText: /verify|submit|check|done/i }).first()
  ];
  for (const submitButton of submitCandidates) {
    if (await submitButton.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await humanClick(submitButton, { timeout: 5_000 }).catch(() => {});
      break;
    }
  }

  await page.waitForTimeout(4_000);
  const captchaState = await detectCaptchaRequired(page);
  return !captchaState.required;
};

const solveVisibleHcaptchaChallenge = async ({ page, screenshotPath = null, maxRounds = 3 }) => {
  let previousId = null;

  for (let round = 1; round <= maxRounds; round += 1) {
    const frame = await visibleHcaptchaChallengeFrame(page);
    if (!frame) return { attempted: round > 1, handled: round > 1 };

    const challengeInfo = await inspectHcaptchaChallenge(frame);
    const taskCount = await frame.locator('.task-grid .task[role="button"]').count().catch(() => 0);
    if (taskCount === 0) {
      if (challengeInfo.type === 'drag-shape') {
        const solved = await solveHcaptchaDragShapeChallenge({ page, frame, challenge: challengeInfo, screenshotPath, round });
        if (solved) {
          console.error('✅ hCaptcha 形状拖拽 challenge 已通过');
          return { attempted: true, handled: true };
        }
        continue;
      }

      writeCaptchaDebug(
        screenshotPath,
        `-hcaptcha-unknown-challenge-round-${round}.json`,
        `${JSON.stringify(challengeInfo, null, 2)}\n`
      );
      return { attempted: round > 1, handled: false };
    }

    const gridLocator = frame.locator('.task-grid').first();
    const headerLocator = frame.locator('.challenge-header').first();
    await gridLocator.waitFor({ state: 'visible', timeout: 10_000 });

    const challenge = await frame.evaluate(() => {
      const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
      const rectOf = (el) => {
        const rect = el.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      };
      const uniqueAxis = (values) => {
        const sorted = [...values].sort((a, b) => a - b);
        return sorted.filter((value, index) => index === 0 || Math.abs(value - sorted[index - 1]) > 20);
      };
      const tasks = [...document.querySelectorAll('.task-grid .task[role="button"]')].map((task, index) => ({
        index: index + 1,
        rect: rectOf(task),
        pressed: task.getAttribute('aria-pressed') === 'true'
      }));
      const xs = uniqueAxis(tasks.map((task) => task.rect.x));
      const ys = uniqueAxis(tasks.map((task) => task.rect.y));

      return {
        prompt: normalize(document.querySelector('.challenge-header')?.innerText || document.body.innerText || ''),
        buttonText: normalize(document.querySelector('.button-submit.button')?.textContent || ''),
        rows: ys.length || 3,
        cols: xs.length || 3,
        tasks
      };
    });

    const gridBuffer = await gridLocator.screenshot({ timeout: 10_000 });
    const instructionsBuffer = await headerLocator.screenshot({ timeout: 10_000 }).catch(() => null);

    writeCaptchaDebug(screenshotPath, `-hcaptcha-grid-round-${round}.png`, gridBuffer);
    if (instructionsBuffer) {
      writeCaptchaDebug(screenshotPath, `-hcaptcha-instructions-round-${round}.png`, instructionsBuffer);
    }

    console.error(`🔄 正在用 2Captcha grid 解决 hCaptcha 第 ${round}/${maxRounds} 轮...`);

    const gridParams = {
      body: gridBuffer.toString('base64'),
      textinstructions:
        `${challenge.prompt || 'Select all matching images.'} Use the reference image shown in the instruction area.`,
      rows: challenge.rows,
      cols: challenge.cols,
      imgType: 'hcaptcha',
      canSkip: 1
    };
    if (instructionsBuffer) {
      gridParams.imginstructions = instructionsBuffer.toString('base64');
    }
    if (previousId) {
      gridParams.previousId = previousId;
    }

    const result = await solver.grid(gridParams);
    previousId = result.id;

    const parsed = parseGridAnswer(result.data, challenge.tasks.length);
    writeCaptchaDebug(
      screenshotPath,
      `-hcaptcha-grid-result-round-${round}.json`,
      `${JSON.stringify({ id: result.id, data: result.data, parsed, challenge }, null, 2)}\n`
    );

    if (parsed.tiles.length > 0) {
      console.error(`✅ 2Captcha grid 返回格子: ${parsed.tiles.join(', ')}`);
    } else if (parsed.skip) {
      console.error('✅ 2Captcha grid 返回无匹配图片，点击 Skip/Verify');
    } else {
      throw new Error(`2Captcha grid 未返回有效格子: ${JSON.stringify(result.data)}`);
    }

    const tilesLocator = frame.locator('.task-grid .task[role="button"]');
    for (const tile of parsed.tiles) {
      await humanClick(tilesLocator.nth(tile - 1));
      await page.waitForTimeout(150);
    }

    const selectedScreenshotPath = captchaDebugPath(screenshotPath, `-hcaptcha-selected-round-${round}.png`);
    if (selectedScreenshotPath) {
      await page.screenshot({ path: selectedScreenshotPath, fullPage: true }).catch(() => {});
    }

    await humanClick(frame.locator('.button-submit.button[role="button"]').first(), { timeout: 10_000 });
    await page.waitForTimeout(3_000);

    const captchaState = await detectCaptchaRequired(page);
    if (!captchaState.required) {
      console.error('✅ hCaptcha challenge 已通过');
      return { attempted: true, handled: true };
    }
  }

  throw new Error(`hCaptcha visual challenge 连续 ${maxRounds} 轮后仍未通过`);
};

// ==================== 新版：自动处理验证码 ====================
const handleCaptchaIfRequired = async ({ page, screenshotPath = null, maxRounds = 3 }) => {
  const captchaState = await detectCaptchaRequired(page);
  if (!captchaState.required) return false;

  console.error('🚨 检测到 hCaptcha...');

  if (screenshotPath) {
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  }

  if (!solver) {
    const proof = captchaState.frames.length > 0 
      ? ` Visible frames: ${JSON.stringify(captchaState.frames)}` 
      : '';
    throw new SunoCaptchaRequiredError(
      `Suno 要求人机验证。请手动完成或设置 2Captcha。${proof}`
    );
  }

  // 使用 2Captcha 自动解决
  try {
    const visualChallenge = await solveVisibleHcaptchaChallenge({ page, screenshotPath, maxRounds });
    if (visualChallenge.handled) return 'visual';

    console.error('🔄 正在调用 2Captcha 解决...');

    const captchaData = await page.evaluate(() => {
      const paramsFromUrl = (value) => {
        try {
          const url = new URL(value, window.location.href);
          const hashParams = new URLSearchParams(url.hash.replace(/^#/, ''));
          return {
            sitekey:
              url.searchParams.get('sitekey') ||
              url.searchParams.get('k') ||
              hashParams.get('sitekey') ||
              hashParams.get('k'),
            rqdata: url.searchParams.get('rqdata') || hashParams.get('rqdata'),
            size: url.searchParams.get('size') || hashParams.get('size'),
            frame: url.searchParams.get('frame') || hashParams.get('frame'),
            host: url.hostname
          };
        } catch {
          return { sitekey: null, rqdata: null, size: null, frame: null, host: '' };
        }
      };

      const dataSitekey =
        document.querySelector('[data-sitekey]')?.getAttribute('data-sitekey') ||
        document.querySelector('div.h-captcha')?.getAttribute('data-sitekey') ||
        '';
      const frames = [...document.querySelectorAll('iframe')]
        .map((iframe) => {
          const parsed = paramsFromUrl(iframe.getAttribute('src') || '');
          return {
            src: iframe.getAttribute('src') || '',
            title: iframe.getAttribute('title') || '',
            ariaLabel: iframe.getAttribute('aria-label') || '',
            ...parsed
          };
        })
        .filter((frame) => /hcaptcha|captcha|challenge/i.test(`${frame.src} ${frame.title} ${frame.ariaLabel}`));
      const frameWithSitekey = frames.find((frame) => frame.sitekey);

      return {
        sitekey: dataSitekey || frameWithSitekey?.sitekey || '',
        rqdata: frameWithSitekey?.rqdata || '',
        invisible: frames.some((frame) => frame.size === 'invisible' || /invisible/i.test(frame.frame || '')),
        url: window.location.href,
        frames: frames.map((frame) => ({
          src: frame.src.slice(0, 300),
          title: frame.title,
          ariaLabel: frame.ariaLabel,
          host: frame.host,
          hasSitekey: Boolean(frame.sitekey),
          hasRqdata: Boolean(frame.rqdata),
          size: frame.size,
          frame: frame.frame
        }))
      };
    });

    if (!captchaData?.sitekey) {
      throw new Error(`无法提取 hCaptcha sitekey: ${JSON.stringify(captchaData?.frames || [])}`);
    }

    const hcaptchaParams = {
      sitekey: captchaData.sitekey,
      pageurl: captchaData.url,
      userAgent: await page.evaluate(() => navigator.userAgent)
    };
    if (captchaData.invisible) {
      hcaptchaParams.invisible = 1;
    }
    if (captchaData.rqdata) {
      hcaptchaParams.data = captchaData.rqdata;
    }

    const result = await solver.hcaptcha(hcaptchaParams);

    console.error(`✅ 2Captcha 返回 token`);

    await page.evaluate((token) => {
      document
        .querySelectorAll('textarea[name="h-captcha-response"], textarea[name="g-recaptcha-response"], input[name="h-captcha-response"]')
        .forEach(el => {
        el.value = token;
      });

      if (typeof window.hcaptcha !== 'undefined') {
        if (typeof window.hcaptcha.submit === 'function') window.hcaptcha.submit();
      }

      const event = new Event('change', { bubbles: true });
      document
        .querySelectorAll('textarea[name="h-captcha-response"], textarea[name="g-recaptcha-response"], input[name="h-captcha-response"]')
        .forEach(el => {
          el.dispatchEvent(event);
      });
    }, result.data);

    await page.waitForTimeout(4500);
    console.error('✅ 2Captcha token 已注入');
    return 'token';

  } catch (err) {
    const safeErrorMessage = redactSensitiveMessage(err.message);
    console.error('❌ 2Captcha 失败:', safeErrorMessage);
    if (screenshotPath) {
      await page.screenshot({ 
        path: screenshotPath.replace('.png', '-2captcha-fail.png'), 
        fullPage: true 
      }).catch(() => {});
    }
    throw new SunoCaptchaRequiredError(`2Captcha 解决失败: ${safeErrorMessage}`);
  }
};
// =========================================================

const plainRow = (row) =>
  row
    ? {
        text: row.text || '',
        href: row.href || '',
        rect: row.rect || null,
        duration: row.duration || null,
        durationSeconds: row.durationSeconds ?? null,
        menuButton: row.menuButton || null,
        scanStep: row.scanStep ?? null
      }
    : null;

const exportStorageState = async ({ endpoint, storageStatePath }) => {
  const cdpBrowser = await chromium.connectOverCDP(endpoint);

  try {
    const context = cdpBrowser.contexts()[0];
    if (!context) throw new Error(`No browser context found at ${endpoint}`);
    await context.storageState({ path: storageStatePath });
  } finally {
    await cdpBrowser.close();
  }
};

const parseSongFile = (file, index) => {
  const md = readFileSync(file, 'utf8');
  const selectedBrief = section(md, 'Selected Brief') || '';
  const title = selectedBrief.match(/"title_seed":\s*"([^"]+)"/)?.[1];
  const style = section(md, 'Style Prompt');
  const llmLyrics = section(md, 'Lyrics');
  const submit = keyValueSection(section(md, 'Suno Submit'));
  const submitLyricsMode = String(submit.lyrics_mode || '').trim().toLowerCase();
  const lyricsMode = submitLyricsMode === 'suno' ? 'suno' : (llmLyrics ? 'llm' : 'suno');
  const lyrics = lyricsMode === 'suno' ? '' : llmLyrics;

  if (!title || (!style && !lyrics)) {
    throw new Error(`Could not parse title/style/lyrics from ${file}`);
  }

  return {
    index,
    file,
    title,
    style,
    lyrics,
    lyricsMode: lyricsMode || (lyrics ? 'llm' : 'suno'),
    llmLyricsChars: llmLyrics?.length || 0,
    slug: `${String(index + 1).padStart(2, '0')}-${slugify(title || basename(file))}`,
    beforeUrls: new Set(),
    observedRows: [],
    completedRows: [],
    selectedRow: null,
    status: 'pending'
  };
};

const openCreatePage = async ({ page }) => {
  await page.goto('https://suno.com/create', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(1_000);
};

const fillAdvancedForm = async ({ page, task }) => {
  await humanClick(page.getByRole('tab', { name: 'Advanced' }), { timeout: 30_000 });
  await page.waitForTimeout(300);

  if (task.lyrics) {
    const lyricsBox = page.locator('textarea[data-testid="lyrics-textarea"]:visible');
    await lyricsBox.waitFor({ state: 'visible', timeout: 30_000 });
    await humanFill(lyricsBox, task.lyrics);
  }

  if (task.style) {
    const styleBox = page.locator('textarea:visible:not([data-testid="lyrics-textarea"])').first();
    await styleBox.waitFor({ state: 'visible', timeout: 30_000 });
    await humanFill(styleBox, task.style);
  }

  await humanFill(page.locator('input[placeholder="Song Title (Optional)"]:visible').first(), task.title);
};

const clickCreateSongButton = async ({ page }) => {
  const createButton = page.getByRole('button', { name: 'Create song' });
  await createButton.waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForTimeout(250);

  const buttonState = await createButton.evaluate((button) => ({
    disabled: Boolean(button.disabled) || button.getAttribute('aria-disabled') === 'true',
    text: button.innerText,
    aria: button.getAttribute('aria-label')
  }));

  if (buttonState.disabled) throw new Error(`Create button is disabled: ${JSON.stringify(buttonState)}`);

  await humanClick(createButton);
  await page.waitForTimeout(1_500);
};

const submitScreenshotName = ({ baseName, attempt }) =>
  attempt === 1 ? `${baseName}.png` : `${baseName}-retry-${attempt}.png`;

const detectSubmitRejection = async ({ page }) =>
  page.evaluate(() => {
    const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.top < window.innerHeight &&
        rect.right > 0 &&
        rect.left < window.innerWidth
      );
    };

    const candidates = [...document.querySelectorAll('[role="alert"], [aria-live], body *')]
      .filter(visible)
      .map((el) => normalize(el.textContent))
      .filter(Boolean);
    const rejectedText = candidates.find((text) =>
      /couldn[’']?t generate that|could not generate that|lyrics contain copyrighted material|copyrighted material/i.test(text)
    );

    return rejectedText ? { rejected: true, text: rejectedText.slice(0, 500) } : { rejected: false, text: '' };
  });

const setSubmitUnconfirmedError = (task, fallback) => {
  if (!/^Suno rejected submit:/.test(task.error || '')) {
    task.error = fallback;
  }
};

const waitForSubmissionEvidence = async ({ page, task, waitMs, maxScrolls, screenshotDir, attempt }) => {
  const deadline = Date.now() + Math.max(waitMs, 5_000);
  let observedRows = [];

  while (Date.now() < deadline) {
    const rejection = await detectSubmitRejection({ page }).catch(() => ({ rejected: false, text: '' }));
    if (rejection.rejected) {
      task.error = `Suno rejected submit: ${rejection.text}`;
      await page
        .screenshot({
          path: join(screenshotDir, task.slug, submitScreenshotName({ baseName: 'submit-rejected', attempt })),
          fullPage: true
        })
        .catch(() => {});
      return false;
    }

    const rows = await getRowsForTitle({ page, title: task.title, maxScrolls });
    observedRows = rows.filter((row) => !task.beforeUrls.has(row.href));
    task.observedRows = observedRows.map(plainRow);

    if (observedRows.length > 0) {
      return true;
    }

    await sleep(2_000);
    await openCreatePage({ page }).catch(() => {});
    await page.waitForTimeout(1_000);
  }

  await page
    .screenshot({
      path: join(screenshotDir, task.slug, submitScreenshotName({ baseName: 'submit-unconfirmed', attempt })),
      fullPage: true
    })
    .catch(() => {});
  return false;
};

const ensureCleanCreateForm = async ({ page, task, screenshotDir, attempt }) => {
  await humanKeyPress(page, 'Escape').catch(() => {});
  await openCreatePage({ page });

  const captchaHandled = await handleCaptchaIfRequired({
    page,
    maxRounds: maxCaptchaRounds,
    screenshotPath: join(
      screenshotDir,
      task.slug,
      submitScreenshotName({ baseName: 'error-captcha-before-submit', attempt })
    )
  });

  if (captchaHandled) {
    await page
      .screenshot({
        path: join(
          screenshotDir,
          task.slug,
          submitScreenshotName({ baseName: 'captcha-solved-before-submit', attempt })
        ),
        fullPage: true
      })
      .catch(() => {});
    await openCreatePage({ page });
  }
};

const submitTaskWithCaptchaRetries = async ({ page, task, screenshotDir, postSubmitWaitMs, maxSubmitAttempts }) => {
  let sawCaptcha = false;
  const evidenceWaitMs = Math.max(postSubmitWaitMs, 15_000);

  for (let attempt = 1; attempt <= maxSubmitAttempts; attempt += 1) {
    task.submitAttempt = attempt;
    task.observedRows = [];
    await ensureCleanCreateForm({ page, task, screenshotDir, attempt });

    await fillAdvancedForm({ page, task });
    await page.screenshot({
      path: join(
        screenshotDir,
        task.slug,
        attempt === 1 ? 'filled.png' : submitScreenshotName({ baseName: 'refilled-after-captcha', attempt })
      ),
      fullPage: true
    });

    await clickCreateSongButton({ page });

    const captchaHandledAfterCreate = await handleCaptchaIfRequired({
      page,
      maxRounds: maxCaptchaRounds,
      screenshotPath: join(
        screenshotDir,
        task.slug,
        submitScreenshotName({ baseName: 'error-captcha-after-create', attempt })
      )
    });

    if (captchaHandledAfterCreate) {
      sawCaptcha = true;
      task.captchaMethod = captchaHandledAfterCreate;
      await page
        .screenshot({
          path: join(
            screenshotDir,
            task.slug,
            submitScreenshotName({ baseName: 'captcha-solved-after-create', attempt })
          ),
          fullPage: true
        })
        .catch(() => {});
      if (captchaHandledAfterCreate === 'visual') {
        const visualSubmitSettleMs = Math.min(postSubmitWaitMs, 5_000);
        if (visualSubmitSettleMs > 0) {
          await sleep(visualSubmitSettleMs);
          await page
            .screenshot({
              path: join(screenshotDir, task.slug, submitScreenshotName({ baseName: 'submitted-settled', attempt })),
              fullPage: true
            })
            .catch(() => {});
        }
        if (await waitForSubmissionEvidence({ page, task, waitMs: evidenceWaitMs, maxScrolls, screenshotDir, attempt })) {
          return { attempt, captchaMethod: captchaHandledAfterCreate, retriedAfterCaptcha: false, sawCaptcha };
        }
        setSubmitUnconfirmedError(task, 'Create captcha was solved, but no new song row appeared; retrying submit.');
        task.retriedAfterCaptcha = true;
        continue;
      }
      task.retriedAfterCaptcha = true;
      continue;
    }

    await page.screenshot({
      path: join(screenshotDir, task.slug, submitScreenshotName({ baseName: 'submitted', attempt })),
      fullPage: true
    });

    if (postSubmitWaitMs > 0) {
      await sleep(postSubmitWaitMs);
      const captchaHandledAfterWait = await handleCaptchaIfRequired({
        page,
        maxRounds: maxCaptchaRounds,
        screenshotPath: join(
          screenshotDir,
          task.slug,
          submitScreenshotName({ baseName: 'error-captcha-after-submit-wait', attempt })
        )
      });

      if (captchaHandledAfterWait) {
        sawCaptcha = true;
        task.captchaMethod = captchaHandledAfterWait;
        await page
          .screenshot({
            path: join(
              screenshotDir,
              task.slug,
              submitScreenshotName({ baseName: 'captcha-solved-after-submit-wait', attempt })
            ),
            fullPage: true
          })
          .catch(() => {});
        if (captchaHandledAfterWait === 'visual') {
          const visualSubmitSettleMs = Math.min(postSubmitWaitMs, 5_000);
          if (visualSubmitSettleMs > 0) {
            await sleep(visualSubmitSettleMs);
          }
          await page
            .screenshot({
              path: join(screenshotDir, task.slug, submitScreenshotName({ baseName: 'submitted-settled', attempt })),
              fullPage: true
            })
            .catch(() => {});
          if (await waitForSubmissionEvidence({ page, task, waitMs: evidenceWaitMs, maxScrolls, screenshotDir, attempt })) {
            return { attempt, captchaMethod: captchaHandledAfterWait, retriedAfterCaptcha: false, sawCaptcha };
          }
          setSubmitUnconfirmedError(task, 'Post-submit captcha was solved, but no new song row appeared; retrying submit.');
          task.retriedAfterCaptcha = true;
          continue;
        }
        task.retriedAfterCaptcha = true;
        continue;
      }

      await page
        .screenshot({
          path: join(screenshotDir, task.slug, submitScreenshotName({ baseName: 'submitted-settled', attempt })),
          fullPage: true
        })
        .catch(() => {});
    }

    if (await waitForSubmissionEvidence({ page, task, waitMs: evidenceWaitMs, maxScrolls, screenshotDir, attempt })) {
      return { attempt, captchaMethod: task.captchaMethod || null, retriedAfterCaptcha: sawCaptcha, sawCaptcha };
    }
    setSubmitUnconfirmedError(task, 'Create clicked, but no new song row appeared; retrying submit.');
    task.retriedAfterCaptcha = sawCaptcha;
  }

  throw new Error(`Suno Create did not produce a new song row after ${maxSubmitAttempts} attempts.`);
};

const scrollSongListToTop = async ({ page }) =>
  page.evaluate(() => {
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const scroller =
      [...document.querySelectorAll('body *')]
        .filter((el) => {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return (
            visible(el) &&
            rect.x > 550 &&
            rect.width > 300 &&
            rect.height > 300 &&
            el.scrollHeight > el.clientHeight + 40 &&
            /auto|scroll/.test(style.overflowY)
          );
        })
        .map((el) => ({
          el,
          hasSongRows: Boolean(el.querySelector('a[href*="/song/"]')),
          area: el.clientHeight * el.clientWidth
        }))
        .sort((a, b) => Number(b.hasSongRows) - Number(a.hasSongRows) || b.area - a.area)[0]?.el ||
      document.scrollingElement ||
      document.documentElement;

    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    return {
      top: scroller.scrollTop,
      max: Math.max(0, scroller.scrollHeight - scroller.clientHeight)
    };
  });

const scrollSongListDown = async ({ page, stepPx = null } = {}) =>
  page.evaluate((stepPx) => {
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const scroller =
      [...document.querySelectorAll('body *')]
        .filter((el) => {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return (
            visible(el) &&
            rect.x > 550 &&
            rect.width > 300 &&
            rect.height > 300 &&
            el.scrollHeight > el.clientHeight + 40 &&
            /auto|scroll/.test(style.overflowY)
          );
        })
        .map((el) => ({
          el,
          hasSongRows: Boolean(el.querySelector('a[href*="/song/"]')),
          area: el.clientHeight * el.clientWidth
        }))
        .sort((a, b) => Number(b.hasSongRows) - Number(a.hasSongRows) || b.area - a.area)[0]?.el ||
      document.scrollingElement ||
      document.documentElement;

    const before = scroller.scrollTop;
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const step = Number.isFinite(stepPx) && stepPx > 0 ? stepPx : Math.max(400, Math.floor(scroller.clientHeight * 0.85));
    scroller.scrollTop = Math.min(max, before + step);
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }));

    return {
      before,
      after: scroller.scrollTop,
      max,
      atBottom: scroller.scrollTop >= max - 2
    };
  }, stepPx);

const collapseBlockingBottomTrayIfPresent = async ({ page } = {}) => {
  let clicked = false;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const target = await page
      .evaluate((attempt) => {
        const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
        const visible = (el) => {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            rect.width > 0 &&
            rect.height > 0 &&
            rect.bottom > 0 &&
            rect.top < window.innerHeight &&
            rect.right > 0 &&
            rect.left < window.innerWidth
          );
        };
        const rectOf = (el) => {
          const rect = el.getBoundingClientRect();
          return {
            x: rect.x,
            y: rect.y,
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
            right: rect.right,
            bottom: rect.bottom
          };
        };
        const looksLikeStudioTray = (text) =>
          /Master Your Studio/i.test(text) ||
          /Time left\s+\d+\s+days?/i.test(text) ||
          /Convert to MIDI|Pull it apart|Remaster/i.test(text) ||
          (/Layer it up/i.test(text) && /Generate vocals or instrumentals/i.test(text));

        const trays = [...document.querySelectorAll('body *')]
          .filter(visible)
          .map((el) => ({ el, rect: rectOf(el), text: normalize(el.innerText || el.textContent || '') }))
          .filter(
            ({ rect, text }) =>
              rect.top > window.innerHeight * 0.45 &&
              rect.width > window.innerWidth * 0.4 &&
              rect.height > 48 &&
              looksLikeStudioTray(text)
          )
          .sort((a, b) => a.rect.top - b.rect.top || b.rect.width * b.rect.height - a.rect.width * a.rect.height);

        const tray = trays[0];
        if (!tray) return null;

        const buttons = [...document.querySelectorAll('button, [role="button"], [aria-label], [title]')]
          .filter(visible)
          .map((el) => ({
            rect: rectOf(el),
            label: normalize(el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '')
          }))
          .filter(
            ({ rect }) =>
              rect.x >= 200 &&
              rect.y >= tray.rect.y - 80 &&
              rect.y <= tray.rect.y + Math.min(120, tray.rect.height) &&
              rect.width >= 20 &&
              rect.height >= 20
          )
          .sort((a, b) => {
            const preferredLabel = (button) => /close|collapse|minimi[sz]e|hide|dismiss|down|chevron/i.test(button.label);
            const sideScore = (button) => (button.rect.x > window.innerWidth - 180 ? 0 : 1);
            const topDistance = (button) => Math.abs(button.rect.y + button.rect.height / 2 - (tray.rect.y + 28));
            return (
              Number(!preferredLabel(a)) - Number(!preferredLabel(b)) ||
              sideScore(a) - sideScore(b) ||
              topDistance(a) - topDistance(b) ||
              b.rect.x - a.rect.x
            );
          });

        const button = buttons[0];
        if (button) {
          return {
            x: button.rect.x + button.rect.width / 2,
            y: button.rect.y + button.rect.height / 2,
            reason: button.label || 'studio-tray-button'
          };
        }

        return {
          x: Math.min(window.innerWidth - 24, tray.rect.x + tray.rect.width - 28),
          y: tray.rect.y + Math.min(34, tray.rect.height / 3),
          reason: 'studio-tray-fallback'
        };
      }, attempt)
      .catch(() => null);

    if (!target) return clicked;
    clicked = true;
    await humanMouseClick(page, target.x, target.y).catch(() => {});
    await page.waitForTimeout(500);
  }

  return clicked;
};

const getVisibleRowsForTitle = async ({ page, title }) =>
  page.evaluate((title) => {
    const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.top < window.innerHeight &&
        rect.right > 0 &&
        rect.left < window.innerWidth
      );
    };
    const rectOf = (el) => {
      const rect = el.getBoundingClientRect();
      return {
        x: rect.x,
        y: rect.y,
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        right: rect.right,
        bottom: rect.bottom
      };
    };
    const clickableBottom = (() => {
      const viewportHeight = window.innerHeight;
      const looksLikeBlockingTray = (text) =>
        /Master Your Studio/i.test(text) ||
        /Time left\s+\d+\s+days?/i.test(text) ||
        /Convert to MIDI|Pull it apart|Remaster/i.test(text) ||
        (/Layer it up/i.test(text) && /Generate vocals or instrumentals/i.test(text));
      const overlayTops = [...document.querySelectorAll('body *')]
        .filter(visible)
        .map((el) => {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          const text = normalize(el.innerText || el.textContent || '');
          return { position: style.position, rect, text };
        })
        .filter(
          ({ position, rect, text }) =>
            rect.top > viewportHeight * 0.6 &&
            rect.height >= 48 &&
            rect.width >= window.innerWidth * 0.4 &&
            ((/fixed|sticky/.test(position) && rect.bottom >= viewportHeight - 4) || looksLikeBlockingTray(text))
        )
        .map(({ rect }) => rect.top);

      return Math.min(viewportHeight - 24, ...(overlayTops.length ? overlayTops : [viewportHeight]));
    })();
    const safelyClickable = (rect) =>
      rect.width > 0 &&
      rect.height > 0 &&
      rect.top >= 0 &&
      rect.bottom <= clickableBottom - 8 &&
      rect.left >= 0 &&
      rect.right <= window.innerWidth;

    const durations = [...document.querySelectorAll('body *')]
      .filter(visible)
      .map((el) => ({ text: normalize(el.textContent), rect: rectOf(el) }))
      .filter((candidate) => /^\d+[:：]\d{2}$/.test(candidate.text));

    const menuButtons = [...document.querySelectorAll('button[aria-label="More options"], button, [role="button"]')]
      .filter(visible)
      .map((el) => ({ rect: rectOf(el), label: normalize(el.getAttribute('aria-label') || el.textContent || '') }))
      .filter(
        (button) =>
          safelyClickable(button.rect) &&
          button.rect.x > window.innerWidth * 0.75 &&
          !/manage|remix/i.test(button.label) &&
          (/more|options|ellipsis|menu|•••|\.\.\./i.test(button.label) ||
            (button.rect.x > window.innerWidth * 0.9 && button.rect.width <= 80)) &&
          button.rect.width >= 28 &&
          button.rect.height >= 28
      );

    const songNodes = [
      ...document.querySelectorAll('a[href*="/song/"]'),
      ...document.querySelectorAll('body *')
    ];
    const seen = new Set();
    const songs = songNodes
      .filter(visible)
      .map((el) => {
        const rect = rectOf(el);
        const href = el.href || el.closest?.('a[href*="/song/"]')?.href || '';
        return { text: normalize(el.textContent), href, rect };
      })
      .filter((song) => song.text === title && song.rect.x > 600)
      .filter((song) => {
        const key = `${song.href || 'nohref'}:${Math.round(song.rect.x)}:${Math.round(song.rect.y)}:${Math.round(song.rect.width)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => a.rect.y - b.rect.y);

    return songs
      .map((song) => {
        const centerY = song.rect.y + song.rect.height / 2;
        const duration = durations
          .filter((candidate) => Math.abs((candidate.rect.y + candidate.rect.height / 2) - centerY) < 100)
          .sort(
            (a, b) =>
              Math.abs((a.rect.y + a.rect.height / 2) - centerY) -
              Math.abs((b.rect.y + b.rect.height / 2) - centerY)
          )[0];
        const menuButton = menuButtons
          .filter((button) => Math.abs((button.rect.y + button.rect.height / 2) - centerY) < 80)
          .sort(
            (a, b) =>
              Math.abs((a.rect.y + a.rect.height / 2) - centerY) -
              Math.abs((b.rect.y + b.rect.height / 2) - centerY)
          )[0];
        const fallbackMenuRect = {
          x: window.innerWidth - 76,
          y: centerY + 10,
          left: window.innerWidth - 76,
          top: centerY + 10,
          width: 48,
          height: 48,
          right: window.innerWidth - 28,
          bottom: centerY + 58
        };
        const fallbackMenuButton = safelyClickable(fallbackMenuRect) ? { rect: fallbackMenuRect, synthetic: true } : null;

        return {
          ...song,
          duration: duration?.text || null,
          durationSeconds: duration
            ? Number(duration.text.replace('：', ':').split(':')[0]) * 60 +
              Number(duration.text.replace('：', ':').split(':')[1])
            : null,
          menuButton: menuButton || fallbackMenuButton
        };
      });
  }, title);

const getVisibleRowForHref = async ({ page, href }) =>
  page.evaluate((href) => {
    const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.top < window.innerHeight &&
        rect.right > 0 &&
        rect.left < window.innerWidth
      );
    };
    const rectOf = (el) => {
      const rect = el.getBoundingClientRect();
      return {
        x: rect.x,
        y: rect.y,
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        right: rect.right,
        bottom: rect.bottom
      };
    };
    const clickableBottom = (() => {
      const viewportHeight = window.innerHeight;
      const looksLikeBlockingTray = (text) =>
        /Master Your Studio/i.test(text) ||
        /Time left\s+\d+\s+days?/i.test(text) ||
        /Convert to MIDI|Pull it apart|Remaster/i.test(text) ||
        (/Layer it up/i.test(text) && /Generate vocals or instrumentals/i.test(text));
      const overlayTops = [...document.querySelectorAll('body *')]
        .filter(visible)
        .map((el) => {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          const text = normalize(el.innerText || el.textContent || '');
          return { position: style.position, rect, text };
        })
        .filter(
          ({ position, rect, text }) =>
            rect.top > viewportHeight * 0.6 &&
            rect.height >= 48 &&
            rect.width >= window.innerWidth * 0.4 &&
            ((/fixed|sticky/.test(position) && rect.bottom >= viewportHeight - 4) || looksLikeBlockingTray(text))
        )
        .map(({ rect }) => rect.top);

      return Math.min(viewportHeight - 24, ...(overlayTops.length ? overlayTops : [viewportHeight]));
    })();
    const safelyClickable = (rect) =>
      rect.width > 0 &&
      rect.height > 0 &&
      rect.top >= 0 &&
      rect.bottom <= clickableBottom - 8 &&
      rect.left >= 0 &&
      rect.right <= window.innerWidth;

    const anchor = [...document.querySelectorAll('a[href*="/song/"]')].find((el) => el.href === href && visible(el));
    if (!anchor) return null;

    const song = { text: normalize(anchor.textContent), href: anchor.href, rect: rectOf(anchor) };
    const centerY = song.rect.y + song.rect.height / 2;
    const durations = [...document.querySelectorAll('body *')]
      .filter(visible)
      .map((el) => ({ text: normalize(el.textContent), rect: rectOf(el) }))
      .filter((candidate) => /^\d+[:：]\d{2}$/.test(candidate.text));
    const duration = durations
      .filter((candidate) => Math.abs((candidate.rect.y + candidate.rect.height / 2) - centerY) < 100)
      .sort(
        (a, b) =>
          Math.abs((a.rect.y + a.rect.height / 2) - centerY) -
          Math.abs((b.rect.y + b.rect.height / 2) - centerY)
      )[0];
    const menuButtons = [...document.querySelectorAll('button[aria-label="More options"], button, [role="button"]')]
      .filter(visible)
      .map((el) => ({ rect: rectOf(el), label: normalize(el.getAttribute('aria-label') || el.textContent || '') }))
      .filter(
        (button) =>
          safelyClickable(button.rect) &&
          button.rect.x > window.innerWidth * 0.75 &&
          !/manage|remix/i.test(button.label) &&
          (/more|options|ellipsis|menu|•••|\.\.\./i.test(button.label) ||
            (button.rect.x > window.innerWidth * 0.9 && button.rect.width <= 80)) &&
          button.rect.width >= 28 &&
          button.rect.height >= 28
      );
    const menuButton = menuButtons
      .filter((button) => Math.abs((button.rect.y + button.rect.height / 2) - centerY) < 80)
      .sort(
        (a, b) =>
          Math.abs((a.rect.y + a.rect.height / 2) - centerY) -
          Math.abs((b.rect.y + b.rect.height / 2) - centerY)
      )[0];
    const fallbackMenuRect = {
      x: window.innerWidth - 76,
      y: centerY + 10,
      left: window.innerWidth - 76,
      top: centerY + 10,
      width: 48,
      height: 48,
      right: window.innerWidth - 28,
      bottom: centerY + 58
    };
    const fallbackMenuButton = safelyClickable(fallbackMenuRect) ? { rect: fallbackMenuRect, synthetic: true } : null;

    return {
      ...song,
      duration: duration?.text || null,
      durationSeconds: duration
        ? Number(duration.text.replace('：', ':').split(':')[0]) * 60 +
          Number(duration.text.replace('：', ':').split(':')[1])
        : null,
      menuButton: menuButton || fallbackMenuButton
    };
  }, href);

const getRowsForTitle = async ({ page, title, maxScrolls = 40 }) => {
  const rowsByHref = new Map();
  await collapseBlockingBottomTrayIfPresent({ page });
  await scrollSongListToTop({ page });
  await page.waitForTimeout(250);

  for (let scanStep = 0; scanStep < maxScrolls; scanStep += 1) {
    const visibleRows = await getVisibleRowsForTitle({ page, title });
    for (const row of visibleRows) {
      const previous = rowsByHref.get(row.href);
      if (!previous || (!previous.duration && row.duration) || (!previous.menuButton && row.menuButton)) {
        rowsByHref.set(row.href, { ...row, scanStep });
      }
    }

    const state = await scrollSongListDown({ page });
    if (state.after === state.before) break;
    await page.waitForTimeout(200);
  }

  return [...rowsByHref.values()].sort((a, b) => a.scanStep - b.scanStep || a.rect.y - b.rect.y);
};

const centerSongRowByHref = async ({ page, href }) =>
  page.evaluate((href) => {
    const anchor = [...document.querySelectorAll('a[href*="/song/"]')].find((el) => el.href === href);
    if (!anchor) return false;
    anchor.scrollIntoView({ block: 'center', inline: 'nearest' });
    return true;
  }, href);

const visibleSearchBox = async ({ page }) => {
  const inputs = page.locator('input[placeholder*="Search" i], input[aria-label*="Search" i]');
  const count = await inputs.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const input = inputs.nth(index);
    if ((await input.isVisible().catch(() => false)) && (await input.isEditable().catch(() => false))) {
      return input;
    }
  }
  return null;
};

const searchSongList = async ({ page, title }) => {
  const searchBox = await visibleSearchBox({ page });
  if (!searchBox) return false;
  await humanFill(searchBox, title, { timeout: 10_000 });
  await humanKeyPress(page, 'Enter').catch(() => {});
  await page.waitForTimeout(4_000);
  return true;
};

const clearSongSearch = async ({ page }) => {
  const searchBox = await visibleSearchBox({ page });
  if (!searchBox) return false;
  await humanFill(searchBox, '', { timeout: 10_000 });
  await humanKeyPress(page, 'Escape').catch(() => {});
  await page.waitForTimeout(1_000);
  return true;
};

const revealRowByHref = async ({ page, title, href, maxScrolls = 40 }) => {
  const scanLoadedList = async () => {
    await collapseBlockingBottomTrayIfPresent({ page });
    await scrollSongListToTop({ page });
    await page.waitForTimeout(250);

    for (let scanStep = 0; scanStep < maxScrolls; scanStep += 1) {
      const row = await getVisibleRowForHref({ page, href });
      if (row?.menuButton && row.durationSeconds !== null) return { ...row, scanStep };

      const centered = await centerSongRowByHref({ page, href });
      if (centered) {
        await collapseBlockingBottomTrayIfPresent({ page });
        await page.waitForTimeout(450);
        const centeredRow = await getVisibleRowForHref({ page, href });
        if (centeredRow?.menuButton && centeredRow.durationSeconds !== null) return { ...centeredRow, scanStep };
      }

      const state = await scrollSongListDown({ page });
      if (state.after === state.before) break;
      await page.waitForTimeout(200);
    }

    return null;
  };

  const currentRow = await scanLoadedList();
  if (currentRow) return currentRow;

  if (title && (await searchSongList({ page, title }))) {
    const searchedRow = await scanLoadedList();
    if (searchedRow) return searchedRow;
  }

  return null;
};

const revealBestRowByTitle = async ({ page, title, maxScrolls = 120 }) => {
  await clearSongSearch({ page });
  await collapseBlockingBottomTrayIfPresent({ page });
  await scrollSongListToTop({ page });
  await page.waitForTimeout(500);

  for (let scanStep = 0; scanStep < maxScrolls; scanStep += 1) {
    const visibleRows = await getVisibleRowsForTitle({ page, title });
    const safeRows = visibleRows
      .filter((candidate) => candidate.menuButton && candidate.durationSeconds !== null)
      .sort((a, b) => b.durationSeconds - a.durationSeconds);
    if (scanStep === 0 || scanStep % 10 === 0 || safeRows.length > 0) {
      const sample = visibleRows
        .slice(0, 3)
        .map((row) => `y=${Math.round(row.rect.y)} d=${row.duration || '-'} menu=${row.menuButton ? 'y' : 'n'}`)
        .join(' ');
      console.error(`[download-scan] ${title} step=${scanStep} rows=${visibleRows.length} safe=${safeRows.length} ${sample}`);
    }
    if (safeRows[0]) return { ...safeRows[0], scanStep };

    const bestUnsafeRow = visibleRows
      .filter((candidate) => candidate.href && candidate.durationSeconds !== null)
      .sort((a, b) => b.durationSeconds - a.durationSeconds)[0];
    if (bestUnsafeRow?.href) {
      const centered = await centerSongRowByHref({ page, href: bestUnsafeRow.href });
      if (centered) {
        await collapseBlockingBottomTrayIfPresent({ page });
        await page.waitForTimeout(450);
        const centeredRows = await getVisibleRowsForTitle({ page, title });
        const centeredSafeRows = centeredRows
          .filter((candidate) => candidate.menuButton && candidate.durationSeconds !== null)
          .sort((a, b) => b.durationSeconds - a.durationSeconds);
        if (centeredSafeRows[0]) return { ...centeredSafeRows[0], scanStep };
      }
    }

    const state = await scrollSongListDown({ page, stepPx: 140 });
    if (state.after === state.before) break;
    await page.waitForTimeout(120);
  }

  return null;
};

const downloadRow = async ({ page, task, row, downloadDir, screenshotDir }) => {
  if (!row.menuButton) throw new Error(`No menu button for ${task.title}`);

  await humanKeyPress(page, 'Escape').catch(() => {});
  await page.waitForTimeout(200);
  await collapseBlockingBottomTrayIfPresent({ page });
  await humanMouseClick(
    page,
    row.menuButton.rect.x + row.menuButton.rect.width / 2,
    row.menuButton.rect.y + row.menuButton.rect.height / 2
  );
  await page.waitForTimeout(200);
  const downloadButton = page.getByRole('button', { name: 'Download' });
  try {
    await humanClick(downloadButton, { timeout: 3_000 });
  } catch (error) {
    await collapseBlockingBottomTrayIfPresent({ page });
    await humanKeyPress(page, 'Escape').catch(() => {});
    await page.waitForTimeout(200);
    await humanMouseClick(
      page,
      row.menuButton.rect.x + row.menuButton.rect.width / 2,
      row.menuButton.rect.y + row.menuButton.rect.height / 2
    );
    await page.waitForTimeout(200);
    await humanClick(downloadButton, { timeout: 10_000 });
  }
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(screenshotDir, task.slug, 'download-menu.png'), fullPage: true });

  const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
  await humanClick(page.getByRole('button', { name: 'MP3 Audio' }), { timeout: 10_000 });
  const download = await downloadPromise;
  const suggestedFilename = sanitizeFilename(download.suggestedFilename() || `${task.title}.mp3`);
  const targetPath = uniquePath(join(downloadDir, suggestedFilename));

  await download.saveAs(targetPath);
  return { suggestedFilename, targetPath };
};

const filesArg = readArg('--files');
const files = filesArg ? filesArg.split(',').map((file) => file.trim()).filter(Boolean) : positionalArgs();

if (files.length === 0) {
  console.error('Missing markdown files. Example: npm run suno:batch -- 01-static-fever.md 02-ghosts-on-the-boulevard.md');
  process.exit(1);
}

const tasks = files.map(parseSongFile);
const duplicateTitles = tasks
  .map((task) => task.title)
  .filter((title, index, titles) => titles.indexOf(title) !== index);

if (duplicateTitles.length > 0) {
  throw new Error(`Duplicate titles are not supported in one batch: ${[...new Set(duplicateTitles)].join(', ')}`);
}

const endpoint = readArg('--endpoint') || process.env.CDP_ENDPOINT || 'http://127.0.0.1:9222';
const storageStatePath = resolve(readArg('--storage-state') || process.env.SUNO_STORAGE_STATE || 'suno-storage-state.json');
const batchName =
  readArg('--batch') ||
  process.env.SUNO_BATCH_NAME ||
  new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
const downloadRoot = resolve(readArg('--dir') || process.env.SUNO_DOWNLOAD_DIR || 'downloads');
const downloadDir = args.includes('--flat-dir') ? downloadRoot : join(downloadRoot, batchName);
const screenshotRoot = resolve(readArg('--screenshots') || process.env.SUNO_SCREENSHOT_DIR || 'headless-screenshots');
const screenshotDir = join(screenshotRoot, batchName);
const statePath = resolve(readArg('--state') || process.env.SUNO_BATCH_STATE || join(screenshotDir, 'batch-state.json'));
const versionsNeeded = Number.parseInt(readArg('--versions') || process.env.SUNO_BATCH_VERSIONS || '2', 10);
const submitGapMs = Number.parseInt(readArg('--submit-gap-ms') || process.env.SUNO_BATCH_SUBMIT_GAP_MS || '1000', 10);
const maxSubmitAttempts = parsePositiveInteger(
  readArg('--submit-attempts') || process.env.SUNO_BATCH_SUBMIT_ATTEMPTS || '3',
  3
);
const maxCaptchaRounds = parsePositiveInteger(
  readArg('--captcha-rounds') || process.env.SUNO_BATCH_CAPTCHA_ROUNDS || '3',
  3
);
const postSubmitWaitMs = parseNonNegativeInteger(
  readArg('--post-submit-wait-ms') || process.env.SUNO_BATCH_POST_SUBMIT_WAIT_MS || '15000',
  15000
);
const pollMs = Number.parseInt(readArg('--poll-ms') || process.env.SUNO_BATCH_POLL_MS || '10000', 10);
const timeoutMs = Number.parseInt(readArg('--timeout-ms') || process.env.SUNO_BATCH_TIMEOUT_MS || '1200000', 10);
const maxScrolls = Number.parseInt(readArg('--max-scrolls') || process.env.SUNO_BATCH_MAX_SCROLLS || '40', 10);
const dryRun = args.includes('--dry-run');
const skipSubmit = args.includes('--skip-submit') || process.env.SUNO_BATCH_SKIP_SUBMIT === '1';
const resetState = args.includes('--reset-state') || process.env.SUNO_BATCH_RESET_STATE === '1';

const serializeTask = (task) => ({
  file: task.file,
  title: task.title,
  slug: task.slug,
  status: task.status,
  error: task.error || '',
  beforeUrls: [...task.beforeUrls],
  observedRows: (task.observedRows || []).map(plainRow),
  completedRows: (task.completedRows || []).map(plainRow),
  selectedRow: plainRow(task.selectedRow),
  submitAttempt: task.submitAttempt || null,
  retriedAfterCaptcha: Boolean(task.retriedAfterCaptcha),
  captchaMethod: task.captchaMethod || null,
  result: task.result || null,
  updatedAt: new Date().toISOString()
});

const saveBatchState = (phase = 'running') => {
  mkdirSync(dirname(statePath), { recursive: true });
  const snapshot = {
    version: 1,
    phase,
    batchName,
    downloadDir,
    screenshotDir,
    statePath,
    versionsNeeded,
    actionJitterMs,
    maxSubmitAttempts,
    maxCaptchaRounds,
    submitGapMs,
    postSubmitWaitMs,
    pollMs,
    timeoutMs,
    maxScrolls,
    skipSubmit,
    updatedAt: new Date().toISOString(),
    tasks: Object.fromEntries(tasks.map((task) => [task.slug, serializeTask(task)]))
  };
  const temporaryPath = `${statePath}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  renameSync(temporaryPath, statePath);
};

const loadBatchState = () => {
  if (resetState || !existsSync(statePath)) return null;
  return JSON.parse(readFileSync(statePath, 'utf8'));
};

const hydrateTasksFromState = (state) => {
  if (!state?.tasks || typeof state.tasks !== 'object') return false;

  let hydrated = false;
  for (const task of tasks) {
    const saved = state.tasks[task.slug];
    if (!saved) continue;

    task.beforeUrls = new Set(Array.isArray(saved.beforeUrls) ? saved.beforeUrls : []);
    task.observedRows = Array.isArray(saved.observedRows) ? saved.observedRows.filter(Boolean) : [];
    task.completedRows = Array.isArray(saved.completedRows) ? saved.completedRows.filter(Boolean) : [];
    task.selectedRow = saved.selectedRow || null;
    task.submitAttempt = saved.submitAttempt || null;
    task.retriedAfterCaptcha = Boolean(saved.retriedAfterCaptcha);
    task.captchaMethod = saved.captchaMethod || null;
    task.result = saved.result || null;
    task.error = saved.error || '';
    task.status = saved.status || 'pending';

    if (task.status === 'downloaded' && (!task.result?.targetPath || !existsSync(task.result.targetPath))) {
      task.status = task.selectedRow ? 'ready' : 'submitted';
      task.result = null;
      task.error = 'Downloaded state existed, but target file was missing; retrying download.';
    }

    if (task.status === 'ready' && !task.selectedRow) {
      task.status = 'submitted';
    }

    if (
      task.status === 'submit_unconfirmed' ||
      (task.status === 'submitted' &&
        /^Only found 0\/\d+ completed new versions/.test(task.error) &&
        task.observedRows.length === 0 &&
        task.completedRows.length === 0)
    ) {
      task.status = 'pending';
      task.beforeUrls = new Set();
      task.observedRows = [];
      task.completedRows = [];
      task.selectedRow = null;
      task.error = 'Previous submit had no visible Suno row; retrying submit.';
    }

    hydrated = true;
  }

  return hydrated;
};

if (dryRun) {
  console.log(
    JSON.stringify(
      {
        dryRun: true,
        batchName,
        downloadDir,
        screenshotDir,
        statePath,
        actionJitterMs,
        maxSubmitAttempts,
        maxCaptchaRounds,
        submitGapMs,
        postSubmitWaitMs,
        versionsNeeded,
        maxScrolls,
        skipSubmit,
        resetState,
        files: tasks.map((task) => ({
          file: task.file,
          title: task.title,
          styleChars: task.style?.length || 0,
          lyricsChars: task.lyrics?.length || 0,
          llmLyricsChars: task.llmLyricsChars || 0,
          lyricsMode: task.lyricsMode
        }))
      },
      null,
      2
    )
  );
  process.exit(0);
}

mkdirSync(downloadDir, { recursive: true });
mkdirSync(screenshotDir, { recursive: true });
for (const task of tasks) {
  mkdirSync(join(screenshotDir, task.slug), { recursive: true });
}

const restoredState = loadBatchState();
const resumed = hydrateTasksFromState(restoredState);
saveBatchState(resumed ? 'resumed' : 'initialized');

if (!existsSync(storageStatePath) || args.includes('--refresh-auth')) {
  await exportStorageState({ endpoint, storageStatePath });
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });

try {
  const context = await browser.newContext({
    acceptDownloads: true,
    storageState: storageStatePath,
    viewport: { width: 1440, height: 900 }
  });
  const page = await context.newPage();

  await openCreatePage({ page });
  await page.screenshot({ path: join(screenshotDir, 'batch-loaded.png'), fullPage: true });

  const captchaHandledAtLoad = await handleCaptchaIfRequired({
    page,
    maxRounds: maxCaptchaRounds,
    screenshotPath: join(screenshotDir, 'error-captcha-loaded.png')
  });
  if (captchaHandledAtLoad) {
    await openCreatePage({ page });
  }

  const bodyText = await page.locator('body').innerText({ timeout: 10_000 }).catch(() => '');
  if (/join suno|log in|couldn.t sign/i.test(bodyText) && !/Create|Advanced/i.test(bodyText)) {
    throw new Error(`Headless session does not look logged in. See ${join(screenshotDir, 'batch-loaded.png')}`);
  }

  for (const task of tasks) {
    if (['submitted', 'ready', 'downloaded'].includes(task.status)) continue;

    const rows = await getRowsForTitle({ page, title: task.title, maxScrolls });
    task.beforeUrls = skipSubmit ? new Set() : new Set(rows.map((row) => row.href));
    if (skipSubmit) task.status = 'submitted';
    saveBatchState('scanned');
  }

  for (const task of tasks) {
    if (skipSubmit || ['submitted', 'ready', 'downloaded'].includes(task.status)) continue;

    try {
      task.error = '';

      const submitResult = await submitTaskWithCaptchaRetries({
        page,
        task,
        screenshotDir,
        postSubmitWaitMs,
        maxSubmitAttempts
      });
      
      task.status = 'submitted';
      task.error = '';
      task.submitAttempt = submitResult.attempt;
      task.retriedAfterCaptcha = submitResult.retriedAfterCaptcha;
      task.captchaMethod = submitResult.captchaMethod || null;
      saveBatchState('submitted');
      await sleep(submitGapMs);
    } catch (error) {
      task.status = error?.code === CAPTCHA_ERROR_CODE ? 'captcha_required' : 'submit_failed';
      task.error = error.message;
      await page.screenshot({ path: join(screenshotDir, task.slug, 'error-submit.png'), fullPage: true }).catch(() => {});
      saveBatchState(task.status);
      throw error;
    }
  }

  const startedAt = Date.now();
  let lastWaitingScreenshotAt = 0;

  while (Date.now() - startedAt < timeoutMs) {
    await openCreatePage({ page }).catch(() => {});
    await page.waitForTimeout(2_500);
    
    // 替换为 handleCaptchaIfRequired [位置 4/5]
    await handleCaptchaIfRequired({
      page,
      maxRounds: maxCaptchaRounds,
      screenshotPath: join(screenshotDir, 'error-captcha-waiting.png')
    });

    for (const task of tasks.filter((candidate) => !['ready', 'downloaded'].includes(candidate.status))) {
      const rows = await getRowsForTitle({ page, title: task.title, maxScrolls });
      const newRows = rows.filter((row) => !task.beforeUrls.has(row.href));
      task.observedRows = newRows.map(plainRow);
      const completedRows = newRows
        .filter((row) => row.duration && row.durationSeconds !== null && row.menuButton)
        .sort((a, b) => b.durationSeconds - a.durationSeconds);

      task.completedRows = completedRows;
      if (completedRows.length >= versionsNeeded) {
        task.selectedRow = completedRows[0];
        task.status = 'ready';
        task.error = '';
      }
    }
    saveBatchState('waiting');

    if (tasks.every((task) => ['ready', 'downloaded'].includes(task.status))) break;

    if (Date.now() - lastWaitingScreenshotAt >= 60_000) {
      const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
      for (const task of tasks.filter((candidate) => !['ready', 'downloaded'].includes(candidate.status))) {
        await page.screenshot({ path: join(screenshotDir, task.slug, `waiting-${elapsedSeconds}s.png`), fullPage: true }).catch(() => {});
      }
      lastWaitingScreenshotAt = Date.now();
    }

    await sleep(pollMs);
  }

  const notReady = tasks.filter((task) => !['ready', 'downloaded'].includes(task.status));
  if (notReady.length > 0) {
    for (const task of notReady) {
      await page.screenshot({ path: join(screenshotDir, task.slug, 'error-not-ready.png'), fullPage: true }).catch(() => {});
      if ((task.observedRows || []).length === 0) {
        task.status = 'submit_unconfirmed';
        task.error = 'No new Suno song row appeared after Create; submit likely did not happen.';
      } else {
        task.error = `Only found ${task.completedRows.length}/${versionsNeeded} completed new versions`;
      }
    }
    saveBatchState('not_ready');
    throw new Error(`Timed out waiting for: ${notReady.map((task) => `${task.title} (${task.error})`).join(', ')}`);
  }

  for (const task of tasks) {
    if (task.status === 'downloaded' && task.result?.targetPath && existsSync(task.result.targetPath)) continue;

    let selected = null;

    for (let attempt = 1; attempt <= 6; attempt += 1) {
      await openCreatePage({ page }).catch(() => {});
      await page.waitForTimeout(1_500 + attempt * 750);
      
      // 替换为 handleCaptchaIfRequired [位置 5/5]
      await handleCaptchaIfRequired({
        page,
        maxRounds: maxCaptchaRounds,
        screenshotPath: join(screenshotDir, task.slug, 'error-captcha-before-download.png')
      });

      if (task.selectedRow?.href) {
        selected = await revealRowByHref({
          page,
          title: task.title,
          href: task.selectedRow.href,
          maxScrolls
        });
      }
      if (!selected?.menuButton || selected.durationSeconds === null) {
        selected = await revealBestRowByTitle({ page, title: task.title });
      }
      if (selected) task.selectedRow = selected;
      if (selected) break;
    }

    if (!selected) {
      await page.screenshot({ path: join(screenshotDir, task.slug, 'error-selected-row-missing.png'), fullPage: true }).catch(() => {});
      saveBatchState('download_failed');
      throw new Error(`No completed row was safely clickable before download: ${task.title}`);
    }
    try {
      const downloadResult = await downloadRow({ page, task, row: selected, downloadDir, screenshotDir });
      task.status = 'downloaded';
      task.error = '';
      task.result = {
        file: task.file,
        title: task.title,
        selectedDuration: selected.duration,
        selectedSeconds: selected.durationSeconds,
        songUrl: selected.href,
        ...downloadResult
      };
      saveBatchState('downloaded');
    } catch (error) {
      task.status = 'ready';
      task.error = error.message;
      await page.screenshot({ path: join(screenshotDir, task.slug, 'error-download.png'), fullPage: true }).catch(() => {});
      saveBatchState('download_failed');
      throw error;
    }
  }

  const results = tasks.map((task) => task.result).filter(Boolean);
  saveBatchState('complete');
  console.log(
    JSON.stringify(
      {
        headless: true,
        batchName,
        downloadDir,
        screenshotDir,
        statePath,
        resumed,
        submitted: tasks.length,
        results
      },
      null,
      2
    )
  );
} finally {
  await browser.close();
}
