/**
 * 검수작업 (모바일 앱).
 *
 *   #/inspect        스캔 · 검수 대상 목록 (출고완료 · 검수 전)
 *   #/inspect/:id    요청작업 확인 · 패킹리스트 · 총 파렛트수/박스수 · 검수완료
 *
 * 🔑 묶음은 db.getBatchGroup 을 쓴다 - **대표주문번호 묶음만** 함께 검수되고
 * 총 파렛트수·박스수도 묶음 총량을 1회 입력한다 (총량은 db 가 대표에 싣는다).
 * 추가주문 차수는 차수마다 따로 검수한다. 화면에서 다시 묶지 않는다.
 *
 * 출고작업은 별도 탭(#/ship)이다. 출고가 끝나지 않은 주문을 열면 안내와 함께
 * 그 탭으로 가는 버튼을 낸다.
 *
 * 작업지시 박스·스캔 진입·단계 옵션은 출고작업 탭과 같은 조각을 쓴다 (mobile/ui.js).
 */
import { YN } from '../../config.js';
import { can } from '../../auth.js';
import { visibleSteps, loadDone } from '../../steps.js';
import * as db from '../../db.js';
import { icon } from '../../icons.js';
import {
    esc, num, fmtDateTime, toast, confirmDialog,
} from '../../util.js';
import {
    emptyState, tag, seqTag, plusBadge, card, orderHead, bindOrderHead,
    stepBar, sheet, workNoteHtml, stepOpt, mountScan, actionDock, pollGuard,
    menuSheet, closeAllSheets,
} from '../ui.js';

/** 목록 검색어 - 상세를 다녀와도 유지한다 */
const filter = { keyword: '' };

/**
 * 입력 중인 검수 실측값 - 실시간 갱신으로 화면을 다시 그려도 값이 날아가지 않게
 * 화면 밖에 둔다. 주문이 바뀌면 비운다.
 */
const form = { id: null, pallet: '', box: '', reqWork: false };

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
<p class="m-listtitle">검수 대상 (출고완료 · 검수 전)</p>
<div id="list"></div>
<div id="scanhost"></div>
<div id="dockhost"></div>`;

    const sumEl = root.querySelector('#sum');
    const listEl = root.querySelector('#list');

    async function reload() {
        // 웹 검수작업 탭(tabRows('inspect'))과 같은 조건이다 - 출고작업이 끝난 주문만 대상이다
        const rows = (await db.listOrders({
            createdBy: can(user, 'viewAll') ? undefined : user.id,
            keyword: filter.keyword,
        })).filter((o) => !o.canceled_at && o.ship_done_at);
        draw(db.repGroups(rows));
    }

    function draw(groups) {
        const open = groups.filter((g) => !g.rows.every((r) => r.inspect_done_at));
        sumEl.innerHTML = groups.length ? `
<span>검수대기 <b>${num(open.length)}</b></span>
<span>완료 <b>${num(groups.length - open.length)}</b></span>` : '';

        listEl.innerHTML = open.length
            ? open.map(inspectCard).join('')
            : emptyState(filter.keyword.trim()
                ? '검색 결과가 없습니다.'
                : '검수작업할 주문이 없습니다. (출고작업이 끝난 주문만 나옵니다)');
    }

    root.querySelector('#f-kw').addEventListener('input', (e) => {
        filter.keyword = e.target.value;
        reload();
    });

    listEl.addEventListener('click', (e) => {
        const row = e.target.closest('.m-card[data-id]');
        if (row) location.hash = `#/inspect/${row.dataset.id}`;
    });

    const scan = mountScan(root, (id) => {
        location.hash = `#/inspect/${id}`;
    });

    await reload();
    const unwatch = db.subscribe(pollGuard(root, reload), 5000);
    return () => {
        closeAllSheets();
        scan.destroy();
        unwatch();
    };
}

/** 목록 카드 한 장 - 검수에 필요한 조건(요청작업·패킹리스트)을 배지로 미리 보여준다 */
function inspectCard(g) {
    const o = g.head;
    const no = esc(o.rep_no || o.order_no);
    const body = `
<span class="m-card__cust">${esc(o.customer)}</span>
<span class="m-card__meta">${seqTag(o.seq, '차수')} ${esc(o.vehicle_type)}
  · 출고 ${esc(o.ship_req_date ?? '미정')}</span>`;

    return card(o.rep_no ? `<b>${no}</b>` : no, body, {
        badges: `${o.rep_no ? tag('대표', 'amber') : ''}${plusBadge(g.rows.length)}`,
        status: `${g.rows.some(db.hasExtraWork) ? tag('요청작업', 'blue') : ''}`
            + `${g.rows.some((r) => r.packing_yn === YN.YES) ? tag('패킹', 'amber') : ''}`,
        attrs: { id: o.id },
        tap: true,
    });
}

/* ================================ 상세 (§5-2) ================================ */

async function renderDetail(root, user, orderId) {
    const editable = can(user, 'updateStatus');
    let g = await db.getBatchGroup(orderId);
    if (!g) {
        root.innerHTML = emptyState('주문을 찾을 수 없습니다.',
            { label: '검수작업 목록으로', href: '#/inspect' });
        return null;
    }
    // 스캔해서 작업을 연 사람이 이 단계의 작업자가 된다 (조회 권한만 있으면 기록하지 않는다).
    // 주문이 있는지 확인한 뒤에 기록한다
    if (editable) await db.recordWorker(orderId, 'inspect', user);
    let opt = await stepOpt(g.head);
    if (form.id !== orderId) {
        form.id = orderId;
        form.pallet = g.head.pallet_count || (g.head.seq > 1 ? '0' : '');
        form.box = g.head.box_count || '';
        form.reqWork = false;
    }

    root.innerHTML = `
<div id="head"></div>
<div id="body"></div>
<div id="dockhost"></div>`;

    const headEl = root.querySelector('#head');
    const bodyEl = root.querySelector('#body');
    const dockCtl = actionDock(root.querySelector('#dockhost'));
    let openSheet = null;

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
        const done = Boolean(o.inspect_done_at);
        const hasExtra = rows.some(db.hasExtraWork);
        const hasPacking = rows.some((r) => r.packing_yn === YN.YES);
        // 0파렛트(혼적)는 추가건일 때만 허용한다. 총량은 대표에 실리므로 대표 기준으로 본다
        const allowZero = db.minPalletOf(o) === 0;
        const written = Boolean((o.packing_note ?? '').trim());
        // 패킹리스트·실측값은 상차완료 전까지 현장에서도 고칠 수 있다 (웹과 같은 조건)
        const canWritePacking = editable && !loadDone(o);
        const canFix = editable && done && !loadDone(o);
        const notShipped = rows.filter((r) => !r.ship_done_at);

        // 위험 조작(완료 취소)은 독에 두지 않고 `···` 메뉴에만 둔다
        headEl.innerHTML = orderHead(o, {
            group: g,
            more: editable && done,
            meta: `${seqTag(o.seq, '차수')} ${esc(o.customer)} · ${esc(o.vehicle_type)}`
                + ` · 출고 ${esc(o.ship_req_date ?? '미정')}`,
            note: rows.length > 1
                ? `묶인 주문 ${rows.length}건이 한 번에 검수됩니다`
                    + ` (${esc(rows.map((r) => r.order_no).join(', '))}).`
                : '',
        }) + stepBar(visibleSteps(o, opt));
        bindOrderHead(headEl, {
            onMore: () => menuSheet([{
                label: '검수작업 완료 취소', icon: 'trash', tone: 'danger', onPick: doCancel,
            }]),
        });

        // 출고가 끝나지 않았으면 검수할 것이 없다. 헛걸음하지 않게 그 탭으로 보낸다
        if (notShipped.length && !done) {
            bodyEl.innerHTML = `
<div class="m-guide">
  <p>출고작업이 완료되지 않은 주문입니다
    (${esc(notShipped.map((r) => r.order_no).join(', '))}).<br>
    출고작업을 먼저 완료해야 검수할 수 있습니다.</p>
  <a class="m-btn m-btn--primary" href="#/ship/${esc(o.id)}">출고작업으로</a>
</div>`;
            dockCtl.hide();
            return;
        }

        bodyEl.innerHTML = `
${workNoteHtml(o)}
${hasExtra ? `
<label class="m-check">
  <input type="checkbox" id="chk-req" ${done || form.reqWork ? 'checked' : ''}
         ${done ? 'disabled' : ''}>
  <span>요청작업 완료 확인</span>
</label>` : '<p class="m-note">등록된 요청작업이 없습니다.</p>'}

${hasPacking ? `
<div class="m-block">
  <div class="m-block__head">
    <span class="m-block__title">패킹리스트</span>
    ${tag(written ? '작성완료' : '미작성', written ? 'green' : 'gray')}
  </div>
  ${written
        ? `<p class="m-packing">${esc(o.packing_note)}</p>`
        : '<p class="m-note">작성된 패킹리스트가 없습니다.'
          + ' 작성해야 검수를 완료할 수 있습니다.</p>'}
  ${canWritePacking ? `
  <button class="m-btn ${written ? '' : 'm-btn--primary'}" type="button" id="btn-packing">
    ${icon('sheet', 'm-icon')}<span>패킹리스트 ${written ? '수정' : '작성'}</span></button>` : ''}
</div>` : ''}

${done ? '' : `
<div class="m-numgrid">
  <label class="m-numfield">
    <span class="m-numfield__label">총 파렛트수 *</span>
    <input type="number" id="in-pallet" min="${db.minPalletOf(o)}" step="1"
           inputmode="numeric" placeholder="0" value="${esc(form.pallet)}">
  </label>
  <label class="m-numfield">
    <span class="m-numfield__label">총 박스수 *</span>
    <input type="number" id="in-box" min="1" step="1"
           inputmode="numeric" placeholder="0" value="${esc(form.box)}">
  </label>
</div>
<p class="m-note">검수하면서 센 실제 수량을 입력합니다.
  입력한 파렛트 수만큼 상차 검수용 바코드가 만들어집니다.
  ${rows.length > 1
        ? `<br><b>묶음 ${rows.length}건의 총량을 한 번에 입력합니다.</b>` : ''}
  ${allowZero ? '<br><b>추가건은 기존 차수에 혼적하면 0파렛트로 둡니다.</b>' : ''}</p>`}

<div class="m-kv">
  <div class="m-kv__row"><span class="m-kv__k">총 파렛트수</span>
    <span class="m-kv__v">${o.pallet_count ? `${num(o.pallet_count)} PLT` : '-'}
      ${canFix ? '<button class="m-btn m-btn--sm" type="button" id="btn-fix-pallet">수정</button>'
        : ''}</span></div>
  <div class="m-kv__row"><span class="m-kv__k">총 박스수</span>
    <span class="m-kv__v">${o.box_count ? `${num(o.box_count)} 박스` : '-'}
      ${canFix ? '<button class="m-btn m-btn--sm" type="button" id="btn-fix-box">수정</button>'
        : ''}</span></div>
  <div class="m-kv__row"><span class="m-kv__k">작업자</span>
    <span class="m-kv__v">${o.inspect_worker ? esc(o.inspect_worker) : '-'}</span></div>
  <div class="m-kv__row"><span class="m-kv__k">검수완료</span>
    <span class="m-kv__v">${done ? esc(fmtDateTime(o.inspect_done_at)) : '-'}</span></div>
</div>
${editable ? '' : '<p class="m-note">처리 권한이 없어 조회만 가능합니다.</p>'}`;

        bodyEl.querySelector('#chk-req')?.addEventListener('change', (e) => {
            form.reqWork = e.target.checked;
            syncDock();
        });
        bodyEl.querySelector('#in-pallet')?.addEventListener('input', (e) => {
            form.pallet = e.target.value;
            syncDock();
        });
        bodyEl.querySelector('#in-box')?.addEventListener('input', (e) => {
            form.box = e.target.value;
            syncDock();
        });
        bodyEl.querySelector('#btn-packing')?.addEventListener('click',
            () => openPacking(o, written));
        bodyEl.querySelector('#btn-fix-pallet')?.addEventListener('click', () => fixPallet(o));
        bodyEl.querySelector('#btn-fix-box')?.addEventListener('click', () => fixBox(o));

        syncDock();
    }

    /** 필수 항목이 다 찼는지 - 최종 검증은 db.setInspectDone 이 다시 한다 */
    function ready() {
        const rows = g.rows;
        const minPallet = db.minPalletOf(g.head);
        const pallet = Number(form.pallet);
        const box = Number(form.box);
        if (form.pallet === '' || !Number.isInteger(pallet) || pallet < minPallet) return false;
        if (form.box === '' || !Number.isInteger(box) || box < 1) return false;
        if (rows.some(db.hasExtraWork) && !form.reqWork) return false;
        return !rows.some((r) => r.packing_yn === YN.YES
            && !(r.packing_note ?? '').trim());
    }

    /** 하단 독 - 지금 할 수 있는 동작 하나만 남긴다 */
    function syncDock() {
        const o = g.head;
        const done = Boolean(o.inspect_done_at);
        // 완료된 뒤에는 독을 비운다 - 완료 취소는 `···` 메뉴로만 한다
        if (!editable || done) {
            dockCtl.hide();
            return;
        }
        const ok = ready();
        const spec = {
            mode: 'action',
            note: ok ? '' : '요청작업 확인 · 패킹리스트 · 총 파렛트수 · 총 박스수를 채우세요.',
            primary: { label: '검수완료', tone: 'go', icon: 'check', disabled: !ok },
            onPrimary: doDone,
        };
        dockCtl.set(spec);
    }

    async function doDone() {
        const rows = g.rows;
        const checks = {
            reqWork: rows.some(db.hasExtraWork) ? form.reqWork : true,
            palletCount: Number(form.pallet),
            boxCount: Number(form.box),
        };
        // 추가건을 0파렛트로 넘기면 혼적 여부를 한 번 더 묻는다
        if (db.minPalletOf(g.head) === 0 && checks.palletCount === 0) {
            const ok = await confirmDialog('0파렛트로 처리됩니다.\n\n'
                + '기존 차수 파렛트에 함께 적재(혼적)하여 파렛트수가 늘지 않는 것이 맞습니까?');
            if (!ok) return;
        }
        await run(() => db.setInspectDone(orderId, true, checks, user),
            rows.length > 1
                ? `묶음 ${rows.length}건의 검수작업을 완료했습니다.`
                : '검수작업을 완료했습니다.');
    }

    async function doCancel() {
        const msg = g.rows.length > 1
            ? `묶인 주문 ${g.rows.length}건의 검수작업 완료를 모두 취소하시겠습니까?`
            : '검수작업 완료를 취소하시겠습니까?';
        if (!await confirmDialog(msg)) return;
        // 적치·상차가 남아 있으면 데이터 계층이 순서를 알려주며 거부한다
        await run(() => db.setInspectDone(orderId, false, {}, user),
            '검수작업 완료를 취소했습니다.');
    }

    /** 패킹리스트 작성·수정 - 좁은 화면이라 바텀시트에서 받는다 */
    function openPacking(o, written) {
        const s = sheet(`패킹리스트 ${written ? '수정' : '작성'}`, `
<label class="m-field">
  <span class="m-field__label">패킹리스트 내용</span>
  <textarea class="m-textarea" id="pk-input" rows="8"
            placeholder="패킹리스트 내용을 작성하세요">${esc(o.packing_note ?? '')}</textarea>
</label>`, {
            footer: '<button class="m-btn m-btn--go m-btn--block" type="button" id="pk-save">'
                + '저장</button>',
        });
        openSheet = s;
        s.foot.querySelector('#pk-save').addEventListener('click', async () => {
            try {
                await db.setPackingNote(orderId, s.body.querySelector('#pk-input').value, user);
            } catch (err) {
                toast(err.message, 'error');
                return;
            }
            s.close();
            openSheet = null;
            toast(`패킹리스트를 ${written ? '수정' : '저장'}했습니다.`, 'success');
            await refresh();
        });
    }

    /** 총 박스수 수정 - 허용 조건은 데이터 계층이 판단한다 */
    function fixBox(o) {
        openSheet = numberSheet({
            title: '총 박스수 수정',
            note: '검수하면서 센 실제 박스수를 입력하세요.',
            value: o.box_count ?? '',
            min: 1,
            onSave: (v) => run(() => db.setBoxCount(orderId, v, user), '박스수를 고쳤습니다.'),
        });
    }

    /** 총 파렛트수 수정 - 로케이션이 든 파렛트가 빠지면 한 번 더 확인받는다 */
    function fixPallet(o) {
        openSheet = numberSheet({
            title: '총 파렛트수 수정',
            note: '기존 로케이션은 그대로 두고 끝에서만 늘리거나 줄입니다.',
            value: o.pallet_count ?? '',
            min: db.minPalletOf(o),
            onSave: (v) => savePallet(o, v),
        });
    }

    async function savePallet(o, v) {
        try {
            await db.setPalletCount(orderId, v, user);
        } catch (err) {
            if (!err.needConfirm) {
                toast(err.message, 'error');
                return;
            }
            // 로케이션이 든 파렛트가 빠진다 - 어떤 것인지 보여주고 한 번 더 묻는다
            const ok = await confirmDialog(`${err.message}\n\n${err.removing.join('\n')}\n\n`
                + '이 파렛트들을 지우고 파렛트수를 줄이시겠습니까?');
            if (!ok) return;
            try {
                await db.setPalletCount(orderId, v, user, { confirmRemove: true });
            } catch (err2) {
                toast(err2.message, 'error');
                return;
            }
        }
        // 늘어난 파렛트는 로케이션이 비어 있다 - 출고적치에서 마저 넣도록 안내한다
        const added = Number(v) - (o.pallet_count ?? 0);
        toast(added > 0
            ? `파렛트수를 고쳤습니다. 새 파렛트 ${added}개는 출고적치에서 로케이션을 넣으세요.`
            : '파렛트수를 고쳤습니다. 상차 검수 바코드 수가 함께 바뀝니다.', 'success');
        await refresh();
    }

    draw();
    const unwatch = db.subscribe(pollGuard(root, refresh), 5000);
    return () => {
        closeAllSheets();
        dockCtl.destroy();
        openSheet?.close();
        unwatch();
    };
}

/**
 * 숫자 1개를 받는 바텀시트 - 모바일에서는 prompt 대화상자가 작아 다루기 어렵다.
 * 저장하면 onSave(값)를 부르고 시트를 닫는다.
 */
function numberSheet({
    title, note, value, min, onSave,
}) {
    const s = sheet(title, `
<p class="m-note">${esc(note)}</p>
<label class="m-numfield m-numfield--wide">
  <input type="number" id="nb-input" min="${min}" step="1" inputmode="numeric"
         value="${esc(value)}" aria-label="${esc(title)}">
</label>`, {
        footer: '<button class="m-btn m-btn--go m-btn--block" type="button" id="nb-save">'
            + '저장</button>',
    });
    const input = s.body.querySelector('#nb-input');
    input.focus();
    input.select();
    s.foot.querySelector('#nb-save').addEventListener('click', () => {
        const v = input.value.trim();
        s.close();
        onSave(v);
    });
    return s;
}
