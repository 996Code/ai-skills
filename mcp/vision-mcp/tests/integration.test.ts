import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { analyzeImages } from '../src/tools/shared.js';
import { ANALYZE_IMAGE_PROMPT } from '../src/prompts/index.js';

// 64x64 纯红 PNG（满足上游 >10px 的限制）
const RED_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC';

const RUN = process.env.VITEST_INTEGRATION === '1' && !!process.env.VISION_API_KEY;

describe.skipIf(!RUN)('integration: real qwen3.7-plus vision', () => {
  it(
    'analyzes a local image file',
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-mcp-it-'));
      const file = path.join(dir, 'red.png');
      fs.writeFileSync(file, Buffer.from(RED_PNG_B64, 'base64'));
      const out = await analyzeImages(
        ANALYZE_IMAGE_PROMPT,
        [file],
        'What is the dominant color of this image? Answer with a single word.',
      );
      console.info('local-file output:', out.slice(0, 200));
      expect(/red/i.test(out)).toBe(true);
    },
    120000,
  );

  it(
    'analyzes bare base64 input',
    async () => {
      const out = await analyzeImages(
        ANALYZE_IMAGE_PROMPT,
        [RED_PNG_B64],
        'What is the dominant color of this image? Answer with a single word.',
      );
      console.info('base64 output:', out.slice(0, 200));
      expect(/red/i.test(out)).toBe(true);
    },
    120000,
  );
});
