/** 주문정보등록 화면 - 화주 영업사원이 출고 주문을 게시판 형태로 등록/수정한다 */
import {
    VEHICLE_TYPES, EXTRA_WORKS, PROGRESS, ORDER_POLICY, ADJUST_CATEGORIES, adjustCategory,
    RESTORE_TYPE, RESTORE_TYPE_LABEL, RESTORE_REASONS,
} from '../config.js';
import { can, allow } from '../auth.js';
import { currentStep } from '../steps.js';
import * as db from '../db.js';
import {
    esc, num, today, toDateStr, downloadCsv, toast, openModal, confirmDialog, fmtDateTime,
} from '../util.js';

/** 조회 필터 상태 */
const filter = { from: '', to: '', keyword: '' };

export async function render(root, { user }) {
    const monthAgo = new Date();
    monthAgo.setDate(monthAgo.getDate() - 30);
    filter.from = filter.from || toDateStr(monthAgo);
    filter.to = filter.to || today();

    root.innerHTML = `
<div class="card">
  <div class="card__head">
    <h2>주문 등록 내역</h2>
    <span class="tag tag--gray" id="row-count"></span>
    <div class="toolbar__spacer"></div>
    <div class="btn-row" id="head-actions"></div>
  </div>
  <div class="card__body">
    <div class="toolbar">
      <label class="field" style="max-width:150px">
        <span class="field__label">등록일 시작</span>
        <input type="date" id="f-from" value="${filter.from}">
      </label>
      <label class="field" style="max-width:150px">
        <span class="field__label">등록일 종료</span>
        <input type="date" id="f-to" value="${filter.to}">
      </label>
      <label class="field" style="max-width:220px">
        <span class="field__label">주문번호 / 거래처명</span>
        <input type="text" id="f-kw" placeholder="검색어 입력" value="${esc(filter.keyword)}">
      </label>
      <button class="btn" id="btn-search" type="button">조회</button>
    </div>
    <div class="table-wrap"><table class="grid" id="tbl"></table></div>
  </div>
</div>`;

    const actions = root.querySelector('#head-actions');
    if (can(user, 'download')) {
        actions.insertAdjacentHTML('beforeend',
            '<button class="btn btn--sm" id="btn-csv" type="button">다운로드</button>');
    }
    if (canWrite(user)) {
        actions.insertAdjacentHTML('beforeend',
            '<button class="btn btn--sm" id="btn-bulk" type="button">일괄등록</button>'
            + '<button class="btn btn--primary btn--sm" id="btn-new" type="button">주문 등록</button>');
    }

    let rows = [];

    /** 목록 조회 후 요약/표 갱신 */
    async function reload() {
        rows = await db.listOrders({
            ...filter,
            createdBy: can(user, 'viewAll') ? undefined : user.id,
        });
        const [stats, users] = await Promise.all([db.checkStats(), db.listUsers()]);
        // 담당자(등록자) 이름 조회용 맵
        const names = Object.fromEntries(users.map((u) => [u.id, u.name]));
        drawTable(root, rows, user, reload, stats, names);
        root.querySelector('#row-count').textContent = `${num(rows.length)}건`;
    }

    root.querySelector('#btn-search').addEventListener('click', () => {
        filter.from = root.querySelector('#f-from').value;
        filter.to = root.querySelector('#f-to').value;
        filter.keyword = root.querySelector('#f-kw').value;
        reload();
    });

    root.querySelector('#f-kw').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') root.querySelector('#btn-search').click();
    });

    root.querySelector('#btn-csv')?.addEventListener('click', async () => {
        const [counts, users] = await Promise.all([db.countRestores(), db.listUsers()]);
        const names = Object.fromEntries(users.map((u) => [u.id, u.name]));
        downloadCsv(`주문등록내역_${today()}.csv`,
            ['연번', '등록일자', '전송일자', '담당자', '차수', '주문번호', '거래처명', '추가작업',
                '요청사항', '출고요청일', '진행상태', '접수확인', '수정횟수', '조정요청',
                '차량구분', '품목수', '출고수량', '비고'],
            rows.map((o, i) => [
                i + 1, o.reg_date, o.send_date, names[o.created_by] ?? '',
                `${o.seq}차수`, o.order_no, o.customer,
                (o.extra_works ?? []).join(' / '),
                o.request_note, o.ship_req_date, progressOf(o),
                o.confirmed_at ? '접수확인' : '미확인',
                o.edit_count ? `${o.edit_count}회` : '',
                counts[o.id] ? `${counts[o.id]}건` : '',
                o.vehicle_type, o.item_count, o.qty, o.remark,
            ]));
    });

    root.querySelector('#btn-new')?.addEventListener('click', () => openForm(null, user, reload));
    root.querySelector('#btn-bulk')?.addEventListener('click', () => openBulkForm(user, reload));

    await reload();
    return db.subscribe(reload);
}

/**
 * 작성 권한 (등록·수정·조정요청).
 * 관리자·화주관리자는 항상, 그 외 역할은 소속이 고객사일 때만 가능하다.
 */
function canWrite(user) {
    return allow(user, ORDER_POLICY.write);
}

/**
 * 확인 권한 (확인 컬럼 체크, 이력의 확인처리).
 * 관리자·화주관리자는 항상, 그 외 역할은 소속이 용마로지스일 때만 가능하다.
 */
function canConfirm(user) {
    return allow(user, ORDER_POLICY.confirm);
}

/** 수정 가능 여부 - 상차완료 전까지만 수정할 수 있다 */
function canEdit(user, o) {
    return canWrite(user) && !o.loaded_at && !o.canceled_at;
}

/**
 * 조정요청 가능 여부 - 검수작업 완료 전까지만 요청할 수 있다.
 * 검수가 끝난 뒤에는 되돌릴 수 없으므로 이슈등록으로 처리한다.
 */
function canRestore(user, o) {
    return canWrite(user) && !o.inspect_done_at && !o.canceled_at;
}

const EMPTY_STAT = { edits: 0, editsLeft: 0, restores: 0, restoresLeft: 0 };

/**
 * 주문번호 우측 위에 붙는 건수 배지.
 * 수정 + 조정요청 합계를 보여주고, 확인처리가 남았는지에 따라 색이 달라진다.
 *   초록 : 모두 확인처리됨
 *   빨강 : 확인처리가 1건이라도 남음
 */
function countBadge(stat = EMPTY_STAT) {
    const st = stat ?? EMPTY_STAT;
    const total = st.edits + st.restores;
    if (!total) return '';
    const left = st.editsLeft + st.restoresLeft;
    const tip = `수정 ${st.edits}건 · 조정요청 ${st.restores}건`
        + (left ? ` · 미확인 ${left}건` : ' · 모두 확인');
    return `<sup class="cnt-badge ${left ? 'is-pending' : 'is-done'}"
        title="${esc(tip)}">${total}</sup>`;
}

/**
 * 확인 셀 - 접수 체크박스 하나.
 * 색으로 상태를 알린다.
 *   흰색   : 접수 전
 *   초록   : 접수 완료, 확인할 변경 없음
 *   빨강   : 접수 완료했지만 수정·조정 미확인이 남음 (이력에서 확인해야 한다)
 */
function confirmCell(user, o, stat = EMPTY_STAT) {
    const st = stat ?? EMPTY_STAT;
    const confirmed = Boolean(o.confirmed_at);
    const left = st.editsLeft + st.restoresLeft;
    // 취소된 주문은 더 이상 접수 처리를 바꾸지 않는다
    const active = canConfirm(user) && !o.canceled_at;

    let cls = '';
    let tip = '접수 확인 전';
    if (confirmed) {
        const by = o.confirmed_by_name ? ` · ${o.confirmed_by_name}` : '';
        cls = left ? 'is-alert' : 'is-on';
        tip = left
            ? `수정·조정 미확인 ${left}건 · 이력에서 확인하세요`
            : `${fmtDateTime(o.confirmed_at)}${by}`;
    }

    return `
<div class="chk-group">
  <label class="chk ${cls} ${active ? '' : 'is-readonly'}" title="${esc(tip)}">
    <input type="checkbox" data-confirm="${o.id}" ${confirmed ? 'checked' : ''}
           ${active ? '' : 'disabled'}>
    <span>접수</span>
  </label>
</div>`;
}

/**
 * 진행상태 셀.
 * 저장된 값이 아니라 주문 상태에서 계산한다.
 *   취소 > 완료(상차완료) > 진행(접수) > 대기
 */
function progressOf(o) {
    if (o.canceled_at) return PROGRESS.CANCELED;
    if (o.loaded_at) return PROGRESS.DONE;
    if (o.confirmed_at) return PROGRESS.DOING;
    return PROGRESS.WAIT;
}

function progressCell(o) {
    const p = progressOf(o);
    const cls = {
        [PROGRESS.WAIT]: 'tag--gray',
        [PROGRESS.DOING]: 'tag--blue',
        [PROGRESS.DONE]: 'tag--green',
        [PROGRESS.CANCELED]: 'tag--red tag--canceled',
    }[p];
    const tip = p === PROGRESS.CANCELED && o.canceled_at
        ? `${fmtDateTime(o.canceled_at)}${o.canceled_by_name ? ` · ${o.canceled_by_name}` : ''}`
        : '';
    return `<span class="tag ${cls}" title="${esc(tip)}">${p}</span>`;
}

/** 추가작업 태그 HTML */
function extraWorkTags(list) {
    if (!list || !list.length) return '<span class="muted">-</span>';
    return list.map((w) => `<span class="tag tag--blue">${esc(w)}</span>`).join(' ');
}

/** 게시판 형태 목록 렌더링 */
function drawTable(root, rows, user, reload, stats = {}, names = {}) {
    const tbl = root.querySelector('#tbl');
    if (!rows.length) {
        tbl.innerHTML = '<tbody><tr><td class="empty">조회된 주문이 없습니다.</td></tr></tbody>';
        return;
    }
    tbl.innerHTML = `
<thead><tr>
  <th class="num">연번</th><th>등록일자</th><th>전송일자</th>
  <th class="center">담당자</th><th class="center">차수</th>
  <th>주문번호</th><th>거래처명</th><th class="center">추가작업</th><th>요청사항</th>
  <th>출고요청일</th><th class="center">확인</th><th class="center">진행상태</th>
</tr></thead>
<tbody>
${rows.map((o, i) => `
<tr class="${o.canceled_at ? 'is-canceled' : ''}">
  <td class="num">${rows.length - i}</td>
  <td>${o.reg_date}</td>
  <td>${o.send_date}</td>
  <td class="center">${esc(names[o.created_by] ?? '-')}</td>
  <td class="center"><span class="seq ${o.seq > 1 ? 'seq--multi' : ''}">${o.seq}차수</span></td>
  <td>
    <span class="link" data-detail="${o.id}">${esc(o.order_no)}</span>${countBadge(stats[o.id])}
  </td>
  <td>${esc(o.customer)}</td>
  <td class="center">${extraWorkTags(o.extra_works)}</td>
  <td class="wrap">${esc(o.request_note)}</td>
  <td>${o.ship_req_date}</td>
  <td class="center">${confirmCell(user, o, stats[o.id])}</td>
  <td class="center">${progressCell(o)}</td>
</tr>`).join('')}
</tbody>`;

    tbl.querySelectorAll('[data-detail]').forEach((el) => {
        el.addEventListener('click', () => showDetail(el.dataset.detail, user, reload));
    });
    tbl.querySelectorAll('[data-edit]').forEach((el) => {
        el.addEventListener('click', async () => {
            openForm(await db.getOrder(el.dataset.edit), user, reload);
        });
    });
    /** 확인 체크박스 바인딩 */
    const bindCheckbox = (attr, handler) => {
        tbl.querySelectorAll(`[${attr}]`).forEach((el) => {
            el.addEventListener('change', async () => {
                try {
                    await handler(el.dataset[attr.replace('data-', '')], el.checked);
                    reload();
                } catch (err) {
                    toast(err.message, 'error');
                    reload();
                }
            });
        });
    };

    bindCheckbox('data-confirm', async (id) => {
        const o = await db.toggleOrderConfirm(id, user);
        toast(o.confirmed_at ? '접수확인 처리되었습니다.' : '접수확인을 해제했습니다.',
            o.confirmed_at ? 'success' : 'info');
    });


}

/**
 * 항목별 수정 내역 HTML.
 * 가장 오래된 변경부터 순서대로 이전 → 이후 값을 보여준다.
 * @param {Array} logs 해당 항목의 이력 (오래된 순)
 */
function changeLog(logs) {
    const first = logs[0].before;
    return `
<div class="change-log">
  <div class="change-log__origin">
    <span class="change-log__tag">최초 내용</span>
    <b>${esc(first) || '<i class="muted">(없음)</i>'}</b>
  </div>
  ${logs.map((h) => `
  <div class="change-log__line">
    <span class="change-log__rev">${h.rev}회차</span>
    <span class="change-log__from">${esc(h.before) || '<i class="muted">(없음)</i>'}</span>
    <span class="change-log__arrow">→</span>
    <span class="change-log__to">${esc(h.after) || '<i class="muted">(없음)</i>'}</span>
    <span class="change-log__meta">
      ${fmtDateTime(h.changed_at)} · ${esc(h.changed_by_name)}${h.memo ? ` · ${esc(h.memo)}` : ''}
    </span>
  </div>`).join('')}
</div>`;
}

/** 상세 팝업의 탭 정의 */
const DETAIL_TABS = [
    { key: 'info', label: '주문정보상세' },
    { key: 'adjust', label: '조정요청' },
    { key: 'history', label: '수정이력' },
];

/**
 * 주문 상세 팝업.
 * 주문정보상세 / 조정요청 / 수정이력 세 탭으로 나뉜다.
 *  - 조정요청 : 이 탭에서 등록하고, 용마담당자가 확인처리한다
 *  - 수정이력 : 실제 수정 내용만 보여주고, 용마담당자가 확인처리한다
 */
async function showDetail(id, user, reload) {
    const canConfirmHere = canConfirm(user);
    let activeTab = 'info';

    const m = openModal('주문 상세', `
<div class="tabs" id="d-tabs">
  ${DETAIL_TABS.map((t) => `
  <button class="tabs__btn ${t.key === 'info' ? 'is-active' : ''}"
          data-dtab="${t.key}" type="button">${t.label}</button>`).join('')}
</div>
<div id="d-pane"><div class="empty">불러오는 중...</div></div>`, { wide: true, xl: true });

    const pane = m.root.querySelector('#d-pane');

    /** 현재 탭을 다시 그린다 (데이터도 새로 읽는다) */
    async function draw() {
        const o = await db.getOrder(id);
        if (!o) return;
        m.root.querySelector('.modal__head h3').textContent =
            `주문 상세 - ${o.order_no} (${o.seq}차수)`;

        m.root.querySelectorAll('[data-dtab]').forEach((el) => {
            el.classList.toggle('is-active', el.dataset.dtab === activeTab);
        });

        if (activeTab === 'info') await drawInfoPane(pane, o, id);
        else if (activeTab === 'adjust') await drawAdjustPane(pane, o, user, canConfirmHere, draw);
        else await drawHistoryPane(pane, o, user, canConfirmHere, draw);

        drawFooter(o);
    }

    /**
     * 하단 버튼 - 탭마다 다르다.
     *   주문정보상세 : 수정
     *   조정요청     : 저장 (등록 폼 제출)
     *   수정이력     : 저장할 내용 없음
     * 주문 취소는 조정요청의 '전체취소' 항목으로 처리한다.
     * (닫기 버튼과 헷갈리지 않도록 하단에 취소 버튼을 두지 않는다)
     */
    function drawFooter(o) {
        const foot = m.root.querySelector('.modal__foot');
        const note = o.canceled_at
            ? `취소된 주문입니다. (${fmtDateTime(o.canceled_at)}${
                o.canceled_by_name ? ` · ${o.canceled_by_name}` : ''})`
            : o.loaded_at ? '상차완료된 주문이라 수정할 수 없습니다.' : '';

        // 조정요청 탭의 저장 버튼은 등록 카드 안에 있다 (목록 아래가 아니라 입력 바로 밑)
        const btn = activeTab === 'info' && canEdit(user, o)
            ? '<button class="btn btn--primary" id="btn-detail-edit" type="button">수정</button>'
            : '';

        foot.innerHTML = `
<div class="modal__foot-note">${esc(note)}</div>
${btn ? `<div class="btn-row">${btn}</div>` : ''}`;

        foot.querySelector('#btn-detail-edit')?.addEventListener('click', () => {
            m.close();
            openForm(o, user, reload);
        });
    }

    // 하단 영역을 미리 만들어 둔다 (openModal 은 footer 문자열을 받아 생성한다)
    if (!m.root.querySelector('.modal__foot')) {
        const foot = document.createElement('div');
        foot.className = 'modal__foot';
        m.root.querySelector('.modal').appendChild(foot);
    }

    m.root.querySelectorAll('[data-dtab]').forEach((el) => {
        el.addEventListener('click', () => {
            activeTab = el.dataset.dtab;
            draw();
        });
    });

    await draw();
    // 팝업에서 처리한 내용이 목록에 반영되도록 닫을 때 갱신한다
    m.root.querySelector('.modal__close').addEventListener('click', reload);
}

/* ------------------------------ 탭 1. 주문정보상세 ----------------------------- */

async function drawInfoPane(pane, o, id) {
    const [owner, tasks, adjust, history] = await Promise.all([
        db.getUser(o.created_by), db.extraTaskMap(), db.adjustMap(), db.listHistory(id),
    ]);
    const stepOpt = { task: Boolean(tasks[o.order_no]), adjust: adjust[o.id] };

    // 항목별 수정 이력 (오래된 순)
    const editLog = {};
    history.filter((h) => h.rev > 0).forEach((h) => {
        (editLog[h.field] ??= []).unshift(h);
    });

    /** 항목 1칸. 수정된 적이 있으면 눌러서 이전 내용을 펼쳐 볼 수 있다 */
    const row = (k, v, full = false) => {
        const logs = editLog[k];
        const cls = `detail-item ${full ? 'detail-item--full' : ''} ${logs ? 'is-edited' : ''}`;
        const attr = logs
            ? `data-field="${esc(k)}" role="button" tabindex="0" title="눌러서 이전 내용 보기"` : '';
        return `
<div class="${cls}" ${attr}>
  <div class="detail-item__row">
    <span class="detail-item__label">
      ${k}${logs ? '<span class="tag tag--amber">수정됨</span>' : ''}
    </span>
    <span class="detail-item__value">${esc(v) || '<i class="muted">-</i>'}</span>
    ${logs ? '<span class="detail-item__caret" aria-hidden="true">▾</span>' : ''}
  </div>
  ${logs ? `<div class="detail-item__log" hidden>${changeLog(logs)}</div>` : ''}
</div>`;
    };

    pane.innerHTML = `
<div class="detail-grid">
${row('주문번호', o.order_no)}
${row('거래처명', o.customer)}
${row('담당자', owner?.name ?? '-')}
${row('차수', `${o.seq}차수`)}
${row('차량구분', o.vehicle_type)}
${row('등록일자', o.reg_date)}
${row('전송일자', o.send_date)}
${row('출고요청일', o.ship_req_date)}
${row('접수확인', o.confirmed_at
        ? `접수확인 · ${fmtDateTime(o.confirmed_at)}${o.confirmed_by_name ? ` · ${o.confirmed_by_name}` : ''}`
        : '미확인')}
${row('품목수', `${num(o.item_count)}개`)}
${row('출고수량', `${num(o.qty)}ea`)}
${row('파렛트수', `${num(o.pallet_count)}파렛트`)}
${row('처리현황', currentStep(o, stepOpt))}
${row('진행상태', progressOf(o))}
${row('추가작업', (o.extra_works ?? []).join(', '), true)}
${row('요청사항', o.request_note, true)}
${row('비고', o.remark, true)}
</div>`;

    pane.querySelectorAll('[data-field]').forEach((el) => {
        const toggle = () => {
            const log = el.querySelector('.detail-item__log');
            log.hidden = !log.hidden;
            el.classList.toggle('is-open', !log.hidden);
        };
        el.addEventListener('click', toggle);
        el.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            toggle();
        });
    });
}

/**
 * 확인 조작 영역 (변동 이력 · 조정요청 공통).
 * @param {object} row  checked_at 을 가진 행
 * @param {boolean} canCheck 조작 권한
 * @param {string} attr 버튼에 붙일 데이터 속성명
 * @param {string} label 미처리 상태의 버튼 문구
 * @param {string} doneLabel 처리 완료 상태의 문구
 */
function checkControl(row, canCheck, attr, label, doneLabel = '확인완료') {
    if (row.checked_at) {
        const by = row.checked_by_name ? ` · ${row.checked_by_name}` : '';
        const tip = `${fmtDateTime(row.checked_at)}${by}`;
        return canCheck
            ? `<button class="btn btn--sm btn--confirmed" ${attr}="${row.id}" type="button"
                 title="${esc(tip)} (누르면 해제)">${doneLabel}</button>`
            : `<span class="tag tag--green" title="${esc(tip)}">${doneLabel}</span>`;
    }
    return canCheck
        ? `<button class="btn btn--sm" ${attr}="${row.id}" type="button">${label}</button>`
        : '<span class="tag tag--gray">미확인</span>';
}

/** 확인처리 기록 한 줄 - 누가 언제 확인했는지 남긴다 */
function checkedMeta(row) {
    if (!row.checked_at) return '';
    const who = row.checked_by_name || '-';
    return `<div class="history__checked">
        처리 <b>${esc(who)}</b> · ${fmtDateTime(row.checked_at)}</div>`;
}

/**
 * 주문 등록/수정 폼
 * @param {object|null} o 수정 대상 (null 이면 신규 등록)
 */
function openForm(o, user, reload) {
    const isEdit = Boolean(o);
    const v = (k, d = '') => esc(o?.[k] ?? d);
    const m = openModal(isEdit ? `주문 수정 - ${o.order_no}` : '주문 등록', `
<p class="req-note"><span class="req">*</span> 표시는 필수 입력 항목입니다.</p>
<form id="order-form">
  <div class="form-grid">
    <label class="field">
      <span class="field__label">전송일자<span class="req">*</span></span>
      <input type="date" name="send_date" required value="${v('send_date', today())}">
    </label>
    <label class="field">
      <span class="field__label">주문번호<span class="req">*</span></span>
      <input type="text" name="order_no" required placeholder="PO-00000000" value="${v('order_no')}">
    </label>
    <label class="field">
      <span class="field__label">거래처명<span class="req">*</span></span>
      <input type="text" name="customer" required value="${v('customer')}">
    </label>
    <label class="field">
      <span class="field__label">출고요청일<span class="req">*</span></span>
      <input type="date" name="ship_req_date" required value="${v('ship_req_date', today())}">
    </label>
    <label class="field">
      <span class="field__label">차량구분<span class="req">*</span></span>
      <select name="vehicle_type" required>
        ${VEHICLE_TYPES.map((t) => `
        <option value="${t}" ${o?.vehicle_type === t ? 'selected' : ''}>${t}</option>`).join('')}
      </select>
    </label>
    <div class="field full">
      <span class="field__label">추가작업 (복수 선택 가능)</span>
      <div class="checks">
        ${EXTRA_WORKS.map((w) => `
        <label class="check check--inline">
          <input type="checkbox" name="extra_works" value="${w}"
                 ${(o?.extra_works ?? []).includes(w) ? 'checked' : ''}> ${w}
        </label>`).join('')}
      </div>
    </div>
    <label class="field full">
      <span class="field__label">요청사항</span>
      <textarea name="request_note">${v('request_note')}</textarea>
    </label>
    <label class="field full">
      <span class="field__label">비고</span>
      <input type="text" name="remark" value="${v('remark')}">
    </label>
    ${isEdit ? `
    <label class="field full">
      <span class="field__label">변경 사유 (히스토리에 기록됩니다)</span>
      <input type="text" name="memo" placeholder="예: 거래처 요청으로 출고일 변경">
    </label>` : ''}
  </div>
  <div class="form-actions">
    ${isEdit ? '<button class="btn btn--danger" id="btn-del" type="button">삭제</button>' : ''}
    <button class="btn" type="button" id="btn-cancel">취소</button>
    <button class="btn btn--primary" type="submit">${isEdit ? '수정 저장' : '등록'}</button>
  </div>
</form>`, { wide: true });

    m.body.querySelector('#btn-cancel').addEventListener('click', m.close);

    m.body.querySelector('#btn-del')?.addEventListener('click', async () => {
        if (!await confirmDialog('해당 주문을 삭제하시겠습니까?')) return;
        await db.deleteOrder(o.id, user);
        m.close();
        toast('삭제되었습니다.', 'success');
        reload();
    });

    m.body.querySelector('#order-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const form = new FormData(e.target);
        const fd = Object.fromEntries(form);
        // 체크박스는 다중 선택이므로 getAll 로 따로 읽는다
        fd.extra_works = form.getAll('extra_works');
        const memo = fd.memo ?? '';
        delete fd.memo;
        try {
            if (isEdit) {
                await db.updateOrder(o.id, fd, user, memo);
                toast('수정되었습니다.', 'success');
            } else {
                const created = await db.createOrder(fd, user);
                toast(`${created.seq}차수로 등록되었습니다.`, 'success');
            }
            m.close();
            reload();
        } catch (err) {
            toast(err.message, 'error');
        }
    });
}

/* ------------------------------- 탭 2. 조정요청 ------------------------------ */

/**
 * 조정요청 탭.
 * 이 탭에서 조정요청을 등록하고, 등록된 요청을 용마담당자가 확인처리한다.
 */
async function drawAdjustPane(pane, o, user, canCheck, redraw) {
    const list = await db.listRestores(o.id);
    const canAdd = canRestore(user, o);
    const left = list.filter((r) => !r.checked_at).length;

    pane.innerHTML = `
${canAdd ? `
<div class="card" style="margin-bottom:16px">
  <div class="card__head"><h2>조정요청 등록</h2></div>
  <div class="card__body">
    ${restoreFormHtml(o)}
    <div class="form-actions">
      <button class="btn btn--primary" id="btn-adjust-save" type="button">저장</button>
    </div>
  </div>
</div>` : `
<p class="form-note" style="margin:0 0 16px">
  ${o.canceled_at ? '취소된 주문이라 조정요청을 등록할 수 없습니다.'
        : o.inspect_done_at ? '검수작업이 완료되어 조정요청을 등록할 수 없습니다.'
            : '조정요청 등록 권한이 없습니다.'}
</p>`}

<div class="hist-sec">
  <h4>등록된 조정요청 <span class="tag tag--gray">${list.length}건</span>
    ${list.length ? (left
        ? `<span class="tag tag--red">미접수 ${left}건</span>`
        : '<span class="tag tag--green">모두 접수</span>') : ''}
  </h4>
  ${list.length ? `<ul class="history">${list.map((r) => `
<li class="history__item">
  <div class="history__main">
    <div class="history__diff">
      <span class="tag tag--amber">${adjustCategory(r.category).label}</span>
      <span class="tag ${r.type === RESTORE_TYPE.EMAIL ? 'tag--blue' : 'tag--green'}">
        ${RESTORE_TYPE_LABEL[r.type]}
      </span>
      <b>${esc(r.reason)}</b>${r.product_code || r.qty
    ? ` · 제품코드 ${esc(r.product_code || '-')} / 수량 ${esc(r.qty || '-')}` : ''}
    </div>
    <div class="history__meta">
      ${fmtDateTime(r.created_at)} · ${esc(r.created_by_name ?? '')}
    </div>
    ${checkedMeta(r)}
  </div>
  <div class="history__action">
    ${checkControl(r, canCheck, 'data-check-restore', '접수', '접수완료')}
  </div>
</li>`).join('')}</ul>` : '<div class="empty">등록된 조정요청이 없습니다.</div>'}
</div>`;

    if (canAdd) {
        bindRestoreForm(pane, o, user, redraw);
        pane.querySelector('#btn-adjust-save').addEventListener('click', () => {
            pane.querySelector('#restore-form').requestSubmit();
        });
    }
    // 접수하면 출고주문처리의 조정요청 탭에 자동으로 등록된다
    pane.querySelectorAll('[data-check-restore]').forEach((el) => {
        el.addEventListener('click', async () => {
            try {
                const row = await db.toggleRestoreCheck(el.dataset.checkRestore, user);
                toast(row.checked_at
                    ? '접수되었습니다. 출고주문처리 > 조정요청 탭에 등록되었습니다.'
                    : '접수를 해제했습니다. 조정요청 탭에서 제외됩니다.',
                row.checked_at ? 'success' : 'info');
                redraw();
            } catch (err) {
                toast(err.message, 'error');
            }
        });
    });
}

/* ------------------------------- 탭 3. 수정이력 ------------------------------ */

/**
 * 수정이력 탭.
 * 실제 수정(rev > 0)만 보여준다. 등록·처리현황·접수확인 같은 이벤트는 제외한다.
 * 용마담당자가 건별로 확인처리한다.
 */
async function drawHistoryPane(pane, o, user, canCheck, redraw) {
    const all = await db.listHistory(o.id);
    const list = all.filter((h) => h.rev > 0);
    const left = list.filter((h) => !h.checked_at).length;

    pane.innerHTML = `
<div class="hist-sec">
  <h4>수정 내용 <span class="tag tag--gray">${list.length}건</span>
    ${o.edit_count ? `<span class="tag tag--amber">수정 ${o.edit_count}회</span>` : ''}
    ${list.length ? (left
        ? `<span class="tag tag--red">미확인 ${left}건</span>`
        : '<span class="tag tag--green">모두 확인</span>') : ''}
  </h4>
  ${list.length ? `<ul class="history">${list.map((h) => `
<li class="history__item">
  <div class="history__main">
    <div class="history__diff"><b>${esc(h.field)}</b></div>
    <div class="diff">
      <span class="diff__box diff__box--before">
        <span class="diff__label">이전</span>${esc(h.before) || '<i>(없음)</i>'}
      </span>
      <span class="diff__arrow">→</span>
      <span class="diff__box diff__box--after">
        <span class="diff__label">이후</span>${esc(h.after) || '<i>(없음)</i>'}
      </span>
    </div>
    ${h.memo ? `<div class="history__diff">사유: ${esc(h.memo)}</div>` : ''}
    <div class="history__meta">
      ${fmtDateTime(h.changed_at)} · ${esc(h.changed_by_name)} · ${h.rev}회차 수정
    </div>
    ${checkedMeta(h)}
  </div>
  <div class="history__action">
    ${checkControl(h, canCheck, 'data-check', '수정확인')}
  </div>
</li>`).join('')}</ul>` : '<div class="empty">수정된 내용이 없습니다.</div>'}
</div>`;

    bindCheckToggle(pane, '[data-check]', db.toggleHistoryCheck, '수정확인', user, redraw);
}

/** 확인 토글 버튼 바인딩 (수정이력 · 조정요청 공통) */
function bindCheckToggle(scope, selector, toggle, name, user, redraw) {
    scope.querySelectorAll(selector).forEach((el) => {
        el.addEventListener('click', async () => {
            try {
                const id = el.dataset.check ?? el.dataset.checkRestore;
                const row = await toggle(id, user);
                toast(row.checked_at ? `${name} 처리되었습니다.` : `${name}을 해제했습니다.`,
                    row.checked_at ? 'success' : 'info');
                redraw();
            } catch (err) {
                toast(err.message, 'error');
            }
        });
    });
}

/* ---------------------------- 조정요청 등록 폼 ---------------------------- */

/**
 * 조정요청 등록 폼 HTML.
 * 작성 방식이 두 가지다.
 *  - 이메일로 발송 : 조정사유만 선택하고 별도 작성 내용은 없다
 *  - 여기에 작성   : 주문번호·거래처명·제품코드·수량·조정사유를 직접 작성한다
 */
function restoreFormHtml(o) {
    return `
<p class="req-note"><span class="req">*</span> 표시는 필수 입력 항목입니다.</p>
<form id="restore-form">
  <div class="field full" style="margin-bottom:14px">
    <span class="field__label">요청항목<span class="req">*</span></span>
    <div class="checks">
      ${ADJUST_CATEGORIES.map((c, i) => `
      <label class="check check--inline">
        <input type="radio" name="category" value="${c.key}" ${i === 0 ? '' : ''}
               ${c.key === 'etc' ? 'checked' : ''}>
        ${c.label}
      </label>`).join('')}
    </div>
    <p class="form-note" id="cat-desc"></p>
  </div>

  <div class="field full" style="margin-bottom:14px">
    <span class="field__label">작성 방식<span class="req">*</span></span>
    <div class="checks">
      <label class="check check--inline">
        <input type="radio" name="type" value="${RESTORE_TYPE.EMAIL}" checked>
        ${RESTORE_TYPE_LABEL[RESTORE_TYPE.EMAIL]}
      </label>
      <label class="check check--inline">
        <input type="radio" name="type" value="${RESTORE_TYPE.FORM}">
        ${RESTORE_TYPE_LABEL[RESTORE_TYPE.FORM]}
      </label>
    </div>
  </div>

  <div id="pane-email">
    <label class="field full">
      <span class="field__label">조정사유<span class="req">*</span></span>
      <select name="reason_select" required>
        ${RESTORE_REASONS.map((r) => `<option value="${r}">${r}</option>`).join('')}
      </select>
    </label>
    <p class="form-note">
      선택한 사유로 담당자에게 메일이 발송됩니다. 별도로 작성할 내용은 없습니다.
    </p>
  </div>

  <div id="pane-form" hidden>
    <div class="form-grid">
      <label class="field">
        <span class="field__label">주문번호<span class="req">*</span></span>
        <input type="text" name="order_no" value="${esc(o.order_no)}" disabled>
      </label>
      <label class="field">
        <span class="field__label">거래처명<span class="req">*</span></span>
        <input type="text" name="customer" value="${esc(o.customer)}" disabled>
      </label>
      <label class="field">
        <span class="field__label">제품코드<span class="req">*</span></span>
        <input type="text" name="product_code" placeholder="예: A-102" disabled>
      </label>
      <label class="field">
        <span class="field__label">수량<span class="req">*</span></span>
        <input type="number" name="qty" min="1" placeholder="예: 300" disabled>
      </label>
      <label class="field full">
        <span class="field__label">조정사유<span class="req">*</span></span>
        <textarea name="reason_text" placeholder="조정이 필요한 사유를 작성하세요." disabled></textarea>
      </label>
    </div>
  </div>

</form>`;
}

/** 조정요청 등록 폼 동작 */
function bindRestoreForm(pane, o, user, redraw) {
    const paneEmail = pane.querySelector('#pane-email');
    const paneForm = pane.querySelector('#pane-form');

    /**
     * 선택한 방식의 입력란만 활성화한다.
     * 숨긴 입력란은 disabled 로 둬야 필수값 검증과 전송 대상에서 빠진다.
     */
    function switchPane(type) {
        const isEmail = type === RESTORE_TYPE.EMAIL;
        paneEmail.hidden = !isEmail;
        paneForm.hidden = isEmail;
        paneEmail.querySelectorAll('select, input, textarea')
            .forEach((el) => { el.disabled = !isEmail; });
        paneForm.querySelectorAll('select, input, textarea')
            .forEach((el) => { el.disabled = isEmail; });
        paneForm.querySelectorAll('[name="order_no"], [name="customer"]')
            .forEach((el) => { el.readOnly = true; });
    }

    switchPane(RESTORE_TYPE.EMAIL);
    pane.querySelectorAll('[name="type"]').forEach((el) => {
        el.addEventListener('change', () => switchPane(el.value));
    });

    /** 선택한 요청항목의 설명을 보여준다 */
    const descBox = pane.querySelector('#cat-desc');
    function showDesc() {
        const key = pane.querySelector('[name="category"]:checked')?.value;
        const c = adjustCategory(key);
        descBox.innerHTML = c.cancelsOrder
            ? `⚠️ <b>${esc(c.desc)}</b>`
            : esc(c.desc);
        descBox.classList.toggle('is-warn', Boolean(c.cancelsOrder));
    }
    pane.querySelectorAll('[name="category"]').forEach((el) => {
        el.addEventListener('change', showDesc);
    });
    showDesc();

    pane.querySelector('#restore-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = Object.fromEntries(new FormData(e.target));
        const isEmail = fd.type === RESTORE_TYPE.EMAIL;
        const cat = adjustCategory(fd.category);

        // 전체취소는 주문 자체를 취소하므로 한 번 더 확인한다
        if (cat.cancelsOrder) {
            const msg = `[전체취소] 주문 ${o.order_no} (${o.seq}차수) 을(를) 취소합니다.\n`
                + '복구할 수 없으며 다시 주문을 등록해야 합니다. 진행하시겠습니까?';
            if (!await confirmDialog(msg)) return;
        }

        try {
            await db.createRestore({
                order_id: o.id,
                type: fd.type,
                category: fd.category,
                reason: isEmail ? fd.reason_select : fd.reason_text,
                order_no: isEmail ? o.order_no : fd.order_no,
                customer: isEmail ? o.customer : fd.customer,
                product_code: isEmail ? '' : fd.product_code,
                qty: isEmail ? '' : fd.qty,
            }, user);
            if (cat.cancelsOrder) {
                await db.cancelOrder(o.id, user, '전체취소 요청');
                toast('전체취소 요청이 등록되고 주문이 취소 처리되었습니다.', 'success');
            } else {
                toast(isEmail ? '조정요청이 등록되었습니다. (메일 발송 대상)'
                    : '조정요청이 등록되었습니다.', 'success');
            }
            redraw();
        } catch (err) {
            toast(err.message, 'error');
        }
    });
}

/* -------------------------------- 일괄등록 -------------------------------- */

/** 일괄등록 표의 컬럼 (등록 폼과 같은 순서) */
const BULK_COLS = [
    { key: 'send_date', label: '전송일자', required: true, date: true, hint: '2026-08-30' },
    { key: 'order_no', label: '주문번호', required: true, hint: 'PO-24080101' },
    { key: 'customer', label: '거래처명', required: true, hint: '올리브영 물류센터' },
    { key: 'ship_req_date', label: '출고요청일', required: true, date: true, hint: '2026-08-31' },
    { key: 'vehicle_type', label: '차량구분', required: true, hint: '픽업 또는 용차' },
    { key: 'extra_works', label: '추가작업', hint: '라벨작업, LOT지정' },
    { key: 'request_note', label: '요청사항', hint: '' },
    { key: 'remark', label: '비고', hint: '' },
];

const BULK_MIN_ROWS = 5;

/** 붙여넣은 날짜 문자열을 YYYY-MM-DD 로 정규화한다 */
function normDate(v) {
    const t = String(v ?? '').trim();
    if (!t) return '';
    const m = t.match(/^(\d{4})[-./]?(\d{1,2})[-./]?(\d{1,2})$/);
    if (!m) return t;   // 형식이 다르면 그대로 두고 검증에서 걸러낸다
    return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

/** 일괄등록 팝업 */
function openBulkForm(user, reload) {
    // rows[행][열] 형태의 문자열 표
    let rows = Array.from({ length: BULK_MIN_ROWS }, () => BULK_COLS.map(() => ''));

    const m = openModal('주문 일괄등록', `
<div class="bulk-guide">
  <b>엑셀에서 복사한 데이터를 표에 그대로 붙여넣으세요.</b>
  <ol>
    <li>엑셀에서 <b>머리글을 뺀 데이터 영역만</b> 선택해 복사합니다. (Ctrl+C)</li>
    <li>아래 표의 <b>첫 칸을 클릭</b>하고 붙여넣습니다. (Ctrl+V)</li>
    <li>행 수는 붙여넣은 데이터에 맞춰 <b>자동으로 늘어납니다.</b></li>
  </ol>
  <ul class="bulk-rule">
    <li><span class="req">*</span> 표시는 필수 입력 항목입니다.</li>
    <li><b>날짜</b> — <code>2026-08-30</code> · <code>2026/8/30</code> · <code>20260830</code>
      모두 인식합니다.</li>
    <li><b>차량구분</b> — ${VEHICLE_TYPES.join(' 또는 ')}</li>
    <li>
      <b>추가작업</b> — 한 칸에 여러 개를 넣을 수 있습니다.
      <b>쉼표(,) 또는 슬래시(/)</b> 로 구분하세요.<br>
      예) <code>라벨작업, LOT지정</code> · <code>라벨작업/박스교체</code><br>
      입력 가능한 값: ${EXTRA_WORKS.join(' · ')}
    </li>
  </ul>
</div>

<div class="toolbar" style="margin:14px 0 10px">
  <button class="btn" id="btn-tpl" type="button">양식 다운로드</button>
  <span class="field__label">양식은 컬럼 순서 참조용입니다</span>
  <button class="btn" id="btn-addrow" type="button">행 추가</button>
  <button class="btn" id="btn-clear" type="button">전체 지우기</button>
  <div class="toolbar__spacer"></div>
  <span class="field__label" id="bulk-count"></span>
</div>

<div class="table-wrap"><table class="grid bulk-grid" id="bulk-tbl"></table></div>
<div id="bulk-msg"></div>`, {
        wide: true,
        xl: true,
        footer: `
<div class="modal__foot-note" id="bulk-note"></div>
<div class="btn-row">
  <button class="btn btn--primary" id="btn-bulk-save" type="button">등록</button>
</div>`,
    });

    const tbl = m.root.querySelector('#bulk-tbl');
    const msg = m.root.querySelector('#bulk-msg');

    /** 입력된 행 수 (한 칸이라도 값이 있는 행) */
    const filled = () => rows.filter((r) => r.some((c) => String(c).trim())).length;

    function draw(focus) {
        tbl.innerHTML = `
<thead><tr>
  <th class="num">#</th>
  ${BULK_COLS.map((c) => `
  <th>${c.label}${c.required ? '<span class="req">*</span>' : ''}</th>`).join('')}
</tr></thead>
<tbody>
${rows.map((r, ri) => `
<tr>
  <td class="num">${ri + 1}</td>
  ${r.map((v, ci) => `
  <td><input type="text" data-r="${ri}" data-c="${ci}" value="${esc(v)}"
       placeholder="${esc(BULK_COLS[ci].hint)}"></td>`).join('')}
</tr>`).join('')}
</tbody>`;

        tbl.querySelectorAll('input').forEach((el) => {
            el.addEventListener('input', () => {
                rows[Number(el.dataset.r)][Number(el.dataset.c)] = el.value;
                m.root.querySelector('#bulk-count').textContent = `입력 ${filled()}건`;
            });
        });
        m.root.querySelector('#bulk-count').textContent = `입력 ${filled()}건`;
        if (focus) {
            tbl.querySelector(`[data-r="${focus.r}"][data-c="${focus.c}"]`)?.focus();
        }
    }

    /** 엑셀에서 복사한 표(TSV)를 붙여넣는다 */
    tbl.addEventListener('paste', (e) => {
        const cell = e.target.closest('input');
        if (!cell) return;
        const text = e.clipboardData?.getData('text/plain') ?? '';
        if (!text.includes('\t') && !text.includes('\n')) return;   // 단일 값은 기본 동작
        e.preventDefault();

        const startR = Number(cell.dataset.r);
        const startC = Number(cell.dataset.c);
        const lines = text.replace(/\r/g, '').replace(/\n+$/, '').split('\n');

        // 붙여넣은 만큼 행을 자동으로 늘린다
        while (rows.length < startR + lines.length) rows.push(BULK_COLS.map(() => ''));

        lines.forEach((line, i) => {
            line.split('\t').forEach((val, j) => {
                const c = startC + j;
                if (c >= BULK_COLS.length) return;
                rows[startR + i][c] = BULK_COLS[c].date ? normDate(val) : val.trim();
            });
        });
        draw({ r: startR, c: startC });
        toast(`${lines.length}행을 붙여넣었습니다.`, 'success');
    });

    m.root.querySelector('#btn-tpl').addEventListener('click', () => {
        downloadCsv('주문일괄등록_양식.csv',
            BULK_COLS.map((c) => c.label + (c.required ? '(필수)' : '')),
            [BULK_COLS.map((c) => c.hint)]);
    });

    m.root.querySelector('#btn-addrow').addEventListener('click', () => {
        for (let i = 0; i < 5; i += 1) rows.push(BULK_COLS.map(() => ''));
        draw();
    });

    m.root.querySelector('#btn-clear').addEventListener('click', async () => {
        if (!await confirmDialog('입력한 내용을 모두 지우시겠습니까?')) return;
        rows = Array.from({ length: BULK_MIN_ROWS }, () => BULK_COLS.map(() => ''));
        msg.innerHTML = '';
        draw();
    });

    m.root.querySelector('#btn-bulk-save').addEventListener('click', async () => {
        const targets = [];
        const errors = [];

        rows.forEach((r, ri) => {
            if (!r.some((c) => String(c).trim())) return;   // 빈 행은 건너뛴다
            const o = {};
            BULK_COLS.forEach((c, ci) => {
                o[c.key] = c.date ? normDate(r[ci]) : String(r[ci] ?? '').trim();
            });

            const bad = [];
            BULK_COLS.filter((c) => c.required && !o[c.key]).forEach((c) => bad.push(`${c.label} 누락`));
            ['send_date', 'ship_req_date'].forEach((k) => {
                if (o[k] && !/^\d{4}-\d{2}-\d{2}$/.test(o[k])) bad.push(`${k === 'send_date' ? '전송일자' : '출고요청일'} 형식 오류`);
            });
            if (o.vehicle_type && !VEHICLE_TYPES.includes(o.vehicle_type)) {
                bad.push(`차량구분은 ${VEHICLE_TYPES.join('/')} 만 가능`);
            }
            const works = o.extra_works
                ? o.extra_works.split(/[,/]/).map((w) => w.trim()).filter(Boolean) : [];
            works.filter((w) => !EXTRA_WORKS.includes(w))
                .forEach((w) => bad.push(`추가작업 '${w}' 는 없는 항목`));
            o.extra_works = works;

            if (bad.length) errors.push(`${ri + 1}행: ${bad.join(', ')}`);
            else targets.push(o);
        });

        if (!targets.length && !errors.length) {
            toast('등록할 내용이 없습니다.', 'error');
            return;
        }
        if (errors.length) {
            msg.innerHTML = `
<div class="bulk-err">
  <b>${errors.length}건의 오류가 있습니다. 수정 후 다시 등록하세요.</b>
  <ul>${errors.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
</div>`;
            msg.scrollIntoView({ block: 'nearest' });
            return;
        }

        if (!await confirmDialog(`${targets.length}건을 등록하시겠습니까?`)) return;
        try {
            for (const o of targets) await db.createOrder(o, user);
            m.close();
            toast(`${targets.length}건이 등록되었습니다.`, 'success');
            reload();
        } catch (err) {
            toast(err.message, 'error');
        }
    });

    draw();
}
