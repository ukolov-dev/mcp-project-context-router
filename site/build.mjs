import { mkdirSync, readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marked } from 'marked';

const source = dirname(fileURLToPath(import.meta.url));
const output = join(source, 'dist');
const repo = 'https://github.com/ukolov-dev/mcp-project-context-router';
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const release = `${repo}/releases/tag/v${version}`;
const packageUrl = `${repo}/releases/download/v${version}/mcp-project-context-router-${version}.tgz`;
const pages = ['quickstart', 'configuration', 'context-pack', 'workflow', 'reference', 'upgrading'];
const text = {
  en: { docs: 'Documentation', topics: ['Quick start', 'Project configuration', 'Context packs', 'Agent workflow', 'Tools and records', 'Upgrading and troubleshooting'],
    title: "Your project.<br>Your agent’s context.", intro: 'Local MCP server. Decisions, source files and checks for your task.', start: 'Get started', seeWorkflow: 'See the workflow', releaseNotes: 'Release notes',
    workflow: 'From request to verified work.', steps: [['Define the task','Keep the goal, scope and acceptance criteria together.'],['Bring the right context','Find decisions, relevant source files and existing capabilities.'],['Record the checks','Save actual checks and their limits with the task.']],
    principles: [['Memory you can review','Markdown records live in your repository.'],['Context for this task','Modules and files guide what goes into the pack.'],['Recorded verification','The agent runs checks; the router records results.']],
    local: 'Local files. Rebuildable index.', languages: 'Source languages',
    install: 'Start in your repository.', installIntro: 'Node.js 22.13 or newer. Install the release, then connect your agent.', guide: 'Installation guide', pack: 'Example context pack', illustration: 'Illustrative example',
    exampleTask: 'Fix sign-in', packLabels: ['Task','Project memory','Source files','Verification plan'], exampleDecision: 'decision · Session lifetime',
    explore: 'Find your next step.', topicDescriptions: ['Install and connect an MCP client.','Choose modules, stacks and verification commands.','Follow the diagram, try a request and read the result.','Tasks, context packs, skills and hooks.','Understand tools and durable project memory.','Update safely and check your configuration.'],
    copy: 'Copy', copied: 'Copied', failed: 'Select and copy the code manually', skip: 'Skip to content', toc: 'On this page', next: 'Next', source: 'Edit this page', overview: 'Project overview' },
  ru: { docs: 'Документация', topics: ['Быстрый старт', 'Настройка проекта', 'Пакет контекста', 'Работа с агентом', 'Инструменты и записи', 'Обновление и диагностика'],
    title: 'Ваш проект.<br>Контекст для агента.', intro: 'Локальный MCP-сервер: решения, исходники и проверки для вашей задачи.', start: 'Начать работу', seeWorkflow: 'Как это работает', releaseNotes: 'Что нового',
    workflow: 'От запроса до проверенного результата.', steps: [['Определите задачу','Храните цель, границы и критерии приёмки вместе.'],['Соберите нужный контекст','Находите решения, нужные исходники и готовую реализацию.'],['Запишите проверки','Сохраняйте реальные проверки и их ограничения в задаче.']],
    principles: [['Память, которую можно прочитать','Записи Markdown хранятся в вашем репозитории.'],['Контекст конкретной задачи','Модули и файлы помогают выбрать содержимое пакета.'],['Проверки с результатом','Агент запускает проверки, роутер сохраняет результаты.']],
    local: 'Локальные файлы. Пересоздаваемый индекс.', languages: 'Языки исходников',
    install: 'Начните в своём репозитории.', installIntro: 'Node.js 22.13 или новее. Установите релиз и подключите агента.', guide: 'Инструкция по установке', pack: 'Пример пакета контекста', illustration: 'Иллюстративный пример',
    exampleTask: 'Исправить вход', packLabels: ['Задача','Память проекта','Исходники','План проверки'], exampleDecision: 'decision · Время жизни сессии',
    explore: 'Выберите следующий шаг.', topicDescriptions: ['Установка и подключение MCP-клиента.','Модули, стеки и команды проверки.','Схема сборки, примеры запросов и разбор ответа.','Задачи, пакеты контекста, skills и хуки.','Инструменты и долговечная память проекта.','Безопасное обновление и диагностика конфигурации.'],
    copy: 'Копировать', copied: 'Скопировано', failed: 'Выделите и скопируйте код вручную', skip: 'Перейти к содержимому', toc: 'На этой странице', next: 'Далее', source: 'Редактировать страницу', overview: 'О проекте' },
};
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const arrow = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 12h14m-6-6 6 6-6 6"/></svg>';
const copyIcon = '<svg aria-hidden="true" viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3"/></svg>';
const href = (from, to) => posix.relative(posix.dirname(from), to) || 'index.html';
const code = (body, lang, label='') => `<div class="code-block">${label ? `<div class="code-label">${escape(label)}</div>` : ''}<button class="copy" type="button" aria-label="${text[lang].copy}">${copyIcon}<span>${text[lang].copy}</span></button><pre><code>${escape(body)}</code></pre></div>`;
function shell(lang, file, title, body, description) {
  const t = text[lang], other = lang === 'en' ? 'ru' : 'en';
  const paired = file.replace(new RegExp(`^${lang}/`), `${other}/`);
  const header = `<header class="header"><div class="header-inner"><a class="brand" href="${href(file, `${lang}/index.html`)}">Project Context Router</a><nav aria-label="${t.docs}"><a href="${href(file, `${lang}/docs/quickstart.html`)}">${t.docs}</a><a href="${repo}">GitHub</a><div class="languages" aria-label="Language"><a lang="en" hreflang="en" ${lang === 'en' ? 'aria-current="page"' : ''} href="${href(file, file.replace(/^ru\//, 'en/'))}">EN</a><span aria-hidden="true">/</span><a lang="ru" hreflang="ru" ${lang === 'ru' ? 'aria-current="page"' : ''} href="${href(file, file.replace(/^en\//, 'ru/'))}">RU</a></div></nav></div></header>`;
  const footer = `<footer class="footer"><a class="brand" href="${href(file, `${lang}/index.html`)}">Project Context Router</a><div><a href="${href(file, `${lang}/docs/quickstart.html`)}">${t.docs}</a><a href="${repo}">GitHub</a><a lang="en" href="${href(file, file.replace(/^ru\//,'en/'))}">English</a><a lang="ru" href="${href(file, file.replace(/^en\//,'ru/'))}">Русский</a></div></footer>`;
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)} · Project Context Router</title><meta name="description" content="${escape(description)}"><link rel="alternate" hreflang="${other}" href="${href(file,paired)}"><link rel="stylesheet" href="${href(file,'assets/site.css')}"><link rel="icon" href="${href(file,'assets/favicon.svg')}"><script src="${href(file,'assets/site.js')}" defer></script></head><body data-copy="${t.copy}" data-copied="${t.copied}" data-copy-failed="${t.failed}"><a class="skip" href="#content">${t.skip}</a>${header}${body}${footer}<span class="sr-only" role="status" aria-live="polite" id="copy-status"></span></body></html>`;
}
function home(lang) {
  const t=text[lang], file=`${lang}/index.html`;
  const preview = `<div class="preview"><h2>${t.pack}</h2><p class="preview-caption">${t.illustration}</p><pre><code>${escape(`$ npx project-context pack "${t.exampleTask}"`)}</code></pre><dl>${[t.exampleTask,t.exampleDecision,'src/auth/session.ts','npm test'].map((value,i)=>`<div><dt>${t.packLabels[i]}</dt><dd><code>${escape(value)}</code></dd></div>`).join('')}</dl></div>`;
  // Display wraps the command visually; copy remains a valid single shell line.
  const commands=`npm install --save-dev --save-exact ${packageUrl}\nnpx project-context init --with-skills\nnpx project-context index\nnpx project-context doctor --json`;
  const body=`<main id="content" tabindex="-1" class="home">
    <section class="hero"><div><h1>${t.title}</h1><p class="hero-intro">${t.intro}</p><div class="actions"><a class="button" href="docs/quickstart.html">${t.start}${arrow}</a><a class="text-action" href="#workflow">${t.seeWorkflow}${arrow}</a></div><p class="clients">Codex · OpenCode · <a href="docs/quickstart.html#${lang === 'ru' ? 'zcode-и-deepseek-harness' : 'zcode-and-deepseek-harness'}">ZCode · DeepSeek Harness</a></p><a class="release-link" href="${release}">v${escape(version)} · ${t.releaseNotes}${arrow}</a></div>${preview}</section>
    <div class="stacks"><p>${t.local}</p><p aria-label="${t.languages}">TypeScript / JavaScript · Java · C# · Python · Go · Rust · Markdown</p></div>
    <section class="workflow" id="workflow"><h2>${t.workflow}</h2><ol class="steps" role="list">${t.steps.map((s,i)=>`<li><span class="number" aria-hidden="true">0${i+1}</span><h3>${s[0]}</h3><p>${s[1]}</p></li>`).join('')}</ol><div class="principles">${t.principles.map(s=>`<div><h3>${s[0]}</h3><p>${s[1]}</p></div>`).join('')}</div></section>
    <section class="getting-started"><div><h2>${t.install}</h2><p>${t.installIntro}</p><a class="guide-link" href="docs/quickstart.html">${t.guide}${arrow}</a></div>${code(commands,lang,'bash')}</section>
    <section class="explore"><h2>${t.explore}</h2><nav aria-label="${t.docs}">${pages.map((page,i)=>`<a class="doc-row" href="docs/${page}.html"><span class="number" aria-hidden="true">0${i+1}</span><span class="doc-title">${t.topics[i]}${arrow}</span><span class="doc-description">${t.topicDescriptions[i]}</span></a>`).join('')}</nav></section>
  </main>`;
  return shell(lang,file,t.overview,body,t.intro);
}
function document(lang,id,index) {
  const t=text[lang], file=`${lang}/docs/${id}.html`;
  const md=readFileSync(join(source,'content',lang,`${id}.md`),'utf8');
  const headings=[]; const ids=new Map();
  const marked=new Marked({ renderer: {
    heading({ tokens, depth }) {
      const label=this.parser.parseInline(tokens);
      const base=label.replace(/<[^>]+>/g,'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,'-').replace(/^-|-$/g,'');
      const occurrence=ids.get(base)??0;ids.set(base,occurrence+1);const anchor=occurrence ? `${base}-${occurrence}` : base;
      if(depth===2)headings.push({label,anchor});
      return `<h${depth} id="${escape(anchor)}">${label}</h${depth}>`;
    },
    code({text: body}) { return code(body,lang); },
    html({text: raw}) { return escape(raw); },
  }});
  const article=marked.parse(md);
  const sidebar=`<aside class="sidebar"><nav aria-label="${t.docs}"><h2>${t.docs}</h2>${pages.map((page,i)=>`<a ${page===id ? 'aria-current="page"' : ''} href="${page}.html">${t.topics[i]}</a>`).join('')}</nav></aside>`;
  const toc=`<aside class="toc"><nav aria-label="${t.toc}"><p>${t.toc}</p>${headings.map(h=>`<a href="#${escape(h.anchor)}">${h.label}</a>`).join('')}</nav></aside>`;
  const next=index<pages.length-1 ? `<a class="next" href="${pages[index+1]}.html">${t.next}: ${t.topics[index+1]}${arrow}</a>` : `<a class="next" href="../index.html">${t.overview}${arrow}</a>`;
  return shell(lang,file,t.topics[index],`<main id="content" tabindex="-1" class="docs-layout">${sidebar}<article class="article">${article}<div class="article-bottom"><a href="${repo}/blob/main/site/content/${lang}/${id}.md">${t.source}</a>${next}</div></article>${toc}</main>`,`${t.topics[index]} — Project Context Router`);
}
rmSync(output,{recursive:true,force:true});mkdirSync(output,{recursive:true});cpSync(join(source,'assets'),join(output,'assets'),{recursive:true});
for(const lang of ['en','ru']) {
  mkdirSync(join(output,lang,'docs'),{recursive:true});writeFileSync(join(output,lang,'index.html'),home(lang));
  for(const [index,id] of pages.entries())writeFileSync(join(output,lang,'docs',`${id}.html`),document(lang,id,index));
}
writeFileSync(join(output,'index.html'),'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Project Context Router</title><meta http-equiv="refresh" content="0;url=en/"></head><body><a href="en/">English</a> · <a href="ru/">Русский</a></body></html>');
writeFileSync(join(output,'.nojekyll'),'');
console.log(`Built 2 landing pages and ${pages.length * 2} localized documentation pages in site/dist.`);
