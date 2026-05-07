// 番茄小说批量发布工具 — 注入 window，章节正文从 GitHub raw 拉取
// 使用：window.publishChapter(num, { ai: '是', publishAt: '2026-05-08 09:00' })

(function () {
  const REPO_RAW = 'https://raw.githubusercontent.com/GonsonInter/book_juexingxieyi/main/';

  // 数字 → 中文章号（1-100）
  function numToChinese(n) {
    const cn = ['零','一','二','三','四','五','六','七','八','九'];
    if (n < 10) return cn[n];
    if (n < 20) return '十' + (n === 10 ? '' : cn[n - 10]);
    if (n < 100) {
      const t = Math.floor(n / 10);
      const o = n % 10;
      return cn[t] + '十' + (o === 0 ? '' : cn[o]);
    }
    if (n === 100) return '一百';
    return String(n);
  }

  // 等待元素（按选择器或文本）
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function waitForSelector(sel, timeout = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) return el;
      await sleep(100);
    }
    return null;
  }

  async function waitForText(text, timeout = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      // 在所有可见 dialog/modal 里找文本
      const all = document.querySelectorAll('[role="dialog"], .byte-modal, [class*="modal"]');
      for (const el of all) {
        if (el.offsetParent !== null && el.textContent && el.textContent.includes(text)) {
          return el;
        }
      }
      await sleep(150);
    }
    return null;
  }

  async function clickButtonInDialog(dialog, label) {
    const btns = dialog.querySelectorAll('button');
    for (const b of btns) {
      if (b.textContent && b.textContent.trim() === label) {
        b.click();
        return true;
      }
    }
    return false;
  }

  // 给 input 触发真实事件让 React state 同步
  function setNativeInputValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // 查找 fanqi publish page 的两个 input：章号 + 标题
  function findChapterInputs() {
    const inputs = Array.from(document.querySelectorAll('input[type="text"]'));
    let numIn = null, titleIn = null;
    for (const i of inputs) {
      if (i.placeholder === '请输入标题') { titleIn = i; }
      // 章号 input 没 placeholder，但前面有"第"label
      else if (!i.placeholder && i.parentElement && /第/.test(i.parentElement.textContent || '')) { numIn = i; }
    }
    // fallback: 头两个 text input
    if (!numIn) numIn = inputs[0];
    if (!titleIn) titleIn = inputs[1];
    return { numIn, titleIn };
  }

  // 从 md 文件提取正文
  function extractBody(md) {
    let body = md;
    const sep = md.indexOf('=====');
    if (sep >= 0) body = md.slice(md.indexOf('\n', sep) + 1);
    body = body.trim();
    // 去掉已有"（第X章完）"以避免重复
    body = body.replace(/\n*（第[一二三四五六七八九十百零0-9]+章完）\s*$/, '');
    return body;
  }

  // 把正文注入 ProseMirror 编辑器（章节正文是第一个 .syl-editor .ProseMirror）
  function fillProseMirror(text) {
    const editor = document.querySelector('.syl-editor .ProseMirror');
    if (!editor) throw new Error('no ProseMirror editor');
    editor.focus();
    document.execCommand('selectAll');
    document.execCommand('delete');
    document.execCommand('insertText', false, text);
  }

  window.publishChapter = async function publishChapter(num, opts = {}) {
    const { ai = '是', publishAt = null } = opts;
    const log = [];
    const step = (s) => { log.push(`[${new Date().toISOString().slice(11,19)}] ${s}`); console.log(s); };

    step(`开始 Ch${num}`);

    // 1. 拉章节索引
    if (!window.__chapterIndex) {
      const idxRes = await fetch(REPO_RAW + 'chapter-index.json');
      window.__chapterIndex = await idxRes.json();
    }
    const meta = window.__chapterIndex[String(num)];
    if (!meta) throw new Error(`no ch ${num} in index`);
    step(`Ch${num} = ${meta.title} (${meta.fname})`);

    // 2. 拉正文
    const mdRes = await fetch(REPO_RAW + 'chapters/' + encodeURIComponent(meta.fname));
    if (!mdRes.ok) throw new Error(`fetch md failed: ${mdRes.status}`);
    const md = await mdRes.text();
    let body = extractBody(md);
    body += '\n\n（第' + numToChinese(num) + '章完）';
    step(`正文 ${body.length} 字`);

    // 3. 等编辑器加载
    await waitForSelector('.syl-editor .ProseMirror', 10000);
    await sleep(300);  // 给页面 reactive 一点时间

    // 4. 填章号 + 标题
    const { numIn, titleIn } = findChapterInputs();
    if (!numIn || !titleIn) throw new Error('inputs not found');
    setNativeInputValue(numIn, String(num));
    setNativeInputValue(titleIn, meta.title);
    step('章号/标题 已填');

    // 5. 填正文
    fillProseMirror(body);
    await sleep(500);
    step('正文 已注入');

    // 6. 点"下一步"
    const nextBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '下一步' && !b.disabled);
    if (!nextBtn) throw new Error('next btn missing');
    nextBtn.click();
    step('下一步 clicked');

    // 7. 处理"错别字"对话框（如有）
    await sleep(800);
    const typoDlg = await waitForText('错别字', 3000);
    if (typoDlg) {
      await clickButtonInDialog(typoDlg, '提交');
      step('错别字 提交');
      await sleep(500);
    }

    // 8. 处理"风险检测"对话框（取消，不消耗次数）
    const riskDlg = await waitForText('风险检测', 3000);
    if (riskDlg) {
      await clickButtonInDialog(riskDlg, '取消');
      step('风险检测 取消');
      await sleep(500);
    }

    // 9. 处理"发布设置"对话框
    const pubDlg = await waitForText('发布设置', 8000);
    if (!pubDlg) throw new Error('publish dialog not found');
    step('发布设置 弹出');

    // 9a. 选 AI = ai
    const labels = pubDlg.querySelectorAll('label, span, div');
    for (const el of labels) {
      if (el.textContent && el.textContent.trim() === ai && el.children.length === 0) {
        el.click();
        break;
      }
    }
    step(`AI=${ai} 已选`);
    await sleep(300);

    // 9b. 定时发布（如指定）
    if (publishAt) {
      // 找 switch 开关
      const sw = pubDlg.querySelector('[role="switch"], [class*="switch"]');
      if (sw) sw.click();
      await sleep(500);
      // 找日期 input
      const dateIn = pubDlg.querySelector('input[placeholder*="日期"], input[placeholder*="时间"], input[type="text"]:not([readonly])');
      // (具体填日期格式由 fanqie 决定，可能需要点开 picker — 此处先简化)
      // TODO: 完善定时发布
      step(`定时 ${publishAt} (待实现具体UI)`);
    }

    // 9c. 点"确认发布"
    await sleep(300);
    const confirmBtn = Array.from(pubDlg.querySelectorAll('button')).find(b => b.textContent.trim() === '确认发布');
    if (!confirmBtn) throw new Error('confirm btn missing');
    confirmBtn.click();
    step('确认发布 clicked');

    // 10. 等跳转回 chapter-manage
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      if (location.pathname.includes('chapter-manage')) {
        step('已跳回 chapter-manage');
        break;
      }
      await sleep(300);
    }

    return { ok: true, num, log };
  };

  console.log('[publish-lib] 已注入 window.publishChapter');
})();
