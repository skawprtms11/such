/** 이슈등록 화면 - 주문 관련 이슈를 게시판 형태로 등록/관리한다 */
import { ISSUE_TYPES, ISSUE_STATUS } from '../config.js';
import { can } from '../auth.js';
import * as db from '../db.js';
import {
    esc, num, today, downloadCsv, toast, openModal, fmtDateTime, toDateStr,
} from '../util.js';

const filter = { status: '', keyword: '' };

/** 모바일 여부 - CSS 의 반응형 기준점(860px)과 같은 값을 쓴다 */
const MOBILE_QUERY = '(max-width: 860px)';

function isMobile() {
    return window.matchMedia(MOBILE_QUERY).matches;
}

/** 열려 있는 팝업 - 화면을 떠날 때 함께 닫는다 */
let openedModal = null;

/** 등록일자를 월/일로 줄인다 (모바일 목록용) */
function monthDay(iso) {
    const [, m, d] = String(iso).slice(0, 10).split('-');
    return m && d ? `${m}/${d}` : '-';
}

export async function render(root, { user }) {
    root.innerHTML = `
<div id="summary" class="summary"></div>

<div class="card">
  <div class="card__head">
    <h2>이슈 등록 내역</h2>
    <span class="tag tag--gray" id="row-count"></span>
    <div class="toolbar__spacer"></div>
    <div class="btn-row" id="head-actions"></div>
  </div>
  <div class="card__body">
    <div class="toolbar">
      <label class="field" style="flex:0 0 110px;max-width:110px">
        <span class="field__label">상태</span>
        <select id="f-status">
          <option value="">전체</option>
          ${ISSUE_STATUS.map((s) => `<option value="${s}">${s}</option>`).join('')}
        </select>
      </label>
      <label class="field" style="flex:1 1 130px;max-width:220px">
        <span class="field__label">제목 / 주문번호</span>
        <input type="text" id="f-kw" placeholder="검색어 입력">
      </label>
      <button class="btn" id="btn-search" type="button">조회</button>
    </div>
    <div class="table-wrap"><table class="grid" id="tbl"></table></div>
  </div>
</div>`;

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
        rows = await db.listIssues({
            ...filter,
            createdBy: can(user, 'viewAll') ? undefined : user.id,
        });
        drawSummary(root, rows);
        drawTable(root, rows, user, reload);
        root.querySelector('#row-count').textContent = `${num(rows.length)}건`;
    }

    root.querySelector('#btn-search').addEventListener('click', () => {
        filter.status = root.querySelector('#f-status').value;
        filter.keyword = root.querySelector('#f-kw').value;
        reload();
    });

    root.querySelector('#f-kw').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') root.querySelector('#btn-search').click();
    });

    function downloadRows() {
        downloadCsv(`이슈내역_${today()}.csv`,
            ['등록일자', '유형', '제목', '주문번호', '확인요청일', '상태', '내용'],
            rows.map((i) => [
                fmtDateTime(i.created_at), i.type, i.title, i.order_no ?? '',
                i.due_date, i.status, i.content,
            ]));
    }

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

function drawSummary(root, rows) {
    const count = (s) => rows.filter((i) => i.status === s).length;
    root.querySelector('#summary').innerHTML = `
<div class="stat stat--accent">
  <div class="stat__label">전체 이슈</div>
  <div class="stat__value">${num(rows.length)}<small>건</small></div>
</div>
<div class="stat">
  <div class="stat__label">접수</div>
  <div class="stat__value">${num(count('접수'))}<small>건</small></div>
</div>
<div class="stat">
  <div class="stat__label">확인중</div>
  <div class="stat__value">${num(count('확인중'))}<small>건</small></div>
</div>
<div class="stat">
  <div class="stat__label">종결</div>
  <div class="stat__value">${num(count('종결'))}<small>건</small></div>
</div>`;
}

function statusTag(s) {
    const cls = s === '종결' ? 'tag--green' : s === '확인중' ? 'tag--amber' : 'tag--blue';
    return `<span class="tag ${cls}">${s}</span>`;
}

/** 상세 팝업 - 목록의 행(또는 제목)을 누르면 열린다 */
function bindDetail(scope, rows) {
    scope.querySelectorAll('[data-view]').forEach((el) => {
        el.addEventListener('click', () => {
            const issue = rows.find((i) => i.id === el.dataset.view);
            if (!issue) return;
            openedModal?.close();
            openedModal = openModal(issue.title, `
<table class="grid"><tbody>
  <tr><th>유형</th><td>${esc(issue.type)}</td></tr>
  <tr><th>주문번호</th><td>${esc(issue.order_no ?? '-')}</td></tr>
  <tr><th>확인요청일</th><td>${esc(issue.due_date)}</td></tr>
  <tr><th>상태</th><td>${statusTag(issue.status)}</td></tr>
  <tr><th>등록일시</th><td>${fmtDateTime(issue.created_at)}</td></tr>
</tbody></table>
<p style="white-space:pre-wrap;margin-top:14px">${esc(issue.content)}</p>`);
        });
    });
}

function drawTable(root, rows, user, reload) {
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
  <th class="num">연번</th><th>등록일자</th><th class="center">유형</th><th>제목</th>
</tr></thead>
<tbody>
${rows.map((i, idx) => `
<tr class="is-clickable" data-view="${i.id}">
  <td class="num">${rows.length - idx}</td>
  <td>${monthDay(i.created_at)}</td>
  <td class="center"><span class="tag">${esc(i.type)}</span></td>
  <td class="wrap"><span class="link">${esc(i.title)}</span></td>
</tr>`).join('')}
</tbody>`;
        bindDetail(tbl, rows);
        return;
    }

    tbl.innerHTML = `
<thead><tr>
  <th class="num">연번</th><th>등록일자</th><th class="center">유형</th><th>제목</th>
  <th>확인요청일</th><th class="center">상태</th><th class="center">관리</th>
</tr></thead>
<tbody>
${rows.map((i, idx) => `
<tr>
  <td class="num">${rows.length - idx}</td>
  <td>${fmtDateTime(i.created_at)}</td>
  <td class="center"><span class="tag">${esc(i.type)}</span></td>
  <td><span class="link" data-view="${i.id}">${esc(i.title)}</span></td>
  <td>${i.due_date}</td>
  <td class="center">${statusTag(i.status)}</td>
  <td class="center">
    ${(can(user, 'updateStatus') && can(user, 'createIssue')) || can(user, 'manageUsers') ? `
    <select class="btn btn--sm" data-status="${i.id}" style="min-width:88px">
      ${ISSUE_STATUS.map((s) => `
      <option value="${s}" ${i.status === s ? 'selected' : ''}>${s}</option>`).join('')}
    </select>` : '-'}
  </td>
</tr>`).join('')}
</tbody>`;

    bindDetail(tbl, rows);

    tbl.querySelectorAll('[data-status]').forEach((el) => {
        el.addEventListener('change', async () => {
            await db.updateIssue(el.dataset.status, { status: el.value });
            toast('상태가 변경되었습니다.', 'success');
            reload();
        });
    });
}

/** 이슈 등록 폼 */
function openForm(user, reload) {
    const due = new Date();
    due.setDate(due.getDate() + 1);
    const m = openModal('이슈 등록', `
<form id="issue-form">
  <div class="form-grid">
    <label class="field">
      <span class="field__label">유형 *</span>
      <select name="type" required>
        ${ISSUE_TYPES.map((t) => `<option value="${t}">${t}</option>`).join('')}
      </select>
    </label>
    <label class="field">
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
        await db.createIssue(Object.fromEntries(new FormData(e.target)), user);
        m.close();
        toast('이슈가 등록되었습니다.', 'success');
        reload();
    });
}
