/** 공지사항 화면 - 게시판 형태로 공지를 등록하고 댓글로 문답한다 */
import { can } from '../auth.js';
import * as db from '../db.js';
import { icon } from '../icons.js';
import {
    esc, num, toast, confirmDialog, openModal, fmtDateTime,
} from '../util.js';

/** 조회 조건 - 다른 화면에 다녀와도 유지한다 */
const filter = { keyword: '' };

/** 열려 있는 팝업 - 화면을 떠날 때 함께 닫는다 */
let openedModal = null;

/**
 * 아이콘 버튼 한 개.
 * 문구 대신 아이콘만 두므로 aria-label·title 로 무슨 버튼인지 알린다.
 */
function iconBtn(name, label, attr, cls = 'btn btn--icon btn--sm') {
    return `<button class="${cls}" type="button" ${attr}
        aria-label="${esc(label)}" title="${esc(label)}">${icon(name, 'icon icon--sm')}</button>`;
}

export async function render(root, { user }) {
    const canManage = can(user, 'manageNotice');

    root.innerHTML = `
<div class="card">
  <div class="card__head">
    <h2>공지사항</h2>
    <span class="tag tag--gray" id="row-count"></span>
    <div class="toolbar__spacer"></div>
    <div class="btn-row">
      ${canManage
        ? '<button class="btn btn--primary" id="btn-new" type="button">공지 등록</button>'
        : ''}
    </div>
  </div>
  <div class="card__body">
    <div class="toolbar">
      <label class="field" style="flex:1 1 160px;max-width:260px">
        <span class="field__label">제목 / 내용</span>
        <input type="text" id="f-kw" placeholder="검색어 입력" value="${esc(filter.keyword)}">
      </label>
      <button class="btn" id="btn-search" type="button">조회</button>
    </div>
    <div class="table-wrap"><table class="grid" id="tbl"></table></div>
  </div>
</div>`;

    const tbl = root.querySelector('#tbl');
    let rows = [];

    async function reload() {
        rows = await db.listNotices({ keyword: filter.keyword });
        root.querySelector('#row-count').textContent = `${num(rows.length)}건`;
        draw();
    }

    function draw() {
        tbl.innerHTML = `
<colgroup>
  <col style="width:56px"><col><col style="width:120px">
  <col style="width:110px"><col style="width:80px">
</colgroup>
<thead>
  <tr>
    <th>연번</th><th>제목</th><th>작성자</th><th>작성일</th><th class="center">댓글</th>
  </tr>
</thead>
<tbody>
  ${rows.length ? rows.map((n, i) => `
  <tr class="${n.important ? 'is-important' : ''}" data-id="${esc(n.id)}">
    <td class="center">${n.important ? '-' : num(i + 1)}</td>
    <td class="wrap">
      ${n.important ? '<span class="tag tag--red">중요</span> ' : ''}
      <span class="link">${esc(n.title)}</span>
    </td>
    <td>${esc(n.created_by_name)}</td>
    <td>${esc(String(n.created_at).slice(0, 10))}</td>
    <td class="center">${n.comment_count ? num(n.comment_count) : '-'}</td>
  </tr>`).join('')
        : '<tr><td colspan="5" class="empty">등록된 공지사항이 없습니다.</td></tr>'}
</tbody>`;

        tbl.querySelectorAll('tbody tr[data-id]').forEach((tr) => {
            tr.addEventListener('click', () => {
                const n = rows.find((x) => x.id === tr.dataset.id);
                if (n) openDetail(n, user, canManage, reload);
            });
        });
    }

    root.querySelector('#btn-search').addEventListener('click', () => {
        filter.keyword = root.querySelector('#f-kw').value;
        reload();
    });
    root.querySelector('#f-kw').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') root.querySelector('#btn-search').click();
    });
    root.querySelector('#btn-new')?.addEventListener('click', () => openForm(null, user, reload));

    await reload();
    const unwatch = db.subscribe(reload);
    return () => {
        openedModal?.close();
        openedModal = null;
        unwatch();
    };
}

/** 상세 팝업 - 본문과 댓글. 수정·삭제는 권한자에게만 아이콘으로 보인다 */
function openDetail(notice, user, canManage, reload) {
    const m = openModal(notice.title, `
<div class="notice-detail">
  <div class="notice-detail__meta">
    <b>${esc(notice.created_by_name)}</b>
    <span>${esc(fmtDateTime(notice.created_at))}${notice.updated_at ? ' (수정됨)' : ''}</span>
    ${notice.important ? '<span class="tag tag--red">중요</span>' : ''}
    <span class="toolbar__spacer"></span>
    ${canManage ? `
    ${iconBtn('edit', '공지 수정', 'id="btn-edit"')}
    ${iconBtn('trash', '공지 삭제', 'id="btn-del"', 'btn btn--icon btn--sm btn--danger')}` : ''}
  </div>
  <div class="notice-detail__body">${esc(notice.content)}</div>
</div>
<div class="comments">
  <h4 class="comments__title">댓글 <span class="tag tag--gray" id="comment-count"></span></h4>
  <div id="comment-list"></div>
  <div class="comment-new">
    <textarea id="new-comment" rows="2" placeholder="댓글을 입력하세요"></textarea>
    <button class="btn btn--primary btn--sm" id="btn-comment-add" type="button">등록</button>
  </div>
</div>`, { wide: true });

    openedModal = m;
    m.body.querySelector('#btn-edit')?.addEventListener('click', () => {
        m.close();
        openForm(notice, user, reload);
    });
    m.body.querySelector('#btn-del')?.addEventListener('click', async () => {
        if (!(await confirmDialog('이 공지사항을 삭제할까요?'))) return;
        try {
            await db.deleteNotice(notice.id, user);
            m.close();
            toast('공지사항을 삭제했습니다.', 'success');
            await reload();
        } catch (err) {
            toast(err.message, 'error');
        }
    });

    initComments(m, notice, user);
}

/**
 * 상세 팝업의 댓글 영역.
 * parent_id 로 대댓글이 이어지고, 깊이만큼 들여쓴다.
 * 수정·삭제는 작성자 본인과 관리자에게만 보인다.
 */
function initComments(m, notice, user) {
    const list = m.body.querySelector('#comment-list');

    /** 답글/수정 입력칸 공통 마크업 */
    const editorHtml = (value, saveLabel) => `
<div class="comment-new">
  <textarea rows="2">${esc(value)}</textarea>
  ${iconBtn('close', '취소', 'data-cancel')}
  ${iconBtn('save', saveLabel, 'data-save', 'btn btn--icon btn--sm btn--primary')}
</div>`;

    async function draw() {
        const all = await db.listNoticeComments(notice.id);
        m.body.querySelector('#comment-count').textContent
            = `${all.filter((c) => !c.deleted_at).length}건`;

        const byParent = new Map();
        all.forEach((c) => {
            const key = c.parent_id ?? '';
            if (!byParent.has(key)) byParent.set(key, []);
            byParent.get(key).push(c);
        });

        const item = (c, depth) => `
<div class="comment" style="margin-left:${Math.min(depth, 5) * 18}px">
  ${c.deleted_at ? '<div class="comment__deleted">삭제된 댓글입니다.</div>' : `
  <div class="comment__meta">
    <b>${esc(c.created_by_name)}</b>
    <span>${fmtDateTime(c.created_at)}${c.updated_at ? ' (수정됨)' : ''}</span>
  </div>
  <div class="comment__body">${esc(c.content)}</div>
  <div class="comment__actions">
    ${iconBtn('reply', '답글', `data-reply="${esc(c.id)}"`)}
    ${db.canEditNoticeComment(user, c) ? `
    ${iconBtn('edit', '댓글 수정', `data-edit="${esc(c.id)}"`)}
    ${iconBtn('trash', '댓글 삭제', `data-del="${esc(c.id)}"`)}` : ''}
  </div>`}
  <div data-slot="${esc(c.id)}"></div>
</div>
${(byParent.get(c.id) ?? []).map((ch) => item(ch, depth + 1)).join('')}`;

        list.innerHTML = (byParent.get('') ?? []).map((c) => item(c, 0)).join('')
            || '<p class="comment__empty">등록된 댓글이 없습니다.</p>';

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

    m.body.querySelector('#btn-comment-add').addEventListener('click', async () => {
        const ta = m.body.querySelector('#new-comment');
        try {
            await db.addNoticeComment(notice.id, null, ta.value, user);
            ta.value = '';
            await draw();
        } catch (err) {
            toast(err.message, 'error');
        }
    });

    draw();
}

/** 공지 등록·수정 폼 - notice 가 있으면 수정이다 */
function openForm(notice, user, reload) {
    const edit = Boolean(notice);
    const m = openModal(edit ? '공지사항 수정' : '공지사항 등록', `
<form id="notice-form">
  <label class="field">
    <span class="field__label">제목 *</span>
    <input type="text" name="title" required maxlength="200"
           value="${esc(notice?.title ?? '')}">
  </label>
  <label class="field">
    <span class="field__label">내용 *</span>
    <textarea name="content" rows="10" required>${esc(notice?.content ?? '')}</textarea>
  </label>
  <label class="check">
    <input type="checkbox" name="important" ${notice?.important ? 'checked' : ''}>
    <span>중요공지 (목록 맨 위에 고정)</span>
  </label>
</form>`, {
        wide: true,
        footer: `
<button class="btn" id="btn-cancel" type="button">취소</button>
<button class="btn btn--primary" id="btn-save" type="submit" form="notice-form">저장</button>`,
    });

    openedModal = m;
    m.root.querySelector('#btn-cancel').addEventListener('click', () => m.close());
    m.body.querySelector('#notice-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = new FormData(e.target);
        const payload = {
            title: f.get('title'),
            content: f.get('content'),
            important: f.get('important') === 'on',
        };
        try {
            if (edit) await db.updateNotice(notice.id, payload, user);
            else await db.createNotice(payload, user);
            m.close();
            toast(edit ? '공지사항을 수정했습니다.' : '공지사항을 등록했습니다.', 'success');
            await reload();
        } catch (err) {
            toast(err.message, 'error');
        }
    });
}
