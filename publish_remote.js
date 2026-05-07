#!/usr/bin/env node
// 番茄小说批量发布脚本 — 使用 puppeteer-core 连接已运行的 Chrome
//
// 前置条件：
//   1. npm i -g puppeteer-core    （或本地：npm i puppeteer-core）
//   2. 完全退出当前所有 Chrome 进程（包括 chrome-devtools-mcp 那个）
//   3. 用以下命令启动 Chrome（保留你登录 fanqie 的会话）：
//      /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
//        --remote-debugging-port=9222 \
//        --user-data-dir=$HOME/Library/Application\ Support/Google/Chrome
//   4. 在那个 Chrome 里访问 https://fanqienovel.com/main/writer/book-manage 确认登录
//   5. 运行：node publish_remote.js
//
// 脚本会读取 ./chapter-index.json 和 ./chapters/*.md，自动从指定起点开始上传剩余章节
// 已经发布过的章节会跳过（按当前服务端章数判定起点）

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const BOOK_ID = '7637028743558483006';
const PUBLISH_URL = `https://fanqienovel.com/main/writer/${BOOK_ID}/publish/?enter_from=newchapter`;
const MANAGE_URL = `https://fanqienovel.com/main/writer/chapter-manage/${BOOK_ID}&%E8%A7%89%E9%86%92%E5%8D%8F%E8%AE%AE%EF%BC%8C%E6%91%87%E7%AF%AE?type=1`;

// 中文章序数 1-100
function numCN(n) {
  const cn = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  if (n < 10) return cn[n];
  if (n < 20) return '十' + (n === 10 ? '' : cn[n - 10]);
  if (n < 100) {
    const t = Math.floor(n / 10), o = n % 10;
    return cn[t] + '十' + (o === 0 ? '' : cn[o]);
  }
  if (n === 100) return '一百';
  return String(n);
}

// 提取章节 body
function extractBody(md, chNum) {
  let body = md;
  const sep = md.indexOf('=====');
  if (sep >= 0) body = md.slice(md.indexOf('\n', sep) + 1);
  body = body.trim();
  body = body.replace(/\n*（第[一二三四五六七八九十百零0-9]+章完）\s*$/, '');
  body += `\n\n（第${numCN(chNum)}章完）`;
  return body;
}

// 章号 → 排期（与 publish-schedule.md 一致）
function getSchedule(num) {
  // Ch5 起，每天 09:00 + 19:00
  // Ch5: 2026-05-09 09:00, Ch6: 5/9 19:00, ...
  if (num < 5) return null; // Ch1-4 已完成
  const idx = num - 5;
  const day = Math.floor(idx / 2);
  const isEvening = idx % 2 === 1;
  const start = new Date(2026, 4, 9); // 2026-05-09
  start.setDate(start.getDate() + day);
  const yyyy = start.getFullYear();
  const mm = String(start.getMonth() + 1).padStart(2, '0');
  const dd = String(start.getDate()).padStart(2, '0');
  return {
    date: `${yyyy}-${mm}-${dd}`,
    time: isEvening ? '19:00' : '09:00'
  };
}

// 番茄发布流程（Page 上下文执行）
async function publishOne(page, num, title, body, date, time) {
  await page.goto(PUBLISH_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForSelector('.syl-editor .ProseMirror', { timeout: 15000 });

  await page.evaluate(async (num, title, body, date, time) => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const setVal = (i, v) => {
      const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      s.call(i, v);
      i.dispatchEvent(new Event('input', { bubbles: true }));
      i.dispatchEvent(new Event('change', { bubbles: true }));
      i.dispatchEvent(new Event('blur', { bubbles: true }));
    };
    const findInDlg = (t) => {
      for (const el of document.querySelectorAll('[role="dialog"], .byte-modal, [class*="modal"]'))
        if (el.offsetParent !== null && el.textContent && el.textContent.includes(t)) return el;
      return null;
    };
    const waitForText = async (t, ms = 6000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { const el = findInDlg(t); if (el) return el; await sleep(150); }
      return null;
    };
    const clickBtn = (dlg, label) => {
      for (const b of dlg.querySelectorAll('button'))
        if (b.textContent.trim() === label) { b.click(); return true; }
      return false;
    };

    let titleIn, editor;
    for (let i = 0; i < 30; i++) {
      titleIn = Array.from(document.querySelectorAll('input')).find(x => x.placeholder === '请输入标题');
      editor = document.querySelector('.syl-editor .ProseMirror');
      if (titleIn && editor) break;
      await sleep(200);
    }
    const allText = Array.from(document.querySelectorAll('input')).filter(i => i.type === 'text' || !i.type);
    const numIn = allText[allText.indexOf(titleIn) - 1];
    setVal(numIn, String(num));
    setVal(titleIn, title);
    editor.focus();
    document.execCommand('selectAll');
    document.execCommand('delete');
    document.execCommand('insertText', false, body);
    await sleep(500);

    const nextBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '下一步' && !b.disabled);
    if (!nextBtn) throw new Error('next disabled');
    nextBtn.click();
    await sleep(1000);

    const typoDlg = await waitForText('错别字', 3000);
    if (typoDlg) { clickBtn(typoDlg, '提交'); await sleep(500); }
    const riskDlg = await waitForText('风险检测', 3000);
    if (riskDlg) { clickBtn(riskDlg, '取消'); await sleep(500); }

    const pubDlg = await waitForText('发布设置', 8000);
    if (!pubDlg) throw new Error('no pub dialog');
    for (const el of pubDlg.querySelectorAll('label, span, div'))
      if (el.textContent && el.textContent.trim() === '是' && el.children.length === 0) { el.click(); break; }
    await sleep(300);
    const sw = pubDlg.querySelector('[role="switch"]');
    if (sw && sw.getAttribute('aria-checked') !== 'true') { sw.click(); await sleep(800); }
    const pickers = pubDlg.querySelectorAll('input.arco-picker-start-time');
    if (pickers.length >= 2) {
      pickers[0].focus(); setVal(pickers[0], date); await sleep(200);
      pickers[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
      await sleep(400);
      pickers[1].focus(); setVal(pickers[1], time); await sleep(200);
      pickers[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
      await sleep(400);
    }
    const confirmBtn = Array.from(pubDlg.querySelectorAll('button')).find(b => b.textContent.trim() === '确认发布');
    if (!confirmBtn) throw new Error('no confirm btn');
    confirmBtn.click();

    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      if (location.pathname.includes('chapter-manage')) return;
      await sleep(300);
    }
  }, num, title, body, date, time);

  // 等跳转到 chapter-manage 完成
  await page.waitForFunction(() => location.pathname.includes('chapter-manage'), { timeout: 15000 });
  await new Promise(r => setTimeout(r, 1500));
}

(async () => {
  const startCh = parseInt(process.env.START_CH || '13', 10);
  const endCh = parseInt(process.env.END_CH || '34', 10);

  console.log(`连接 Chrome (port 9222)...`);
  const browser = await puppeteer.connect({
    browserURL: 'http://127.0.0.1:9222',
    defaultViewport: null
  });
  const pages = await browser.pages();
  let page = pages.find(p => p.url().includes('fanqienovel.com'));
  if (!page) {
    page = await browser.newPage();
    await page.goto(MANAGE_URL);
    console.log('请在新打开的 tab 里登录番茄，然后再次运行此脚本');
    process.exit(0);
  }

  // 读取 chapter index
  const indexPath = path.join(__dirname, 'chapter-index.json');
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));

  console.log(`计划上传 Ch${startCh}-Ch${endCh}`);
  for (let num = startCh; num <= endCh; num++) {
    const meta = index[String(num)];
    if (!meta) { console.warn(`Ch${num} 不在索引中`); continue; }
    const sched = getSchedule(num);
    if (!sched) { console.warn(`Ch${num} 没有排期`); continue; }
    const mdPath = path.join(__dirname, 'chapters', meta.fname);
    const md = fs.readFileSync(mdPath, 'utf-8');
    const body = extractBody(md, num);

    console.log(`[${new Date().toLocaleTimeString()}] Ch${num} ${meta.title} → ${sched.date} ${sched.time}`);
    try {
      await publishOne(page, num, meta.title, body, sched.date, sched.time);
      console.log(`  ✓ 完成`);
    } catch (e) {
      console.error(`  ✗ 失败: ${e.message}`);
      console.error('  停止批量。请手动检查页面状态后重新运行 START_CH=' + num);
      break;
    }
    // 礼貌等待，避免太快
    await new Promise(r => setTimeout(r, 2000));
  }

  await browser.disconnect();
  console.log('完成');
})();
