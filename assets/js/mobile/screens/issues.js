/**
 * 이슈등록 (모바일 앱).
 *
 *   #/issues   탭(이슈등록 및 확인 · 완료 · 취소) · 검색 · 카드 목록 → 상세 시트(댓글 포함)
 *
 * 🔑 처리 주체 판정은 화면이 하지 않는다. db.canAcceptIssue / canConfirmAssignee /
 * canRequestClose / canApproveClose / canCancelIssue 가 준 값으로만 버튼을 낸다
 * (docs/issues.md). 웹 이슈등록도 같은 함수를 쓴다.
 * 등록 버튼은 can(user,'createIssue') 가 있을 때만 나온다 - 현장작업자에게는 없다.
 * 단 **댓글은 웹과 마찬가지로 누구나 쓴다** (현장작업자 포함) - 현장 상황 공유가 목적이다.
 */
import {
    ISSUE_TYPES, ISSUE_WORK_TYPES, ISSUE_STATUS, ISSUE_STATE,
} from '../../config.js';
import { can } from '../../auth.js';
import * as db from '../../db.js';
import { icon } from '../../icons.js';
import {
    esc, num, today, toDateStr, fmtDateTime, monthDay, toast, confirmDialog,
} from '../../util.js';
import {
    emptyState, tag, card, stepBar, sheet, dock, pollGuard, closeAllSheets,
} from '../ui.js';

/**
 * 화면 탭 - 웹 이슈등록과 같은 구분이다.
 *   main     진행중 (종결완료·확인취소 제외)
 *   done     종결완료 (종결일자 기준 월 조회)
 *   canceled 확인취소 (취소일자 기준 월 조회)
 */
const TABS = [
    { key: 'main', label: '진행중' },
    { key: 'done', label: '완료' },
    { key: 'canceled', label: '취소' },
];

/** 상태 → 배지 색 */
const TONE = {
    [ISSUE_STATE.WAIT]: 'gray',
    [ISSUE_STATE.OPEN]: 'amber',
    [ISSUE_STATE.DOING]: 'blue',
    [ISSUE_STATE.CLOSE_REQ]: 'amber',
    [ISSUE_STATE.CLOSED]: 'green',
    [ISSUE_STATE.CANCELED]: 'red',
};

/** 조회 조건 - 다른 화면에 다녀와도 유지한다 */
const filter = { tab: 'main', keyword: '', month: today().slice(0, 7) };

export async function render(root, { user }) {
    const canWrite = can(user, 'createIssue');

    root.innerHTML = `
<div class="m-seg" id="tabs">
  ${TABS.map((t) => `
  <button class="m-seg__btn ${t.key === filter.tab ? 'is-active' : ''}" type="button"
          data-tab="${t.key}">${esc(t.label)}</button>`).join('')}
</div>
<label class="m-search">
  ${icon('search', 'm-icon')}
  <input type="search" id="f-kw" placeholder="제목 · 주문번호"
         value="${esc(filter.keyword)}" aria-label="검색">
</label>
<label class="m-monthbar" id="monthbar">
  <span class="m-monthbar__label">조회 월</span>
  <input type="month" id="f-month" value="${esc(filter.month)}" aria-label="조회 월">
</label>
<p class="m-sum" id="sum"></p>
<div id="list"></div>
<div id="dockhost"></div>`;

    const listEl = root.querySelector('#list');
    const sumEl = root.querySelector('#sum');
    const monthBar = root.querySelector('#monthbar');
    let rows = [];

    // 등록 권한이 있을 때만 독을 만든다 (조회 전용 사용자에게는 자리도 만들지 않는다)
    const dockCtl = canWrite ? dock(root.querySelector('#dockhost'), {
        mode: 'action',
        primary: { label: '이슈 등록', tone: 'primary' },
        onPrimary: () => openForm(user, reload),
    }) : null;

    async function reload() {
        const all = await db.listIssues({
            keyword: filter.keyword,
            createdBy: can(user, 'viewAll') ? undefined : user.id,
        });
        if (filter.tab === 'main') {
            rows = all.filter((i) => i.status !== ISSUE_STATE.CLOSED
                && i.status !== ISSUE_STATE.CANCELED);
        } else {
            const status = filter.tab === 'done' ? ISSUE_STATE.CLOSED : ISSUE_STATE.CANCELED;
            const field = filter.tab === 'done' ? 'closed_at' : 'canceled_at';
            rows = all.filter((i) => i.status === status
                && (!filter.month || String(i[field]).slice(0, 7) === filter.month));
        }
        draw();
    }

    function draw() {
        monthBar.hidden = filter.tab === 'main';
        sumEl.innerHTML = rows.length
            ? `<span>이슈 <b>${num(rows.length)}</b></span>` : '';
        listEl.innerHTML = rows.length
            ? rows.map(issueCard).join('')
            : emptyState('등록된 이슈가 없습니다.');
    }

    root.querySelectorAll('[data-tab]').forEach((el) => {
        el.addEventListener('click', () => {
            filter.tab = el.dataset.tab;
            root.querySelectorAll('[data-tab]').forEach((b) => {
                b.classList.toggle('is-active', b.dataset.tab === filter.tab);
            });
            reload();
        });
    });

    root.querySelector('#f-kw').addEventListener('input', (e) => {
        filter.keyword = e.target.value;
        reload();
    });

    root.querySelector('#f-month').addEventListener('change', (e) => {
        filter.month = e.target.value;
        reload();
    });

    listEl.addEventListener('click', (e) => {
        const row = e.target.closest('.m-card[data-id]');
        if (!row) return;
        const issue = rows.find((i) => i.id === row.dataset.id);
        if (issue) openDetail(issue, user, reload);
    });

    await reload();
    const unwatch = db.subscribe(pollGuard(root, reload), 8000);
    return () => {
        closeAllSheets();
        dockCtl?.destroy();
        unwatch();
    };
}

/** 목록 카드 한 장 */
function issueCard(i) {
    const body = `
<span class="m-card__meta">${esc(i.work_type || '-')} · ${esc(i.type)}
  ${i.order_no ? `· 주문 ${esc(i.order_no)}` : ''}</span>
<span class="m-card__meta">등록 ${esc(monthDay(i.created_at))}
  · 확인요청 ${esc(i.due_date)}
  ${i.assignee_name ? `· 담당 ${esc(i.assignee_name)}` : ''}</span>`;

    return card(esc(i.title), body, {
        status: tag(i.status, TONE[i.status] ?? 'gray'),
        attrs: { id: i.id },
        tap: true,
    });
}

/** 절차 칩 - 지나온 단계는 완료, 현재 단계는 진행중으로 칠한다 */
function issueSteps(issue) {
    const idx = ISSUE_STATUS.indexOf(issue.status);
    const closed = issue.status === ISSUE_STATE.CLOSED;
    return ISSUE_STATUS.map((s, i) => ({
        label: s,
        done: i < idx || closed,
        current: i === idx && !closed,
    }));
}

/* ================================= 상세 시트 ================================= */

function openDetail(issue, user, reload) {
    const dash = '<span class="m-muted">-</span>';
    const row = (k, v) => `
<div class="m-kv__row"><span class="m-kv__k">${esc(k)}</span>
  <span class="m-kv__v">${v}</span></div>`;

    const s = sheet(issue.title, `
${issue.auto_created
        ? '<div class="m-guide"><p>해당 건은 주문정보등록에서 조정요청으로 접수하여'
          + ' 자동등록 된 건입니다.</p></div>'
        : ''}
${issue.status === ISSUE_STATE.CANCELED
        ? tag(ISSUE_STATE.CANCELED, 'red')
        : stepBar(issueSteps(issue))}
<div class="m-kv">
  ${row('업무유형', esc(issue.work_type || '-'))}
  ${row('업무구분', esc(issue.type))}
  ${row('주문번호', issue.order_no ? esc(issue.order_no) : dash)}
  ${row('확인요청일', esc(issue.due_date))}
  ${row('확인담당자', issue.assignee_name ? esc(issue.assignee_name) : dash)}
  ${row('등록자', issue.creator_name ? esc(issue.creator_name) : dash)}
  ${row('등록일시', esc(fmtDateTime(issue.created_at)))}
  ${row('종결일자', issue.closed_at ? esc(toDateStr(new Date(issue.closed_at))) : dash)}
  ${issue.canceled_at
        ? row('취소일자', esc(toDateStr(new Date(issue.canceled_at)))) : ''}
</div>
<p class="m-packing">${esc(issue.content)}</p>
<div class="m-actions" id="issue-actions"></div>
<p class="m-listtitle">댓글 <span class="m-tag" id="comment-count"></span></p>
<div id="comment-list"></div>
<div class="m-newcomment">
  <textarea class="m-textarea" id="new-comment" rows="2"
            placeholder="댓글을 입력하세요"></textarea>
  <button class="m-btn m-btn--primary m-btn--sm" type="button" id="btn-comment-add">등록</button>
</div>`);

    initComments(s, issue, user);
    drawActions(s, issue, user, reload);
    return s;
}

/** 처리 버튼 - 어떤 버튼이 나오는지는 전부 db 의 판정 함수가 정한다 */
function drawActions(s, issue, user, reload) {
    const box = s.body.querySelector('#issue-actions');

    async function run(confirmMsg, fn, doneMsg) {
        if (confirmMsg && !(await confirmDialog(confirmMsg))) return;
        try {
            await fn();
            s.close();
            toast(doneMsg, 'success');
            reload();
        } catch (err) {
            toast(err.message, 'error');
        }
    }

    const canManage = db.canAcceptIssue(user, issue);
    const cancelBtn = '<button class="m-btn" type="button" id="btn-cancel-issue">이슈취소</button>';

    const wireCancel = () => {
        box.querySelector('#btn-cancel-issue')?.addEventListener('click', () => {
            run('이 이슈를 취소할까요? 취소한 건은 취소 탭에서만 보입니다.',
                () => db.cancelIssue(issue.id, user), '이슈가 취소되었습니다.');
        });
    };

    if (issue.status === ISSUE_STATE.WAIT) {
        const parts = [];
        if (canManage) {
            parts.push('<button class="m-btn m-btn--primary" type="button" id="btn-accept">'
                + '이슈접수</button>');
        }
        if (db.canCancelIssue(user, issue)) parts.push(cancelBtn);
        box.innerHTML = parts.join('');
        wireCancel();
        box.querySelector('#btn-accept')?.addEventListener('click', () => openAccept(s, box, issue,
            user, reload));
        return;
    }

    const parts = [];
    if (db.canConfirmAssignee(user, issue)) {
        parts.push('<button class="m-btn m-btn--primary" type="button" id="btn-confirm">'
            + '담당자확인</button>');
    }
    if (db.canRequestClose(user, issue)) {
        parts.push('<button class="m-btn" type="button" id="btn-close-req">종결요청</button>');
    }
    if (db.canApproveClose(user, issue)) {
        parts.push('<button class="m-btn m-btn--go" type="button" id="btn-close-ok">'
            + '종결승인</button>');
    }
    if (db.canCancelIssue(user, issue)) parts.push(cancelBtn);
    box.innerHTML = parts.join('');
    wireCancel();

    box.querySelector('#btn-confirm')?.addEventListener('click', () => {
        run('', () => db.confirmIssueAssignee(issue.id, user),
            `담당자확인 되었습니다. 상태가 '${ISSUE_STATE.DOING}'(으)로 변경됩니다.`);
    });
    box.querySelector('#btn-close-req')?.addEventListener('click', () => {
        run('이 이슈의 종결을 요청할까요? 등록자 쪽의 승인 후 종결완료됩니다.',
            () => db.requestIssueClose(issue.id, user), '종결요청 되었습니다.');
    });
    box.querySelector('#btn-close-ok')?.addEventListener('click', () => {
        run('이 이슈를 종결승인 할까요? 승인하면 종결완료되고 종결일자가 기록됩니다.',
            () => db.approveIssueClose(issue.id, user), '종결승인 되었습니다.');
    });
}

/** 이슈접수 - 확인담당자를 고른다 */
async function openAccept(s, box, issue, user, reload) {
    const users = await db.listIssueAssignees();
    if (!users.length) {
        toast('지정할 수 있는 확인담당자가 없습니다.', 'error');
        return;
    }
    box.innerHTML = `
<label class="m-field">
  <span class="m-field__label">확인담당자 *</span>
  <select class="m-select" id="sel-assignee">
    ${users.map((u) => `
    <option value="${esc(u.id)}" ${u.id === user.id ? 'selected' : ''}>${esc(u.name)}</option>`)
        .join('')}
  </select>
</label>
<button class="m-btn" type="button" id="btn-accept-cancel">취소</button>
<button class="m-btn m-btn--primary" type="button" id="btn-accept-ok">접수</button>`;

    box.querySelector('#btn-accept-cancel').addEventListener('click', () => {
        drawActions(s, issue, user, reload);
    });
    box.querySelector('#btn-accept-ok').addEventListener('click', async () => {
        try {
            await db.acceptIssue(issue.id, box.querySelector('#sel-assignee').value, user);
        } catch (err) {
            toast(err.message, 'error');
            return;
        }
        s.close();
        toast('이슈가 접수되었습니다.', 'success');
        reload();
    });
}

/* =================================== 댓글 =================================== */

function initComments(s, issue, user) {
    const list = s.body.querySelector('#comment-list');

    /** 답글·수정 입력칸 공통 마크업 */
    const editorHtml = (value, saveLabel) => `
<div class="m-newcomment">
  <textarea class="m-textarea" rows="2">${esc(value)}</textarea>
  <button class="m-btn m-btn--sm" type="button" data-cancel>취소</button>
  <button class="m-btn m-btn--primary m-btn--sm" type="button" data-save>${esc(saveLabel)}</button>
</div>`;

    async function draw() {
        const all = await db.listIssueComments(issue.id);
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
    <button class="m-btn m-btn--sm" type="button" data-reply="${esc(c.id)}">답글</button>
    ${c.created_by === user.id ? `
    <button class="m-btn m-btn--sm" type="button" data-edit="${esc(c.id)}">수정</button>
    <button class="m-btn m-btn--sm" type="button" data-del="${esc(c.id)}">삭제</button>` : ''}
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
                openEditor(el.dataset.reply, '', '등록',
                    (v) => db.addIssueComment(issue.id, el.dataset.reply, v, user));
            });
        });
        list.querySelectorAll('[data-edit]').forEach((el) => {
            el.addEventListener('click', () => {
                const c = all.find((x) => x.id === el.dataset.edit);
                openEditor(el.dataset.edit, c?.content ?? '', '저장',
                    (v) => db.updateIssueComment(el.dataset.edit, v, user));
            });
        });
        list.querySelectorAll('[data-del]').forEach((el) => {
            el.addEventListener('click', async () => {
                if (!(await confirmDialog('이 댓글을 삭제할까요?'))) return;
                try {
                    await db.deleteIssueComment(el.dataset.del, user);
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
            await db.addIssueComment(issue.id, null, ta.value, user);
        } catch (err) {
            toast(err.message, 'error');
            return;
        }
        ta.value = '';
        await draw();
    });

    draw();
}

/* ================================= 이슈 등록 ================================= */

function openForm(user, reload) {
    const due = new Date();
    due.setDate(due.getDate() + 1);
    const opts = (arr) => arr.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('');

    const s = sheet('이슈 등록', `
<form id="issue-form">
  <label class="m-field">
    <span class="m-field__label">업무유형 *</span>
    <select class="m-select" name="work_type" required>${opts(ISSUE_WORK_TYPES)}</select>
  </label>
  <label class="m-field">
    <span class="m-field__label">업무구분 *</span>
    <select class="m-select" name="type" required>${opts(ISSUE_TYPES)}</select>
  </label>
  <label class="m-field">
    <span class="m-field__label">확인요청일 *</span>
    <input class="m-input" type="date" name="due_date" required value="${esc(toDateStr(due))}">
  </label>
  <label class="m-field">
    <span class="m-field__label">관련 주문번호</span>
    <input class="m-input" type="text" name="order_no" placeholder="선택 입력">
  </label>
  <label class="m-field">
    <span class="m-field__label">제목 *</span>
    <input class="m-input" type="text" name="title" required>
  </label>
  <label class="m-field">
    <span class="m-field__label">내용 *</span>
    <textarea class="m-textarea" name="content" rows="5" required></textarea>
  </label>
</form>`, {
        footer: '<button class="m-btn m-btn--go m-btn--block" type="button" id="btn-save">'
            + '등록</button>',
    });

    s.foot.querySelector('#btn-save').addEventListener('click', async () => {
        const form = s.body.querySelector('#issue-form');
        if (!form.reportValidity()) return;
        try {
            await db.createIssue(Object.fromEntries(new FormData(form)), user);
        } catch (err) {
            toast(err.message, 'error');
            return;
        }
        s.close();
        toast('이슈가 등록되었습니다.', 'success');
        reload();
    });
    return s;
}
