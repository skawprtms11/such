/**
 * 주문처리현황 화면.
 * 각 화면의 처리 결과가 반영된 단계를 화살표로 보여준다. 단계를 이 화면에서 바꾸지는 않는다.
 *
 * 탭은 세 가지다.
 *   현재진행 - 완료처리도 취소도 되지 않은 주문 (기간 제한 없이 전부)
 *   출고완료 - 용마담당자가 완료처리한 주문 (완료처리한 달 기준)
 *   출고취소 - 주문정보등록에서 취소된 주문 (취소한 달 기준)
 */
import { can } from '../auth.js';
import { code128Svg } from '../barcode.js';
import * as db from '../db.js';
import { visibleSteps, stepRate, currentStep, stepsFlowHtml, loadDone } from '../steps.js';
import {
    esc, num, today, fmtDateTime, downloadCsv, toast, openModal, confirmDialog, isMobile,
    seqTag, MOBILE_QUERY,
} from '../util.js';

/** 탭 정의 */
const TABS = [
    { key: 'active', label: '현재진행' },
    { key: 'done', label: '출고완료' },
    { key: 'canceled', label: '출고취소' },
];

/** 현재 선택된 탭 (다른 메뉴에 갔다 와도 유지된다) */
let activeTab = 'active';

/** 이번 달 (YYYY-MM) */
function thisMonth() {
    return today().slice(0, 7);
}

/**
 * 탭별 조회 조건.
 * 현재진행은 기간을 보지 않고, 나머지 두 탭은 월 또는 상세검색 기간으로 좁힌다.
 */
const search = {
    active: { keyword: '' },
    done: { keyword: '', month: thisMonth(), detail: null },
    canceled: { keyword: '', month: thisMonth(), detail: null },
};

/** 열려 있는 팝업 - 화면을 떠날 때 함께 닫는다 */
let openedModal = null;

/** 단계 계산에 넘길 조건 값 */
function stepOpt(o, tasks, adjust) {
    return { task: Boolean(tasks[o.order_no]), adjust: adjust[o.id] };
}

export async function render(root, { user }) {
    // 완료처리 권한 (주문처리현황은 그 밖에는 조회 전용이다)
    const editable = can(user, 'closeOrder');

    root.innerHTML = `
<div class="tabs" id="tabs">
  ${TABS.map((t) => `
  <button class="tabs__btn ${t.key === activeTab ? 'is-active' : ''}"
          data-tab="${t.key}" type="button">${t.label}</button>`).join('')}
</div>

<div id="summary" class="summary"></div>

<div class="card">
  <div class="card__head">
    <h2 id="card-title"></h2>
    <span class="tag tag--gray" id="row-count"></span>
    <div class="toolbar__spacer"></div>
    <div class="btn-row" id="head-actions"></div>
  </div>
  <div class="card__body">
    <div class="toolbar" id="filters"></div>
    <p class="field__label" style="margin:0 0 8px" id="note"></p>
    <div class="table-wrap"><table class="grid" id="tbl"></table></div>
  </div>
</div>`;

    let rows = [];

    /** 현재 탭의 조회 조건 */
    const cur = () => search[activeTab];

    /** 상단 버튼 (상세검색 · 다운로드) */
    function drawHeadActions() {
        const parts = [];
        if (activeTab !== 'active') {
            parts.push('<button class="btn btn--sm" id="btn-detail" type="button">상세검색</button>');
        }
        // 다운로드는 웹에서만 쓴다 (모바일은 상단을 비워 목록에 자리를 준다)
        if (can(user, 'download') && !isMobile()) {
            parts.push('<button class="btn btn--sm" id="btn-csv" type="button">다운로드</button>');
        }
        root.querySelector('#head-actions').innerHTML = parts.join('');
        root.querySelector('#btn-detail')?.addEventListener('click', openSearchModal);
        root.querySelector('#btn-csv')?.addEventListener('click', downloadRows);
    }

    /** 탭별 필터 줄 */
    function drawFilters() {
        const s = cur();
        const monthBox = activeTab === 'active' ? '' : `
      <label class="field" style="flex:1 1 180px;max-width:220px">
        <span class="field__label">조회 월</span>
        <input type="month" id="f-month" value="${s.month}" ${s.detail ? 'disabled' : ''}>
      </label>`;

        root.querySelector('#filters').innerHTML = `
${monthBox}
      <label class="field" style="flex:1 1 180px;max-width:220px">
        <span class="field__label">주문번호 / 거래처명</span>
        <input type="text" id="f-kw" placeholder="검색어 입력" value="${esc(s.keyword)}">
      </label>
      <button class="btn" id="btn-search" type="button">조회</button>
      ${s.detail ? `
      <div class="toolbar__spacer"></div>
      <span class="tag tag--amber">상세검색 적용중</span>
      <button class="btn btn--sm" id="btn-clear-detail" type="button">해제</button>` : ''}`;

        root.querySelector('#btn-search').addEventListener('click', () => {
            s.keyword = root.querySelector('#f-kw').value;
            const m = root.querySelector('#f-month');
            if (m) s.month = m.value;
            reload();
        });
        root.querySelector('#f-kw').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') root.querySelector('#btn-search').click();
        });
        root.querySelector('#btn-clear-detail')?.addEventListener('click', () => {
            s.detail = null;
            drawFilters();
            reload();
        });
    }

    /** 상세검색 팝업 - 주문번호 · 제목 · 내용 · 출고요청일 기간 */
    function openSearchModal() {
        const d = cur().detail ?? { orderNo: '', title: '', content: '', from: '', to: '' };
        openedModal?.close();
        openedModal = openModal('상세검색', `
<div class="form-grid">
  <label class="field">
    <span class="field__label">주문번호</span>
    <input type="text" id="s-no" value="${esc(d.orderNo)}" placeholder="PO-00000000">
  </label>
  <label class="field">
    <span class="field__label">제목</span>
    <input type="text" id="s-title" value="${esc(d.title)}" placeholder="요청사항 · 이슈 제목">
  </label>
  <label class="field full">
    <span class="field__label">내용</span>
    <input type="text" id="s-content" value="${esc(d.content)}"
           placeholder="비고 · 이슈 내용 · 조정요청 사유">
  </label>
  <label class="field">
    <span class="field__label">출고요청일 (시작)</span>
    <input type="date" id="s-from" value="${d.from}">
  </label>
  <label class="field">
    <span class="field__label">출고요청일 (종료)</span>
    <input type="date" id="s-to" value="${d.to}">
  </label>
</div>
<p class="form-note">
  기간을 넣으면 조회 월 대신 그 기간으로 찾습니다.
  제목·내용은 주문의 요청사항·비고와 그 주문번호로 등록된 이슈·조정요청 본문까지 함께 봅니다.
</p>`, {
            footer: `
<button class="btn" id="s-reset" type="button">초기화</button>
<div class="btn-row">
  <button class="btn btn--primary" id="s-apply" type="button">검색</button>
</div>`,
        });

        const m = openedModal;
        m.root.querySelector('#s-apply').addEventListener('click', () => {
            const v = {
                orderNo: m.root.querySelector('#s-no').value.trim(),
                title: m.root.querySelector('#s-title').value.trim(),
                content: m.root.querySelector('#s-content').value.trim(),
                from: m.root.querySelector('#s-from').value,
                to: m.root.querySelector('#s-to').value,
            };
            cur().detail = Object.values(v).some(Boolean) ? v : null;
            m.close();
            openedModal = null;
            drawFilters();
            reload();
        });
        m.root.querySelector('#s-reset').addEventListener('click', () => {
            cur().detail = null;
            m.close();
            openedModal = null;
            drawFilters();
            reload();
        });
    }

    /** 목록 조회 후 요약·표 갱신 */
    async function reload() {
        const s = cur();
        const all = await db.listOrders({
            keyword: s.keyword,
            createdBy: can(user, 'viewAll') ? undefined : user.id,
        });
        const [tasks, adjust, labels] = await Promise.all([
            db.extraTaskMap(), db.adjustMap(), labelGroups(user),
        ]);
        const text = s.detail && (s.detail.title || s.detail.content) ? await textIndex() : null;

        rows = all.filter((o) => inTab(o, activeTab))
            .filter((o) => inPeriod(o, activeTab, s))
            .filter((o) => matchDetail(o, s.detail, text));

        root.querySelector('#card-title').textContent =
            `${TABS.find((t) => t.key === activeTab).label} 주문`;
        const note = root.querySelector('#note');
        note.textContent = isMobile() ? '' : NOTE[activeTab];
        note.hidden = isMobile();
        root.querySelector('#row-count').textContent = `${num(rows.length)}건`;
        drawSummary(root, rows, tasks, adjust);
        drawTable(root, rows, tasks, adjust, { user, editable, reload, labels });
    }

    /** CSV 다운로드 - 현재 탭에 보이는 행만 */
    async function downloadRows() {
        const [taskMap, adjustMap] = await Promise.all([db.extraTaskMap(), db.adjustMap()]);
        const label = TABS.find((t) => t.key === activeTab).label;
        downloadCsv(`주문처리현황_${label}_${today()}.csv`,
            ['연번', '전송일자', '차수', '대표주문번호', '주문번호', '거래처명', '출고요청일',
                '처리현황', '진행률', '파렛트수', '박스수', '완료처리'],
            rows.map((o, i) => [
                i + 1, o.send_date, `${o.seq}차수`, o.rep_no ?? '', o.order_no, o.customer,
                o.ship_req_date,
                currentStep(o, stepOpt(o, taskMap, adjustMap)),
                `${stepRate(o, stepOpt(o, taskMap, adjustMap))}%`,
                o.pallet_count, o.box_count,
                o.closed_at ? fmtDateTime(o.closed_at) : '',
            ]));
    }

    /** 탭 전환 */
    function openTab(key) {
        activeTab = key;
        root.querySelectorAll('[data-tab]').forEach((el) => {
            el.classList.toggle('is-active', el.dataset.tab === key);
        });
        drawHeadActions();
        drawFilters();
        reload();
    }

    root.querySelectorAll('[data-tab]').forEach((el) => {
        el.addEventListener('click', () => openTab(el.dataset.tab));
    });

    // 창 크기가 기준점을 넘나들면 표 구성이 달라지므로 다시 그린다
    const mq = window.matchMedia(MOBILE_QUERY);
    const onResize = () => {
        drawHeadActions();
        reload();
    };
    mq.addEventListener('change', onResize);

    drawHeadActions();
    drawFilters();
    await reload();

    const unwatch = db.subscribe(reload);
    return () => {
        mq.removeEventListener('change', onResize);
        unwatch();
        openedModal?.close();
        openedModal = null;
    };
}

/* --------------------------------- 조회 조건 -------------------------------- */

/** 탭별 안내 문구 */
const NOTE = {
    active: '처리현황은 각 화면의 처리 결과에 따라 자동으로 갱신됩니다.'
        + ' (접수 → 주문정보등록 / 출고·검수·조정 → 출고주문처리 / 상차작업 → 당일상차리스트)',
    done: '상차작업까지 끝난 뒤 용마담당자가 완료처리한 주문입니다.',
    canceled: '주문정보등록에서 취소된 주문입니다.',
};

/** 이 주문이 그 탭에 속하는지 */
function inTab(o, tab) {
    if (tab === 'canceled') return Boolean(o.canceled_at);
    if (tab === 'done') return Boolean(o.closed_at) && !o.canceled_at;
    return !o.closed_at && !o.canceled_at;
}

/**
 * 기간 조건.
 * 현재진행은 기간을 보지 않는다. 나머지는 상세검색 기간이 있으면 출고요청일로,
 * 없으면 완료처리·취소한 달로 좁힌다.
 */
function inPeriod(o, tab, s) {
    if (tab === 'active') return true;
    const d = s.detail;
    if (d && (d.from || d.to)) {
        if (d.from && o.ship_req_date < d.from) return false;
        if (d.to && o.ship_req_date > d.to) return false;
        return true;
    }
    if (d) return true;                     // 기간 없이 본문만 검색하는 경우
    if (!s.month) return true;
    const at = tab === 'canceled' ? o.canceled_at : o.closed_at;
    return String(at).slice(0, 7) === s.month;
}

/** 주문번호·제목·내용 조건 */
function matchDetail(o, d, text) {
    if (!d) return true;
    if (d.orderNo && !hit(o.order_no, d.orderNo)) return false;
    if (d.title && !hit(`${o.request_note} ${text?.title[o.order_no] ?? ''}`, d.title)) {
        return false;
    }
    const content = `${o.remark} ${text?.content[o.order_no] ?? ''} ${text?.byId[o.id] ?? ''}`;
    if (d.content && !hit(content, d.content)) return false;
    return true;
}

function hit(haystack, needle) {
    return String(haystack).toLowerCase().includes(String(needle).toLowerCase());
}

/**
 * 상세검색용 본문 색인.
 * 주문에는 제목·내용 필드가 없어 이슈와 조정요청 본문을 주문번호로 이어 붙인다.
 */
async function textIndex() {
    const [issues, restores] = await Promise.all([db.listIssues(), db.listAllRestores()]);
    const idx = { title: {}, content: {}, byId: {} };
    issues.forEach((i) => {
        if (!i.order_no) return;
        idx.title[i.order_no] = `${idx.title[i.order_no] ?? ''} ${i.title}`;
        idx.content[i.order_no] = `${idx.content[i.order_no] ?? ''} ${i.content}`;
    });
    restores.forEach((r) => {
        idx.byId[r.order_id] = `${idx.byId[r.order_id] ?? ''} ${r.reason ?? ''}`;
    });
    return idx;
}

/* ----------------------------------- 요약 ----------------------------------- */

/** 상단 요약 - 주문건수 / 품목수 / 출고수량 / 진행률 */
function drawSummary(root, rows, tasks = {}, adjust = {}) {
    const sum = (k) => rows.reduce((a, o) => a + Number(o[k] || 0), 0);
    const rates = rows.map((o) => stepRate(o, stepOpt(o, tasks, adjust)));
    const pct = rates.length
        ? Math.round(rates.reduce((a, b) => a + b, 0) / rates.length) : 0;
    root.querySelector('#summary').innerHTML = `
<div class="stat stat--accent">
  <div class="stat__label">주문건수</div>
  <div class="stat__value">${num(rows.length)}<small>건</small></div>
</div>
<div class="stat">
  <div class="stat__label">품목수</div>
  <div class="stat__value">${num(sum('item_count'))}<small>개</small></div>
</div>
<div class="stat">
  <div class="stat__label">출고수량</div>
  <div class="stat__value">${num(sum('qty'))}<small>ea</small></div>
</div>
<div class="stat">
  <div class="stat__label">진행률</div>
  <div class="stat__value">${pct}<small>%</small></div>
  <div class="bar"><div class="bar__fill ${pct === 100 ? 'bar__fill--done' : ''}"
       style="width:${pct}%"></div></div>
</div>`;
}

/* ------------------------------------ 표 ------------------------------------ */

function drawTable(root, rows, tasks, adjust, ctx) {
    const tbl = root.querySelector('#tbl');
    tbl.classList.toggle('grid--mobile', isMobile());
    if (!rows.length) {
        tbl.innerHTML = '<tbody><tr><td class="empty">조회된 주문이 없습니다.</td></tr></tbody>';
        return;
    }

    if (isMobile()) {
        tbl.innerHTML = mobileTable(rows, tasks, adjust);
        tbl.querySelectorAll('[data-detail]').forEach((el) => {
            el.addEventListener('click', () => {
                const o = rows.find((r) => r.id === el.dataset.detail);
                if (o) openDetail(o, stepOpt(o, tasks, adjust), ctx);
            });
        });
        return;
    }

    tbl.innerHTML = `
<thead><tr>
  <th class="num">연번</th><th>전송일자</th><th class="center">차수</th><th>주문번호</th>
  <th>거래처명</th><th>처리현황</th><th class="num">진행률</th>
  <th class="num">파렛트수</th><th>출고요청일</th><th class="center">상차라벨출력</th>
  <th class="center">${activeTab === 'canceled' ? '취소일시' : '완료처리'}</th>
</tr></thead>
<tbody>
${rows.map((o, i) => {
        const opt = stepOpt(o, tasks, adjust);
        const steps = visibleSteps(o, opt);
        return `
<tr class="${o.canceled_at ? 'is-canceled' : ''}">
  <td class="num">${rows.length - i}</td>
  <td>${o.send_date}</td>
  <td class="center">${seqTag(o.seq)}</td>
  <td>${esc(o.order_no)}${repTag(o)}</td>
  <td>${esc(o.customer)}</td>
  <td>
    <div class="steps steps--flow">${stepsFlowHtml(steps, fmtDateTime)}</div>
  </td>
  <td class="num">${stepRate(o, opt)}%</td>
  <td class="num">${o.pallet_count ? num(o.pallet_count) : '<span class="muted">-</span>'}</td>
  <td>${o.ship_req_date}</td>
  <td class="center">${labelCell(o, ctx.labels?.[o.id])}</td>
  <td class="center">${closeCell(o, ctx.editable)}</td>
</tr>`;
    }).join('')}
</tbody>`;

    bindCloseButtons(tbl, ctx);
    tbl.querySelectorAll('[data-label]').forEach((el) => {
        el.addEventListener('click', () => {
            const o = rows.find((x) => x.id === el.dataset.label);
            printLoadLabel(o, ctx.labels?.[el.dataset.label]);
        });
    });
}

/**
 * 모바일 표 - 좁은 화면에서 읽을 수 있는 만큼만 보여준다.
 * 처리현황은 단계 흐름 전체가 아니라 **마지막으로 끝난 단계 하나**만 표시한다.
 */
function mobileTable(rows, tasks, adjust) {
    return `
<thead><tr>
  <th>출고요청일</th><th>주문번호</th><th>거래처명</th>
  <th class="center">처리현황</th>
</tr></thead>
<tbody>
${rows.map((o) => `
<tr class="is-clickable ${o.canceled_at ? 'is-canceled' : ''}" data-detail="${o.id}">
  <td>${o.ship_req_date}</td>
  <td><span class="link">${esc(o.order_no)}</span>${repTag(o)}</td>
  <td class="wrap">${esc(o.customer)}</td>
  <td class="center">${lastStepTag(o, stepOpt(o, tasks, adjust))}</td>
</tr>`).join('')}
</tbody>`;
}

/** 마지막으로 완료된 단계 배지. 아무것도 끝나지 않았으면 '미착수' */
function lastStepTag(o, opt) {
    if (o.canceled_at) return '<span class="tag tag--red">취소</span>';
    if (o.closed_at) return '<span class="tag tag--green">출고완료</span>';
    const done = visibleSteps(o, opt).filter((s) => s.done);
    const last = done.at(-1);
    if (!last) return '<span class="tag tag--gray">미착수</span>';
    return `<span class="step is-done" title="${fmtDateTime(last.doneAt)}">${last.label}</span>`;
}

/* --------------------------------- 완료처리 --------------------------------- */

/**
 * 완료처리 셀.
 * 상차작업까지 끝난 건에만 버튼이 나오고, 처리 권한(용마담당자·관리자)이 있어야 누를 수 있다.
 */
function closeCell(o, editable) {
    if (o.canceled_at) return fmtDateTime(o.canceled_at);
    if (o.closed_at) {
        const cancelBtn = editable
            ? ` <button class="btn btn--sm" data-close="${o.id}" data-on="0" type="button">취소</button>`
            : '';
        return `<span class="tag tag--green" title="${fmtDateTime(o.closed_at)}">완료</span>${cancelBtn}`;
    }
    if (!loadDone(o)) {
        return '<span class="muted" title="상차작업까지 끝나야 완료처리할 수 있습니다">-</span>';
    }
    if (!editable) return '<span class="muted">-</span>';
    return `<button class="btn btn--success btn--sm" data-close="${o.id}" data-on="1"
        type="button">완료처리</button>`;
}

/** 완료처리 버튼 동작 (표와 상세 팝업이 함께 쓴다) */
function bindCloseButtons(scope, ctx) {
    scope.querySelectorAll('[data-close]').forEach((el) => {
        el.addEventListener('click', async () => {
            const on = el.dataset.on === '1';
            const msg = on ? '출고 완료처리 하시겠습니까?' : '완료처리를 취소하시겠습니까?';
            if (!await confirmDialog(msg)) return;
            try {
                await db.closeOrder(el.dataset.close, on, ctx.user);
                toast(on ? '완료처리 되었습니다.' : '완료처리를 취소했습니다.', 'success');
                openedModal?.close();
                openedModal = null;
                ctx.reload();
            } catch (err) {
                toast(err.message, 'error');
            }
        });
    });
}

/* --------------------------------- 상세 팝업 -------------------------------- */

/**
 * 주문 상세 - 모바일 표에서 뺀 항목까지 모두 보여준다.
 * 완료처리도 여기에서 할 수 있다 (모바일 표에는 완료처리 컬럼이 없다).
 */
function openDetail(o, opt, ctx) {
    const steps = visibleSteps(o, opt);
    const row = (label, value) => `<tr><th>${label}</th><td>${value}</td></tr>`;
    const dash = '<span class="muted">-</span>';
    openedModal?.close();
    openedModal = openModal(`${o.order_no} · ${o.seq}차수`, `
<table class="grid"><tbody>
  ${o.rep_no ? row('대표주문번호', `<b>${esc(o.rep_no)}</b>`) : ''}
  ${row('거래처명', esc(o.customer))}
  ${row('진행상태', o.canceled_at
        ? '<span class="tag tag--red">취소</span>'
        : o.closed_at
            ? '<span class="tag tag--green">출고완료</span>'
            : `<b>${stepRate(o, opt)}%</b> 진행`)}
  ${row('전송일자', o.send_date)}
  ${row('등록일자', o.reg_date)}
  ${row('출고요청일', `<b>${o.ship_req_date}</b>`)}
  ${row('출고형태', esc(o.vehicle_type))}
  ${row('요청작업', (o.extra_works ?? []).length
        ? o.extra_works.map((w) => `<span class="tag tag--blue">${esc(w)}</span>`).join(' ')
        : dash)}
  ${row('파렛트수', o.pallet_count ? `${num(o.pallet_count)} PLT` : dash)}
  ${row('박스수', o.box_count ? `${num(o.box_count)} 박스` : dash)}
  ${row('요청사항', o.request_note ? esc(o.request_note) : dash)}
  ${row('비고', o.remark ? esc(o.remark) : dash)}
</tbody></table>

<p class="field__label" style="margin:14px 0 6px">처리현황</p>
<div class="steps steps--flow">${stepsFlowHtml(steps, fmtDateTime)}</div>

<table class="grid" style="margin-top:14px"><tbody>
  ${steps.map((s) => row(s.label, s.doneAt ? fmtDateTime(s.doneAt) : dash)).join('')}
  ${o.closed_at ? row('출고완료', fmtDateTime(o.closed_at)) : ''}
  ${o.canceled_at ? row('출고취소', fmtDateTime(o.canceled_at)) : ''}
</tbody></table>`, {
        wide: true,
        footer: `<div class="btn-row">${closeCell(o, ctx.editable)}</div>`,
    });
    bindCloseButtons(openedModal.root, ctx);
}

/* --------------------------------- 상차라벨 --------------------------------- */

/** 목록에 붙는 대표주문번호 태그 */
function repTag(o) {
    return o.rep_no
        ? ` <span class="tag tag--amber" title="대표주문번호로 묶인 주문입니다">대표 ${esc(o.rep_no)}</span>`
        : '';
}

/**
 * 상차라벨용 묶음 정보 { 주문ID: {key, head, rows} }.
 * 라벨은 **상차 묶음 단위**로 찍는다 (대표주문번호 · 추가주문 차수 · 묶음 총 파렛트수).
 * 묶인 주문이 조회 조건에서 빠질 수 있어 목록이 아니라 전체 주문으로 만든다.
 */
async function labelGroups(user) {
    const all = await db.listOrders({
        createdBy: can(user, 'viewAll') ? undefined : user.id,
    });
    const map = {};
    db.loadGroups(all.filter((o) => !o.canceled_at)).forEach((g) => {
        g.rows.forEach((o) => { map[o.id] = g; });
    });
    return map;
}

/** 라벨에 찍을 총 파렛트수 - 대표주문번호로 묶였으면 묶음 총량이다 */
function labelTotal(o, g) {
    return o.rep_no ? (g?.head?.pallet_count ?? 0) : o.pallet_count;
}

/**
 * 상차라벨 출력 셀.
 * 검수작업에서 파렛트수를 입력한 뒤에만 출력할 수 있다 (라벨에 총 파렛트수가 들어간다).
 * 🔑 대표주문번호로 묶인 주문은 **대표 행에서만** 출력한다.
 *    멤버 행마다 버튼을 두면 같은 라벨을 묶음 건수만큼 인쇄하게 된다.
 */
function labelCell(o, g) {
    if (o.rep_no && g?.head && g.head.id !== o.id) {
        return `<span class="muted" title="묶음 대표에서 한 번만 출력합니다">대표 ${
            esc(o.rep_no)} 에서 출력</span>`;
    }
    const total = labelTotal(o, g);
    // 추가건이 혼적(0파렛트)이면 파렛트가 없어도 라벨 1장분(앞뒤 2장)을 뽑는다
    const mixed = !total && o.seq > 1;
    if (!o.inspect_done_at || (!total && !mixed)) {
        return '<span class="muted" title="검수작업을 완료하면 출력할 수 있습니다">-</span>';
    }
    const sheets = labelPages(o, g).length;
    return `<button class="btn btn--sm" data-label="${o.id}" type="button"
        title="총 ${sheets}장 (${mixed ? '혼적' : `${total}파렛트`} × 앞뒤 2장)">출력</button>`;
}

/**
 * 상차라벨(A4)을 새 창에 그리고 인쇄 대화상자를 띄운다.
 * 파렛트에 부착하는 라벨이라 박스수는 현장에서 손으로 적도록 빈칸으로 둔다.
 */
function printLoadLabel(o, g) {
    if (!o) return;
    const win = window.open('', '_blank', 'width=820,height=1040');
    if (!win) {
        toast('팝업이 차단되었습니다. 팝업 허용 후 다시 시도하세요.', 'error');
        return;
    }
    win.document.write(labelHtml(o, g));
    win.document.close();
    win.focus();
}

/** 라벨 페이지 목록 - 파렛트 1장당 앞뒤 2매를 뽑는다 ('10/1' = 10장 중 1번째) */
function labelPages(o, g) {
    // 혼적 추가건은 파렛트가 없어도 라벨 1장분을 만든다
    const total = labelTotal(o, g) || (o.seq > 1 ? 1 : 0);
    const pages = [];
    for (let i = 1; i <= total; i += 1) pages.push(`${total}/${i}`, `${total}/${i}`);
    return pages;
}

/**
 * 상차라벨 치수 (mm). A4 세로 · @page margin 10mm 기준으로 계산한다.
 * 안쪽 폭 = 210 - 여백 20 - 라벨 테두리 1.6 - 라벨 안여백 14 ≈ 174
 */
const LABEL_BOX = {
    innerW: 174,     // 표가 쓸 수 있는 가로 폭
    thRatio: 0.26,   // 항목 열이 차지하는 비율
    // 정보 표시 영역 높이. 예전 표는 브라우저 실측 146mm 였고 여기에 15% 를 더한
    // 168mm 가 목표다. 테두리(1.5px × 7줄 ≈ 1.5mm)가 얹히므로 166.5 를 지정한다
    tableH: 166.5,
    // 행 수는 고정하지 않는다. 대표주문번호가 있으면 '묶인 주문' 행이 붙어 한 줄 늘어나고,
    // 이 높이를 행 수만큼 똑같이 나눠 갖는다 (labelHtml 참고)
    padV: 3,         // 셀 위아래 여백 (시인성 확보용, 줄이지 않는다)
    padH: 4,         // 셀 좌우 여백
};

/** 1pt 를 mm 로 환산한 값 */
const PT_MM = 0.3528;

/**
 * 칸에 들어가는 **가장 큰 글자 크기(pt)** 를 구한다.
 * 글자수와 칸 크기만으로 계산하므로 인쇄 전에 값이 정해진다.
 * 한 줄에 안 들어가면 두 줄까지 허용하고, 그 중 더 큰 쪽을 고른다.
 * @param {string} text 칸에 들어갈 글자
 * @param {number} boxW 여백을 뺀 칸의 가로 (mm)
 * @param {number} boxH 여백을 뺀 칸의 세로 (mm)
 * @param {number} maxPt 상한 (항목명이 값보다 커지지 않도록 막는다)
 */
function fitPt(text, boxW, boxH, maxPt) {
    const str = String(text ?? '');
    if (!str.trim()) return maxPt;
    // 한글·한자는 한 글자가 1em, 영문·숫자·기호는 대략 0.58em 을 차지한다
    const em = [...str].reduce(
        (w, ch) => w + (/[ㄱ-힝一-鿿]/.test(ch) ? 1 : 0.58), 0);
    // 1줄 / 2줄 각각에서 가능한 크기를 재고 더 큰 쪽을 쓴다.
    // 세로는 글꼴이 실제로 차지하는 높이(약 1.2em)로 잡아야 여백을 먹지 않는다
    const best = [1, 2].reduce((mx, lines) => Math.max(mx, Math.min(
        boxW / (em / lines),        // 가로가 허용하는 크기
        boxH / (lines * 1.2),       // 세로가 허용하는 크기 (줄간격 1.2)
    )), 0);
    return Math.max(9, Math.min(maxPt, Math.floor(best / PT_MM)));
}

/**
 * 상차라벨 A4 인쇄용 HTML (파렛트 수 × 2 페이지).
 * 🔑 대표주문번호가 있으면 **바코드·주문번호를 대표주문번호로 찍고**, 묶인 주문번호를 함께 적는다.
 * 파렛트수도 묶음 총량이라 묶음의 어느 주문에서 눌러도 같은 라벨이 나온다.
 */
function labelHtml(o, g) {
    const head = g?.head ?? o;
    const src = o.rep_no ? head : o;                       // 라벨에 찍을 주문
    const no = o.rep_no || o.order_no;                     // 바코드 · 주문번호 칸
    const members = o.rep_no ? (g?.rows ?? [o]).map((r) => r.order_no) : [];
    const total = labelTotal(o, g);
    const barcode = code128Svg(no, { height: 120, moduleWidth: 3, showText: false });
    // 항목명 · 값 · 값의 최대 글자 크기(pt)
    const lines = [
        ['출고일자', src.ship_req_date, 55],
        ['주문번호', no, 55],
        ...(members.length > 1 ? [['묶인 주문', members.join(', '), 22]] : []),
        ['거래처명', src.customer, 55],
        ['주문일자', src.reg_date, 55],
        ['총 파렛트수', total ? `${num(total)} PLT` : '기존차수에 혼적적재', 55],
        ['박스수', '', 55],
    ];
    const rowH = LABEL_BOX.tableH / lines.length;
    const boxH = rowH - LABEL_BOX.padV * 2;
    const thW = LABEL_BOX.innerW * LABEL_BOX.thRatio - LABEL_BOX.padH * 2;
    const tdW = LABEL_BOX.innerW * (1 - LABEL_BOX.thRatio) - LABEL_BOX.padH * 2;
    // 항목명은 20pt, 값은 칸 높이가 허용하는 만큼까지 키운다
    const row = (label, value, maxPt) => `
      <tr>
        <th style="font-size:${fitPt(label, thW, boxH, 20)}pt">${esc(label)}</th>
        <td style="font-size:${fitPt(value, tdW, boxH, maxPt)}pt">${esc(value)}</td>
      </tr>`;
    return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<title>상차라벨 ${esc(no)}</title>
<style>
  @page { size: A4 portrait; margin: 10mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0; color: #000; -webkit-print-color-adjust: exact; print-color-adjust: exact;
    font-family: 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif;
  }
  .label {
    border: 3px solid #000; padding: 7mm; height: 277mm;
    display: flex; flex-direction: column; page-break-after: always;
  }
  .label:last-child { page-break-after: auto; }
  /* 정보 표시 영역 - 전체 높이를 고정하고 6행이 똑같이 나눠 갖는다 */
  table {
    width: 100%; border-collapse: collapse; table-layout: fixed;
    height: ${LABEL_BOX.tableH}mm;
  }
  tr { height: ${rowH}mm; }
  th, td {
    border: 1.5px solid #000; height: ${rowH}mm; vertical-align: middle;
    padding: ${LABEL_BOX.padV}mm ${LABEL_BOX.padH}mm; overflow: hidden;
  }
  th {
    width: ${LABEL_BOX.thRatio * 100}%; background: #eee;
    text-align: left; font-weight: 700;
  }
  /* 글자 크기는 칸마다 글자수에 맞춰 계산해 style 로 직접 넣는다 (fitPt) */
  td { font-weight: 800; word-break: keep-all; line-height: 1.2; }
  /* 남는 높이는 바코드가 차지한다 */
  .barcode {
    flex: 1; display: flex; flex-direction: column;
    align-items: center; justify-content: center; padding: 3mm 0;
  }
  .barcode svg { width: 100%; height: auto; max-height: 48mm; }
  .barcode__no { margin-top: 3mm; font-family: monospace; font-size: 20pt; letter-spacing: 4px; }
  .seq { text-align: right; font-size: 14pt; font-weight: 700; }
  /* 추가건(2차수 이상)임을 라벨 오른쪽 위에 알린다 */
  .add-mark { text-align: right; font-size: 20pt; font-weight: 800; margin-bottom: 3mm; }
</style></head>
<body onload="window.print()">
${labelPages(o, g).map((page) => `
  <div class="label">
    ${!o.rep_no && o.seq > 1 ? `<div class="add-mark">추가건 - ${o.seq}차수</div>` : ''}
    <table>
      ${lines.map(([label, value, maxPt]) => row(label, value, maxPt)).join('')}
    </table>
    <div class="barcode">
      ${barcode}
      <div class="barcode__no">${esc(no)}</div>
    </div>
    <div class="seq">${page}</div>
  </div>`).join('')}
</body></html>`;
}
