/** 당일상차리스트 - 모바일 사용을 우선한 화면. 검수와 상차완료를 처리한다 */
import {
    LOAD_STATUS, stowStatus, STOW_STATUS, formatLocation, compareLocation,
} from '../config.js';
import { can } from '../auth.js';
import * as db from '../db.js';
import {
    esc, num, today, rate, downloadCsv, toast, confirmDialog, openModal, fmtDateTime, isMobile,
    addBadge, seqTag, MOBILE_QUERY,
} from '../util.js';

const filter = { date: '', keyword: '' };

export async function render(root, { user }) {
    filter.date = filter.date || today();
    const editable = can(user, 'updateStatus');

    root.innerHTML = `
<div id="summary" class="summary"></div>

<div class="card">
  <div class="card__head">
    <h2>당일 상차 리스트</h2>
    <span class="tag tag--gray" id="row-count"></span>
    <div class="toolbar__spacer"></div>
    <div class="btn-row" id="head-actions"></div>
  </div>
  <div class="card__body">
    <div class="toolbar" id="filters"></div>
    <div class="table-wrap load-table"><table class="grid" id="tbl"></table></div>
    <div class="load-list" id="cards"></div>
  </div>
</div>`;

    /** 필터 줄 - 모바일(앱)은 검색과 날짜만 한 행에 둔다 */
    function drawFilters() {
        const mobile = isMobile();
        root.querySelector('#filters').innerHTML = mobile ? `
      <label class="field" style="flex:1 1 150px">
        <span class="field__label">주문번호 / 거래처명</span>
        <input type="text" id="f-kw" placeholder="검색어 입력" value="${esc(filter.keyword)}">
      </label>
      <label class="field" style="flex:0 0 160px;margin-left:auto">
        <span class="field__label">출고일자</span>
        <input type="date" id="f-date" value="${filter.date}">
      </label>` : `
      <label class="field" style="max-width:170px">
        <span class="field__label">출고일자</span>
        <input type="date" id="f-date" value="${filter.date}">
      </label>
      <button class="btn" id="btn-prev" type="button">전일</button>
      <button class="btn" id="btn-today" type="button">오늘</button>
      <button class="btn" id="btn-next" type="button">익일</button>`;

        root.querySelector('#f-date').addEventListener('change', (e) => setDate(e.target.value));
        root.querySelector('#f-kw')?.addEventListener('input', (e) => {
            filter.keyword = e.target.value;
            reload();
        });
        root.querySelector('#btn-prev')?.addEventListener('click', () => shift(-1));
        root.querySelector('#btn-next')?.addEventListener('click', () => shift(1));
        root.querySelector('#btn-today')?.addEventListener('click', () => setDate(today()));

        // 다운로드는 웹에서만 쓴다 (앱 화면은 현장 처리용이다)
        root.querySelector('#head-actions').innerHTML = !mobile && can(user, 'download')
            ? '<button class="btn btn--sm" id="btn-csv" type="button">다운로드</button>' : '';
        root.querySelector('#btn-csv')?.addEventListener('click', downloadRows);
    }

    let rows = [];

    async function reload() {
        rows = await db.listLoading(filter.date);
        if (!can(user, 'viewAll')) rows = rows.filter((o) => o.created_by === user.id);
        const kw = filter.keyword.trim().toLowerCase();
        if (kw) {
            rows = rows.filter((o) => `${o.order_no} ${o.customer}`.toLowerCase().includes(kw));
        }
        drawSummary(root, rows);
        drawTable(root, rows, editable, user, reload);
        drawCards(root, rows, editable, user, reload);
        root.querySelector('#row-count').textContent = `${num(rows.length)}건`;
    }

    const setDate = (d) => {
        filter.date = d;
        root.querySelector('#f-date').value = d;
        reload();
    };

    const shift = (days) => {
        const d = new Date(filter.date);
        d.setDate(d.getDate() + days);
        setDate(d.toISOString().slice(0, 10));
    };

    function downloadRows() {
        downloadCsv(`당일상차리스트_${filter.date}.csv`,
            ['출고일자', '주문번호', '거래처명', '출고형태', '파렛트수', '검수파렛트', '상태'],
            rows.map((o) => [
                o.ship_req_date, o.order_no, o.customer, o.vehicle_type,
                o.pallet_count, o.inspected, o.load_status,
            ]));
    }

    drawFilters();

    // 창 크기가 기준점을 넘나들면 필터 줄과 카드 구성이 달라진다
    const mq = window.matchMedia(MOBILE_QUERY);
    const onResize = () => {
        drawFilters();
        reload();
    };
    mq.addEventListener('change', onResize);

    await reload();
    const unwatch = db.subscribe(reload);
    return () => {
        mq.removeEventListener('change', onResize);
        unwatch();
        locModal?.close();
        locModal = null;
    };
}

/** 상단 요약 - 출고건수 / 파렛트수 / 상차완료 / 진행률 */
function drawSummary(root, rows) {
    const pallets = rows.reduce((a, o) => a + Number(o.group_pallets ?? o.pallet_count ?? 0), 0);
    const done = rows.filter((o) => o.load_status === LOAD_STATUS.DONE).length;
    const pct = rate(done, rows.length);
    root.querySelector('#summary').innerHTML = `
<div class="stat stat--accent">
  <div class="stat__label">출고건수</div>
  <div class="stat__value">${num(rows.length)}<small>건</small></div>
</div>
<div class="stat">
  <div class="stat__label">파렛트수</div>
  <div class="stat__value">${num(pallets)}<small>PLT</small></div>
</div>
<div class="stat">
  <div class="stat__label">상차완료</div>
  <div class="stat__value">${num(done)}<small>건</small></div>
</div>
<div class="stat">
  <div class="stat__label">진행률</div>
  <div class="stat__value">${pct}<small>%</small></div>
  <div class="bar"><div class="bar__fill ${pct === 100 ? 'bar__fill--done' : ''}"
       style="width:${pct}%"></div></div>
</div>`;
}

/** 상태 배지 HTML */
function statusTag(s) {
    const cls = s === LOAD_STATUS.DONE ? 'tag--green'
        : s === LOAD_STATUS.INSPECTED ? 'tag--blue' : 'tag--gray';
    return `<span class="tag ${cls}">${s}</span>`;
}

/** PC 표 형태 */
function drawTable(root, rows, editable, user, reload) {
    const tbl = root.querySelector('#tbl');
    if (!rows.length) {
        tbl.innerHTML =
            '<tbody><tr><td class="empty">상차 대상 주문이 없습니다.<br>' +
            '(상차 외 모든 작업이 완료된 주문만 표시됩니다.)</td></tr></tbody>';
        return;
    }
    tbl.innerHTML = `
<thead><tr>
  <th>출고일자</th><th>주문번호</th><th>거래처명</th><th class="center">출고형태</th>
  <th class="num">파렛트수</th><th class="num">박스수</th>
  <th class="center">적치로케이션</th>
  <th class="center">검수</th><th class="center">상태</th>
  <th class="center">상차</th>
</tr></thead>
<tbody>
${rows.map((o) => `
<tr>
  <td>${o.ship_req_date}</td>
  <td>${esc(o.order_no)}${addBadge(o.group_count)}</td>
  <td>${esc(o.customer)}</td>
  <td class="center">${esc(o.vehicle_type)}</td>
  <td class="num">${num(o.group_pallets)}</td>
  <td class="num">${o.box_count ? num(o.box_count) : '<span class="muted">-</span>'}</td>
  <td class="center">
    <button class="btn btn--sm" data-loc="${o.id}" type="button">확인</button>
  </td>
  <td class="center">
    <button class="btn btn--sm" data-inspect="${o.id}" type="button">
      검수 ${o.group_inspected}/${o.group_pallets}
    </button>
  </td>
  <td class="center">${statusTag(o.load_status)}</td>
  <td class="center">
    ${o.load_status === LOAD_STATUS.INSPECTED && editable
        ? `<button class="btn btn--success btn--sm" data-load="${o.id}" type="button">상차완료</button>`
        : '-'}
  </td>
</tr>`).join('')}
</tbody>`;
    bindActions(tbl, user, reload);
}

/** 모바일 카드 형태 */
function drawCards(root, rows, editable, user, reload) {
    const box = root.querySelector('#cards');
    if (!rows.length) {
        box.innerHTML = '<div class="empty">상차 대상 주문이 없습니다.</div>';
        return;
    }
    box.innerHTML = rows.map((o) => `
<div class="load-card">
  <div class="load-card__top">
    <span class="load-card__no">${esc(o.order_no)}${addBadge(o.group_count)}</span>
    ${statusTag(o.load_status)}
  </div>
  <div class="load-card__cust">${esc(o.customer)}</div>
  <div class="load-card__meta">
    <span>출고일 <b>${o.ship_req_date}</b></span>
    <span>출고형태 <b>${esc(o.vehicle_type)}</b></span>
    <span>파렛트 <b>${o.group_inspected}/${o.group_pallets}</b></span>
    <span>박스 <b>${o.box_count ? num(o.box_count) : '-'}</b></span>
  </div>
  <div class="load-card__actions">
    ${o.load_status === LOAD_STATUS.DONE ? `
    <button class="load-card__done" data-loaded="${o.id}" type="button">상차완료</button>` : `
    <button class="btn" data-loc="${o.id}" type="button">적치로케이션</button>
    <button class="btn" data-inspect="${o.id}" type="button">상차검수</button>
    ${o.load_status === LOAD_STATUS.INSPECTED && editable
        ? `<button class="btn btn--success" data-load="${o.id}" type="button">상차완료</button>` : ''}`}
  </div>
</div>`).join('');
    bindActions(box, user, reload);
}

/* ------------------------------ 적치 로케이션 ------------------------------ */

/** 열려 있는 팝업 - 화면을 떠날 때 함께 닫는다 */
let locModal = null;

/**
 * 적치 로케이션 팝업.
 * 파렛트마다 로케이션과 체크박스를 보여주고, 체크하면 그 파렛트를 내린 것으로 기록한다.
 * (현장에서 한 파렛트씩 내리면서 체크하는 용도라 모바일에서도 그대로 쓴다)
 */
async function openLocationModal(orderId, user, reload) {
    const editable = can(user, 'updateStatus');
    locModal?.close();
    locModal = openModal('적치 로케이션', '<div id="loc-body"></div>', { wide: true });
    const body = locModal.body.querySelector('#loc-body');

    async function draw() {
        const g = await db.getLoadGroup(orderId);
        if (!g) return;
        const o = g.head;
        const pallets = g.pallets;
        // 창고를 도는 순서대로 보여준다 (구역 → 행 → 열 → 단)
        const list = sortByLocation(pallets);
        const stowed = pallets.filter((p) => p.location).length;
        const picked = pallets.filter((p) => p.picked_at).length;
        const st = stowStatus(stowed, pallets.length);

        body.innerHTML = `
<div class="toolbar" style="margin-bottom:10px">
  <div>
    <b>${esc(o.order_no)}</b>${addBadge(g.rows.length)} · ${esc(o.customer)}
  </div>
  <div class="toolbar__spacer"></div>
  <span class="tag ${st === STOW_STATUS.DONE ? 'tag--green' : 'tag--gray'}">${st}</span>
  <span class="field__label">내림 ${picked}/${pallets.length}</span>
</div>
${o.loaded_at ? '<p class="form-note">상차완료된 주문이라 변경할 수 없습니다.</p>' : ''}
${editable && !o.loaded_at ? `
<p class="form-note" style="margin:0 0 10px">
  파렛트를 하나씩 내리면서 체크하세요. 체크한 항목은 초록으로 바뀝니다.
</p>` : ''}
<div class="pallet-list">
  ${list.length ? list.map((p) => `
  <label class="pallet ${p.picked_at ? 'is-scanned' : ''}">
    ${seqTag(p.seq, '차')}
    <span class="pallet__code">${esc(p.label)}</span>
    <span class="pallet__loc">${p.location
        ? `<b>${esc(formatLocation(p.location))}</b>`
        : '<span class="muted">미지정</span>'}</span>
    <input type="checkbox" class="pallet__check" data-pick="${p.id}"
           ${p.picked_at ? 'checked' : ''}
           ${editable && !o.loaded_at && p.location ? '' : 'disabled'}>
  </label>`).join('') : '<div class="empty">파렛트가 없습니다.</div>'}
</div>`;

        body.querySelectorAll('[data-pick]').forEach((el) => {
            el.addEventListener('change', async () => {
                try {
                    await db.setPalletPicked(el.dataset.pick, el.checked);
                    draw();
                    reload?.();
                } catch (err) {
                    toast(err.message, 'error');
                    el.checked = !el.checked;
                }
            });
        });
    }

    await draw();
}

/**
 * 파렛트에 표시 이름을 붙이고 로케이션 순으로 정렬한다.
 * 이름은 **원래 파렛트 번호**를 유지해야 하므로 정렬 전에 붙인다.
 */
function sortByLocation(pallets) {
    return [...pallets].sort((a, b) => compareLocation(a.location, b.location));
}

/**
 * 상차완료 건의 상세.
 * 결과를 보여주고, 잘못 찍은 상차는 하단의 `상차완료 취소` 로 되돌린다.
 * @param {object} user 로그인 사용자 (취소 이력에 남는다)
 * @param {Function} reload 목록 갱신
 * @param {boolean} editable 처리 권한
 */
async function openLoadedDetail(orderId, user, reload, editable) {
    const o = await db.getOrder(orderId);
    if (!o) return;
    const g = await db.getLoadGroup(orderId);
    const pallets = sortByLocation(g.pallets);
    const row = (label, value) => `<tr><th>${label}</th><td>${value}</td></tr>`;
    const dash = '<span class="muted">-</span>';
    locModal?.close();
    locModal = openModal(`${o.order_no} · 상차완료`, `
<table class="grid"><tbody>
  ${row('거래처명', esc(o.customer))}
  ${row('출고일자', `<b>${o.ship_req_date}</b>`)}
  ${row('출고형태', esc(o.vehicle_type))}
  ${row('차수', `${g.rows.length}개 차수${g.rows.length > 1
        ? ` (추가주문 ${g.rows.length - 1}건 포함)` : ''}`)}
  ${row('파렛트수', pallets.length ? `${num(pallets.length)} PLT` : dash)}
  ${row('박스수', o.box_count ? `${num(o.box_count)} 박스` : dash)}
  ${row('검수', `${pallets.filter((p) => p.scanned_at).length}/${pallets.length}`)}
  ${row('검수완료', o.inspect_done_at ? fmtDateTime(o.inspect_done_at) : dash)}
  ${row('출고적치', o.stow_done_at ? fmtDateTime(o.stow_done_at) : dash)}
  ${row('상차완료', o.loaded_at ? `<b>${fmtDateTime(o.loaded_at)}</b>` : dash)}
</tbody></table>

<p class="field__label" style="margin:14px 0 6px">적치 로케이션</p>
<div class="pallet-list">
  ${pallets.length ? pallets.map((p) => `
  <div class="pallet ${p.picked_at ? 'is-scanned' : ''}">
    ${seqTag(p.seq, '차')}
    <span class="pallet__code">${esc(p.label)}</span>
    <span class="pallet__loc">${p.location
        ? `<b>${esc(formatLocation(p.location))}</b>` : dash}</span>
  </div>`).join('') : '<div class="empty">파렛트가 없습니다.</div>'}
</div>`, {
        wide: true,
        footer: editable
            ? '<button class="btn btn--danger" id="btn-unload" type="button">상차완료 취소</button>'
            : '',
    });

    // 상차완료 취소 - 되돌리면 검수 상태로 돌아가고 다시 상차완료할 수 있다
    locModal.root.querySelector('#btn-unload')?.addEventListener('click', async () => {
        const ok = await confirmDialog(
            `${o.order_no} 의 상차완료를 취소하시겠습니까?\n\n`
            + `묶인 ${g.rows.length}개 차수 전체가 검수 상태로 돌아갑니다.\n`
            + '상차작업 취소 이력이 남습니다.',
        );
        if (!ok) return;
        try {
            await db.cancelLoading(orderId, user);
            locModal.close();
            toast(`${o.order_no} 의 상차완료를 취소했습니다.`, 'success');
            reload();
        } catch (err) {
            toast(err.message, 'error');
        }
    });
}

/** 검수 이동 / 상차완료 / 적치로케이션 버튼 바인딩 */
function bindActions(scope, user, reload) {
    scope.querySelectorAll('[data-loc]').forEach((el) => {
        el.addEventListener('click', () => openLocationModal(el.dataset.loc, user, reload));
    });
    scope.querySelectorAll('[data-loaded]').forEach((el) => {
        el.addEventListener('click', () => openLoadedDetail(
            el.dataset.loaded, user, reload, can(user, 'updateStatus'),
        ));
    });
    scope.querySelectorAll('[data-inspect]').forEach((el) => {
        el.addEventListener('click', () => {
            location.hash = `#/inspect/${el.dataset.inspect}`;
        });
    });
    scope.querySelectorAll('[data-load]').forEach((el) => {
        el.addEventListener('click', async () => {
            if (!await confirmDialog('상차완료 처리하시겠습니까?')) return;
            try {
                await db.completeLoading(el.dataset.load, user);
                toast('상차완료 처리되었습니다.', 'success');
                reload();
            } catch (err) {
                toast(err.message, 'error');
            }
        });
    });
}
