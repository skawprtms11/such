/**
 * 상차작업 (모바일 앱).
 *
 * 목록 → 상차검수 → 상차완료 → 로케이션(파렛트 내리기)을 **한 화면 흐름**으로 처리한다.
 * 웹의 당일상차리스트(#/loading) + 검수(#/inspect/:id) 를 하나로 합친 것이며,
 * 업무 규칙은 새로 쓰지 않고 db.js 함수를 그대로 부른다.
 *
 *   #/load          목록
 *   #/load/:id      상차검수 (상차완료된 건은 로케이션으로 열린다)
 *   #/load/:id/loc  로케이션부터 열기 (목록의 `로케이션` 버튼)
 *
 * 🔑 묶음은 db.getLoadGroup - 대표주문번호 + 추가주문 차수를 함께 본다.
 * 화면에서 다시 묶지 않는다.
 */
import {
    LOAD_STATUS, PALLET_SCAN_STATUS, STOW_STATUS, FLOOR_LOCATION,
    formatLocation, compareLocation, stowStatus,
} from '../../config.js';
import { can } from '../../auth.js';
import { loadDone } from '../../steps.js';
import * as db from '../../db.js';
import { icon } from '../../icons.js';
import {
    esc, num, rate, today, toDateStr, fmtDateTime, toast, confirmDialog,
} from '../../util.js';
import {
    emptyState, tag, seqTag, plusBadge, card, bigCounter, orderHead, bindOrderHead,
    segment, dock, scanBar, menuSheet,
} from '../ui.js';

/** 상차 상태 → 배지 색 */
const STATUS_TONE = {
    [LOAD_STATUS.DONE]: 'green',
    [LOAD_STATUS.INSPECTED]: 'blue',
    [LOAD_STATUS.WAIT]: 'gray',
    [STOW_STATUS.DONE]: 'green',
    [STOW_STATUS.ING]: 'blue',
    [STOW_STATUS.WAIT]: 'gray',
};

/** 목록 조회 조건 - 상세를 다녀와도 유지한다 */
const filter = { date: '', keyword: '' };

export async function render(root, { user, params }) {
    return params[0]
        ? renderDetail(root, user, params[0], params[1])
        : renderList(root, user);
}

/* =============================== 목록 (§4-3a) =============================== */

async function renderList(root, user) {
    filter.date = filter.date || today();
    const editable = can(user, 'updateStatus');

    root.innerHTML = `
<div class="m-datebar">
  <button class="m-datebar__nav" type="button" data-shift="-1" aria-label="전일">
    ${icon('back', 'm-icon')}</button>
  <label class="m-datebar__date">
    <input type="date" id="f-date" value="${esc(filter.date)}" aria-label="출고일자">
  </label>
  <button class="m-datebar__nav" type="button" data-shift="1" aria-label="익일">
    ${icon('forward', 'm-icon')}</button>
  <button class="m-btn m-btn--sm" type="button" id="f-today">오늘</button>
</div>
<label class="m-search">
  ${icon('search', 'm-icon')}
  <input type="search" id="f-kw" placeholder="주문번호 · 거래처명"
         value="${esc(filter.keyword)}" aria-label="검색">
</label>
<p class="m-sum" id="sum"></p>
<div id="list"></div>`;

    const listEl = root.querySelector('#list');
    const dateEl = root.querySelector('#f-date');

    function setDate(d) {
        filter.date = d;
        dateEl.value = d;
        reload();
    }

    function shift(days) {
        const d = new Date(`${filter.date}T00:00:00`);
        d.setDate(d.getDate() + days);
        setDate(toDateStr(d));
    }

    async function reload() {
        let rows = await db.listLoading(filter.date);
        if (!can(user, 'viewAll')) rows = rows.filter((o) => o.created_by === user.id);
        const kw = filter.keyword.trim().toLowerCase();
        if (kw) {
            rows = rows.filter((o) => [o.group_no, o.order_no, o.customer]
                .concat(o.group_nos ?? [])
                .join(' ').toLowerCase().includes(kw));
        }
        draw(rows);
    }

    function draw(rows) {
        const count = (s) => rows.filter((o) => o.load_status === s).length;
        const doneCount = rows.filter((o) => loadDone(o)).length;
        root.querySelector('#sum').innerHTML = rows.length ? `
<span>대기 <b>${num(count(LOAD_STATUS.WAIT))}</b></span>
<span>검수 <b>${num(count(LOAD_STATUS.INSPECTED))}</b></span>
<span>완료 <b>${num(doneCount)}</b></span>
<span class="m-sum__rate">진행 <b>${rate(doneCount, rows.length)}%</b></span>` : '';

        listEl.innerHTML = rows.length
            ? rows.map((o) => loadCard(o, editable)).join('')
            : emptyState('상차 대상 주문이 없습니다. (상차 외 모든 작업이 끝난 주문만 나옵니다)');
    }

    root.querySelector('#f-today').addEventListener('click', () => setDate(today()));
    root.querySelectorAll('[data-shift]').forEach((el) => {
        el.addEventListener('click', () => shift(Number(el.dataset.shift)));
    });
    dateEl.addEventListener('change', (e) => setDate(e.target.value));
    root.querySelector('#f-kw').addEventListener('input', (e) => {
        filter.keyword = e.target.value;
        reload();
    });

    listEl.addEventListener('click', async (e) => {
        const loc = e.target.closest('[data-loc]');
        if (loc) {
            location.hash = `#/load/${loc.dataset.loc}/loc`;
            return;
        }
        const scan = e.target.closest('[data-scan]');
        if (scan) {
            location.hash = `#/load/${scan.dataset.scan}`;
            return;
        }
        const btn = e.target.closest('[data-load]');
        if (btn) {
            if (!await confirmDialog('상차완료 처리하시겠습니까?')) return;
            try {
                await db.completeLoading(btn.dataset.load, user);
                toast('상차완료 처리되었습니다.', 'success');
            } catch (err) {
                toast(err.message, 'error');
            }
            reload();
            return;
        }
        const row = e.target.closest('.m-card[data-id]');
        if (row) location.hash = `#/load/${row.dataset.id}`;
    });

    await reload();
    // 검색어를 치는 중에 목록이 다시 그려지면 입력이 끊긴다
    const poll = () => {
        if (root.contains(document.activeElement)
            && document.activeElement.matches('input')) return;
        reload();
    };
    const unwatch = db.subscribe(poll, 8000);
    return () => unwatch();
}

/** 목록 카드 한 장 */
function loadCard(o, editable) {
    const no = esc(o.group_no ?? o.order_no);
    const total = o.group_pallets ?? 0;
    const done = loadDone(o);
    const body = `
<span class="m-card__cust">${esc(o.customer)}</span>
<span class="m-card__meta">${esc(o.vehicle_type)}
  · 박스 ${o.box_count ? num(o.box_count) : '-'}
  ${done ? `· 상차 ${esc(fmtDateTime(o.loaded_at))}` : ''}</span>`;

    const actions = done ? '' : `
<button class="m-btn" type="button" data-loc="${esc(o.id)}">로케이션</button>
${o.load_status === LOAD_STATUS.INSPECTED && editable
        ? `<button class="m-btn m-btn--go" type="button" data-load="${esc(o.id)}">상차완료</button>`
        : `<button class="m-btn m-btn--primary" type="button"
             data-scan="${esc(o.id)}">상차검수</button>`}`;

    return card(o.rep_no ? `<b>${no}</b>` : no, body, {
        badges: `${o.rep_no ? tag('대표', 'amber') : ''}${plusBadge(o.group_count)}`,
        status: tag(o.load_status, STATUS_TONE[o.load_status] ?? 'gray'),
        bar: { done: o.group_inspected ?? 0, total, label: `${o.group_inspected ?? 0}/${total} PLT` },
        actions,
        attrs: { id: o.id },
        tap: true,
    });
}

/* ========================= 상세 (§4-3b·c·d·e) ========================= */

async function renderDetail(root, user, orderId, mode) {
    let g = await db.getLoadGroup(orderId);
    if (!g) {
        root.innerHTML = emptyState('주문을 찾을 수 없습니다.',
            { label: '상차 목록으로', href: '#/load' });
        return null;
    }
    const editable = can(user, 'updateStatus');

    root.innerHTML = `
<div id="head"></div>
<div id="segbox"></div>
<div id="top"></div>
<div id="list"></div>
<div id="scanhost"></div>
<div id="dockhost"></div>`;

    const headEl = root.querySelector('#head');
    const topEl = root.querySelector('#top');
    const listEl = root.querySelector('#list');
    const scanHost = root.querySelector('#scanhost');
    const dockHost = root.querySelector('#dockhost');

    // 상차완료된 건은 파렛트를 내리러 들어오는 것이므로 로케이션으로 연다
    let seg = mode === 'loc' || loadDone(g.head) ? 'loc' : 'scan';
    let openSheet = null;

    const segCtl = segment(root.querySelector('#segbox'), [
        { key: 'scan', label: '상차검수' },
        { key: 'loc', label: '로케이션' },
    ], seg, (key) => {
        seg = key;
        if (key !== 'scan') scan?.stop();
        draw();
    });

    // 독은 화면이 만들어 소유하고 스캔 바에 넘긴다 (한 화면에 독은 하나뿐이다).
    // 조회 전용 사용자에게는 아예 만들지 않는다 - 빈 막대가 화면 아래에 남지 않게
    const d = editable ? dock(dockHost, {}) : null;
    const scan = editable
        ? scanBar(scanHost, {
            dock: d,
            placeholder: '바코드 직접 입력',
            onSubmit: onScan,
            onCamera: (on) => {
                if (on) scanHost.scrollIntoView({ behavior: 'smooth', block: 'end' });
            },
        })
        : null;

    async function refresh() {
        const next = await db.getLoadGroup(orderId);
        if (!next) return;
        g = next;
        draw();
    }

    function draw() {
        const o = g.head;
        const total = g.pallets.length;
        const scanned = g.pallets.filter((p) => p.scanned_at).length;

        headEl.innerHTML = orderHead(o, {
            group: g,
            meta: `${esc(o.customer)} · ${esc(o.vehicle_type)}`
                + ` · 출고 ${esc(o.ship_req_date ?? '미정')}`,
            note: g.rows.length > 1
                ? `묶인 주문 ${g.rows.length}건이 함께 검수·상차됩니다`
                    + ` (${esc(g.rows.map((r) => r.order_no).join(', '))}).`
                : '',
            more: editable,
        });
        bindOrderHead(headEl, { onMore: openMenu });

        if (seg === 'scan') drawScan(o, total, scanned);
        else drawLocation(o, total, scanned);
        syncDock();
    }

    /* ---------------- 상차검수 세그 ---------------- */

    function drawScan(o, total, scanned) {
        const left = total - scanned;
        topEl.innerHTML = bigCounter(scanned, total, total ? `남은 파렛트 ${num(left)}개` : '')
            + (editable ? '' : '<p class="m-note">검수 권한이 없어 조회만 가능합니다.</p>');

        // 라벨 바코드가 모두 같은 주문번호라 순번으로 보여준다 (라벨의 연번과 같은 순서)
        listEl.innerHTML = total ? `
<p class="m-listtitle">파렛트</p>
${g.pallets.map((p, i) => `
<div class="m-pallet ${p.scanned_at ? 'is-done' : ''}">
  <span class="m-pallet__mark">${icon(p.scanned_at ? 'check' : 'square', 'm-icon')}</span>
  ${seqTag(p.seq)}
  <span class="m-pallet__name">파렛트 ${i + 1} <small>/ ${total}</small></span>
  ${tag(p.scanned_at ? PALLET_SCAN_STATUS.DONE : PALLET_SCAN_STATUS.WAIT,
        p.scanned_at ? 'green' : 'gray')}
</div>`).join('')}` : emptyState('등록된 파렛트가 없습니다.'
            + ' 출고주문처리 검수작업에서 파렛트수를 입력하세요.');
    }

    /* ---------------- 로케이션 세그 (파렛트 내리기) ---------------- */

    function drawLocation(o, total, scanned) {
        const done = loadDone(o);
        const picked = g.pallets.filter((p) => p.picked_at).length;
        const stowed = g.pallets.filter((p) => p.location).length;
        const stow = stowStatus(stowed, total);
        topEl.innerHTML = `
<div class="m-statline">
  ${tag(o.load_status, STATUS_TONE[o.load_status] ?? 'gray')}
  ${done ? `<b>${esc(fmtDateTime(o.loaded_at))}</b>` : ''}
  ${tag(stow, STATUS_TONE[stow] ?? 'gray')}
  <span>적치 ${num(stowed)}/${num(total)}</span>
  <span>검수 ${num(scanned)}/${num(total)}</span>
  <span>박스 ${o.box_count ? num(o.box_count) : '-'}</span>
  <span class="m-statline__pick">내림 ${num(picked)}/${num(total)}</span>
</div>
${done ? '<p class="m-note">상차완료된 주문이라 파렛트 내림을 바꿀 수 없습니다.</p>' : ''}
${!editable ? '<p class="m-note">처리 권한이 없어 조회만 가능합니다.</p>' : ''}`;

        // 창고를 도는 순서대로 보여준다 (구역 → 행 → 열 → 단). 이름은 원래 번호를 유지한다
        const rows = [...g.pallets].sort((a, b) => compareLocation(a.location, b.location));
        listEl.innerHTML = rows.length ? rows.map((p) => `
<label class="m-pallet ${p.picked_at ? 'is-done' : ''}">
  ${seqTag(p.seq)}
  <span class="m-pallet__name">${esc(p.label)}</span>
  <span class="m-pallet__loc">${locationHtml(p.location)}</span>
  <input type="checkbox" class="m-pallet__check" data-pick="${esc(p.id)}"
         ${p.picked_at ? 'checked' : ''}
         ${editable && !done && p.location ? '' : 'disabled'}>
</label>`).join('') : emptyState('파렛트가 없습니다.');

        listEl.querySelectorAll('[data-pick]').forEach((el) => {
            el.addEventListener('change', async () => {
                try {
                    await db.setPalletPicked(el.dataset.pick, el.checked);
                    await refresh();
                } catch (err) {
                    toast(err.message, 'error');
                    el.checked = !el.checked;
                }
            });
        });
    }

    /* ---------------- 하단 독 ---------------- */

    function syncDock() {
        if (!scan) return;
        // 위험 조작은 독에 두지 않는다. 로케이션 세그·상차완료 건에서는 독 자체를 감춘다
        const hidden = seg !== 'scan' || loadDone(g.head);
        dockHost.hidden = hidden;
        if (hidden) {
            scan.stop();
            return;
        }
        // 상차완료 버튼은 묶음 전체가 `검수` 일 때만 낸다 (db.completeLoading 이 한 번 더 막는다)
        const ready = g.rows.every((r) => r.load_status === LOAD_STATUS.INSPECTED);
        if (ready) {
            scan.stop();
            scan.dock.set({
                mode: 'action',
                primary: { label: '상차완료 처리', tone: 'go', icon: 'loading' },
                onPrimary: doComplete,
            });
        } else {
            scan.resetDock();
        }
    }

    /* ---------------- 처리 ---------------- */

    async function onScan(code) {
        const res = await db.scanPallet(orderId, code, user);
        scan.result.show(res.msg, res.ok);
        toast(res.msg, res.ok ? 'success' : 'error');
        // 현장에서 화면을 못 볼 때의 피드백 (성공은 짧게, 실패는 세 번)
        if (navigator.vibrate) navigator.vibrate(res.ok ? 60 : [70, 70, 70]);
        await refresh();
        if (res.ok && g.pallets.length && g.pallets.every((p) => p.scanned_at)) {
            scan.result.show('모든 파렛트 검수가 끝났습니다.', true);
        }
    }

    async function doComplete() {
        if (!await confirmDialog('상차완료 처리하시겠습니까?')) return;
        try {
            await db.completeLoading(orderId, user);
            toast('상차완료 처리되었습니다.', 'success');
            scan?.result.clear();
            seg = 'loc';
            segCtl.set('loc');
        } catch (err) {
            toast(err.message, 'error');
        }
        await refresh();
    }

    async function doReset() {
        const ok = await confirmDialog('검수 내역을 모두 초기화하시겠습니까?\n\n'
            + `묶인 주문 ${g.rows.length}건 전체가 대기 상태로 돌아갑니다.`);
        if (!ok) return;
        // 상차완료된 묶음은 데이터 계층이 거부한다 (상차완료를 먼저 취소해야 한다)
        try {
            await db.resetInspection(orderId, user);
            toast('검수가 초기화되었습니다.');
            scan?.result.clear();
        } catch (err) {
            toast(err.message, 'error');
        }
        await refresh();
    }

    async function doCancelLoad() {
        const no = g.head.rep_no || g.head.order_no;
        const ok = await confirmDialog(`${no} 의 상차완료를 취소하시겠습니까?\n\n`
            + `묶인 주문 ${g.rows.length}건 전체가 검수 상태로 돌아갑니다.\n`
            + '상차작업 취소 이력이 남습니다.');
        if (!ok) return;
        try {
            await db.cancelLoading(orderId, user);
            toast(`${no} 의 상차완료를 취소했습니다.`, 'success');
            seg = 'scan';
            segCtl.set('scan');
        } catch (err) {
            toast(err.message, 'error');
        }
        await refresh();
    }

    /** `···` 메뉴 - 위험 조작은 여기에만 둔다 */
    function openMenu() {
        const items = loadDone(g.head)
            ? [{ label: '상차완료 취소', icon: 'back', tone: 'danger', onPick: doCancelLoad }]
            : [{ label: '검수 초기화', icon: 'adjust', tone: 'danger', onPick: doReset }];
        openSheet = menuSheet(items, g.head.rep_no || g.head.order_no);
    }

    draw();
    // 입력·체크를 만지는 중에 다시 그리면 손이 튄다 (목록과 같은 가드)
    const poll = () => {
        if (root.contains(document.activeElement)
            && document.activeElement.matches('input')) return;
        refresh();
    };
    const unwatch = db.subscribe(poll, 8000);
    return () => {
        scan?.destroy();      // 카메라 정지 + 스캔 조각 제거
        d?.destroy();
        segCtl.destroy();
        openSheet?.close();
        unwatch();
    };
}

/** 로케이션 표시 - 바닥 적치는 좌표가 없어 `평치` 로 나온다 */
function locationHtml(location) {
    if (!location) return '<span class="m-muted">미지정</span>';
    const v = formatLocation(location);
    return v === FLOOR_LOCATION
        ? `${icon('floor', 'm-icon')}<b>${esc(v)}</b>`
        : `<b>${esc(v)}</b>`;
}
