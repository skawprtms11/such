/**
 * 출고주문처리 화면.
 *
 * 모바일 : 주문번호를 스캔해 출고작업 → 검수작업 → 추가작업을 직접 처리한다.
 * 웹     : 각 탭의 **진행중 목록만** 보여준다. 처리는 하지 않는다.
 *
 * 실제 작업은 현장에서 모바일로 하고, 웹은 진행 상황을 확인하는 용도다.
 * 처리 결과는 주문의 단계 완료 시각으로 저장되고 주문처리현황에 그대로 반영된다.
 */
import {
    adjustCategory, palletLabel, stowStatus, STOW_STATUS,
    formatLocation, isValidLocation, LOCATION_FORMAT,
} from '../config.js';
import { can } from '../auth.js';
import * as db from '../db.js';
import { visibleSteps } from '../steps.js';
import { createScanner, scanSupported } from '../scanner.js';
import {
    esc, num, today, fmtDateTime, toast, confirmDialog, openModal, downloadCsv,
} from '../util.js';

/** 탭 정의 */
const TABS = [
    { key: 'ship', label: '출고작업' },
    { key: 'inspect', label: '검수작업' },
    { key: 'stow', label: '출고적치' },
    { key: 'load', label: '상차대기' },
    { key: 'extra', label: '조정요청' },
];

/** 현재 선택된 탭 (화면을 다시 열어도 유지된다) */
let activeTab = 'ship';

/** 열려 있는 팝업 - 화면을 떠날 때 함께 닫는다 */
let openedModal = null;

/** 모바일 여부 - CSS 의 반응형 기준점(860px)과 같은 값을 쓴다 */
const MOBILE_QUERY = '(max-width: 860px)';

function isMobile() {
    return window.matchMedia(MOBILE_QUERY).matches;
}

export async function render(root, { user }) {
    const editable = can(user, 'updateStatus');

    root.innerHTML = `
<div class="tabs" id="tabs">
  ${TABS.map((t) => `
  <button class="tabs__btn ${t.key === activeTab ? 'is-active' : ''}"
          data-tab="${t.key}" type="button">${t.label}</button>`).join('')}
</div>
<div id="pane"></div>`;

    const pane = root.querySelector('#pane');
    let cleanupPane = null;

    /** 조정요청 탭에 미처리 건수를 배지로 알린다 */
    async function refreshTabBadge() {
        const n = (await pendingExtra()).length;
        const btn = root.querySelector('[data-tab="extra"]');
        btn.querySelector('.cnt-badge')?.remove();
        if (n) {
            btn.insertAdjacentHTML('beforeend',
                `<sup class="cnt-badge is-pending" title="처리할 요청 ${n}건">${n}</sup>`);
        }
    }

    /** 탭 전환 */
    async function openTab(key) {
        activeTab = key;
        root.querySelectorAll('[data-tab]').forEach((el) => {
            el.classList.toggle('is-active', el.dataset.tab === key);
        });
        if (typeof cleanupPane === 'function') cleanupPane();
        cleanupPane = null;
        pane.innerHTML = '';

        if (!isMobile()) {
            // 웹에서는 처리하지 않고 진행중 목록만 보여준다
            cleanupPane = await renderPendingList(pane, key, user);
        } else if (key === 'extra') {
            cleanupPane = await renderExtraTab(pane, user, editable);
        } else if (key === 'stow') {
            cleanupPane = await renderStowTab(pane, user, editable);
        } else if (key === 'load') {
            cleanupPane = await renderLoadWaitTab(pane, user);
        } else {
            cleanupPane = await renderWorkTab(pane, user, editable, key);
        }
    }

    root.querySelectorAll('[data-tab]').forEach((el) => {
        el.addEventListener('click', () => openTab(el.dataset.tab));
    });

    // 창 크기가 기준점을 넘나들면 화면을 다시 그린다
    const mq = window.matchMedia(MOBILE_QUERY);
    const onResize = () => openTab(activeTab);
    mq.addEventListener('change', onResize);

    await openTab(activeTab);
    await refreshTabBadge();
    const unwatch = db.subscribe(refreshTabBadge);
    return () => {
        mq.removeEventListener('change', onResize);
        unwatch();
        if (typeof cleanupPane === 'function') cleanupPane();
        openedModal?.close();
        openedModal = null;
    };
}

/* ------------------------------ 스캔 입력 영역 ------------------------------ */

/**
 * 주문번호 스캔/입력 패널을 그린다.
 * @param {Element} box 그릴 위치
 * @param {(no:string) => void} onSubmit 주문번호가 확정되면 호출
 * @returns {Function} 정리 함수 (카메라 정지)
 */
function mountScanBox(box, onSubmit) {
    box.innerHTML = `
<div class="card">
  <div class="card__body">
    <div class="toolbar" style="margin-bottom:0">
      <label class="field" style="flex:1;min-width:180px">
        <span class="field__label">주문번호 (바코드 스캔 또는 직접 입력)</span>
        <input type="text" id="scan-input" placeholder="PO-00000000"
               autocomplete="off" enterkeyhint="search">
      </label>
      <button class="btn btn--primary" id="btn-find" type="button">조회</button>
      <button class="btn" id="btn-cam" type="button">📷 스캔</button>
    </div>
    <video id="scan-video" playsinline muted hidden style="margin-top:12px"></video>
    ${scanSupported() ? '' : `
    <p class="form-note">
      이 브라우저는 카메라를 사용할 수 없습니다. 주문번호를 직접 입력하세요.
      (HTTPS 접속인지 확인하세요. 블루투스 스캐너는 그대로 사용할 수 있습니다)
    </p>`}
  </div>
</div>`;

    const input = box.querySelector('#scan-input');
    const video = box.querySelector('#scan-video');
    const scanner = createScanner(video, (code) => {
        input.value = code;
        onSubmit(code);
    });

    const submit = () => {
        const v = input.value.trim();
        if (v) onSubmit(v);
    };

    box.querySelector('#btn-find').addEventListener('click', submit);
    input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        submit();
    });

    box.querySelector('#btn-cam').addEventListener('click', async () => {
        if (scanner.isOn()) {
            scanner.stop();
            return;
        }
        try {
            await scanner.start();
        } catch (err) {
            toast(err.message, 'error');
        }
    });

    input.focus();
    return () => scanner.stop();
}

/* --------------------------------- 공통 조각 -------------------------------- */

/** 주문 요약 카드 (단계 표시 포함) */
function orderSummary(o, opt) {
    const steps = visibleSteps(o, opt);
    return `
<div class="work-head">
  <div class="work-head__top">
    <strong>${esc(o.order_no)}</strong>
    <span class="tag tag--blue">${o.seq}차수</span>
  </div>
  <div class="work-head__cust">${esc(o.customer)}</div>
  <div class="work-head__meta">
    <span>출고요청일 <b>${o.ship_req_date}</b></span>
    <span>차량 <b>${esc(o.vehicle_type)}</b></span>
    <span>파렛트 <b>${num(o.pallet_count)}</b></span>
  </div>
  <div class="steps steps--flow">
    ${steps.map((s, i) => `
    ${i ? '<span class="steps__arrow">→</span>' : ''}
    <span class="step ${s.done ? 'is-done' : ''}" title="${s.doneAt ? fmtDateTime(s.doneAt) : ''}">
      ${s.label}
    </span>`).join('')}
  </div>
</div>`;
}

/** 주문번호로 조회해 1건을 고른다. 여러 차수면 선택 목록을 보여준다 */
async function pickOrder(box, orderNo, onPick) {
    const rows = await db.findOrdersByNo(orderNo);
    if (!rows.length) {
        box.innerHTML = `<div class="empty">주문번호 <b>${esc(orderNo)}</b> 를 찾을 수 없습니다.</div>`;
        return null;
    }
    if (rows.length === 1) return rows[0];

    box.innerHTML = `
<div class="card"><div class="card__body">
  <p class="field__label">차수가 여러 건입니다. 처리할 건을 선택하세요.</p>
  <div class="btn-row">
    ${rows.map((o) => `
    <button class="btn" data-pick="${o.id}" type="button">
      ${o.seq}차수 · ${esc(o.customer)}
    </button>`).join('')}
  </div>
</div></div>`;
    box.querySelectorAll('[data-pick]').forEach((el) => {
        el.addEventListener('click', () => onPick(el.dataset.pick));
    });
    return null;
}

/* ---------------------------- 출고작업 · 검수작업 탭 --------------------------- */

/**
 * 출고작업/검수작업 탭.
 * @param {'ship'|'inspect'} mode
 */
async function renderWorkTab(pane, user, editable, mode) {
    pane.innerHTML = '<div id="scan-box"></div><div id="work-box"></div>';
    const workBox = pane.querySelector('#work-box');
    const tasks = await db.extraTaskMap();

    /** 주문 1건의 작업 화면을 그린다 */
    async function draw(orderId) {
        // 스캔해서 작업을 연 사람이 이 단계의 작업자가 된다 (조회 권한만 있으면 기록하지 않는다)
        if (editable) await db.recordWorker(orderId, mode, user);
        const o = await db.getOrder(orderId);
        if (!o) return;
        const opt = { task: Boolean(tasks[o.order_no]), adjust: (await db.adjustMap())[o.id] };
        workBox.innerHTML = `
${orderSummary(o, opt)}
<div class="card"><div class="card__body" id="work-body"></div></div>`;
        const body = workBox.querySelector('#work-body');

        if (mode === 'ship') drawShip(body, o, user, editable, () => draw(orderId));
        else drawInspect(body, o, user, editable, () => draw(orderId));
    }

    const cleanup = mountScanBox(pane.querySelector('#scan-box'), async (no) => {
        const picked = await pickOrder(workBox, no, (id) => draw(id));
        if (picked) draw(picked.id);
    });

    return cleanup;
}

/** 출고작업 본문 */
function drawShip(body, o, user, editable, reload) {
    const started = Boolean(o.ship_started_at);
    const done = Boolean(o.ship_done_at);

    body.innerHTML = `
<table class="grid"><tbody>
  <tr><th>작업자</th><td>${workerCell(o.ship_worker)}</td></tr>
  <tr><th>작업시작</th><td>${o.ship_started_at ? fmtDateTime(o.ship_started_at) : '-'}</td></tr>
  <tr><th>작업완료</th><td>${o.ship_done_at ? fmtDateTime(o.ship_done_at) : '-'}</td></tr>
</tbody></table>
${!o.confirmed_at ? `
<p class="form-note">⚠️ 아직 접수 처리되지 않은 주문입니다. 주문처리 단계가 비어 있습니다.</p>` : ''}
${editable ? `
<div class="btn-row" style="margin-top:16px">
  ${done ? `
  <button class="btn btn--danger btn--lg" id="btn-cancel" type="button">완료 취소</button>`
        : started ? `
  <button class="btn btn--success btn--lg" id="btn-done" type="button">작업완료</button>
  <button class="btn btn--danger btn--lg" id="btn-reset" type="button">시작 취소</button>`
            : `
  <button class="btn btn--primary btn--lg" id="btn-start" type="button">작업시작</button>
  <button class="btn btn--success btn--lg" id="btn-done" type="button">바로 작업완료</button>`}
</div>` : '<p class="form-note">처리 권한이 없어 조회만 가능합니다.</p>'}`;

    const run = async (fn, msg) => {
        try {
            await fn();
            toast(msg, 'success');
            reload();
        } catch (err) {
            toast(err.message, 'error');
        }
    };

    body.querySelector('#btn-start')?.addEventListener('click', () => {
        run(() => db.startShipWork(o.id, user), '출고작업을 시작했습니다.');
    });
    body.querySelector('#btn-done')?.addEventListener('click', () => {
        run(() => db.setShipWorkDone(o.id, true, user), '출고작업을 완료했습니다.');
    });
    body.querySelector('#btn-cancel')?.addEventListener('click', async () => {
        if (!await confirmDialog('출고작업 완료를 취소하시겠습니까?')) return;
        run(() => db.setShipWorkDone(o.id, false, user), '출고작업 완료를 취소했습니다.');
    });
    body.querySelector('#btn-reset')?.addEventListener('click', async () => {
        if (!await confirmDialog('작업시작을 취소하시겠습니까?')) return;
        run(() => db.setShipWorkDone(o.id, false, user), '작업시작을 취소했습니다.');
    });
}

/** 검수작업 본문 */
function drawInspect(body, o, user, editable, reload) {
    const extras = o.extra_works ?? [];
    const done = Boolean(o.inspect_done_at);

    if (!o.ship_done_at && !done) {
        body.innerHTML = `
<div class="empty">
  출고작업이 완료되지 않은 주문입니다.<br>
  출고작업 탭에서 먼저 완료 처리하세요.
</div>`;
        return;
    }

    body.innerHTML = `
${extras.length ? `
<div class="check-block">
  <label class="check">
    <input type="checkbox" id="chk-req" ${done ? 'checked' : ''} ${done ? 'disabled' : ''}>
    <span>요청작업 완료 확인</span>
  </label>
  <div class="check-block__detail">
    ${extras.map((w) => `<span class="tag tag--blue">${esc(w)}</span>`).join(' ')}
  </div>
</div>` : '<p class="form-note">등록된 요청작업이 없습니다.</p>'}

<div class="check-block">
  <label class="check">
    <input type="checkbox" id="chk-pack" ${done ? 'checked' : ''} ${done ? 'disabled' : ''}>
    <span>패킹리스트 작성 확인</span>
  </label>
</div>

${done ? '' : `
<div class="form-grid" style="margin-top:14px">
  <label class="field">
    <span class="field__label">총 파렛트수<span class="req">*</span></span>
    <input type="number" id="in-pallet" min="1" step="1" inputmode="numeric"
           placeholder="0" value="${o.pallet_count || ''}">
  </label>
  <label class="field">
    <span class="field__label">총 박스수<span class="req">*</span></span>
    <input type="number" id="in-box" min="1" step="1" inputmode="numeric"
           placeholder="0" value="${o.box_count || ''}">
  </label>
</div>
<p class="form-note">
  검수하면서 센 실제 수량을 입력합니다. 입력한 파렛트 수만큼 상차 검수용 바코드가 만들어집니다.
</p>`}

<table class="grid" style="margin-top:14px"><tbody>
  <tr><th>총 파렛트수</th><td>${o.pallet_count ? `${num(o.pallet_count)} PLT` : '-'}</td></tr>
  <tr><th>총 박스수</th><td>${o.box_count ? `${num(o.box_count)} 박스` : '-'}</td></tr>
  <tr><th>작업자</th><td>${workerCell(o.inspect_worker)}</td></tr>
  <tr><th>검수완료</th><td>${o.inspect_done_at ? fmtDateTime(o.inspect_done_at) : '-'}</td></tr>
</tbody></table>

${editable ? `
<div class="btn-row" style="margin-top:16px">
  ${done
        ? '<button class="btn btn--danger btn--lg" id="btn-cancel" type="button">완료 취소</button>'
        : '<button class="btn btn--success btn--lg" id="btn-done" type="button">검수완료</button>'}
</div>` : '<p class="form-note">처리 권한이 없어 조회만 가능합니다.</p>'}`;

    body.querySelector('#btn-done')?.addEventListener('click', async () => {
        const checks = {
            reqWork: body.querySelector('#chk-req')?.checked ?? true,
            packing: body.querySelector('#chk-pack')?.checked ?? false,
            palletCount: Number(body.querySelector('#in-pallet')?.value),
            boxCount: Number(body.querySelector('#in-box')?.value),
        };
        try {
            await db.setInspectDone(o.id, true, checks, user);
            toast('검수작업을 완료했습니다.', 'success');
            reload();
        } catch (err) {
            toast(err.message, 'error');
        }
    });

    body.querySelector('#btn-cancel')?.addEventListener('click', async () => {
        if (!await confirmDialog('검수작업 완료를 취소하시겠습니까?')) return;
        try {
            await db.setInspectDone(o.id, false, {}, user);
            toast('검수작업 완료를 취소했습니다.', 'success');
            reload();
        } catch (err) {
            toast(err.message, 'error');
        }
    });
}

/* -------------------------------- 추가작업 탭 -------------------------------- */

/**
 * 추가작업 탭.
 * 검수작업까지 완료됐고 추가작업 요청이 등록된 주문만 목록에 나온다.
 * 요청은 이슈등록의 '작업요청' 유형 건을 주문번호로 이어 붙인 것이다.
 */
async function renderExtraTab(pane, user, editable) {
    // 조정요청은 스캔할 대상이 아니라 접수된 요청 목록에서 고르는 화면이다
    pane.innerHTML = `
<div id="picked"></div>
<div class="card">
  <div class="card__head">
    <h2>조정요청 대상</h2>
    <span class="tag tag--gray" id="task-count"></span>
  </div>
  <div class="card__body">
    <div class="table-wrap"><table class="grid" id="tbl"></table></div>
  </div>
</div>`;

    const picked = pane.querySelector('#picked');

    /** 대상 목록 = 요청이 있고, 아직 상차 전인 주문 (출고·검수 진행 여부는 보지 않는다) */
    async function targets() {
        const list = await db.listRequestTasks();
        return list.filter(({ order: o }) => !o.canceled_at && !o.loaded_at);
    }

    async function drawPicked(orderId) {
        if (editable) await db.recordWorker(orderId, 'extra', user);
        const rows = await targets();
        const hit = rows.find((r) => r.order.id === orderId);
        if (!hit) {
            picked.innerHTML = `
<div class="empty">
  조정요청 대상이 아닙니다.<br>
  접수된 조정요청·작업요청이 있고 아직 상차되지 않은 주문만 표시됩니다.
</div>`;
            return;
        }
        const { order: o } = hit;
        const done = Boolean(o.extra_done_at);
        picked.innerHTML = `
${orderSummary(o, { task: true, adjust: (await db.adjustMap())[o.id] })}
<div class="card"><div class="card__body">
  <div class="task-detail">
    <span class="field__label">
      ${hit.source === 'adjust'
        ? `조정요청 내용 <span class="tag tag--amber">${adjustCategory(hit.category).label}</span>`
        : '작업요청 내용'}
    </span>
    <p>${esc(hit.content)}</p>
    <div class="history__meta">
      ${hit.due_date ? `완료요청일 ${hit.due_date} · ` : ''}등록 ${fmtDateTime(hit.created_at)}
    </div>
  </div>
  <table class="grid" style="margin-top:14px"><tbody>
    <tr><th>작업자</th><td>${workerCell(o.extra_worker)}</td></tr>
    <tr><th>작업완료</th><td>${o.extra_done_at ? fmtDateTime(o.extra_done_at) : '-'}</td></tr>
  </tbody></table>
  ${!o.inspect_done_at ? `
  <p class="form-note">
    ⚠️ 아직 검수작업이 완료되지 않았습니다. 요청 내용은 확인할 수 있지만
    작업완료 처리는 검수작업을 마친 뒤에 가능합니다.
  </p>` : ''}
  ${editable ? `
  <div class="btn-row" style="margin-top:16px">
    ${done
        ? '<button class="btn btn--danger btn--lg" id="btn-cancel" type="button">완료 취소</button>'
        : '<button class="btn btn--success btn--lg" id="btn-done" type="button">작업완료</button>'}
  </div>` : '<p class="form-note">처리 권한이 없어 조회만 가능합니다.</p>'}
</div></div>`;

        const run = async (fn, msg) => {
            try {
                await fn();
                toast(msg, 'success');
                drawPicked(orderId);
                drawList();
            } catch (err) {
                toast(err.message, 'error');
            }
        };

        picked.querySelector('#btn-done')?.addEventListener('click', () => {
            run(() => db.setExtraWorkDone(o.id, true, user), '요청 작업을 완료했습니다.');
        });
        picked.querySelector('#btn-cancel')?.addEventListener('click', async () => {
            if (!await confirmDialog('작업 완료를 취소하시겠습니까?')) return;
            run(() => db.setExtraWorkDone(o.id, false, user), '작업 완료를 취소했습니다.');
        });
    }

    /** 대상 목록 표 */
    async function drawList() {
        const rows = await targets();
        pane.querySelector('#task-count').textContent = `${rows.length}건`;
        const tbl = pane.querySelector('#tbl');
        if (!rows.length) {
            tbl.innerHTML =
                '<tbody><tr><td class="empty">조정요청 대상이 없습니다.<br>'
                + '(접수된 요청이 있고 아직 상차되지 않은 주문만 표시됩니다.)</td></tr></tbody>';
            return;
        }
        // 모바일이라 좁다. 등록일자는 월/일만, 나머지는 구분·주문번호·거래처명만 보여주고
        // 행을 누르면 위쪽에 상세가 펼쳐진다
        tbl.classList.add('grid--mobile');
        tbl.innerHTML = `
<thead><tr>
  <th>등록일자</th><th class="center">구분</th><th>주문번호</th><th>거래처명</th>
</tr></thead>
<tbody>
${rows.map((t) => { const o = t.order; return `
<tr class="is-clickable" data-open="${o.id}">
  <td>${monthDay(t.created_at)}</td>
  <td class="center">
    <span class="tag ${t.source === 'adjust' ? 'tag--amber' : 'tag--gray'}">
      ${t.source === 'adjust' ? adjustCategory(t.category).label : '작업요청'}
    </span>
  </td>
  <td><span class="link">${esc(o.order_no)}</span></td>
  <td class="wrap">${esc(o.customer)}</td>
</tr>`; }).join('')}
</tbody>`;
        tbl.querySelectorAll('[data-open]').forEach((el) => {
            el.addEventListener('click', () => {
                drawPicked(el.dataset.open);
                picked.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
        });
    }

    await drawList();
    return db.subscribe(drawList);
}

/** 등록일자를 월/일로 줄인다 (모바일 목록용) */
function monthDay(iso) {
    const [, m, d] = String(iso).slice(0, 10).split('-');
    return m && d ? `${m}/${d}` : '-';
}

/* -------------------------------- 출고적치 탭 -------------------------------- */

function stowTag(done, total) {
    const st = stowStatus(done, total);
    const cls = st === STOW_STATUS.DONE ? 'tag--green'
        : st === STOW_STATUS.ING ? 'tag--blue' : 'tag--gray';
    return `<span class="tag ${cls}">${st}</span>`;
}

/** 주문 목록에 적치 진행 수를 붙인다 */
async function withStow(rows) {
    return Promise.all(rows.map(async (o) => ({ ...o, stow: await db.stowCount(o.id) })));
}

/**
 * 모바일 출고적치 탭.
 * 주문번호를 스캔하면 파렛트 목록이 나오고, 한 건씩 로케이션을 입력한다.
 */
async function renderStowTab(pane, user, editable) {
    pane.innerHTML = '<div id="scan-box"></div><div id="stow-box"></div>';
    const box = pane.querySelector('#stow-box');
    let locCleanup = null;

    /** 파렛트 목록을 그린다 */
    async function draw(orderId, openPalletId = null) {
        if (typeof locCleanup === 'function') locCleanup();
        locCleanup = null;

        const o = await db.getOrder(orderId);
        if (!o) return;
        if (!o.inspect_done_at) {
            box.innerHTML = `
${orderSummary(o, {})}
<div class="empty">
  검수작업이 완료되지 않은 주문입니다.<br>
  검수작업 탭에서 먼저 완료 처리하세요.
</div>`;
            return;
        }

        const pallets = await db.listPallets(o.id);
        const done = pallets.filter((p) => p.location).length;
        box.innerHTML = `
${orderSummary(o, {})}
<div class="card">
  <div class="card__head">
    <h2>적치 로케이션</h2>
    ${stowTag(done, pallets.length)}
    <div class="toolbar__spacer"></div>
    <span class="field__label">${done}/${pallets.length} 완료</span>
  </div>
  <div class="card__body">
    ${pallets.length ? `
    <div class="pallet-list">
      ${pallets.map((p, i) => `
      <button class="pallet ${p.location ? 'is-scanned' : ''} ${
    p.id === openPalletId ? 'is-open' : ''}"
              data-pallet="${p.id}" type="button" ${editable ? '' : 'disabled'}>
        <span class="pallet__mark">${p.location ? '✅' : '⬜'}</span>
        <span class="pallet__code">${esc(palletLabel(o.order_no, i))}</span>
        <span class="pallet__loc">${p.location
        ? `<b>${esc(formatLocation(p.location))}</b>`
        : '<span class="muted">로케이션 미지정</span>'}</span>
      </button>`).join('')}
    </div>` : `
    <div class="empty">
      파렛트가 없습니다.<br>검수작업에서 파렛트수를 입력하세요.
    </div>`}
    ${editable ? '' : '<p class="form-note">처리 권한이 없어 조회만 가능합니다.</p>'}
  </div>
</div>
<div id="loc-panel"></div>`;

        box.querySelectorAll('[data-pallet]').forEach((el) => {
            el.addEventListener('click', () => openLocPanel(el.dataset.pallet));
        });

        /** 파렛트 1개의 로케이션 입력 패널 */
        function openLocPanel(palletId) {
            if (typeof locCleanup === 'function') locCleanup();
            const idx = pallets.findIndex((p) => p.id === palletId);
            const target = pallets[idx];
            locCleanup = mountLocationPanel(
                box.querySelector('#loc-panel'),
                { order: o, pallet: target, label: palletLabel(o.order_no, idx) },
                async (value) => {
                    try {
                        await db.setPalletLocation(target.id, value);
                        toast(`${palletLabel(o.order_no, idx)} → ${formatLocation(value)}`,
                            'success');
                        if (navigator.vibrate) navigator.vibrate(60);
                        // 다음 미지정 파렛트를 바로 이어서 입력할 수 있게 연다
                        const next = pallets.find((p, i) => i > idx && !p.location);
                        draw(orderId, next?.id ?? null);
                    } catch (err) {
                        toast(err.message, 'error');
                    }
                },
                async () => {
                    try {
                        await db.clearPalletLocation(target.id);
                        toast('로케이션을 지웠습니다.', 'success');
                        draw(orderId, target.id);
                    } catch (err) {
                        toast(err.message, 'error');
                    }
                },
            );
            box.querySelector('#loc-panel')
                .scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }

        if (openPalletId) openLocPanel(openPalletId);
    }

    const cleanup = mountScanBox(pane.querySelector('#scan-box'), async (no) => {
        const picked = await pickOrder(box, no, (id) => draw(id));
        if (picked) draw(picked.id);
    });

    return () => {
        cleanup();
        if (typeof locCleanup === 'function') locCleanup();
    };
}

/**
 * 로케이션 입력 패널.
 * 2D 바코드 스캔과 수기입력 중 하나를 고른다. 수기입력 자판은 계산기 배열이다.
 * @returns {Function} 정리 함수 (카메라 정지)
 */
function mountLocationPanel(host, { pallet, label }, onSave, onClear) {
    // 계산기와 같은 배열 - 위가 7 8 9, 아래가 0
    const KEYS = ['7', '8', '9', '4', '5', '6', '1', '2', '3', 'clr', '0', 'del'];
    let zone = '';
    let digits = '';

    host.innerHTML = `
<div class="card loc-panel">
  <div class="card__head">
    <h2>${esc(label)}</h2>
    <div class="toolbar__spacer"></div>
    ${pallet.location
        ? `<span class="tag tag--green">${esc(formatLocation(pallet.location))}</span>` : ''}
  </div>
  <div class="card__body">
    <div class="btn-row" style="margin-bottom:12px">
      <button class="btn btn--primary" id="loc-cam" type="button">📷 2D 바코드 스캔</button>
    </div>
    <video id="loc-video" playsinline muted hidden></video>
    <div id="loc-cam-note"></div>

    <label class="field" style="margin-top:14px">
      <span class="field__label">구역코드 (영문 2자리)</span>
      <input type="text" id="loc-zone" placeholder="IF" autocomplete="off"
             inputmode="text" maxlength="2" value="">
    </label>

    <div class="loc-preview" id="loc-preview">-</div>
    <p class="form-note" style="margin:0 0 10px">
      숫자 6자리를 누르면 <b>${LOCATION_FORMAT}</b> 형식으로 자동으로 끊어집니다.
    </p>

    <div class="keypad">
      ${KEYS.map((k) => `
      <button class="keypad__key ${k === 'del' || k === 'clr' ? 'keypad__key--del' : ''}"
              data-k="${k}" type="button">${
    k === 'del' ? '←' : k === 'clr' ? 'C' : k}</button>`).join('')}
    </div>

    <div class="btn-row" style="margin-top:14px">
      <button class="btn btn--success btn--lg" id="loc-save" type="button">로케이션 저장</button>
      ${pallet.location
        ? '<button class="btn btn--danger btn--lg" id="loc-clear" type="button">지우기</button>'
        : ''}
    </div>
  </div>
</div>`;

    const preview = host.querySelector('#loc-preview');
    const zoneInput = host.querySelector('#loc-zone');

    /** 입력 중인 값을 형식에 맞춰 실시간으로 보여준다 */
    const value = () => formatLocation(`${zone}${digits}`);
    const sync = () => {
        const v = value();
        preview.textContent = v || '-';
        preview.classList.toggle('is-empty', !v);
        preview.classList.toggle('is-ready', isValidLocation(v));
    };

    zoneInput.addEventListener('input', () => {
        // 구역코드는 영문 2자리만 받는다
        zoneInput.value = zoneInput.value.replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 2);
        zone = zoneInput.value;
        sync();
    });

    host.querySelectorAll('[data-k]').forEach((el) => {
        el.addEventListener('click', () => {
            const k = el.dataset.k;
            if (k === 'del') digits = digits.slice(0, -1);
            else if (k === 'clr') digits = '';
            else if (digits.length < 6) digits += k;      // 2자리 × 3묶음까지만
            sync();
        });
    });

    host.querySelector('#loc-save').addEventListener('click', () => {
        const v = value();
        if (!isValidLocation(v)) {
            toast(`로케이션은 ${LOCATION_FORMAT} 형식으로 입력하세요.`, 'error');
            return;
        }
        onSave(v);
    });
    host.querySelector('#loc-clear')?.addEventListener('click', onClear);

    // 2D 바코드(QR 등) 스캔 - 인식된 값을 그대로 로케이션으로 쓴다
    const video = host.querySelector('#loc-video');
    const scanner = createScanner(video, (code) => {
        const v = formatLocation(code);
        if (!isValidLocation(v)) {
            toast(`읽은 값이 ${LOCATION_FORMAT} 형식이 아닙니다: ${code}`, 'error');
            return;
        }
        scanner.stop();
        onSave(v);
    });

    if (!scanSupported()) {
        host.querySelector('#loc-cam').hidden = true;
        host.querySelector('#loc-cam-note').innerHTML = `
<p class="form-note">
  이 접속에서는 카메라를 쓸 수 없습니다 (HTTPS 또는 localhost 필요).
  아래에서 직접 입력하세요.
</p>`;
    }

    host.querySelector('#loc-cam').addEventListener('click', async () => {
        if (scanner.isOn()) {
            scanner.stop();
            return;
        }
        try {
            await scanner.start();
        } catch (err) {
            toast(err.message, 'error');
        }
    });

    sync();
    return () => scanner.stop();
}

/** 웹 - 주문의 적치 로케이션 조회 팝업 */
async function openLocationView(orderId) {
    const o = await db.getOrder(orderId);
    if (!o) return;
    const pallets = await db.listPallets(orderId);
    const done = pallets.filter((p) => p.location).length;
    openedModal?.close();
    openedModal = openModal(`${o.order_no} · 적치 로케이션`, `
<div class="toolbar" style="margin-bottom:10px">
  <span>${esc(o.customer)}</span>
  <div class="toolbar__spacer"></div>
  ${stowTag(done, pallets.length)}
  <span class="field__label">${done}/${pallets.length} 완료</span>
</div>
<table class="grid"><thead><tr>
  <th>파렛트</th><th>로케이션</th>
</tr></thead>
<tbody>
${pallets.length ? pallets.map((p, i) => `
<tr>
  <td>${esc(palletLabel(o.order_no, i))}</td>
  <td>${p.location
        ? `<b>${esc(formatLocation(p.location))}</b>`
        : '<span class="muted">미지정</span>'}</td>
</tr>`).join('') : '<tr><td colspan="2" class="empty">파렛트가 없습니다.</td></tr>'}
</tbody></table>`, { wide: true });
}

/* ------------------------------- 재고실사표 ------------------------------- */

/**
 * 재고실사표 대상 - 적치가 끝나고 아직 상차되지 않은 파렛트 전체.
 * 창고에서 실물을 확인할 목록이라 로케이션 순으로 정렬한다.
 */
async function stockRows(user) {
    const orders = (await db.listOrders({
        createdBy: can(user, 'viewAll') ? undefined : user.id,
    })).filter((o) => o.stow_done_at && !o.loaded_at && !o.canceled_at);

    const lists = await Promise.all(orders.map(async (o) => {
        const pallets = await db.listPallets(o.id);
        return pallets
            .filter((p) => p.location)
            .map((p) => ({
                location: formatLocation(p.location),
                order_no: o.order_no,
                customer: o.customer,
            }));
    }));

    return lists.flat().sort((a, b) => a.location.localeCompare(b.location));
}

/**
 * 재고실사표 팝업.
 * `적치확인` 과 `비고` 는 현장에서 손으로 적는 칸이라 빈 값으로 둔다.
 */
async function openStockSheet(user) {
    const rows = await stockRows(user);
    openedModal?.close();
    openedModal = openModal(`재고실사표 (${today()})`, `
<p class="form-note" style="margin:0 0 10px">
  적치가 끝나고 아직 상차되지 않은 파렛트 ${num(rows.length)}건입니다.
  적치확인·비고는 현장에서 직접 적는 칸이라 비워 둡니다.
</p>
<div class="table-wrap"><table class="grid">
<thead><tr>
  <th>로케이션</th><th>주문번호</th><th>거래처명</th>
  <th class="center">적치확인</th><th>비고</th>
</tr></thead>
<tbody>
${rows.length ? rows.map((r) => `
<tr>
  <td><b>${esc(r.location)}</b></td>
  <td>${esc(r.order_no)}</td>
  <td>${esc(r.customer)}</td>
  <td class="center"></td>
  <td></td>
</tr>`).join('') : '<tr><td colspan="5" class="empty">대상이 없습니다.</td></tr>'}
</tbody></table></div>`, {
        wide: true,
        footer: `
<span class="field__label">${num(rows.length)}건</span>
<div class="btn-row">
  <button class="btn" id="stock-csv" type="button">엑셀 다운로드</button>
  <button class="btn btn--primary" id="stock-print" type="button">인쇄</button>
</div>`,
    });

    openedModal.root.querySelector('#stock-csv').addEventListener('click', () => {
        downloadCsv(`재고실사표_${today()}.csv`,
            ['로케이션', '주문번호', '거래처명', '적치확인', '비고'],
            rows.map((r) => [r.location, r.order_no, r.customer, '', '']));
    });
    openedModal.root.querySelector('#stock-print').addEventListener('click', () => {
        printStockSheet(rows);
    });
}

/** 재고실사표 인쇄 - A4 가로 한 장에 표로 뽑는다 */
function printStockSheet(rows) {
    const win = window.open('', '_blank', 'width=980,height=1100');
    if (!win) {
        toast('팝업이 차단되었습니다. 팝업 허용 후 다시 시도하세요.', 'error');
        return;
    }
    win.document.write(`<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<title>재고실사표 ${today()}</title>
<style>
  @page { size: A4 portrait; margin: 12mm; }
  * { box-sizing: border-box; }
  body {
    /* A4(210mm)에서 좌우 12mm 여백을 뺀 폭으로 고정한다.
       고정하지 않으면 인쇄 시 표가 오른쪽 여백을 넘는다 */
    width: 186mm;
    margin: 0; color: #000;
    font-family: 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif;
  }
  h1 { margin: 0 0 4mm; font-size: 20pt; text-align: center; letter-spacing: 4px; }
  .meta { margin-bottom: 5mm; font-size: 10pt; display: flex; justify-content: space-between; }
  /* 밑줄을 문자로 그리면 폭이 밀려 표가 인쇄 여백을 넘는다 */
  .sign { display: inline-block; width: 32mm; border-bottom: 1px solid #000; }
  /* 고정폭이라야 지정한 컬럼 비율대로 나오고 인쇄 여백을 넘지 않는다 */
  table { width: 100%; table-layout: fixed; border-collapse: collapse; font-size: 11pt; }
  th, td { border: 1px solid #000; padding: 3mm 2mm; }
  th { background: #eee; }
  /* 손으로 적는 칸은 넉넉하게 비워 둔다 */
  td.blank { height: 9mm; }
  .loc { font-weight: 700; font-variant-numeric: tabular-nums; }
  thead { display: table-header-group; }   /* 여러 장이면 머리글을 반복한다 */
</style></head>
<body onload="window.print()">
  <h1>재 고 실 사 표</h1>
  <div class="meta">
    <span>출력일 ${today()}</span>
    <span>총 ${rows.length}건</span>
    <span>확인자 <span class="sign"></span></span>
  </div>
  <table>
    <thead><tr>
      <th style="width:22%">로케이션</th><th style="width:22%">주문번호</th>
      <th style="width:26%">거래처명</th><th style="width:12%">적치확인</th><th>비고</th>
    </tr></thead>
    <tbody>
      ${rows.map((r) => `
      <tr>
        <td class="loc">${esc(r.location)}</td>
        <td>${esc(r.order_no)}</td>
        <td>${esc(r.customer)}</td>
        <td class="blank"></td>
        <td class="blank"></td>
      </tr>`).join('')}
    </tbody>
  </table>
</body></html>`);
    win.document.close();
    win.focus();
}

/** 웹 - 상차대기 목록 표 */
function loadWaitTable(rows) {
    return `
<thead><tr>
  <th>출고일자</th><th>주문번호</th><th class="center">차수</th><th>거래처명</th>
  <th class="num">파렛트수</th><th class="center">적치로케이션</th><th class="center">상태</th>
</tr></thead>
<tbody>
${rows.map((o) => `
<tr>
  <td>${o.ship_req_date}</td>
  <td>${esc(o.order_no)}</td>
  <td class="center"><span class="seq ${o.seq > 1 ? 'seq--multi' : ''}">${o.seq}차수</span></td>
  <td>${esc(o.customer)}</td>
  <td class="num">${num(o.stow.total)}</td>
  <td class="center">${o.loaded_at
        ? '<span class="muted">-</span>'
        : `<button class="btn btn--sm" data-loc="${o.id}" type="button">로케이션 보기</button>`}</td>
  <td class="center">
    <span class="tag ${o.loaded_at ? 'tag--green' : 'tag--gray'}">
      ${o.loaded_at ? '상차완료' : '상차대기'}
    </span>
  </td>
</tr>`).join('')}
</tbody>`;
}

/** 웹 - 출고적치 목록 표 */
function stowTable(rows) {
    return `
<thead><tr>
  <th>출고일자</th><th>주문번호</th><th class="center">차수</th><th>거래처명</th>
  <th class="num">파렛트수</th><th class="center">출고적치</th>
</tr></thead>
<tbody>
${rows.map((o) => `
<tr>
  <td>${o.ship_req_date}</td>
  <td><span class="link" data-loc="${o.id}">${esc(o.order_no)}</span></td>
  <td class="center"><span class="seq ${o.seq > 1 ? 'seq--multi' : ''}">${o.seq}차수</span></td>
  <td>${esc(o.customer)}</td>
  <td class="num">${num(o.stow.total)}</td>
  <td class="center">
    ${stowTag(o.stow.done, o.stow.total)}
    <span class="field__label">${o.stow.done}/${o.stow.total}</span>
  </td>
</tr>`).join('')}
</tbody>`;
}

/* ------------------------------ 모바일 상차대기 ----------------------------- */

/**
 * 모바일 상차대기 탭.
 * 적치가 끝나 상차를 기다리는 주문을 목록으로 보여주고, 고르면 상세와 로케이션을 편다.
 * **상차완료된 건은 목록에서 빠진다.** (실제 상차 처리는 당일상차리스트에서 한다)
 */
async function renderLoadWaitTab(pane, user) {
    pane.innerHTML = `
<div id="picked"></div>
<div class="card">
  <div class="card__head">
    <h2>상차대기</h2>
    <span class="tag tag--gray" id="wait-count"></span>
  </div>
  <div class="card__body">
    <div class="table-wrap"><table class="grid grid--mobile" id="tbl"></table></div>
  </div>
</div>`;

    const picked = pane.querySelector('#picked');

    /** 적치가 끝났고 아직 상차되지 않은 주문 */
    async function targets() {
        const rows = await db.listOrders({
            createdBy: can(user, 'viewAll') ? undefined : user.id,
        });
        return rows.filter((o) => o.stow_done_at && !o.loaded_at && !o.canceled_at);
    }

    /** 고른 주문의 상세 + 파렛트별 로케이션 */
    async function drawPicked(orderId) {
        const o = await db.getOrder(orderId);
        if (!o) return;
        const pallets = await db.listPallets(orderId);
        picked.innerHTML = `
${orderSummary(o, {})}
<div class="card">
  <div class="card__head">
    <h2>적치 로케이션</h2>
    ${stowTag(pallets.filter((p) => p.location).length, pallets.length)}
    <div class="toolbar__spacer"></div>
    <span class="field__label">파렛트 ${num(pallets.length)}</span>
  </div>
  <div class="card__body">
    <table class="grid"><tbody>
      <tr><th>거래처명</th><td>${esc(o.customer)}</td></tr>
      <tr><th>출고요청일</th><td><b>${o.ship_req_date}</b></td></tr>
      <tr><th>차량구분</th><td>${esc(o.vehicle_type)}</td></tr>
      <tr><th>박스수</th><td>${o.box_count
        ? `${num(o.box_count)} 박스` : '<span class="muted">-</span>'}</td></tr>
      <tr><th>검수</th><td>${o.inspected}/${o.pallet_count}</td></tr>
    </tbody></table>
    <div class="pallet-list" style="margin-top:12px">
      ${pallets.map((p, i) => `
      <div class="pallet ${p.picked_at ? 'is-scanned' : ''}">
        <span class="pallet__mark">${p.picked_at ? '✅' : '⬜'}</span>
        <span class="pallet__code">${esc(palletLabel(o.order_no, i))}</span>
        <span class="pallet__loc">${p.location
        ? `<b>${esc(formatLocation(p.location))}</b>`
        : '<span class="muted">미지정</span>'}</span>
      </div>`).join('')}
    </div>
    <p class="form-note">
      상차 처리와 파렛트 내리기는 <b>당일상차리스트</b> 에서 합니다.
    </p>
  </div>
</div>`;
        picked.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    /** 목록 - 주문번호 · 거래처명 · 파렛트수 · 적치로케이션 */
    async function drawList() {
        const rows = await targets();
        const withLoc = await Promise.all(rows.map(async (o) => {
            const pallets = await db.listPallets(o.id);
            const locs = pallets.filter((p) => p.location).map((p) => formatLocation(p.location));
            return { ...o, locs };
        }));

        pane.querySelector('#wait-count').textContent = `${num(withLoc.length)}건`;
        const tbl = pane.querySelector('#tbl');
        if (!withLoc.length) {
            tbl.innerHTML = '<tbody><tr><td class="empty">상차대기 건이 없습니다.</td></tr></tbody>';
            return;
        }
        tbl.innerHTML = `
<thead><tr>
  <th>주문번호</th><th>거래처명</th><th class="num">파렛트</th><th>적치로케이션</th>
</tr></thead>
<tbody>
${withLoc.map((o) => `
<tr class="is-clickable" data-open="${o.id}">
  <td><span class="link">${esc(o.order_no)}</span></td>
  <td class="wrap">${esc(o.customer)}</td>
  <td class="num">${num(o.pallet_count)}</td>
  <td>${o.locs.length
        ? `${esc(o.locs[0])}${o.locs.length > 1 ? ` <span class="muted">외 ${o.locs.length - 1}</span>` : ''}`
        : '<span class="muted">-</span>'}</td>
</tr>`).join('')}
</tbody>`;
        tbl.querySelectorAll('[data-open]').forEach((el) => {
            el.addEventListener('click', () => drawPicked(el.dataset.open));
        });
    }

    await drawList();
    return db.subscribe(drawList);
}

/* ----------------------------- 웹: 진행중 목록 ----------------------------- */

/** 탭별 안내 문구 */
const PENDING_NOTE = {
    ship: '접수된 주문 중 아직 출고작업이 끝나지 않은 건입니다.',
    inspect: '출고작업이 끝나고 아직 검수되지 않은 건입니다.',
    stow: '검수가 끝난 건입니다. 적치가 끝난 건도 함께 보이고, 상차완료되면 빠집니다.',
    load: '적치까지 끝나 상차를 기다리는 건입니다. 상차완료된 건도 함께 보입니다.',
    extra: '접수된 조정요청·작업요청이 남아 있는 건입니다. (출고·검수 진행 여부와 무관하게 표시됩니다)',
};

/** 탭별 완료 판정 필드 - 값이 있으면 그 탭에서 할 일이 끝난 것이다 */
const DONE_FIELD = {
    ship: 'ship_done_at',
    inspect: 'inspect_done_at',
    stow: 'stow_done_at',
    load: 'loaded_at',
    extra: 'extra_done_at',
};

/** 탭별 검색어 (탭을 오가도 유지된다) */
const searchKw = {
    ship: '', inspect: '', stow: '', load: '', extra: '',
};

/** 완료된 건까지 함께 보여주는 탭 (나머지는 미완료만 보여준다) */
function showsDone(key) {
    return key === 'stow' || key === 'load';
}

/** 목록 행에서 주문을 꺼낸다 (조정요청 탭은 요청 안에 주문이 들어 있다) */
function orderOf(row) {
    return row.order ?? row;
}

/**
 * 웹 전용 - 탭 요약과 처리해야 할 주문 목록.
 * 처리 버튼은 두지 않는다. 실제 작업은 모바일에서 스캔으로 한다.
 */
async function renderPendingList(pane, key, user) {
    pane.innerHTML = `
<div class="sum-row">
  <div class="summary" id="summary"></div>
  <div class="sum-row__search">
    <label class="field">
      <span class="field__label">주문번호 / 거래처명</span>
      <input type="text" id="f-kw" placeholder="검색어 입력" value="${esc(searchKw[key])}"
             autocomplete="off" enterkeyhint="search">
    </label>
    <button class="btn" id="btn-search" type="button">조회</button>
    <button class="btn" id="btn-clear" type="button">초기화</button>
  </div>
</div>

<div class="card">
  <div class="card__head">
    <h2>${TABS.find((t) => t.key === key).label}${showsDone(key) ? ' 목록' : ' 진행중'}</h2>
    <span class="tag tag--gray" id="cnt"></span>
    <div class="toolbar__spacer"></div>
    ${key === 'load'
        ? '<button class="btn btn--sm" id="btn-stock" type="button">재고실사표</button>'
        : '<span class="field__label">처리는 모바일에서 스캔으로 진행합니다</span>'}
  </div>
  <div class="card__body">
    <p class="form-note" style="margin:0 0 12px">${PENDING_NOTE[key]}</p>
    <div class="table-wrap"><table class="grid" id="tbl"></table></div>
  </div>
</div>`;

    async function draw() {
        // 요약은 검색 결과 기준으로 집계한다 (검색어가 없으면 탭 전체)
        const all = matchKeyword(await tabRows(key, user), searchKw[key]);
        const done = all.filter((r) => orderOf(r)[DONE_FIELD[key]]).length;
        const rows = all.filter((r) => !orderOf(r)[DONE_FIELD[key]]);
        const listed = showsDone(key) ? all : rows;

        drawSummary(pane, all.length, done);
        pane.querySelector('#cnt').textContent = `${num(listed.length)}건`;

        const tbl = pane.querySelector('#tbl');
        if (!listed.length) {
            tbl.innerHTML = `<tbody><tr><td class="empty">${searchKw[key].trim()
                ? '검색 결과가 없습니다.' : '해당하는 건이 없습니다.'}</td></tr></tbody>`;
            return;
        }
        if (key === 'extra') {
            tbl.innerHTML = extraTable(rows);
        } else if (key === 'stow' || key === 'load') {
            // 이 두 탭은 완료된 건도 상태와 함께 보여준다
            const withCount = await withStow(all);
            tbl.innerHTML = key === 'stow' ? stowTable(withCount) : loadWaitTable(withCount);
            tbl.querySelectorAll('[data-loc]').forEach((el) => {
                el.addEventListener('click', () => openLocationView(el.dataset.loc));
            });
        } else {
            tbl.innerHTML = workTable(rows, key);
        }
    }

    pane.querySelector('#btn-stock')?.addEventListener('click', () => openStockSheet(user));

    const kw = pane.querySelector('#f-kw');
    const search = pane.querySelector('#btn-search');

    search.addEventListener('click', () => {
        searchKw[key] = kw.value;
        draw();
    });
    kw.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        search.click();
    });
    pane.querySelector('#btn-clear').addEventListener('click', () => {
        searchKw[key] = '';
        kw.value = '';
        draw();
    });

    await draw();
    return db.subscribe(draw);
}

/** 탭 요약 - 총건수 / 완료건수 / 미완료 / 완료율 */
function drawSummary(pane, total, done) {
    const pct = total ? Math.round((done / total) * 100) : 0;
    pane.querySelector('#summary').innerHTML = `
<div class="stat stat--accent">
  <div class="stat__label">총건수</div>
  <div class="stat__value">${num(total)}<small>건</small></div>
</div>
<div class="stat">
  <div class="stat__label">완료건수</div>
  <div class="stat__value">${num(done)}<small>건</small></div>
</div>
<div class="stat">
  <div class="stat__label">미완료</div>
  <div class="stat__value">${num(total - done)}<small>건</small></div>
</div>
<div class="stat">
  <div class="stat__label">완료율</div>
  <div class="stat__value">${pct}<small>%</small></div>
  <div class="bar"><div class="bar__fill ${pct === 100 ? 'bar__fill--done' : ''}"
       style="width:${pct}%"></div></div>
</div>`;
}

/**
 * 탭별 집계 대상(모수). 완료된 건까지 모두 담는다.
 * 목록에는 이 가운데 미완료만, 요약에는 전체를 쓴다.
 */
async function tabRows(key, user) {
    if (key === 'extra') {
        // 접수된 요청이 있고 아직 상차 전인 주문 (출고·검수 진행 여부는 보지 않는다)
        const list = await db.listRequestTasks();
        return list.filter(({ order: o }) => !o.canceled_at && !o.loaded_at);
    }
    const rows = await db.listOrders({
        createdBy: can(user, 'viewAll') ? undefined : user.id,
    });
    return rows
        // 검수작업 탭은 출고작업이 끝난 주문, 출고적치 탭은 검수까지 끝난 주문이 대상이다
        .filter((o) => {
            if (o.canceled_at) return false;
            // 출고적치는 검수완료 후 상차 전까지, 상차대기는 적치완료 후 마감 전까지 본다
            if (key === 'stow') return Boolean(o.inspect_done_at) && !o.loaded_at;
            if (key === 'load') return Boolean(o.stow_done_at) && !o.closed_at;
            return key === 'ship' || Boolean(o.ship_done_at);
        })
        .sort((a, b) => (a.ship_req_date === b.ship_req_date
            ? a.order_no.localeCompare(b.order_no)
            : a.ship_req_date.localeCompare(b.ship_req_date)));
}

/** 주문번호·거래처명 검색 (대소문자 구분 없음) */
function matchKeyword(rows, keyword) {
    const q = keyword.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
        const o = orderOf(r);
        return `${o.order_no} ${o.customer}`.toLowerCase().includes(q);
    });
}

/** 조정요청 탭의 미처리 요청 (탭 배지에서도 쓴다) */
async function pendingExtra() {
    return (await tabRows('extra')).filter(({ order: o }) => !o.extra_done_at);
}

/**
 * 작업자 셀 - 표시 전용.
 * 값은 모바일에서 주문번호를 스캔해 작업을 연 사람의 이름으로 자동 기록된다.
 */
function workerCell(name) {
    return name ? `<b>${esc(name)}</b>` : '<span class="muted">-</span>';
}

/** 출고작업/검수작업 목록 표 */
function workTable(rows, key) {
    const workerOf = (o) => (key === 'ship' ? o.ship_worker : o.inspect_worker);
    return `
<thead><tr>
  <th>출고요청일</th><th>주문번호</th><th class="center">차수</th><th>거래처명</th>
  <th class="center">차량구분</th><th class="center">요청작업</th>
  ${key === 'inspect' ? '<th class="num">파렛트수</th><th class="num">박스수</th>' : ''}
  <th class="center">작업자</th>
  <th class="center">${key === 'ship' ? '작업상태' : '출고완료'}</th>
</tr></thead>
<tbody>
${rows.map((o) => `
<tr>
  <td>${o.ship_req_date}</td>
  <td>${esc(o.order_no)}</td>
  <td class="center"><span class="seq ${o.seq > 1 ? 'seq--multi' : ''}">${o.seq}차수</span></td>
  <td>${esc(o.customer)}</td>
  <td class="center">${esc(o.vehicle_type)}</td>
  <td class="center">${(o.extra_works ?? []).length
        ? (o.extra_works).map((w) => `<span class="tag tag--blue">${esc(w)}</span>`).join(' ')
        : '<span class="muted">-</span>'}</td>
  ${key === 'inspect' ? `
  <td class="num">${o.pallet_count ? num(o.pallet_count) : '<span class="muted">-</span>'}</td>
  <td class="num">${o.box_count ? num(o.box_count) : '<span class="muted">-</span>'}</td>` : ''}
  <td class="center">${workerCell(workerOf(o))}</td>
  <td class="center">${key === 'ship'
        ? (o.ship_started_at
            ? '<span class="tag tag--blue">작업중</span>'
            : o.confirmed_at
                ? '<span class="tag tag--gray">대기</span>'
                : '<span class="tag tag--amber">미접수</span>')
        : fmtDateTime(o.ship_done_at)}</td>
</tr>`).join('')}
</tbody>`;
}

/** 추가작업 목록 표 */
function extraTable(rows) {
    return `
<thead><tr>
  <th>등록일자</th><th class="center">구분</th><th>주문번호</th><th class="center">차수</th>
  <th>거래처명</th><th>요청 내용</th><th>완료요청일</th><th class="center">작업자</th>
</tr></thead>
<tbody>
${rows.map((t) => { const o = t.order; return `
<tr>
  <td>${fmtDateTime(t.created_at)}</td>
  <td class="center">
    <span class="tag ${t.source === 'adjust' ? 'tag--amber' : 'tag--gray'}">
      ${t.source === 'adjust' ? adjustCategory(t.category).label : '작업요청'}
    </span>
  </td>
  <td>${esc(o.order_no)}</td>
  <td class="center"><span class="seq ${o.seq > 1 ? 'seq--multi' : ''}">${o.seq}차수</span></td>
  <td>${esc(o.customer)}</td>
  <td class="wrap">${esc(t.content)}</td>
  <td>${t.due_date || '-'}</td>
  <td class="center">${workerCell(o.extra_worker)}</td>
</tr>`; }).join('')}
</tbody>`;
}
