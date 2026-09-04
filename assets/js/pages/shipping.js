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
    adjustCategory, palletLabel, stowStatus, STOW_STATUS, YN,
    formatLocation, isValidLocation, LOCATION_FORMAT,
} from '../config.js';
import { can } from '../auth.js';
import * as db from '../db.js';
import { visibleSteps, stepsFlowHtml, loadDone } from '../steps.js';
import { createScanner, scanSupported } from '../scanner.js';
import { icon } from '../icons.js';
import {
    esc, num, today, fmtDateTime, toast, confirmDialog, openModal, downloadCsv, isMobile,
    monthDay, addBadge, seqTag, MOBILE_QUERY,
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
      <button class="btn" id="btn-cam" type="button">${icon('camera')} 스캔</button>
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

/** 요약 카드를 접어둔 상태인지 - 화면을 다시 그려도 유지한다 */
let headFolded = false;

/**
 * 주문 요약 카드 (단계 표시 포함).
 * `fold: true` 면 카드 하단에 접기/펼치기 손잡이가 붙고,
 * 접으면 **주문번호와 거래처명만 한 줄로** 남는다. `bindOrderHead()` 로 동작을 연결한다.
 */
function orderSummary(o, opt, { fold = false } = {}) {
    const steps = visibleSteps(o, opt);
    const folded = fold && headFolded;
    return `
<div class="work-head ${folded ? 'is-folded' : ''}" data-head>
  <div class="work-head__top">
    <strong>${esc(o.order_no)}</strong>
    <span class="tag tag--blue">${o.seq}차수</span>
    <span class="work-head__cust-inline">${esc(o.customer)}</span>
  </div>
  <div class="work-head__body">
    <div class="work-head__cust">${esc(o.customer)}</div>
    <div class="work-head__meta">
      <span>출고요청일 <b>${o.ship_req_date}</b></span>
      <span>출고형태 <b>${esc(o.vehicle_type)}</b></span>
      <span>파렛트 <b>${num(o.pallet_count)}</b></span>
    </div>
    ${steps.length ? `
    <div class="steps steps--flow">${stepsFlowHtml(steps, fmtDateTime)}</div>` : ''}
  </div>
  ${fold ? `
  <button class="work-head__fold" type="button" data-fold>
    ${folded ? '∨ 펼치기' : '∧ 접기'}
  </button>` : ''}
</div>`;
}

/** 요약 카드의 접기/펼치기 손잡이를 연결한다 */
function bindOrderHead(root) {
    const btn = root.querySelector('[data-fold]');
    if (!btn) return;
    btn.addEventListener('click', () => {
        headFolded = !headFolded;
        const head = root.querySelector('[data-head]');
        head.classList.toggle('is-folded', headFolded);
        btn.textContent = headFolded ? '∨ 펼치기' : '∧ 접기';
    });
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
${orderSummary(o, opt, { fold: true })}
<div class="card"><div class="card__body" id="work-body"></div></div>`;
        bindOrderHead(workBox);
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
/** 접수 시 작성된 작업지시 - 출고작업·검수작업 탭 상단에 보여준다 */
function workNoteHtml(o) {
    if (!o.work_note) return '';
    return `
<div class="work-note">
  <b>작업지시</b>
  <p>${esc(o.work_note)}</p>
</div>`;
}

function drawShip(body, o, user, editable, reload) {
    const started = Boolean(o.ship_started_at);
    const done = Boolean(o.ship_done_at);

    body.innerHTML = `
${workNoteHtml(o)}
<table class="grid"><tbody>
  <tr><th>작업자</th><td>${workerCell(o.ship_worker)}</td></tr>
  <tr><th>작업시작</th><td>${o.ship_started_at ? fmtDateTime(o.ship_started_at) : '-'}</td></tr>
  <tr><th>작업완료</th><td>${o.ship_done_at ? fmtDateTime(o.ship_done_at) : '-'}</td></tr>
</tbody></table>
${!o.confirmed_at ? `
<p class="form-note">⚠️ 아직 접수 처리되지 않은 주문입니다.
주문정보등록에서 접수 후 출고작업을 시작할 수 있습니다.</p>` : ''}
${editable ? `
<div class="btn-row" style="margin-top:16px">
  ${done ? `
  <button class="btn btn--danger btn--lg" id="btn-cancel" type="button">완료 취소</button>`
        : started ? `
  <button class="btn btn--success btn--lg" id="btn-done" type="button">작업완료</button>
  <button class="btn btn--danger btn--lg" id="btn-reset" type="button">시작 취소</button>`
            : o.confirmed_at ? `
  <button class="btn btn--primary btn--lg" id="btn-start" type="button">작업시작</button>` : ''}
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
    // 추가작업은 등록 시 '있음' 선택으로 판단한다 (옛 데이터는 extra_works 배열)
    const hasExtra = o.extra_yn === YN.YES || (o.extra_works ?? []).length > 0;
    const hasPacking = o.packing_yn === YN.YES;
    const done = Boolean(o.inspect_done_at);
    // 패킹리스트 내용은 주문정보등록 화면과 같은 값(packing_note)을 쓴다.
    // 편집 조건도 그 화면과 맞춘다 - 상차완료 전까지는 현장에서도 고칠 수 있다
    const written = Boolean((o.packing_note ?? '').trim());
    const canWritePacking = editable && !loadDone(o);

    if (!o.ship_done_at && !done) {
        body.innerHTML = `
<div class="empty">
  출고작업이 완료되지 않은 주문입니다.<br>
  출고작업 탭에서 먼저 완료 처리하세요.
</div>`;
        return;
    }

    body.innerHTML = `
${workNoteHtml(o)}
${hasExtra ? `
<div class="check-block">
  <label class="check">
    <input type="checkbox" id="chk-req" ${done ? 'checked' : ''} ${done ? 'disabled' : ''}>
    <span>요청작업 완료 확인</span>
  </label>
</div>` : '<p class="form-note">등록된 요청작업이 없습니다.</p>'}

${hasPacking ? `
<div class="check-block" id="packing-note-box">
  <span class="field__label">패킹리스트 내용
    <span class="tag ${written ? 'tag--green' : 'tag--gray'}">
      ${written ? '작성완료' : '미작성'}</span>
  </span>
  ${written
        ? `<p class="packing-note">${esc(o.packing_note)}</p>`
        : '<p class="form-note" style="margin:4px 0">작성된 패킹리스트가 없습니다.'
          + ' 작성해야 검수를 완료할 수 있습니다.</p>'}
  ${canWritePacking ? `
  <button class="btn btn--sm ${written ? '' : 'btn--primary'}"
          id="btn-packing-note" type="button">
    패킹리스트 ${written ? '수정' : '작성'}</button>` : ''}
</div>` : ''}

${done ? '' : `
<div class="form-grid" style="margin-top:14px">
  <label class="field">
    <span class="field__label">총 파렛트수<span class="req">*</span></span>
    <input type="number" id="in-pallet" min="${o.seq > 1 ? 0 : 1}" step="1" inputmode="numeric"
           placeholder="0" value="${o.pallet_count || (o.seq > 1 ? '0' : '')}">
  </label>
  <label class="field">
    <span class="field__label">총 박스수<span class="req">*</span></span>
    <input type="number" id="in-box" min="1" step="1" inputmode="numeric"
           placeholder="0" value="${o.box_count || ''}">
  </label>
</div>
<p class="form-note">
  검수하면서 센 실제 수량을 입력합니다. 입력한 파렛트 수만큼 상차 검수용 바코드가 만들어집니다.
  ${o.seq > 1 ? '<br><b>추가건은 기존 차수에 혼적하면 0파렛트로 둡니다.</b>' : ''}
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

    // 패킹리스트 내용 작성/수정 - 입력칸을 그 자리에 펼친다
    body.querySelector('#btn-packing-note')?.addEventListener('click', () => {
        const box = body.querySelector('#packing-note-box');
        box.innerHTML = `
<span class="field__label">패킹리스트 ${written ? '수정' : '작성'}</span>
<textarea id="packing-note-input" rows="6"
          placeholder="패킹리스트 내용을 작성하세요">${esc(o.packing_note ?? '')}</textarea>
<div class="btn-row" style="margin-top:8px">
  <button class="btn btn--sm" id="btn-packing-cancel" type="button">취소</button>
  <button class="btn btn--primary btn--sm" id="btn-packing-save" type="button">저장</button>
</div>`;
        box.querySelector('#btn-packing-cancel').addEventListener('click', reload);
        box.querySelector('#btn-packing-save').addEventListener('click', async () => {
            try {
                await db.setPackingNote(o.id, box.querySelector('#packing-note-input').value, user);
                toast(`패킹리스트를 ${written ? '수정' : '저장'}했습니다.`, 'success');
                reload();
            } catch (err) {
                toast(err.message, 'error');
            }
        });
    });

    body.querySelector('#btn-done')?.addEventListener('click', async () => {
        const checks = {
            reqWork: body.querySelector('#chk-req')?.checked ?? true,
            palletCount: Number(body.querySelector('#in-pallet')?.value),
            boxCount: Number(body.querySelector('#in-box')?.value),
        };
        // 추가건을 0파렛트로 넘기면 혼적 여부를 한 번 더 묻는다
        if (o.seq > 1 && checks.palletCount === 0) {
            const ok = await confirmDialog(
                '0파렛트로 처리됩니다.\n\n'
                + '기존 차수 파렛트에 함께 적재(혼적)하여 파렛트수가 늘지 않는 것이 맞습니까?',
            );
            if (!ok) return;
        }
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
        return list.filter(({ order: o }) => !o.canceled_at && !loadDone(o));
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

/* -------------------------------- 출고적치 탭 -------------------------------- */

/** 이동 방식 - 연속이동은 목록 순서대로, 건별이동은 고른 파렛트만 처리한다 */
const STOW_MODES = [
    { key: 'seq', label: '연속이동' },
    { key: 'one', label: '건별이동' },
];

/** 구역코드 입력 방식 - 자동은 앞자리를 따라붙이고, 수기는 넣은 값을 그대로 쓴다 */
const ZONE_MODES = [
    { key: 'auto', label: '자동' },
    { key: 'manual', label: '수기' },
];

/** 스캐너가 같은 값을 연달아 보내는 것을 무시하는 시간(ms) */
const STOW_REPEAT_MS = 2500;

/** 적치 입력 설정 - 탭을 다시 열어도 유지한다 */
const stowPrefs = { mode: 'seq', zoneMode: 'auto', zone: '', keypad: false };

function stowTag(done, total) {
    const st = stowStatus(done, total);
    const cls = st === STOW_STATUS.DONE ? 'tag--green'
        : st === STOW_STATUS.ING ? 'tag--blue' : 'tag--gray';
    return `<span class="tag ${cls}">${st}</span>`;
}

/** 주문 목록에 적치 진행 수와 상차 단위(차수 묶음)를 붙인다 */
async function withStow(rows) {
    return Promise.all(rows.map(async (o) => ({
        ...o,
        stow: await db.stowCount(o.id),
        group: await db.getLoadGroup(o.id),
    })));
}

/**
 * 모바일 출고적치 탭.
 * 주문번호를 스캔하면 파렛트 목록이 나오고, 상단에 고정된 입력 패널에서 로케이션을 넣는다.
 */
async function renderStowTab(pane, user, editable) {
    pane.innerHTML = '<div id="scan-box"></div><div id="stow-box"></div>';
    const box = pane.querySelector('#stow-box');
    let panelCleanup = null;

    /** 주문 1건의 적치 화면을 그린다 */
    async function draw(orderId) {
        if (typeof panelCleanup === 'function') panelCleanup();
        panelCleanup = null;

        const o = await db.getOrder(orderId);
        if (!o) return;
        if (!o.inspect_done_at) {
            box.innerHTML = `
${orderSummary(o, {}, { fold: true })}
<div class="empty">
  검수작업이 완료되지 않은 주문입니다.<br>
  검수작업 탭에서 먼저 완료 처리하세요.
</div>`;
            bindOrderHead(box);
            return;
        }

        box.innerHTML = `${orderSummary(o, {}, { fold: true })}<div id="stow-panel"></div>`;
        bindOrderHead(box);
        panelCleanup = await mountStowPanel(
            box.querySelector('#stow-panel'), { order: o, editable, user },
        );
    }

    const cleanup = mountScanBox(pane.querySelector('#scan-box'), async (no) => {
        const picked = await pickOrder(box, no, (id) => draw(id));
        if (picked) draw(picked.id);
    });

    return () => {
        cleanup();
        if (typeof panelCleanup === 'function') panelCleanup();
    };
}

/**
 * 적치 로케이션 입력 패널 + 파렛트 목록.
 *
 * 입력 패널은 화면 위에 **고정(sticky)** 되어 목록을 훑는 동안에도 계속 보인다.
 * 한 건 저장할 때마다 입력칸을 비우고 커서를 되돌려 스캐너로 연속 입력할 수 있다.
 *
 * @param {Element} host 그릴 위치
 * @param {{order:object, editable:boolean, user:object}} ctx
 * @returns {Promise<Function>} 정리 함수 (카메라 정지)
 */
async function mountStowPanel(host, { order, editable, user }) {
    // 계산기와 같은 배열 - 위가 7 8 9, 아래가 0
    const KEYS = ['7', '8', '9', '4', '5', '6', '1', '2', '3', 'clr', '0', 'del'];

    let pallets = await db.listPallets(order.id);
    let selectedId = null;      // 건별이동에서 고른 파렛트
    let moved = [];             // 이번 화면에서 이동 처리한 파렛트 id (먼저 넣은 것이 앞)
    let lastValue = '';         // 스캐너 중복 발사를 막기 위한 직전 입력값
    let lastAt = 0;

    host.innerHTML = `
<div class="stow-bar">
  <div class="card">
    <div class="card__head">${editable ? `
      <div class="seg seg--block" id="seg-mode" role="group" aria-label="이동 방식">
        ${STOW_MODES.map((m) => `
        <button class="seg__btn" data-mode="${m.key}" type="button">${m.label}</button>`).join('')}
      </div>` : '<h2>적치 로케이션</h2><div class="toolbar__spacer"></div>'}
      <span id="stow-state"></span>
    </div>
    <div class="card__body">${!editable ? `
      <p class="form-note">처리 권한이 없어 조회만 가능합니다.</p>` : `
      <div class="stow-zone" style="margin-top:0">
        <span class="field__label">구역코드</span>
        <div class="seg seg--sm" id="seg-zone" role="group" aria-label="구역코드 방식">
          ${ZONE_MODES.map((z) => `
          <button class="seg__btn" data-zone="${z.key}" type="button">${z.label}</button>`).join('')}
        </div>
        <input type="text" id="zone-code" class="stow-zone__code" placeholder="IF"
               autocomplete="off" maxlength="2" aria-label="구역코드">
      </div>
      <p class="form-note stow-note" id="zone-note"></p>

      <div class="stow-target" id="stow-target"></div>

      <div class="stow-input">
        <input type="text" id="loc-input" placeholder="010203" autocomplete="off"
               enterkeyhint="done" aria-label="로케이션 입력">
        <button class="btn btn--success btn--lg" id="loc-save" type="button">저장</button>
      </div>
      <div class="loc-preview" id="loc-preview">-</div>

      <div class="stow-tools">
        <button class="btn btn--danger stow-tool" id="loc-clear" type="button" hidden>지우기</button>
        <button class="btn btn--danger stow-tool" id="stow-cancel" type="button" hidden>
          적치취소</button>
        <button class="btn btn--success stow-tool" id="stow-done" type="button" hidden>
          적치완료</button>
        <button class="btn stow-tool" id="loc-cam" type="button">
          ${icon('camera')}카메라</button>
        <button class="btn stow-tool" id="loc-pad" type="button">
          ${icon('keypad')}자판</button>
      </div>
      <video id="loc-video" playsinline muted hidden></video>
      <div id="loc-cam-note"></div>

      <div class="keypad" id="keypad" hidden>
        ${KEYS.map((k) => `
        <button class="keypad__key ${k === 'del' || k === 'clr' ? 'keypad__key--del' : ''}"
                data-k="${k}" type="button">${
    k === 'del' ? '←' : k === 'clr' ? 'C' : k}</button>`).join('')}
      </div>`}
    </div>
  </div>
</div>

<div class="card">
  <div class="card__head">
    <h2>파렛트</h2>
  </div>
  <div class="card__body">
    <div class="pallet-list" id="pallet-list"></div>
  </div>
</div>`;

    const $ = (sel) => host.querySelector(sel);
    const list = $('#pallet-list');
    const input = $('#loc-input');

    /* ------------------------------ 대상 계산 ------------------------------ */

    /** 지금 로케이션을 넣을 파렛트 (연속이동은 첫 미지정, 건별이동은 고른 것) */
    function target() {
        if (stowPrefs.mode === 'one') {
            return pallets.find((p) => p.id === selectedId) ?? null;
        }
        return pallets.find((p) => !p.location) ?? null;
    }

    /** 파렛트의 표시 이름 */
    const nameOf = (p) => palletLabel(order.order_no, pallets.indexOf(p));

    /**
     * 입력값을 로케이션으로 만든다.
     * 구역코드가 `자동` 이고 숫자만 들어오면 앞에 구역코드를 붙인다 (010203 → IF-01-02-03).
     * `수기` 이거나 영문이 섞여 들어오면(로케이션 바코드 스캔) 넣은 값을 그대로 쓴다.
     */
    function compose(raw) {
        const s = String(raw ?? '').trim();
        if (!s) return '';
        if (stowPrefs.zoneMode === 'auto' && stowPrefs.zone && !/[a-zA-Z]/.test(s)) {
            return formatLocation(stowPrefs.zone + s);
        }
        return formatLocation(s);
    }

    /* -------------------------------- 그리기 -------------------------------- */

    /** 상단 상태 태그와 진행 수 */
    function drawState() {
        const done = pallets.filter((p) => p.location).length;
        $('#stow-state').innerHTML = `${stowTag(done, pallets.length)}
<span class="field__label" id="stow-count">${done}/${pallets.length}</span>`;
    }

    /** 지금 어느 파렛트에 넣는지 알려준다 */
    function drawTarget() {
        if (!editable) return;
        const t = target();
        const el = $('#stow-target');
        const rest = pallets.filter((p) => !p.location).length;

        if (stowPrefs.mode === 'one' && !t) {
            el.className = 'stow-target is-wait';
            el.innerHTML = '아래 목록에서 파렛트를 선택하세요.';
        } else if (!t) {
            el.className = 'stow-target is-done';
            el.innerHTML = `${icon('check')} 모든 파렛트의 적치가 끝났습니다.`;
        } else {
            el.className = 'stow-target';
            el.innerHTML = `
<span class="stow-target__label">${stowPrefs.mode === 'one' ? '선택' : '다음 대상'}</span>
<b>${esc(nameOf(t))}</b>
${t.location
        ? `<span class="tag tag--green">${esc(formatLocation(t.location))}</span>`
        : `<span class="stow-target__rest">남은 ${rest}건</span>`}`;
        }

        $('#loc-clear').hidden = !(t && t.location);
        // 전량 입력 → `적치완료` / 완료된 뒤 → `적치취소`
        const allFilled = pallets.length > 0 && pallets.every((p) => p.location);
        const stowed = Boolean(order.stow_done_at);
        $('#stow-done').hidden = !(allFilled && !stowed);
        $('#stow-cancel').hidden = !stowed;
        input.disabled = !t;
        $('#loc-save').disabled = !t;
    }

    /**
     * 목록에 뿌릴 순서.
     * 연속이동은 **방금 이동한 것이 맨 위**로 와야 눈으로 바로 확인할 수 있다.
     * 건별이동은 목록에서 골라야 하므로 파렛트 번호순을 그대로 둔다.
     */
    function ordered() {
        if (stowPrefs.mode !== 'seq' || !moved.length) return pallets;
        const recent = [...moved].reverse()
            .map((id) => pallets.find((p) => p.id === id))
            .filter(Boolean);
        return [...recent, ...pallets.filter((p) => !moved.includes(p.id))];
    }

    /** 파렛트 목록 */
    function drawList() {
        if (!pallets.length) {
            list.innerHTML = `
<div class="empty">파렛트가 없습니다.<br>검수작업에서 파렛트수를 입력하세요.</div>`;
            return;
        }
        const t = target();
        list.innerHTML = ordered().map((p) => `
<button class="pallet ${p.location ? 'is-scanned' : ''} ${p.id === t?.id ? 'is-target' : ''}"
        data-pallet="${p.id}" type="button" ${editable ? '' : 'disabled'}>
  <span class="pallet__mark">${icon(p.location ? 'check' : p.id === t?.id ? 'next' : 'square')}</span>
  <span class="pallet__code">${esc(nameOf(p))}</span>
  <span class="pallet__loc">${p.location
        ? `<b>${esc(formatLocation(p.location))}</b>`
        : '<span class="muted">미지정</span>'}</span>
</button>`).join('');

        list.querySelectorAll('[data-pallet]').forEach((el) => {
            el.addEventListener('click', () => pick(el.dataset.pallet));
        });
    }

    /** 입력 중인 값을 형식에 맞춰 크게 보여준다 */
    function drawPreview() {
        if (!editable) return;
        const v = compose(input.value);
        const el = $('#loc-preview');
        // 입력 전에는 빈 상자만 남으므로 값이 있을 때만 보여준다
        el.hidden = !v;
        el.textContent = v || '-';
        el.classList.toggle('is-ready', isValidLocation(v));
    }

    /** 모드·구역코드 선택 상태를 화면에 맞춘다 */
    function drawModes() {
        if (!editable) return;
        host.querySelectorAll('[data-mode]').forEach((el) => {
            el.classList.toggle('is-active', el.dataset.mode === stowPrefs.mode);
        });
        host.querySelectorAll('[data-zone]').forEach((el) => {
            el.classList.toggle('is-active', el.dataset.zone === stowPrefs.zoneMode);
        });

        const auto = stowPrefs.zoneMode === 'auto';
        const zoneInput = $('#zone-code');
        zoneInput.disabled = !auto;
        zoneInput.value = stowPrefs.zone;
        // 자동이고 구역코드가 정해졌으면 숫자만 받으면 되므로 숫자 자판을 띄운다
        input.inputMode = auto && stowPrefs.zone ? 'numeric' : 'text';
        input.placeholder = auto && stowPrefs.zone ? '010203' : LOCATION_FORMAT;
        const note = $('#zone-note');
        note.innerHTML = auto
            ? (stowPrefs.zone
                ? `숫자 6자리만 넣으면 <b>${esc(stowPrefs.zone)}-00-00-00</b> 으로 채워집니다.`
                : '⚠️ 구역코드를 먼저 넣으세요. 이후 입력에 계속 따라붙습니다.')
            : '넣은 값을 그대로 씁니다. (로케이션 바코드 스캔용)';
        note.classList.toggle('is-warn', auto && !stowPrefs.zone);
    }

    /** 목록·상태·대상을 다시 읽어 그린다 */
    async function refresh() {
        pallets = await db.listPallets(order.id);
        if (selectedId && !pallets.some((p) => p.id === selectedId)) selectedId = null;
        drawState();
        drawTarget();
        drawList();
    }

    /** 입력칸을 비우고 커서를 되돌린다 (스캐너 연속 입력) */
    function resetInput() {
        input.value = '';
        drawPreview();
        if (!input.disabled) input.focus();
    }

    /* -------------------------------- 동작 -------------------------------- */

    /** 목록에서 파렛트를 고른다. 연속이동 중이면 건별이동으로 넘어간다 */
    function pick(palletId) {
        if (!editable) return;
        if (stowPrefs.mode !== 'one') {
            stowPrefs.mode = 'one';
            toast('건별이동으로 바꿨습니다.', 'info');
            drawModes();
        }
        selectedId = palletId;
        drawTarget();
        drawList();
        resetInput();
    }

    /** 로케이션 저장 */
    async function save(pallet, value) {
        try {
            await db.setPalletLocation(pallet.id, value);
            toast(`${nameOf(pallet)} → ${value}`, 'success');
            moved = [...moved.filter((id) => id !== pallet.id), pallet.id];
            if (navigator.vibrate) navigator.vibrate(60);
            // 건별이동도 저장 뒤에는 다음 미지정 파렛트로 옮겨 이어서 넣게 한다
            const from = pallets.indexOf(pallet);
            selectedId = pallets.find((p, i) => i > from && !p.location)?.id
                ?? pallets.find((p) => !p.location && p.id !== pallet.id)?.id
                ?? null;
            await refresh();
            resetInput();
        } catch (err) {
            toast(err.message, 'error');
            resetInput();
        }
    }

    /**
     * 입력 확정.
     * 스캐너가 같은 값을 연달아 보내면 2.5초 안에는 무시하고,
     * 이미 다른 파렛트에 들어간 로케이션이면 알리고 다시 받는다.
     */
    function submit(raw) {
        const t = target();
        if (!t) {
            toast('로케이션을 넣을 파렛트가 없습니다.', 'error');
            return;
        }
        const v = compose(raw);
        if (!isValidLocation(v)) {
            toast(`로케이션은 ${LOCATION_FORMAT} 형식으로 입력하세요.`, 'error');
            resetInput();
            return;
        }

        const now = performance.now();
        if (v === lastValue && now - lastAt < STOW_REPEAT_MS) {
            resetInput();          // 스캐너 중복 발사 - 조용히 넘긴다
            return;
        }
        lastValue = v;
        lastAt = now;

        const dup = pallets.find((p) => p.id !== t.id && p.location
            && formatLocation(p.location) === v);
        if (dup) {
            toast(`${v} 는 ${nameOf(dup)} 에 이미 들어간 로케이션입니다. 다시 스캔하세요.`, 'error');
            if (navigator.vibrate) navigator.vibrate([70, 70, 70]);
            resetInput();
            return;
        }

        save(t, v);
    }

    /* ------------------------------ 이벤트 연결 ------------------------------ */

    if (editable) {
        host.querySelectorAll('[data-mode]').forEach((el) => {
            el.addEventListener('click', () => {
                stowPrefs.mode = el.dataset.mode;
                // 연속이동으로 돌아오면 첫 미지정 파렛트부터 다시 시작한다
                if (stowPrefs.mode === 'one' && !selectedId) {
                    selectedId = pallets.find((p) => !p.location)?.id ?? null;
                }
                drawModes();
                drawTarget();
                drawList();
                resetInput();
            });
        });

        host.querySelectorAll('[data-zone]').forEach((el) => {
            el.addEventListener('click', () => {
                stowPrefs.zoneMode = el.dataset.zone;
                drawModes();
                drawPreview();
                input.focus();
            });
        });

        $('#zone-code').addEventListener('input', (e) => {
            // 구역코드는 영문 2자리만 받는다
            e.target.value = e.target.value.replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 2);
            stowPrefs.zone = e.target.value;
            drawModes();
            drawPreview();
            if (stowPrefs.zone.length === 2) input.focus();
        });

        input.addEventListener('input', drawPreview);
        input.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();          // 외부 스캐너의 Enter 도 여기로 들어온다
            submit(input.value);
        });
        $('#loc-save').addEventListener('click', () => submit(input.value));

        host.querySelectorAll('[data-k]').forEach((el) => {
            el.addEventListener('click', () => {
                const k = el.dataset.k;
                if (k === 'del') input.value = input.value.slice(0, -1);
                else if (k === 'clr') input.value = '';
                else input.value += k;
                drawPreview();
            });
        });

        $('#loc-pad').addEventListener('click', () => {
            stowPrefs.keypad = !stowPrefs.keypad;
            syncKeypad();
        });

        $('#stow-done').addEventListener('click', async () => {
            try {
                await db.completeStow(order.id, user);
                toast('출고적치를 완료했습니다.', 'success');
                if (navigator.vibrate) navigator.vibrate(60);
                order.stow_done_at = new Date().toISOString();   // 화면 상태를 즉시 맞춘다
                await refresh();
                resetInput();
            } catch (err) {
                toast(err.message, 'error');
            }
        });

        $('#stow-cancel').addEventListener('click', async () => {
            const ok = await confirmDialog(
                '이 주문의 적치를 취소하시겠습니까?\n\n'
                + `입력한 로케이션 ${pallets.length}건이 모두 지워지고 처음부터 다시 넣어야 합니다.`,
            );
            if (!ok) return;
            try {
                await db.cancelStow(order.id, user);
                toast('출고적치를 취소했습니다.', 'success');
                order.stow_done_at = null;
                moved = [];
                selectedId = null;
                lastValue = '';
                await refresh();
                resetInput();
            } catch (err) {
                toast(err.message, 'error');
            }
        });

        $('#loc-clear').addEventListener('click', async () => {
            const t = target();
            if (!t) return;
            try {
                await db.clearPalletLocation(t.id);
                toast('로케이션을 지웠습니다.', 'success');
                moved = moved.filter((id) => id !== t.id);
                lastValue = '';
                selectedId = stowPrefs.mode === 'one' ? t.id : null;
                await refresh();
                resetInput();
            } catch (err) {
                toast(err.message, 'error');
            }
        });
    }

    /* ------------------------------ 카메라 스캔 ------------------------------ */

    const scanner = createScanner(host.querySelector('#loc-video'), (code) => submit(code));

    if (editable) {
        if (!scanSupported()) {
            $('#loc-cam').hidden = true;
            $('#loc-cam-note').innerHTML = `
<p class="form-note">
  이 접속에서는 카메라를 쓸 수 없습니다 (HTTPS 또는 localhost 필요).
  입력칸에 직접 넣거나 외부 스캐너를 쓰세요.
</p>`;
        }
        $('#loc-cam').addEventListener('click', async () => {
            if (scanner.isOn()) {
                scanner.stop();
                $('#loc-cam').classList.remove('btn--primary');
                $('#loc-cam').innerHTML = `${icon('camera')}카메라`;
                return;
            }
            try {
                await scanner.start();
                $('#loc-cam').classList.add('btn--primary');
                $('#loc-cam').innerHTML = `${icon('stop')}중지`;
            } catch (err) {
                toast(err.message, 'error');
            }
        });
    }

    /** 숫자 자판 펼침 상태를 화면에 맞춘다 */
    function syncKeypad() {
        if (!editable) return;
        $('#keypad').hidden = !stowPrefs.keypad;
        $('#loc-pad').classList.toggle('btn--primary', stowPrefs.keypad);
        host.querySelector('.stow-bar').classList.toggle('is-tall', stowPrefs.keypad);
    }

    // 연속이동은 목록 순서대로, 건별이동은 첫 미지정 파렛트부터 시작한다
    if (stowPrefs.mode === 'one') selectedId = pallets.find((p) => !p.location)?.id ?? null;
    drawModes();
    drawState();
    drawTarget();
    drawList();
    drawPreview();
    syncKeypad();
    if (editable && !input.disabled) {
        // 자동인데 구역코드가 비어 있으면 그것부터 받는다
        const first = stowPrefs.zoneMode === 'auto' && !stowPrefs.zone ? $('#zone-code') : input;
        first.focus();
    }

    return () => scanner.stop();
}

/** 웹 - 주문의 적치 로케이션 조회 팝업 */
async function openLocationView(orderId) {
    // 추가주문까지 한 거래처로 실리므로 차수를 묶어서 보여준다
    const g = await db.getLoadGroup(orderId);
    if (!g) return;
    const { head, rows, pallets } = g;
    const done = pallets.filter((p) => p.location).length;
    openedModal?.close();
    openedModal = openModal(`${head.order_no} · 적치 로케이션`, `
<div class="toolbar" style="margin-bottom:10px">
  <span>${esc(head.customer)}${addBadge(rows.length)}</span>
  <div class="toolbar__spacer"></div>
  ${stowTag(done, pallets.length)}
  <span class="field__label">${done}/${pallets.length} 완료</span>
</div>
<table class="grid"><thead><tr>
  <th class="center">차수</th><th>파렛트</th><th>로케이션</th>
</tr></thead>
<tbody>
${pallets.length ? pallets.map((p) => `
<tr>
  <td class="center">${seqTag(p.seq, '차')}</td>
  <td>${esc(p.label)}</td>
  <td>${p.location
        ? `<b>${esc(formatLocation(p.location))}</b>`
        : '<span class="muted">미지정</span>'}</td>
</tr>`).join('') : '<tr><td colspan="3" class="empty">파렛트가 없습니다.</td></tr>'}
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
    // 상차완료된 건만 뺀다 (상차 정보가 어긋난 건은 아직 창고에 있으므로 남긴다)
    })).filter((o) => o.stow_done_at && !loadDone(o) && !o.canceled_at);

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

/**
 * 상차대기 상태 태그.
 * 🔑 상차완료는 **단계 시각(loaded_at)과 상차 상태(load_status)가 모두 완료**일 때만이다.
 * 한쪽만 완료인 건은 아직 실리지 않은 것이므로 `상차대기` 로 본다.
 */
function loadStatusTag(o) {
    return loadDone(o)
        ? '<span class="tag tag--green">상차완료</span>'
        : '<span class="tag tag--gray">상차대기</span>';
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
  <td>${esc(o.order_no)}${addBadge(o.group.rows.length)}</td>
  <td class="center"><span class="seq">${o.group.rows.length}개 차수</span></td>
  <td>${esc(o.customer)}</td>
  <td class="num">${num(o.group.pallets.length)}</td>
  <td class="center">${loadDone(o)
        ? '<span class="muted">-</span>'
        : `<button class="btn btn--sm" data-loc="${o.id}" type="button">로케이션 보기</button>`}</td>
  <td class="center">${loadStatusTag(o)}</td>
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
  <td class="center">${seqTag(o.seq)}</td>
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
        return rows
            // 상차완료된 건만 뺀다. 상차 정보가 어긋난 건은 남겨 눈에 띄게 한다
            .filter((o) => o.stow_done_at && !loadDone(o) && !o.canceled_at)
            // 추가주문은 1차수와 함께 실리므로 대표(가장 낮은 차수)만 남긴다
            .filter((o, _i, all) => !all.some(
                (x) => (x.base_no ?? x.order_no) === (o.base_no ?? o.order_no) && x.seq < o.seq,
            ));
    }

    /** 고른 주문의 상세 + 파렛트별 로케이션 */
    async function drawPicked(orderId) {
        const g = await db.getLoadGroup(orderId);
        if (!g) return;
        const o = g.head;
        const pallets = g.pallets;
        picked.innerHTML = `
${orderSummary(o, {})}
${g.rows.length > 1 ? `
<p class="form-note">추가주문 ${g.rows.length - 1}건이 함께 실립니다 (전체 ${g.rows.length}개 차수).</p>` : ''}
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
      <tr><th>출고형태</th><td>${esc(o.vehicle_type)}</td></tr>
      <tr><th>박스수</th><td>${o.box_count
        ? `${num(o.box_count)} 박스` : '<span class="muted">-</span>'}</td></tr>
      <tr><th>검수</th><td>${o.inspected}/${o.pallet_count}</td></tr>
    </tbody></table>
    <div class="pallet-list" style="margin-top:12px">
      ${pallets.map((p) => `
      <div class="pallet ${p.picked_at ? 'is-scanned' : ''}">
        ${seqTag(p.seq, '차')}
        <span class="pallet__code">${esc(p.label)}</span>
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
            const g = await db.getLoadGroup(o.id);
            const locs = g.pallets.filter((p) => p.location)
                .map((p) => formatLocation(p.location));
            return { ...o, locs, group: g };
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
  <td><span class="link">${esc(o.order_no)}</span>${addBadge(o.group.rows.length)}</td>
  <td class="wrap">${esc(o.customer)}</td>
  <td class="num">${num(o.group.pallets.length)}</td>
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

/**
 * 탭의 처리가 끝났는지. 상차대기만 단계 시각과 상차 상태를 함께 본다
 * (한쪽만 완료인 건을 완료로 세면 요약과 목록이 어긋난다).
 */
function tabDone(key, o) {
    return key === 'load' ? loadDone(o) : Boolean(o[DONE_FIELD[key]]);
}

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
        const done = all.filter((r) => tabDone(key, orderOf(r))).length;
        const rows = all.filter((r) => !tabDone(key, orderOf(r)));
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
        return list.filter(({ order: o }) => !o.canceled_at && !loadDone(o));
    }
    const rows = await db.listOrders({
        createdBy: can(user, 'viewAll') ? undefined : user.id,
    });
    return rows
        // 검수작업 탭은 출고작업이 끝난 주문, 출고적치 탭은 검수까지 끝난 주문이 대상이다
        .filter((o) => {
            if (o.canceled_at) return false;
            // 출고적치는 검수완료 후 상차 전까지, 상차대기는 적치완료 후 마감 전까지 본다
            if (key === 'stow') return Boolean(o.inspect_done_at) && !loadDone(o);
            // 추가주문은 1차수와 함께 실리므로 대표(가장 낮은 차수)만 목록에 둔다
            if (key === 'load') {
                if (!o.stow_done_at || o.closed_at) return false;
                const base = o.base_no ?? o.order_no;
                return !rows.some((x) => (x.base_no ?? x.order_no) === base
                    && !x.canceled_at && x.stow_done_at && !x.closed_at && x.seq < o.seq);
            }
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

/**
 * 출고작업/검수작업 목록 표.
 * 추가작업 컬럼에는 주문정보등록에서 접수할 때 쓴 작업지시(`work_note`)를 보여준다.
 */
function workTable(rows, key) {
    const workerOf = (o) => (key === 'ship' ? o.ship_worker : o.inspect_worker);
    return `
<thead><tr>
  <th>출고요청일</th><th>주문번호</th><th class="center">차수</th><th>거래처명</th>
  <th class="center">출고형태</th><th>추가작업</th>
  ${key === 'inspect' ? '<th class="num">파렛트수</th><th class="num">박스수</th>' : ''}
  <th class="center">작업자</th>
  <th class="center">${key === 'ship' ? '작업상태' : '출고완료'}</th>
</tr></thead>
<tbody>
${rows.map((o) => `
<tr>
  <td>${o.ship_req_date}</td>
  <td>${esc(o.order_no)}</td>
  <td class="center">${seqTag(o.seq)}</td>
  <td>${esc(o.customer)}</td>
  <td class="center">${esc(o.vehicle_type)}</td>
  <td class="wrap">${esc(o.work_note) || '<span class="muted">-</span>'}</td>
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
  <td class="center">${seqTag(o.seq)}</td>
  <td>${esc(o.customer)}</td>
  <td class="wrap">${esc(t.content)}</td>
  <td>${t.due_date || '-'}</td>
  <td class="center">${workerCell(o.extra_worker)}</td>
</tr>`; }).join('')}
</tbody>`;
}
