/**
 * AI Code Reviewer — сервер Express + DeepSeek
 *
 * Роути:
 *   GET  /               -> статика з public/
 *   GET  /api/health     -> перевірка стану сервера
 *   POST /api/analyze    -> аналіз коду ({ type: 'code' | 'githubUrl', ... })
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import dotenv from 'dotenv';
import axios from 'axios';
import OpenAI from 'openai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ────────────────────────────────────────────────────────────────────────────
// Конфігурація
// ────────────────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT) || 3000;
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';

const MAX_CODE_CHARS = 60_000; // ліміт коду, що йде в модель
const MAX_REPO_FILES = 6; // скільки файлів тягнути з репозиторію
const MAX_FILE_BYTES = 150_000; // ігноруємо завеликі файли
const GITHUB_TIMEOUT_MS = 15_000;
const AI_TIMEOUT_MS = 180_000;

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY || 'missing-key',
  baseURL: DEEPSEEK_BASE_URL,
  timeout: AI_TIMEOUT_MS,
  maxRetries: 2,
});

// ────────────────────────────────────────────────────────────────────────────
// Системний промпт
// ────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Ти — senior software engineer і досвідчений code reviewer з 15-річним стажем.
Ти ретельно аналізуєш код і даєш конкретні, практичні зауваження.

ПРАВИЛА:
1. Відповідай ВИКЛЮЧНО українською мовою.
2. Відповідай ВИКЛЮЧНО валідним JSON-об'єктом. Без markdown-обгорток, без тексту до чи після JSON.
3. Не вигадуй проблем, яких немає в коді. Якщо в категорії все добре — поверни порожній масив issues і поясни це в summary.
4. Кожна проблема має бути конкретною: вказуй назву функції/рядок і пояснюй, ЧОМУ це проблема.
5. Поле "suggestion" має містити виправлений фрагмент коду, а не загальну пораду.
6. Не додавай коментарів усередині JSON.

КАТЕГОРІЇ (рівно три):
- "bugs" — критичні баги, помилки логіки, безпека, витоки памʼяті/ресурсів, необроблені виключення, race conditions, SQL-ін'єкції, XSS.
- "performance" — складність алгоритмів, зайві алокації, N+1 запити, блокуючі виклики, відсутність кешування, зайві цикли.
- "cleanCode" — читабельність, найменування, дублювання, структура, обробка помилок, відповідність best practices та ідіомам мови.

СТРУКТУРА JSON (дотримуйся точно):
{
  "score": 0-100,
  "verdict": "одне коротке речення — загальний вердикт",
  "language": "визначена мова програмування українською",
  "bugs": {
    "summary": "1-2 речення про стан цієї категорії",
    "issues": [
      {
        "title": "короткий заголовок проблеми",
        "severity": "critical" | "high" | "medium" | "low",
        "location": "функція / рядок / блок коду",
        "description": "що саме не так і які наслідки, 1-3 речення",
        "suggestion": "виправлений фрагмент коду"
      }
    ]
  },
  "performance": {
    "summary": "...",
    "issues": [ { "title": "", "severity": "high" | "medium" | "low", "location": "", "description": "", "suggestion": "" } ]
  },
  "cleanCode": {
    "summary": "...",
    "issues": [ { "title": "", "severity": "high" | "medium" | "low", "location": "", "description": "", "suggestion": "" } ]
  }
}

Обмеження: максимум 6 issues на кожну категорію, найважливіші — першими.
Якщо код порожній або надто короткий для аналізу — поверни score 0 і поясни це в "verdict".`;

function buildUserPrompt(code, language, source) {
  const lang = language && language !== 'auto' ? language : 'визнач самостійно';
  return `Проаналізуй наведений код.

Джерело: ${source}
Мова: ${lang}
Обсяг: ${code.length} символів, ${code.split('\n').length} рядків

Поверни результат строго у форматі JSON, описаного в системному промпті. Усі тексти — українською.

=== ПОЧАТОК КОДУ ===
${code}
=== КІНЕЦЬ КОДУ ===`;
}

// ────────────────────────────────────────────────────────────────────────────
// GitHub: парсинг посилань
// ────────────────────────────────────────────────────────────────────────────

const GITHUB_HEADERS = () => {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'ai-code-reviewer',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  return headers;
};

/**
 * Розбирає посилання на GitHub у структуру { owner, repo, ref, filePath, kind }.
 * Підтримує:
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo/blob/main/src/app.js
 *   https://github.com/owner/repo/tree/main/src
 *   https://raw.githubusercontent.com/owner/repo/main/src/app.js
 */
function parseGitHubUrl(input) {
  let raw = String(input || '').trim();
  if (!raw) return { error: 'Посилання порожнє' };
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;

  let url;
  try {
    url = new URL(raw);
  } catch {
    return { error: 'Некоректне посилання' };
  }

  const host = url.hostname.replace(/^www\./, '');
  const segments = url.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s));

  // raw.githubusercontent.com/owner/repo/ref/path/to/file.js
  if (host === 'raw.githubusercontent.com') {
    const [owner, repo, ref, ...rest] = segments;
    if (!owner || !repo || !ref || rest.length === 0) {
      return { error: 'Посилання raw.githubusercontent.com має містити власника, репо, гілку та шлях до файлу' };
    }
    return { owner, repo, ref, filePath: rest.join('/'), kind: 'file' };
  }

  if (host !== 'github.com') {
    return { error: 'Підтримуються лише посилання на github.com та raw.githubusercontent.com' };
  }

  const [owner, repo, marker, ...rest] = segments;
  if (!owner || !repo) {
    return { error: 'У посиланні немає назви власника та репозиторію' };
  }
  if (!marker) return { owner, repo, kind: 'repo' };

  // blob (файл) / raw (файл) / tree (гілка або папка)
  if (marker === 'blob' || marker === 'raw') {
    if (rest.length < 2) return { error: 'Посилання на файл має містити гілку та шлях до файлу' };
    return { owner, repo, refParts: rest, kind: 'file' };
  }
  if (marker === 'tree') {
    if (rest.length === 0) return { owner, repo, kind: 'repo' };
    if (rest.length === 1) return { owner, repo, ref: rest[0], kind: 'repo' };
    return { owner, repo, refParts: rest, kind: 'dir' };
  }

  return { owner, repo, kind: 'repo' };
}

async function fetchRawFile(owner, repo, ref, filePath, { method = 'get' } = {}) {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath}`;
  return axios({
    url,
    method,
    timeout: GITHUB_TIMEOUT_MS,
    responseType: 'text',
    transformResponse: [(d) => d],
    headers: { 'User-Agent': 'ai-code-reviewer' },
    validateStatus: () => true,
  });
}

/**
 * У посиланні /blob/<ref>/<path> гілка теоретично може містити слеші (feature/foo),
 * тому заздалегідь невідомо, де закінчується ref і починається шлях.
 * Пробуємо варіанти через HEAD-запити (без завантаження тіла).
 */
const COMMON_BRANCHES = new Set(['main', 'master', 'develop', 'development', 'dev', 'trunk', 'release', 'staging', 'gh-pages', 'next']);

async function resolveFileRef(owner, repo, refParts) {
  const maxRefSegments = Math.min(3, refParts.length - 1);
  const order = COMMON_BRANCHES.has(refParts[0].toLowerCase())
    // типова назва гілки — майже напевно вона й є ref (0 зайвих запитів)
    ? Array.from({ length: maxRefSegments }, (_, i) => i + 1)
    // інакше перевіряємо довші варіанти першими (feature/x важливіше за feature)
    : Array.from({ length: maxRefSegments }, (_, i) => maxRefSegments - i);

  for (const n of order) {
    const ref = refParts.slice(0, n).join('/');
    const filePath = refParts.slice(n).join('/');
    if (!filePath) continue;

    const res = await fetchRawFile(owner, repo, ref, filePath, { method: 'head' });
    if (res.status === 200) return { ref, filePath };
  }
  return null;
}

async function fetchGitHubFile(target) {
  const { owner, repo } = target;
  let ref = target.ref;
  let filePath = target.filePath;

  if (target.refParts) {
    const resolved = await resolveFileRef(owner, repo, target.refParts);
    if (!resolved) {
      throw httpError(404, `Файл не знайдено: github.com/${owner}/${repo}/${target.refParts.join('/')}`);
    }
    ({ ref, filePath } = resolved);
  }

  const raw = await fetchRawFile(owner, repo, ref, filePath);
  if (raw.status !== 200) {
    throw httpError(404, `Не вдалося завантажити файл (HTTP ${raw.status}). Перевірте, що репозиторій публічний.`);
  }

  const code = String(raw.data);
  if (!code.trim()) throw httpError(422, 'Файл порожній');
  if (code.length > MAX_CODE_CHARS) {
    return {
      code: `${code.slice(0, MAX_CODE_CHARS)}\n\n// ... (файл обрізано, показано перші ${MAX_CODE_CHARS} символів)`,
      source: `GitHub: ${owner}/${repo}/${ref}/${filePath} (обрізано)`,
      files: [{ path: filePath, lines: code.split('\n').length, truncated: true }],
    };
  }

  return {
    code,
    source: `GitHub: ${owner}/${repo}/${ref}/${filePath}`,
    files: [{ path: filePath, lines: code.split('\n').length, truncated: false }],
  };
}

// ────────────────────────────────────────────────────────────────────────────
// GitHub: вибір файлів з репозиторію
// ────────────────────────────────────────────────────────────────────────────

const CODE_EXTENSIONS = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.vue', '.svelte',
  '.py', '.java', '.kt', '.kts', '.scala', '.groovy',
  '.cs', '.vb', '.fs',
  '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx',
  '.go', '.rs', '.rb', '.php', '.swift', '.dart', '.lua', '.pl', '.r', '.m',
  '.sh', '.bash', '.zsh', '.ps1', '.sql', '.graphql', '.proto',
  '.html', '.css', '.scss', '.sass', '.less',
]);

const IGNORED_PATH_PARTS = [
  'node_modules/', 'dist/', 'build/', 'out/', 'target/', 'vendor/',
  '__pycache__/', '.venv/', 'venv/', 'env/', 'coverage/', '.git/',
  'migrations/', 'fixtures/', 'snapshots/', '__snapshots__/', 'test/', 'tests/',
  '__tests__/', 'spec/', 'specs/', 'e2e/', 'assets/', 'static/', 'images/',
  'third_party/', 'bower_components/', '.next/', '.nuxt/', 'bin/', 'obj/',
];

const IGNORED_FILE_PATTERNS = [
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'composer.lock',
  'Gemfile.lock', 'poetry.lock', 'Cargo.lock', 'go.sum',
];

const PRIORITY_DIRS = ['src/', 'app/', 'lib/', 'server/', 'api/', 'core/', 'internal/', 'pkg/', 'components/', 'services/', 'routes/', 'controllers/', 'models/'];
const PRIORITY_NAMES = ['index', 'main', 'app', 'server', 'cli', 'core', 'router', 'routes', 'service', 'handler', 'controller', 'utils', 'helper'];

function scoreFile(filePath) {
  const lower = filePath.toLowerCase();
  const ext = path.extname(lower);
  const base = path.basename(lower, ext);
  let score = 0;

  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) score += 30;
  else if (['.py', '.go', '.rs', '.java', '.cs', '.cpp', '.rb', '.php', '.kt', '.swift'].includes(ext)) score += 28;
  else score += 15;

  if (PRIORITY_NAMES.includes(base)) score += 25;
  else if (PRIORITY_NAMES.some((n) => base.includes(n))) score += 12;

  if (PRIORITY_DIRS.some((d) => lower.startsWith(d))) score += 20;
  if (lower.startsWith('src/') || lower.startsWith('lib/')) score += 10;

  const depth = filePath.split('/').length;
  score -= depth * 2; // ближче до кореня — важливіше

  if (/\.(test|spec)\./.test(lower)) score -= 20;
  if (/\.(config|conf)\./.test(lower)) score -= 8;
  if (lower.endsWith('.d.ts')) score -= 30;
  if (lower.includes('.min.')) score -= 100;

  return score;
}

function isAnalyzable(file) {
  const filePath = file.path;
  const lower = filePath.toLowerCase();

  if (file.type !== 'blob') return false;
  if (file.size === 0 || file.size > MAX_FILE_BYTES) return false;
  if (IGNORED_PATH_PARTS.some((p) => lower.includes(p))) return false;
  if (IGNORED_FILE_PATTERNS.some((p) => lower.endsWith(p.toLowerCase()))) return false;
  if (/\.(min|bundle|chunk)\.(js|css)$/.test(lower)) return false;
  if (/\.(png|jpe?g|gif|svg|ico|webp|pdf|zip|tar|gz|exe|dll|so|dylib|woff2?|ttf|eot|mp4|mp3|wasm|lock|log|csv|xlsx?)$/.test(lower)) return false;

  return CODE_EXTENSIONS.has(path.extname(lower));
}

async function githubApi(url) {
  const res = await axios.get(url, {
    headers: GITHUB_HEADERS(),
    timeout: GITHUB_TIMEOUT_MS,
    validateStatus: () => true,
  });
  if (res.status === 403 || res.status === 429) {
    const remaining = res.headers['x-ratelimit-remaining'];
    if (remaining === '0') {
      throw httpError(429, 'Вичерпано ліміт GitHub API. Додайте GITHUB_TOKEN у .env і спробуйте знову.');
    }
    throw httpError(403, 'GitHub API відхилив запит (403). Можливо, репозиторій приватний.');
  }
  if (res.status === 404) {
    throw httpError(404, 'Репозиторій або файл не знайдено. Перевірте, що він публічний.');
  }
  if (res.status >= 400) {
    throw httpError(res.status, `GitHub API повернув помилку ${res.status}`);
  }
  return res.data;
}

async function fetchGitHubRepo(target) {
  const { owner, repo } = target;

  const meta = await githubApi(`https://api.github.com/repos/${owner}/${repo}`);
  const branch = target.ref || meta.default_branch || 'main';

  let tree;
  try {
    tree = await githubApi(
      `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`
    );
  } catch (err) {
    if (err.status === 404) {
      throw httpError(404, `Гілку "${branch}" не знайдено в репозиторії ${owner}/${repo}`);
    }
    throw err;
  }

  if (!Array.isArray(tree.tree)) throw httpError(502, 'GitHub не повернув список файлів');

  const candidates = tree.tree
    .filter(isAnalyzable)
    .map((f) => ({ ...f, score: scoreFile(f.path) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_REPO_FILES);

  if (candidates.length === 0) {
    throw httpError(422, 'У репозиторії не знайдено файлів із кодом, які можна проаналізувати');
  }

  const fetched = await Promise.all(
    candidates.map(async (file) => {
      try {
        const res = await fetchRawFile(owner, repo, branch, file.path);
        if (res.status !== 200) return null;
        return { path: file.path, content: String(res.data) };
      } catch {
        return null;
      }
    })
  );

  const files = [];
  let budget = MAX_CODE_CHARS;
  for (const file of fetched) {
    if (!file || !file.content.trim() || budget <= 0) continue;
    const content = file.content.length > budget ? `${file.content.slice(0, budget)}\n// ... (обрізано)` : file.content;
    budget -= content.length;
    files.push({ path: file.path, content, lines: content.split('\n').length, truncated: content.length < file.content.length });
  }

  if (files.length === 0) throw httpError(502, 'Не вдалося завантажити вміст файлів із GitHub');

  const code = files
    .map((f) => `// ── Файл: ${f.path} (${f.lines} рядків)${f.truncated ? ' [обрізано]' : ''} ──\n${f.content}`)
    .join('\n\n\n');

  return {
    code,
    source: `GitHub-репозиторій: ${owner}/${repo} @ ${branch} (${files.length} файл(ів))${meta.language ? `, основна мова: ${meta.language}` : ''}`,
    files: files.map((f) => ({ path: f.path, lines: f.lines, truncated: f.truncated })),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// DeepSeek
// ────────────────────────────────────────────────────────────────────────────

function extractJson(text) {
  let s = String(text || '').trim();
  // прибираємо ```json ... ```
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(s);
  } catch {
    /* пробуємо знайти перший збалансований об'єкт */
  }
  const start = s.indexOf('{');
  if (start === -1) throw httpError(502, 'Модель повернула відповідь не у форматі JSON');

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1));
        } catch {
          break;
        }
      }
    }
  }
  throw httpError(502, 'Не вдалося розібрати JSON у відповіді моделі');
}

function normalizeSection(section) {
  const issues = Array.isArray(section?.issues) ? section.issues : [];
  return {
    summary: typeof section?.summary === 'string' ? section.summary : '',
    issues: issues
      .filter((i) => i && typeof i === 'object')
      .slice(0, 10)
      .map((i) => ({
        title: String(i.title || 'Зауваження'),
        severity: ['critical', 'high', 'medium', 'low'].includes(i.severity) ? i.severity : 'medium',
        location: String(i.location || ''),
        description: String(i.description || ''),
        suggestion: String(i.suggestion || ''),
      })),
  };
}

function normalizeAnalysis(raw) {
  const score = Number(raw?.score);
  return {
    score: Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : null,
    verdict: typeof raw?.verdict === 'string' ? raw.verdict : '',
    language: typeof raw?.language === 'string' ? raw.language : '',
    bugs: normalizeSection(raw?.bugs),
    performance: normalizeSection(raw?.performance),
    cleanCode: normalizeSection(raw?.cleanCode),
  };
}

async function analyzeWithDeepSeek(code, language, source) {
  if (!process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY.startsWith('sk-your')) {
    throw httpError(500, 'DEEPSEEK_API_KEY не налаштовано. Відкрийте .env і вставте свій ключ з platform.deepseek.com', { expected: true });
  }

  const completion = await client.chat.completions.create({
    model: DEEPSEEK_MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(code, language, source) },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.3,
    max_tokens: 8000,
    stream: false,
  });

  const content = completion.choices?.[0]?.message?.content;
  if (!content) throw httpError(502, 'Модель повернула порожню відповідь');

  return {
    analysis: normalizeAnalysis(extractJson(content)),
    usage: completion.usage || null,
    model: completion.model || DEEPSEEK_MODEL,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Утиліти
// ────────────────────────────────────────────────────────────────────────────

function httpError(status, message, { expected = false } = {}) {
  const err = new Error(message);
  err.status = status;
  err.expose = true;
  err.expected = expected; // очікувана помилка — не забиваємо консоль стектрейсом
  return err;
}

/** Найпростіший in-memory rate limit, щоб не спалити API-кредити. */
function createRateLimiter({ windowMs = 10 * 60 * 1000, max = 20 } = {}) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip;
    const entry = hits.get(key);
    if (!entry || now > entry.resetAt) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    entry.count += 1;
    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({
        error: `Забагато запитів. Спробуйте через ${Math.ceil(retryAfter / 60)} хв.`,
      });
    }
    return next();
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Express
// ────────────────────────────────────────────────────────────────────────────

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    model: DEEPSEEK_MODEL,
    apiKeyConfigured: Boolean(process.env.DEEPSEEK_API_KEY) && !process.env.DEEPSEEK_API_KEY.startsWith('sk-your'),
    githubTokenConfigured: Boolean(GITHUB_TOKEN),
    uptime: Math.round(process.uptime()),
  });
});

app.post('/api/analyze', createRateLimiter(), async (req, res, next) => {
  try {
    const body = req.body || {};
    const type = body.type;
    const language = typeof body.language === 'string' ? body.language : 'auto';

    let code;
    let source;

    if (type === 'code') {
      code = String(body.code ?? body.content ?? '');
      if (!code.trim()) throw httpError(400, 'Поле з кодом порожнє');
      if (code.length > MAX_CODE_CHARS) {
        code = `${code.slice(0, MAX_CODE_CHARS)}\n\n// ... (обрізано)`;
      }
      source = `Вставлений код (мова: ${language === 'auto' ? 'не вказана' : language})`;
    } else if (type === 'githubUrl') {
      const urlInput = String(body.url ?? body.githubUrl ?? body.content ?? '').trim();
      if (!urlInput) throw httpError(400, 'Посилання на GitHub порожнє');

      const target = parseGitHubUrl(urlInput);
      if (target.error) throw httpError(400, target.error);

      const fetched = target.kind === 'file' ? await fetchGitHubFile(target) : await fetchGitHubRepo(target);
      code = fetched.code;
      source = fetched.source;
      res.locals.files = fetched.files;
    } else {
      throw httpError(400, "Поле 'type' має бути 'code' або 'githubUrl'");
    }

    const { analysis, usage, model } = await analyzeWithDeepSeek(code, language, source);

    res.json({
      success: true,
      meta: {
        source,
        language: analysis.language || language,
        analyzedChars: code.length,
        analyzedLines: code.split('\n').length,
        files: res.locals.files || null,
        model,
        usage,
      },
      analysis,
    });
  } catch (err) {
    next(err);
  }
});

// 404 для невідомих API-роутів
app.use('/api', (_req, res) => res.status(404).json({ error: 'Роут не знайдено' }));

// Обробник помилок
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;

  if (status >= 500 && !err.expected) {
    console.error('[ERROR]', err);
  }

  let message = err.message || 'Внутрішня помилка сервера';

  // Помилки від OpenAI SDK / DeepSeek
  if (err.status === 401 || /api key/i.test(message)) {
    message = 'Невірний DEEPSEEK_API_KEY. Перевірте ключ у файлі .env';
  } else if (err.status === 429 && !err.expose) {
    message = 'DeepSeek тимчасово обмежив запити. Спробуйте за кілька секунд.';
  } else if (err.code === 'ECONNABORTED' || /timeout/i.test(message)) {
    message = 'Час очікування вичерпано. Спробуйте ще раз із меншим фрагментом коду.';
  } else if (err.name === 'APIConnectionError' || err.code === 'ENOTFOUND') {
    message = 'Немає зʼєднання з api.deepseek.com. Перевірте інтернет або проксі.';
  } else if (err.status === 402 || /insufficient balance/i.test(message)) {
    message = 'Недостатньо коштів на балансі DeepSeek. Поповніть рахунок.';
  }

  res.status(status).json({ error: message });
});

const server = app.listen(PORT, () => {
  const keyOk = Boolean(process.env.DEEPSEEK_API_KEY) && !process.env.DEEPSEEK_API_KEY.startsWith('sk-your');
  console.log('');
  console.log('  🤖  AI Code Reviewer');
  console.log(`  ➜  Сервер:  http://localhost:${PORT}`);
  console.log(`  ➜  Модель:  ${DEEPSEEK_MODEL} (${DEEPSEEK_BASE_URL})`);
  console.log(`  ➜  API-ключ: ${keyOk ? '✅ налаштовано' : '❌ НЕ налаштовано — впишіть DEEPSEEK_API_KEY у .env'}`);
  console.log(`  ➜  GitHub-токен: ${GITHUB_TOKEN ? '✅' : '— (необовʼязково)'}`);
  console.log('');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  ❌ Порт ${PORT} уже зайнятий.`);
    console.error(`     Закрийте інший процес або вкажіть інший порт: PORT=3001 npm start\n`);
    process.exit(1);
  }
  throw err;
});

// Коректне завершення, щоб порт звільнявся одразу
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
