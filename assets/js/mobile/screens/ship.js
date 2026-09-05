/**
 * 출고작업 (모바일 앱).
 *
 *   #/ship        스캔 · 출고 대상 목록
 *   #/ship/:id    작업시작 · 작업완료 · 시작 취소 · 완료 취소
 *
 * 🔑 묶음은 db.getBatchGroup 을 쓴다 - **대표주문번호 묶음만** 함께 처리되고
 * 추가주문 차수는 차수마다 따로 처리한다. 화면에서 다시 묶지 않는다.
 * (적치·상차의 db.getLoadGroup 과 혼동하면 뒤늦게 합류한 주문이 막힌다)
 *
 * 검수작업은 별도 탭(#/inspect)이다. 여기서는 출고작업만 다루고,
 * 단계가 다른 주문을 열면 안내와 함께 그 탭으로 가는 버튼을 낸다.
 */
import { ORDER_STATE } from '../../config.js';
import { can } from '../../auth.js';
import { visibleSteps } from '../../steps.js';
import * as db from '../../db.js';
import { icon } from '../../icons.js';
import {
    esc, num, fmtDateTime, toast, confirmDialog,
} from '../../util.js';
import {
    emptyState, tag, seqTag, plusBadge, card, orderHead, bindOrderHead,
    stepBar, workNoteHtml, stepOpt, mountScan, actionDock, pollGuard,
    menuSheet, closeAllSheets,
} from '../ui.js';

/** 목록 검색어 - 상세를 다녀와도 유지한다 */
const filter = { keyword: '' };

export async function render(root, { user, params }) {
    return params[0]
        ? renderDetail(root, user, params[0])
        : renderList(root, user);
}

/* ============================ 목록 · 스캔 (§5-3) ============================ */

async function renderList(root, user) {
    root.innerHTML = `
<label class="m-search">
  ${icon('search', 'm-icon')}
  <input type="search" id="f-kw" placeholder="주문번호 · 거래처명"
         value="${esc(filter.keyword)}" aria-label="검색">
</label>
<p class="m-sum" id="sum"></p>
<p class="m-listtitle">출고 대상 (접수 · 출고작업 전)</p>
<div id="list"></div>
<div id="scanhost"></div>
<div id="dockhost"></div>`;

    const sumEl = root.querySelector('#sum');
    const listEl = root.querySelector('#list');

    async function reload() {
        // 웹 출고작업 탭(tabRows('ship'))과 같은 조건이다.
        // 취소된 주문만 빼고, 묶음 전체가 끝난 건은 목록에서 내린다
        const rows = (await db.listOrders({
            createdBy: can(user, 'viewAll') ? undefined : user.id,
            keyword: filter.keyword,
        })).filter((o) => !o.canceled_at);
        draw(db.repGroups(rows));
    }

    function draw(groups) {
        const open = groups.filter((g) => !g.rows.every((r) => r.ship_done_at));
        const going = open.filter((g) => g.rows.some((r) => r.ship_started_at)).length;
        sumEl.innerHTML = groups.length ? `
<span>대기 <b>${num(open.length - going)}</b></span>
<span>진행 <b>${num(going)}</b></span>
<span>완료 <b>${num(groups.length - open.length)}</b></span>` : '';

        listEl.innerHTML = open.length
            ? open.map(shipCard).join('')
            : emptyState(filter.keyword.trim()
                ? '검색 결과가 없습니다.'
                : '출고작업할 주문이 없습니다.');
    }

    root.querySelector('#f-kw').addEventListener('input', (e) => {
        filter.keyword = e.target.value;
        reload();
    });

    listEl.addEventListener('click', (e) => {
        const row = e.target.closest('.m-card[data-id]');
        if (row) location.hash = `#/ship/${row.dataset.id}`;
    });

    const scan = mountScan(root, (id) => {
        location.hash = `#/ship/${id}`;
    });

    await reload();
    const unwatch = db.subscribe(pollGuard(root, reload), 5000);
    return () => {
        closeAllSheets();
        scan.destroy();
        unwatch();
    };
}

/** 목록 카드 한 장 - 상태는 주문정보등록의 확인 컬럼과 같은 말을 쓴다 */
function shipCard(g) {
    const o = g.head;
    const no = esc(o.rep_no || o.order_no);
    const started = g.rows.some((r) => r.ship_started_at);
    const confirmed = g.rows.every((r) => r.confirmed_at);
    const state = started ? ORDER_STATE.DOING
        : confirmed ? ORDER_STATE.ACCEPTED : ORDER_STATE.WAIT;
    const body = `
<span class="m-card__cust">${esc(o.customer)}</span>
<span class="m-card__meta">${seqTag(o.seq, '차수')} ${esc(o.vehicle_type)}
  · 출고 ${esc(o.ship_req_date ?? '미정')}</span>`;

    return card(o.rep_no ? `<b>${no}</b>` : no, body, {
        badges: `${o.rep_no ? tag('대표', 'amber') : ''}${plusBadge(g.rows.length)}`,
        status: tag(state, started ? 'blue' : confirmed ? 'amber' : 'gray'),
        attrs: { id: o.id },
        tap: true,
    });
}

/* ================================ 상세 (§5-1) ================================ */

async function renderDetail(root, user, orderId) {
    const editable = can(user, 'updateStatus');
    let g = await db.getBatchGroup(orderId);
    if (!g) {
        root.innerHTML = emptyState('주문을 찾을 수 없습니다.',
            { label: '출고작업 목록으로', href: '#/ship' });
        return null;
    }
    // 스캔해서 작업을 연 사람이 이 단계의 작업자가 된다 (조회 권한만 있으면 기록하지 않는다).
    // 주문이 있는지 확인한 뒤에 기록한다
    if (editable) await db.recordWorker(orderId, 'ship', user);
    let opt = await stepOpt(g.head);

    root.innerHTML = `
<div id="head"></div>
<div id="body"></div>
<div id="dockhost"></div>`;

    const headEl = root.querySelector('#head');
    const bodyEl = root.querySelector('#body');
    const dockCtl = actionDock(root.querySelector('#dockhost'));

    async function refresh() {
        const next = await db.getBatchGroup(orderId);
        if (!next) return;
        g = next;
        opt = await stepOpt(g.head);
        draw();
    }

    /** 처리 후 공통 뒷정리 - 실패 문구는 데이터 계층이 준 것을 그대로 쓴다 */
    async function run(fn, msg) {
        try {
            await fn();
            toast(msg, 'success');
        } catch (err) {
            toast(err.message, 'error');
        }
        await refresh();
    }

    function draw() {
        const o = g.head;
        const rows = g.rows;
        const started = Boolean(o.ship_started_at);
        const done = Boolean(o.ship_done_at);
        // 처리는 묶음 전체에 적용된다. 접수되지 않은 주문이 있으면 시작할 수 없다
        const waiting = rows.filter((r) => !r.confirmed_at);
        const inspected = Boolean(o.inspect_done_at);

        // 위험 조작(완료 취소)은 독에 두지 않고 `···` 메뉴에만 둔다
        const more = editable && done && !inspected;
        headEl.innerHTML = orderHead(o, {
            group: g,
            more,
            meta: `${seqTag(o.seq, '차수')} ${esc(o.customer)} · ${esc(o.vehicle_type)}`
                + ` · 출고 ${esc(o.ship_req_date ?? '미정')}`,
            note: rows.length > 1
                ? `묶인 주문 ${rows.length}건이 한 번에 처리됩니다`
                    + ` (${esc(rows.map((r) => r.order_no).join(', '))}).`
                : '',
        }) + stepBar(visibleSteps(o, opt));
        bindOrderHead(headEl, {
            onMore: () => menuSheet([{
                label: '출고작업 완료 취소', icon: 'trash', tone: 'danger', onPick: doCancelDone,
            }]),
        });

        bodyEl.innerHTML = `
${workNoteHtml(o)}
<div class="m-kv">
  <div class="m-kv__row"><span class="m-kv__k">작업자</span>
    <span class="m-kv__v">${o.ship_worker ? esc(o.ship_worker) : '-'}</span></div>
  <div class="m-kv__row"><span class="m-kv__k">작업시작</span>
    <span class="m-kv__v">${o.ship_started_at ? esc(fmtDateTime(o.ship_started_at)) : '-'}</span>
  </div>
  <div class="m-kv__row"><span class="m-kv__k">작업완료</span>
    <span class="m-kv__v">${o.ship_done_at ? esc(fmtDateTime(o.ship_done_at)) : '-'}</span></div>
</div>
${waiting.length && !done ? `
<div class="m-guide">
  <p>아직 접수되지 않은 주문이 있습니다
    (${esc(waiting.map((r) => r.order_no).join(', '))}).<br>
    주문정보등록에서 접수한 뒤 출고작업을 시작할 수 있습니다.</p>
</div>` : ''}
${inspected ? `
<div class="m-guide">
  <p>검수작업까지 완료된 주문입니다. 출고작업을 되돌리려면 검수를 먼저 취소하세요.</p>
  <a class="m-btn m-btn--primary" href="#/inspect/${esc(o.id)}">검수작업으로</a>
</div>` : ''}
${editable ? '' : '<p class="m-note">처리 권한이 없어 조회만 가능합니다.</p>'}`;

        syncDock({
            started, done, inspected, blocked: waiting.length > 0,
        });
    }

    /** 하단 독 - 지금 할 수 있는 동작 하나(또는 둘)만 남긴다 */
    function syncDock({ started, done, inspected, blocked }) {
        // 검수까지 끝났으면 여기서 할 일이 없다. 되돌리기는 검수작업 탭에서 시작한다.
        // 완료된 뒤에도 독을 비운다 - 완료 취소는 `···` 메뉴로만 한다
        if (!editable || inspected || done || (!started && blocked)) {
            dockCtl.hide();
            return;
        }
        const spec = started ? {
            mode: 'pair',
            secondary: { label: '시작 취소' },
            primary: { label: '작업완료', tone: 'go', icon: 'check' },
            onSecondary: doCancelStart,
            onPrimary: doDone,
        } : {
            mode: 'action',
            primary: { label: '작업시작', tone: 'primary' },
            onPrimary: doStart,
        };
        dockCtl.set(spec);
    }

    function doStart() {
        return run(() => db.startShipWork(orderId, user), '출고작업을 시작했습니다.');
    }

    function doDone() {
        return run(() => db.setShipWorkDone(orderId, true, user), '출고작업을 완료했습니다.');
    }

    async function doCancelStart() {
        if (!await confirmDialog('작업시작을 취소하시겠습니까?')) return;
        await run(() => db.setShipWorkDone(orderId, false, user), '작업시작을 취소했습니다.');
    }

    async function doCancelDone() {
        const msg = g.rows.length > 1
            ? `묶인 주문 ${g.rows.length}건의 출고작업 완료를 모두 취소하시겠습니까?`
            : '출고작업 완료를 취소하시겠습니까?';
        if (!await confirmDialog(msg)) return;
        await run(() => db.setShipWorkDone(orderId, false, user), '출고작업 완료를 취소했습니다.');
    }

    draw();
    const unwatch = db.subscribe(pollGuard(root, refresh), 5000);
    return () => {
        closeAllSheets();
        dockCtl.destroy();
        unwatch();
    };
}
