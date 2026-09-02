/** 이슈등록 화면 - 주문 관련 이슈를 게시판 형태로 등록/관리한다 */
import { ISSUE_TYPES, ISSUE_WORK_TYPES, ISSUE_STATUS, ISSUE_STATE } from '../config.js';
import { can } from '../auth.js';
import * as db from '../db.js';
import {
    esc, num, today, downloadCsv, toast, confirmDialog, openModal, fmtDateTime, toDateStr,
    isMobile, monthDay, MOBILE_QUERY,
} from '../util.js';

/**
 * 화면 탭.
 *   main     : 이슈등록 및 확인 - 진행중(종결완료·확인취소 제외)인 건
 *   done     : 완료 - 종결완료 건만. 년/월(종결일자 기준) 조회
 *   canceled : 취소 - 확인취소 건만. 년/월(취소일자 기준) 조회
 */
const TABS = [
    { key: 'main', label: '이슈등록 및 확인' },
    { key: 'done', label: '완료' },
    { key: 'canceled', label: '취소' },
];
let tab = 'main';

const filter = { status: '', keyword: '', year: '', month: '' };

/** 열려 있는 팝업 - 화면을 떠날 때 함께 닫는다 */
let openedModal = null;

export async function render(root, { user }) {
    root.innerHTML = `
<div class="tabs" id="issue-tabs"></div>
<div id="summary" class="summary"></div>

<div class="card">
  <div class="card__head">
    <h2>이슈 등록 내역</h2>
    <span class="tag tag--gray" id="row-count"></span>
    <div class="toolbar__spacer"></div>
    <div class="btn-row" id="head-actions"></div>
  </div>
  <div class="card__body">
    <div class="toolbar" id="toolbar"></div>
    <div class="table-wrap"><table class="grid" id="tbl"></table></div>
  </div>
</div>`;

    function drawTabs() {
        root.querySelector('#issue-tabs').innerHTML = TABS.map((t) => `
<button class="tabs__btn ${t.key === tab ? 'is-active' : ''}"
        data-tab="${t.key}" type="button">${t.label}</button>`).join('');
        root.querySelectorAll('[data-tab]').forEach((el) => {
            el.addEventListener('click', () => {
                tab = el.dataset.tab;
                drawTabs();
                drawToolbar();
                reload();
            });
        });
    }

    /** 필터 줄 - 메인 탭은 상태, 완료·취소 탭은 년/월로 조회한다 */
    function drawToolbar() {
        const kwHtml = `
<label class="field" style="flex:1 1 130px;max-width:220px">
  <span class="field__label">제목 / 주문번호</span>
  <input type="text" id="f-kw" placeholder="검색어 입력" value="${esc(filter.keyword)}">
</label>
<button class="btn" id="btn-search" type="button">조회</button>`;

        if (tab === 'main') {
            const statuses = ISSUE_STATUS.filter((s) => s !== ISSUE_STATE.CLOSED);
            root.querySelector('#toolbar').innerHTML = `
<label class="field" style="flex:0 0 110px;max-width:110px">
  <span class="field__label">상태</span>
  <select id="f-status">
    <option value="">전체</option>
    ${statuses.map((s) => `
    <option value="${s}" ${filter.status === s ? 'selected' : ''}>${s}</option>`).join('')}
  </select>
</label>${kwHtml}`;
        } else {
            root.querySelector('#toolbar').innerHTML = `
<label class="field" style="flex:0 0 100px;max-width:100px">
  <span class="field__label">년도</span>
  <select id="f-year"><option value="">전체</option></select>
</label>
<label class="field" style="flex:0 0 90px;max-width:90px">
  <span class="field__label">월</span>
  <select id="f-month">
    <option value="">전체</option>
    ${Array.from({ length: 12 }, (_, k) => k + 1).map((mm) => `
    <option value="${mm}" ${filter.month === String(mm) ? 'selected' : ''}>${mm}월</option>`)
        .join('')}
  </select>
</label>${kwHtml}`;
        }

        root.querySelector('#btn-search').addEventListener('click', () => {
            filter.keyword = root.querySelector('#f-kw').value;
            if (tab === 'main') {
                filter.status = root.querySelector('#f-status').value;
            } else {
                filter.year = root.querySelector('#f-year').value;
                filter.month = root.querySelector('#f-month').value;
            }
            reload();
        });
        root.querySelector('#f-kw').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') root.querySelector('#btn-search').click();
        });
    }

    /** 완료·취소 탭의 년도 목록을 데이터에서 채운다 (선택값은 유지) */
    function fillYearOptions(base, dateField) {
        const sel = root.querySelector('#f-year');
        if (!sel) return;
        const years = [...new Set(base
            .map((i) => i[dateField])
            .filter(Boolean)
            .map((v) => String(new Date(v).getFullYear())))]
            .sort()
            .reverse();
        sel.innerHTML = `<option value="">전체</option>${years.map((y) => `
<option value="${y}" ${filter.year === y ? 'selected' : ''}>${y}년</option>`).join('')}`;
    }

    /** 상단 버튼 - 앱 화면은 조회만 하므로 등록·다운로드를 두지 않는다 */
    function drawHeadActions() {
        const parts = [];
        if (!isMobile() && can(user, 'download')) {
            parts.push('<button class="btn btn--sm" id="btn-csv" type="button">다운로드</button>');
        }
        if (!isMobile() && can(user, 'createIssue')) {
            parts.push('<button class="btn btn--primary btn--sm" id="btn-new" type="button">'
                + '이슈 등록</button>');
        }
        root.querySelector('#head-actions').innerHTML = parts.join('');
        root.querySelector('#btn-csv')?.addEventListener('click', downloadRows);
        root.querySelector('#btn-new')?.addEventListener('click', () => openForm(user, reload));
    }

    let rows = [];

    async function reload() {
        const all = await db.listIssues({
            keyword: filter.keyword,
            createdBy: can(user, 'viewAll') ? undefined : user.id,
        });

        if (tab === 'main') {
            rows = all.filter((i) => i.status !== ISSUE_STATE.CLOSED
                && i.status !== ISSUE_STATE.CANCELED);
            if (filter.status) rows = rows.filter((i) => i.status === filter.status);
        } else {
            const status = tab === 'done' ? ISSUE_STATE.CLOSED : ISSUE_STATE.CANCELED;
            const dateField = tab === 'done' ? 'closed_at' : 'canceled_at';
            const base = all.filter((i) => i.status === status);
            fillYearOptions(base, dateField);
            rows = base.filter((i) => {
                if (!filter.year && !filter.month) return true;
                if (!i[dateField]) return false;
                const d = new Date(i[dateField]);
                if (filter.year && String(d.getFullYear()) !== filter.year) return false;
                if (filter.month && String(d.getMonth() + 1) !== filter.month) return false;
                return true;
            });
        }

        drawSummary(root, rows, tab);
        drawTable(root, rows, user, reload, tab);
        root.querySelector('#row-count').textContent = `${num(rows.length)}건`;
    }

    function downloadRows() {
        downloadCsv(`이슈내역_${today()}.csv`,
            ['등록일자', '업무유형', '업무구분', '제목', '주문번호', '확인요청일', '상태', '내용'],
            rows.map((i) => [
                fmtDateTime(i.created_at), i.work_type ?? '', i.type, i.title, i.order_no ?? '',
                i.due_date, i.status, i.content,
            ]));
    }

    drawTabs();
    drawToolbar();
    drawHeadActions();

    // 창 크기가 기준점을 넘나들면 상단 버튼과 표 구성이 달라진다
    const mq = window.matchMedia(MOBILE_QUERY);
    const onResize = () => {
        drawHeadActions();
        reload();
    };
    mq.addEventListener('change', onResize);

    await reload();
    const unwatch = db.subscribe(reload);
    return () => {
        mq.removeEventListener('change', onResize);
        unwatch();
        openedModal?.close();
        openedModal = null;
    };
}

function drawSummary(root, rows, tabKey) {
    const count = (s) => rows.filter((i) => i.status === s).length;
    const box = root.querySelector('#summary');
    // 메인 탭은 진행 단계별 5칸, 완료·취소 탭은 해당 상태 한 칸만 보여준다
    const labels = tabKey === 'main'
        ? ISSUE_STATUS.filter((s) => s !== ISSUE_STATE.CLOSED)
        : [tabKey === 'done' ? ISSUE_STATE.CLOSED : ISSUE_STATE.CANCELED];
    box.classList.toggle('summary--5', tabKey === 'main');
    box.innerHTML = `
<div class="stat stat--accent">
  <div class="stat__label">전체 이슈</div>
  <div class="stat__value">${num(rows.length)}<small>건</small></div>
</div>
${labels.map((s) => `
<div class="stat">
  <div class="stat__label">${s}</div>
  <div class="stat__value">${num(count(s))}<small>건</small></div>
</div>`).join('')}`;
}

/**
 * 상태를 절차(단계 칩)로 표시한다.
 * 지나온 단계는 초록(is-done), 현재 진행·요청중인 단계는 노랑(is-current).
 * 마지막 단계(종결완료)에 도달하면 전부 완료로 칠한다.
 * 확인취소된 건은 절차 대신 빨간 배지 하나로 표시한다.
 */
function issueFlow(issue) {
    if (issue.status === ISSUE_STATE.CANCELED) {
        return `<span class="tag tag--lg tag--red">${ISSUE_STATE.CANCELED}</span>`;
    }
    const idx = ISSUE_STATUS.indexOf(issue.status);
    const closed = issue.status === ISSUE_STATE.CLOSED;
    return `<div class="steps steps--flow issue-flow">${ISSUE_STATUS.map((s, i) => `
${i ? '<span class="steps__arrow">→</span>' : ''}
<span class="step ${i < idx || closed ? 'is-done' : i === idx ? 'is-current' : ''}">${s}</span>`)
        .join('')}</div>`;
}

/** 상세 팝업 - 목록의 행(또는 제목)을 누르면 열린다 */
function bindDetail(scope, rows, user, reload) {
    scope.querySelectorAll('[data-view]').forEach((el) => {
        el.addEventListener('click', () => {
            const issue = rows.find((i) => i.id === el.dataset.view);
            if (issue) openDetail(issue, user, reload);
        });
    });
}

/**
 * 상세 팝업 본체 - 진행 단계에 따라 처리 주체가 다르다.
 *   접수대기 : 이슈접수 (관리자·용마담당자) - 확인담당자 지정
 *   접수완료 : 담당자확인 (선정된 담당자 본인) / 종결요청 (담당자·관리자)
 *   확인중   : 종결요청 (담당자·관리자)
 *   종결요청 : 종결승인 (등록자·고객사 화주관리자·관리자)
 */
function openDetail(issue, user, reload) {
    openedModal?.close();
    const m = openModal(issue.title, `
${issue.auto_created ? `<div class="issue-auto-note">
  해당 건은 주문정보등록에서 조정요청으로 접수하여 자동등록 된 건입니다.
</div>` : ''}
<table class="grid"><tbody>
  <tr><th>업무유형</th><td>${esc(issue.work_type || '-')}</td></tr>
  <tr><th>업무구분</th><td>${esc(issue.type)}</td></tr>
  <tr><th>주문번호</th><td>${esc(issue.order_no ?? '-')}</td></tr>
  <tr><th>확인요청일</th><td>${esc(issue.due_date)}</td></tr>
  <tr><th>상태</th><td>${issueFlow(issue)}</td></tr>
  <tr><th>확인담당자</th><td>${esc(issue.assignee_name || '-')}</td></tr>
  <tr><th>등록자</th><td>${esc(issue.creator_name || '-')}</td></tr>
  <tr><th>등록일시</th><td>${fmtDateTime(issue.created_at)}</td></tr>
  <tr><th>종결일자</th><td>${issue.closed_at ? toDateStr(new Date(issue.closed_at)) : '-'}</td></tr>
  ${issue.canceled_at ? `
  <tr><th>취소일자</th><td>${toDateStr(new Date(issue.canceled_at))}</td></tr>` : ''}
</tbody></table>
<p style="white-space:pre-wrap;margin-top:14px">${esc(issue.content)}</p>
<div class="form-actions" id="issue-actions"></div>
<div class="comments">
  <h4 class="comments__title">댓글 <span class="tag tag--gray" id="comment-count"></span></h4>
  <div id="comment-list"></div>
  <div class="comment-new">
    <textarea id="new-comment" rows="2" placeholder="댓글을 입력하세요"></textarea>
    <button class="btn btn--primary btn--sm" id="btn-comment-add" type="button">등록</button>
  </div>
</div>`, { xl: true });
    openedModal = m;

    initComments(m, issue, user);

    const box = m.body.querySelector('#issue-actions');

    /** 처리 공통 - 확인 후 실행하고 팝업을 닫는다 */
    async function run(confirmMsg, fn, doneMsg) {
        if (confirmMsg && !(await confirmDialog(confirmMsg))) return;
        try {
            await fn();
            m.close();
            toast(doneMsg, 'success');
            reload();
        } catch (err) {
            toast(err.message, 'error');
        }
    }

    // 이슈접수는 이슈 상태를 바꿀 수 있는 역할(관리자·용마담당자)만 한다
    const canManage = (can(user, 'updateStatus') && can(user, 'createIssue'))
        || can(user, 'manageUsers');

    const cancelBtnHtml = '<button class="btn" id="btn-cancel-issue" type="button">'
        + '이슈취소</button>';
    const wireCancel = () => {
        box.querySelector('#btn-cancel-issue')?.addEventListener('click', () => {
            run('이 이슈를 취소할까요? 취소한 건은 취소 탭에서만 보입니다.',
                () => db.cancelIssue(issue.id, user), '이슈가 취소되었습니다.');
        });
    };

    if (issue.status === ISSUE_STATE.WAIT) {
        const waitParts = [];
        if (canManage) {
            waitParts.push('<button class="btn btn--primary" id="btn-accept" type="button">'
                + '이슈접수</button>');
        }
        if (db.canCancelIssue(user, issue)) waitParts.push(cancelBtnHtml);
        box.innerHTML = waitParts.join('');
        wireCancel();
        box.querySelector('#btn-accept')?.addEventListener('click', async () => {
            const users = await db.listIssueAssignees();
            if (!users.length) {
                toast('지정할 수 있는 확인담당자가 없습니다.', 'error');
                return;
            }
            box.innerHTML = `
<label class="field" style="flex:1 1 200px;max-width:260px">
  <span class="field__label">확인담당자 *</span>
  <select id="sel-assignee">
    ${users.map((u) => `
    <option value="${esc(u.id)}" ${u.id === user.id ? 'selected' : ''}>${esc(u.name)}</option>
    `).join('')}
  </select>
</label>
<button class="btn" id="btn-accept-cancel" type="button">취소</button>
<button class="btn btn--primary" id="btn-accept-ok" type="button">접수</button>`;
            box.querySelector('#btn-accept-cancel').addEventListener('click', () => {
                openDetail(issue, user, reload);
            });
            box.querySelector('#btn-accept-ok').addEventListener('click', async () => {
                try {
                    await db.acceptIssue(issue.id, box.querySelector('#sel-assignee').value);
                    m.close();
                    toast('이슈가 접수되었습니다.', 'success');
                    reload();
                } catch (err) {
                    toast(err.message, 'error');
                }
            });
        });
        return;
    }

    const parts = [];
    if (db.canConfirmAssignee(user, issue)) {
        parts.push('<button class="btn btn--primary" id="btn-confirm-assignee" type="button">'
            + '담당자확인</button>');
    }
    if (db.canRequestClose(user, issue)) {
        parts.push('<button class="btn" id="btn-close-req" type="button">종결요청</button>');
    }
    if (db.canApproveClose(user, issue)) {
        parts.push('<button class="btn btn--primary" id="btn-close-approve" type="button">'
            + '종결승인</button>');
    }
    if (db.canCancelIssue(user, issue)) parts.push(cancelBtnHtml);
    box.innerHTML = parts.join('');
    wireCancel();

    box.querySelector('#btn-confirm-assignee')?.addEventListener('click', () => {
        run('', () => db.confirmIssueAssignee(issue.id, user),
            `담당자확인 되었습니다. 상태가 '${ISSUE_STATE.DOING}'(으)로 변경됩니다.`);
    });
    box.querySelector('#btn-close-req')?.addEventListener('click', () => {
        run('이 이슈의 종결을 요청할까요? 등록자 쪽의 승인 후 종결완료됩니다.',
            () => db.requestIssueClose(issue.id, user), '종결요청 되었습니다.');
    });
    box.querySelector('#btn-close-approve')?.addEventListener('click', () => {
        run('이 이슈를 종결승인 할까요? 승인하면 종결완료되고 종결일자가 기록됩니다.',
            () => db.approveIssueClose(issue.id, user), '종결승인 되었습니다.');
    });
}

function drawTable(root, rows, user, reload, tabKey) {
    const tbl = root.querySelector('#tbl');
    tbl.classList.toggle('grid--mobile', isMobile());
    if (!rows.length) {
        tbl.innerHTML = '<tbody><tr><td class="empty">등록된 이슈가 없습니다.</td></tr></tbody>';
        return;
    }

    // 앱 화면은 좁아서 연번·등록일자(월/일)·유형·제목만 보여주고 상세는 팝업으로 연다
    if (isMobile()) {
        tbl.innerHTML = `
<thead><tr>
  <th class="num">연번</th><th>등록일자</th><th class="center">업무구분</th><th>제목</th>
</tr></thead>
<tbody>
${rows.map((i, idx) => `
<tr class="is-clickable" data-view="${i.id}">
  <td class="num">${rows.length - idx}</td>
  <td>${monthDay(i.created_at)}</td>
  <td class="center"><span class="tag">${esc(i.type)}</span></td>
  <td class="wrap">${i.auto_created ? '<span class="tag tag--amber">자동등록</span> ' : ''}<span
      class="link">${esc(i.title)}</span></td>
</tr>`).join('')}
</tbody>`;
        bindDetail(tbl, rows, user, reload);
        return;
    }

    // 완료·취소 탭은 절차 칩 대신 상태 배지 하나만, 마지막 컬럼은 탭에 맞는 날짜를 보여준다
    const statusCell = (i) => (tabKey === 'main'
        ? issueFlow(i)
        : `<span class="tag tag--lg ${tabKey === 'done' ? 'tag--green' : 'tag--red'}">
            ${esc(i.status)}</span>`);
    const dateLabel = tabKey === 'canceled' ? '취소일자' : '종결일자';
    const dateField = tabKey === 'canceled' ? 'canceled_at' : 'closed_at';
    const statusWidth = tabKey === 'main' ? 420 : 96;

    // 제목이 가장 넓게 남도록 나머지 컬럼은 고정 폭으로 좁게 잡는다
    tbl.innerHTML = `
<thead><tr>
  <th class="num" style="width:44px">연번</th>
  <th style="width:88px">등록일자</th>
  <th class="center" style="width:76px">업무유형</th>
  <th class="center" style="width:88px">업무구분</th>
  <th style="width:110px">관련주문번호</th>
  <th>제목</th>
  <th style="width:96px">등록자</th>
  <th class="center" style="width:${statusWidth}px">상태</th>
  <th class="center" style="width:88px">${dateLabel}</th>
</tr></thead>
<tbody>
${rows.map((i, idx) => `
<tr>
  <td class="num">${rows.length - idx}</td>
  <td>${toDateStr(new Date(i.created_at))}</td>
  <td class="center"><span class="tag tag--lg">${esc(i.work_type || '-')}</span></td>
  <td class="center"><span class="tag tag--lg">${esc(i.type)}</span></td>
  <td>${esc(i.order_no || '-')}</td>
  <td class="wrap">${i.auto_created ? '<span class="tag tag--amber">자동등록</span> ' : ''}<span
      class="link" data-view="${i.id}">${esc(i.title)}</span></td>
  <td>${esc(i.creator_name || '-')}</td>
  <td class="center">${statusCell(i)}</td>
  <td class="center">${i[dateField] ? toDateStr(new Date(i[dateField])) : '-'}</td>
</tr>`).join('')}
</tbody>`;

    bindDetail(tbl, rows, user, reload);
}

/**
 * 상세 팝업의 댓글 영역.
 * parent_id 로 대댓글이 이어지고, 깊이만큼 들여쓴다.
 * 수정·삭제는 작성자 본인만 보인다. 답글 달린 댓글을 지우면 '삭제된 댓글' 로 남는다.
 */
function initComments(m, issue, user) {
    const list = m.body.querySelector('#comment-list');

    /** 답글/수정 입력칸 공통 마크업 */
    const editorHtml = (value, saveLabel) => `
<div class="comment-new">
  <textarea rows="2">${esc(value)}</textarea>
  <button class="btn btn--sm" data-cancel type="button">취소</button>
  <button class="btn btn--primary btn--sm" data-save type="button">${saveLabel}</button>
</div>`;

    async function draw() {
        const all = await db.listIssueComments(issue.id);
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
    <button class="btn btn--sm" data-reply="${esc(c.id)}" type="button">답글</button>
    ${c.created_by === user.id ? `
    <button class="btn btn--sm" data-edit="${esc(c.id)}" type="button">수정</button>
    <button class="btn btn--sm" data-del="${esc(c.id)}" type="button">삭제</button>` : ''}
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

    m.body.querySelector('#btn-comment-add').addEventListener('click', async () => {
        const ta = m.body.querySelector('#new-comment');
        try {
            await db.addIssueComment(issue.id, null, ta.value, user);
            ta.value = '';
            await draw();
        } catch (err) {
            toast(err.message, 'error');
        }
    });

    draw();
}

/** 이슈 등록 폼 */
function openForm(user, reload) {
    const due = new Date();
    due.setDate(due.getDate() + 1);
    const m = openModal('이슈 등록', `
<form id="issue-form">
  <div class="form-grid">
    <label class="field">
      <span class="field__label">업무유형 *</span>
      <select name="work_type" required>
        ${ISSUE_WORK_TYPES.map((t) => `<option value="${t}">${t}</option>`).join('')}
      </select>
    </label>
    <label class="field">
      <span class="field__label">업무구분 *</span>
      <select name="type" required>
        ${ISSUE_TYPES.map((t) => `<option value="${t}">${t}</option>`).join('')}
      </select>
    </label>
    <label class="field full">
      <span class="field__label">확인요청일 *</span>
      <input type="date" name="due_date" required value="${toDateStr(due)}">
    </label>
    <label class="field full">
      <span class="field__label">관련 주문번호</span>
      <input type="text" name="order_no" placeholder="선택 입력">
    </label>
    <label class="field full">
      <span class="field__label">제목 *</span>
      <input type="text" name="title" required>
    </label>
    <label class="field full">
      <span class="field__label">내용 *</span>
      <textarea name="content" required></textarea>
    </label>
  </div>
  <div class="form-actions">
    <button class="btn" type="button" id="btn-cancel">취소</button>
    <button class="btn btn--primary" type="submit">등록</button>
  </div>
</form>`, { wide: true });

    m.body.querySelector('#btn-cancel').addEventListener('click', m.close);
    m.body.querySelector('#issue-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
            await db.createIssue(Object.fromEntries(new FormData(e.target)), user);
            m.close();
            toast('이슈가 등록되었습니다.', 'success');
            reload();
        } catch (err) {
            toast(err.message, 'error');
        }
    });
}
