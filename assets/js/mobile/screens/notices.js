/**
 * 공지사항 (모바일 앱).
 *
 *   #/notices   검색 · 카드 목록 → 상세 시트(본문 + 댓글)
 *
 * 웹 공지사항(pages/notices.js)의 최소판이다 - 목록·상세·댓글만 둔다.
 * 🔑 권한 판정은 화면이 하지 않는다. 등록·수정·삭제는 db.canManageNotice(),
 * 댓글 수정·삭제는 db.canEditNoticeComment() 가 준 값으로만 버튼을 낸다
 * (docs/notices.md). 웹 공지사항도 같은 함수를 쓴다.
 * 댓글은 웹과 마찬가지로 **누구나** 쓴다 (현장작업자 포함).
 */
import * as db from '../../db.js';
import { icon } from '../../icons.js';
import {
    esc, num, fmtDateTime, monthDay, toast, confirmDialog,
} from '../../util.js';
import {
    emptyState, tag, card, sheet, dock, pollGuard, closeAllSheets,
} from '../ui.js';

/** 조회 조건 - 다른 화면에 다녀와도 유지한다 */
const filter = { keyword: '' };

/**
 * 아이콘 버튼 한 개 - 문구 대신 아이콘만 두므로 aria-label·title 로 뜻을 알린다.
 */
function iconBtn(name, label, attr, cls = 'm-btn m-btn--sm') {
    return `<button class="${cls}" type="button" ${attr}
        aria-label="${esc(label)}" title="${esc(label)}">${icon(name, 'm-icon')}</button>`;
}

export async function render(root, { user }) {
    const canManage = db.canManageNotice(user);

    root.innerHTML = `
<label class="m-search">
  ${icon('search', 'm-icon')}
  <input type="search" id="f-kw" placeholder="제목 · 내용"
         value="${esc(filter.keyword)}" aria-label="검색">
</label>
<p class="m-sum" id="sum"></p>
<div id="list"></div>
<div id="dockhost"></div>`;

    const listEl = root.querySelector('#list');
    const sumEl = root.querySelector('#sum');
    let rows = [];

    // 등록 권한이 있을 때만 독을 만든다 (조회 전용 사용자에게는 자리도 만들지 않는다)
    const dockCtl = canManage ? dock(root.querySelector('#dockhost'), {
        mode: 'action',
        primary: { label: '공지 등록', tone: 'primary' },
        onPrimary: () => openForm(null, user, reload),
    }) : null;

    async function reload() {
        rows = await db.listNotices({ keyword: filter.keyword });
        sumEl.innerHTML = rows.length ? `<span>공지 <b>${num(rows.length)}</b></span>` : '';
        listEl.innerHTML = rows.length
            ? rows.map(noticeCard).join('')
            : emptyState('등록된 공지사항이 없습니다.');
    }

    root.querySelector('#f-kw').addEventListener('input', (e) => {
        filter.keyword = e.target.value;
        reload();
    });

    listEl.addEventListener('click', (e) => {
        const row = e.target.closest('.m-card[data-id]');
        if (!row) return;
        const n = rows.find((x) => x.id === row.dataset.id);
        if (n) openDetail(n, user, reload);
    });

    await reload();
    const unwatch = db.subscribe(pollGuard(root, reload), 8000);
    return () => {
        closeAllSheets();
        dockCtl?.destroy();
        unwatch();
    };
}

/** 목록 카드 한 장 - 중요공지는 위에 고정되고 빨강 배지가 붙는다 */
function noticeCard(n) {
    const body = `
<span class="m-card__meta">${esc(n.created_by_name)} · ${esc(monthDay(n.created_at))}
  ${n.comment_count ? `· 댓글 ${num(n.comment_count)}` : ''}</span>`;

    return card(esc(n.title), body, {
        badges: n.important ? tag('중요', 'red') : '',
        attrs: { id: n.id },
        tap: true,
    });
}

/* ================================= 상세 시트 ================================= */

function openDetail(notice, user, reload) {
    const canManage = db.canManageNotice(user);

    const s = sheet(notice.title, `
<div class="m-comment__meta">
  <b>${esc(notice.created_by_name)}</b>
  <span>${esc(fmtDateTime(notice.created_at))}${notice.updated_at ? ' (수정됨)' : ''}</span>
  ${notice.important ? tag('중요', 'red') : ''}
</div>
<p class="m-packing">${esc(notice.content)}</p>
${canManage ? `
<div class="m-actions">
  ${iconBtn('edit', '공지 수정', 'id="btn-edit"')}
  ${iconBtn('trash', '공지 삭제', 'id="btn-del"')}
</div>` : ''}
<p class="m-listtitle">댓글 <span class="m-tag" id="comment-count"></span></p>
<div id="comment-list"></div>
<div class="m-newcomment">
  <textarea class="m-textarea" id="new-comment" rows="2"
            placeholder="댓글을 입력하세요"></textarea>
  <button class="m-btn m-btn--primary m-btn--sm" type="button" id="btn-comment-add">등록</button>
</div>`);

    s.body.querySelector('#btn-edit')?.addEventListener('click', () => {
        s.close();
        openForm(notice, user, reload);
    });
    s.body.querySelector('#btn-del')?.addEventListener('click', async () => {
        if (!(await confirmDialog('이 공지사항을 삭제할까요?'))) return;
        try {
            await db.deleteNotice(notice.id, user);
        } catch (err) {
            toast(err.message, 'error');
            return;
        }
        s.close();
        toast('공지사항을 삭제했습니다.', 'success');
        reload();
    });

    initComments(s, notice, user);
    return s;
}

/** 상세 시트의 댓글 영역 - 대댓글은 깊이만큼 들여쓴다 */
function initComments(s, notice, user) {
    const list = s.body.querySelector('#comment-list');

    const editorHtml = (value, saveLabel) => `
<div class="m-newcomment">
  <textarea class="m-textarea" rows="2">${esc(value)}</textarea>
  ${iconBtn('close', '취소', 'data-cancel')}
  ${iconBtn('save', saveLabel, 'data-save', 'm-btn m-btn--primary m-btn--sm')}
</div>`;

    async function draw() {
        const all = await db.listNoticeComments(notice.id);
        s.body.querySelector('#comment-count').textContent
            = `${all.filter((c) => !c.deleted_at).length}건`;

        const byParent = new Map();
        all.forEach((c) => {
            const key = c.parent_id ?? '';
            if (!byParent.has(key)) byParent.set(key, []);
            byParent.get(key).push(c);
        });

        // 좁은 화면이라 들여쓰기는 3단까지만 준다
        const item = (c, depth) => `
<div class="m-comment" style="margin-left:${Math.min(depth, 3) * 14}px">
  ${c.deleted_at ? '<p class="m-comment__gone">삭제된 댓글입니다.</p>' : `
  <div class="m-comment__meta">
    <b>${esc(c.created_by_name)}</b>
    <span>${esc(fmtDateTime(c.created_at))}${c.updated_at ? ' (수정됨)' : ''}</span>
  </div>
  <p class="m-comment__body">${esc(c.content)}</p>
  <div class="m-comment__act">
    ${iconBtn('reply', '답글', `data-reply="${esc(c.id)}"`)}
    ${db.canEditNoticeComment(user, c) ? `
    ${iconBtn('edit', '댓글 수정', `data-edit="${esc(c.id)}"`)}
    ${iconBtn('trash', '댓글 삭제', `data-del="${esc(c.id)}"`)}` : ''}
  </div>`}
  <div data-slot="${esc(c.id)}"></div>
</div>
${(byParent.get(c.id) ?? []).map((ch) => item(ch, depth + 1)).join('')}`;

        list.innerHTML = (byParent.get('') ?? []).map((c) => item(c, 0)).join('')
            || '<p class="m-note">등록된 댓글이 없습니다.</p>';

        /** slot 에 입력칸을 열고 저장 동작을 연결한다 */
        function openEditor(id, value, saveLabel, onSave) {
            const slot = list.querySelector(`[data-slot="${id}"]`);
            slot.innerHTML = editorHtml(value, saveLabel);
            slot.querySelector('[data-cancel]').addEventListener('click', () => {
                slot.innerHTML = '';
            });
            slot.querySelector('[data-save]').addEventListener('click', async () => {
                try {
                    await onSave(slot.querySelector('textarea').value);
                    await draw();
                } catch (err) {
                    toast(err.message, 'error');
                }
            });
        }

        list.querySelectorAll('[data-reply]').forEach((el) => {
            el.addEventListener('click', () => {
                openEditor(el.dataset.reply, '', '답글 등록',
                    (v) => db.addNoticeComment(notice.id, el.dataset.reply, v, user));
            });
        });
        list.querySelectorAll('[data-edit]').forEach((el) => {
            el.addEventListener('click', () => {
                const c = all.find((x) => x.id === el.dataset.edit);
                openEditor(el.dataset.edit, c?.content ?? '', '저장',
                    (v) => db.updateNoticeComment(el.dataset.edit, v, user));
            });
        });
        list.querySelectorAll('[data-del]').forEach((el) => {
            el.addEventListener('click', async () => {
                if (!(await confirmDialog('이 댓글을 삭제할까요?'))) return;
                try {
                    await db.deleteNoticeComment(el.dataset.del, user);
                    await draw();
                } catch (err) {
                    toast(err.message, 'error');
                }
            });
        });
    }

    s.body.querySelector('#btn-comment-add').addEventListener('click', async () => {
        const ta = s.body.querySelector('#new-comment');
        try {
            await db.addNoticeComment(notice.id, null, ta.value, user);
        } catch (err) {
            toast(err.message, 'error');
            return;
        }
        ta.value = '';
        await draw();
    });

    draw();
}

/* ============================== 공지 등록 · 수정 ============================== */

function openForm(notice, user, reload) {
    const edit = Boolean(notice);
    const s = sheet(edit ? '공지사항 수정' : '공지사항 등록', `
<form id="notice-form">
  <label class="m-field">
    <span class="m-field__label">제목 *</span>
    <input class="m-input" type="text" name="title" required maxlength="200"
           value="${esc(notice?.title ?? '')}">
  </label>
  <label class="m-field">
    <span class="m-field__label">내용 *</span>
    <textarea class="m-textarea" name="content" rows="8"
              required>${esc(notice?.content ?? '')}</textarea>
  </label>
  <label class="m-check">
    <input type="checkbox" name="important" ${notice?.important ? 'checked' : ''}>
    <span>중요공지 (목록 맨 위에 고정)</span>
  </label>
</form>`, {
        footer: `<button class="m-btn m-btn--go m-btn--block" type="button" id="btn-save">${
            edit ? '저장' : '등록'}</button>`,
    });

    s.foot.querySelector('#btn-save').addEventListener('click', async () => {
        const form = s.body.querySelector('#notice-form');
        if (!form.reportValidity()) return;
        const f = new FormData(form);
        const payload = {
            title: f.get('title'),
            content: f.get('content'),
            important: f.get('important') === 'on',
        };
        try {
            if (edit) await db.updateNotice(notice.id, payload, user);
            else await db.createNotice(payload, user);
        } catch (err) {
            toast(err.message, 'error');
            return;
        }
        s.close();
        toast(edit ? '공지사항이 수정되었습니다.' : '공지사항이 등록되었습니다.', 'success');
        reload();
    });
    return s;
}
