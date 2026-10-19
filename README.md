# 🤖 AI Code Reviewer

Веб-додаток для автоматичного рев'ю коду на базі **DeepSeek** та **Express**.
Вставляєте код або посилання на GitHub — отримуєте структурований звіт із трьох категорій.

## Що аналізується

| Картка | Категорія | Приклади |
|---|---|---|
| 🔴 | **Критичні баги** | помилки логіки, безпека, витоки ресурсів, необроблені виключення, race conditions |
| 🟡 | **Оптимізація** | складність алгоритмів, N+1 запити, зайві алокації, блокуючі виклики |
| 🟢 | **Стиль коду** | читабельність, найменування, дублювання, best practices |

Додатково: оцінка якості 0–100, загальний вердикт і кнопка копіювання звіту в Markdown.

---

## 🚀 Запуск

### 1. Встановити залежності

```bash
npm install
```

### 2. Отримати API-ключ DeepSeek

Зареєструйтесь на [platform.deepseek.com](https://platform.deepseek.com/api_keys) і створіть ключ.
Потім відкрийте файл `.env` у корені проєкту та вставте ключ:

```env
DEEPSEEK_API_KEY=sk-ваш-справжній-ключ
```

> ⚠️ Без ключа сервер запуститься, але роут `/api/analyze` поверне помилку.
> Перевірити стан можна на `http://localhost:3000/api/health`.

### 3. Запустити сервер

```bash
npm start
```

або з автоперезапуском при зміні файлів (Node 18+):

```bash
npm run dev
```

### 4. Відкрити додаток

👉 **http://localhost:3000**

---

## ⚙️ Налаштування (`.env`)

| Змінна | Обов'язкова | Опис |
|---|---|---|
| `DEEPSEEK_API_KEY` | ✅ | Ключ API DeepSeek |
| `PORT` | — | Порт сервера, за замовчуванням `3000` |
| `DEEPSEEK_MODEL` | — | `deepseek-chat` (V3, за замовчуванням) або `deepseek-reasoner` (R1) |
| `DEEPSEEK_BASE_URL` | — | За замовчуванням `https://api.deepseek.com` |
| `GITHUB_TOKEN` | — | Підвищує ліміт GitHub API з 60 до 5000 запитів/год і відкриває приватні репозиторії |

---

## 📁 Структура

```
.
├── server.js          # Express-сервер, GitHub-парсер, клієнт DeepSeek
├── public/
│   └── index.html     # весь фронтенд (Tailwind CDN + vanilla JS)
├── .env               # секрети (у .gitignore)
├── .env.example       # шаблон конфігурації
└── package.json
```

---

## 🔌 API

### `GET /api/health`

```json
{
  "status": "ok",
  "model": "deepseek-chat",
  "apiKeyConfigured": true,
  "githubTokenConfigured": false,
  "uptime": 42
}
```

### `POST /api/analyze`

**Аналіз вставленого коду:**

```bash
curl -X POST http://localhost:3000/api/analyze \
  -H "Content-Type: application/json" \
  -d '{
    "type": "code",
    "code": "function sum(a){ return a.reduce((x,y)=>x+y) }",
    "language": "JavaScript"
  }'
```

**Аналіз GitHub-файлу або репозиторію:**

```bash
curl -X POST http://localhost:3000/api/analyze \
  -H "Content-Type: application/json" \
  -d '{
    "type": "githubUrl",
    "url": "https://github.com/expressjs/express/blob/master/lib/application.js"
  }'
```

**Формат відповіді:**

```json
{
  "success": true,
  "meta": {
    "source": "GitHub: expressjs/express/master/lib/application.js",
    "language": "JavaScript",
    "analyzedChars": 13953,
    "analyzedLines": 632,
    "files": [{ "path": "lib/application.js", "lines": 632, "truncated": false }],
    "model": "deepseek-chat",
    "usage": { "prompt_tokens": 4200, "completion_tokens": 1800, "total_tokens": 6000 }
  },
  "analysis": {
    "score": 62,
    "verdict": "Код загалом якісний, але є проблеми з обробкою помилок.",
    "language": "JavaScript",
    "bugs":        { "summary": "…", "issues": [ { "title": "…", "severity": "high", "location": "…", "description": "…", "suggestion": "…" } ] },
    "performance": { "summary": "…", "issues": [] },
    "cleanCode":   { "summary": "…", "issues": [] }
  }
}
```

`severity` набуває значень `critical` | `high` | `medium` | `low`.

---

## 🐙 Які GitHub-посилання підтримуються

| Формат | Поведінка |
|---|---|
| `github.com/owner/repo` | Береться гілка за замовчуванням, обираються до **6 найважливіших** файлів із кодом |
| `github.com/owner/repo/blob/гілка/шлях/файл.js` | Аналізується конкретний файл (гілки зі слешем теж працюють) |
| `github.com/owner/repo/tree/гілка/папка` | Аналізуються файли цієї гілки |
| `raw.githubusercontent.com/...` | Аналізується конкретний файл |

**Як обираються файли з репозиторію:** пріоритет надається вихідному коду в `src/`, `lib/`, `app/`, `api/`
та файлам з іменами `index`, `main`, `server`, `router` тощо. Автоматично ігноруються
`node_modules`, `dist`, `build`, `vendor`, тести, lock-файли, мініфіковані бандли, зображення й бінарники.
Загальний обсяг коду, що йде в модель, обмежений 60 000 символів.

---

## 🛡️ Вбудовані обмеження

- **Rate limit:** 20 запитів на 10 хвилин з однієї IP-адреси (захист від спалювання API-кредитів).
- **Розмір тіла запиту:** до 2 МБ.
- **Таймаут до DeepSeek:** 180 с, до GitHub: 15 с.
- **JSON-режим:** модель зобов'язана повертати валідний JSON; відповідь додатково парситься
  з урахуванням markdown-обгорток і стороннього тексту, а всі поля нормалізуються перед віддачею на фронтенд.

---

## 🧯 Типові проблеми

| Симптом | Рішення |
|---|---|
| `DEEPSEEK_API_KEY не налаштовано` | Впишіть ключ у `.env` і перезапустіть сервер |
| `Невірний DEEPSEEK_API_KEY` | Перевірте ключ на [platform.deepseek.com](https://platform.deepseek.com/api_keys) |
| `Недостатньо коштів на балансі` | Поповніть баланс DeepSeek |
| `Вичерпано ліміт GitHub API` | Додайте `GITHUB_TOKEN` у `.env` (60 → 5000 запитів/год) |
| `Репозиторій або файл не знайдено` | Перевірте, що репозиторій публічний, або додайте `GITHUB_TOKEN` для приватних |
| `Час очікування вичерпано` | Аналізуйте менший фрагмент коду або один файл замість репозиторію |

---

## 📦 Стек

Node.js 18+ · Express 4 · OpenAI SDK (DeepSeek-сумісний) · axios · Tailwind CSS (CDN)
