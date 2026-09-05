/**
 * 조정요청 (모바일 앱).
 *
 *   #/adjust        접수된 조정요청 · 작업요청 목록
 *   #/adjust/:id    요청 내용 상세 + 작업완료 / 완료 취소
 *
 * 대상 판정은 db.listRequestTasks 가 준 목록을 그대로 쓴다 (웹 조정요청 탭과 같은 조건).
 *   - 이슈등록의 '작업요청' 유형 (자동등록 건 제외)
 *   - 주문 상세에서 등록되고 **접수 처리된** 조정요청
 * 여기에 취소된 주문·상차완료된 주문만 걷어낸다.
 *
 * 🔑 스캔 대상이 아니다. 목록에서 골라 연다.
 */
import { adjustCategory } from '../../config.js';
import { can } from '../../auth.js';
import { visibleSteps, loadDone } from '../../steps.js';
import * as db from '../../db.js';
import { icon } from '../../icons.js';
import {
    esc, fmtDateTime, monthDay, toast, confirmDialog,
} from '../../util.js';
import {
    emptyState, tag, seqTag, card, orderHead, bindOrderHead,
    stepBar, workNoteHtml, stepOpt, actionDock, pollGuard,
} from '../ui.js';

/** 목록 검색어 - 상세를 다녀와도 유지한다 */
const filter = { keyword: '' };

export async function render(root, { user, params }) {
    return params[0]
        ? renderDetail(root, user, params[0])
        : renderList(root, user);
}

/**
 * 조정요청 대상 - 요청이 있고 아직 상차되지 않은 주문 (웹 조정요청 탭과 같은 조건).
 * 전체 조회 권한이 없는 사용자에게는 본인이 등록한 주문만 남긴다.
 */
async function targets(user) {
    const all = await db.listRequestTasks();
    const mine = can(user, 'viewAll');
    return all.filter(({ order: o }) => !o.canceled_at && !loadDone(o)
        && (mine || o.created_by === user.id));
}

/** 요청 갈래 배지 - 조정요청은 항목명, 작업요청은 그대로 */
function sourceTag(t) {
    return t.source === 'adjust'
        ? tag(adjustCategory(t.category).label, 'amber')
        : tag('작업요청', 'blue');
}

/* =================================== 목록 =================================== */

async function renderList(root, user) {
    root.innerHTML = `
<label class="m-search">
  ${icon('search', 'm-icon')}
  <input type="search" id="f-kw" placeholder="주문번호 · 거래처명"
         value="${esc(filter.keyword)}" aria-label="검색">
</label>
<p class="m-sum" id="sum"></p>
<p class="m-listtitle">조정요청 대상 (접수된 요청 · 상차 전)</p>
<div id="list"></div>`;

    const sumEl = root.querySelector('#sum');
    const listEl = root.querySelector('#list');

    async function reload() {
        const rows = await targets(user);
        const kw = filter.keyword.trim().toLowerCase();
        draw(kw
            ? rows.filter((t) => `${t.order.order_no} ${t.order.rep_no ?? ''} ${t.order.customer}`
                .toLowerCase().includes(kw))
            : rows);
    }

    function draw(rows) {
        const done = rows.filter((t) => t.order.extra_done_at).length;
        sumEl.innerHTML = rows.length ? `
<span>대기 <b>${rows.length - done}</b></span>
<span>완료 <b>${done}</b></span>` : '';

        listEl.innerHTML = rows.length
            ? rows.map(taskCard).join('')
            : emptyState(filter.keyword.trim()
                ? '검색 결과가 없습니다.'
                : '조정요청 대상이 없습니다. (접수된 요청이 있고 아직 상차되지 않은 주문만 나옵니다)');
    }

    root.querySelector('#f-kw').addEventListener('input', (e) => {
        filter.keyword = e.target.value;
        reload();
    });

    listEl.addEventListener('click', (e) => {
        const row = e.target.closest('.m-card[data-id]');
        if (row) location.hash = `#/adjust/${row.dataset.id}`;
    });

    await reload();
    const unwatch = db.subscribe(pollGuard(root, reload), 8000);
    return unwatch;
}

/** 목록 카드 한 장 - 요청 1건이 카드 1장이다 (한 주문에 요청이 여럿일 수 있다) */
function taskCard(t) {
    const o = t.order;
    const no = esc(o.rep_no || o.order_no);
    const body = `
<span class="m-card__cust">${esc(o.customer)}</span>
<span class="m-card__req">${esc(t.content)}</span>
<span class="m-card__meta">${seqTag(o.seq, '차수')} 등록 ${esc(monthDay(t.created_at))}
  ${t.due_date ? `· 완료요청 ${esc(t.due_date)}` : ''}
  ${o.extra_worker ? `· 작업자 ${esc(o.extra_worker)}` : ''}</span>`;

    return card(no, body, {
        badges: sourceTag(t),
        status: o.extra_done_at ? tag('완료', 'green') : tag('대기', 'gray'),
        attrs: { id: o.id },
        tap: true,
    });
}

/* =================================== 상세 =================================== */

async function renderDetail(root, user, orderId) {
    const editable = can(user, 'updateStatus');
    // 목록에서 요청을 연 사람이 이 단계의 작업자가 된다 (조회 권한만 있으면 기록하지 않는다)
    if (editable) await db.recordWorker(orderId, 'extra', user);

    root.innerHTML = `
<div id="head"></div>
<div id="body"></div>
<div id="dockhost"></div>`;

    const headEl = root.querySelector('#head');
    const bodyEl = root.querySelector('#body');
    const dockCtl = actionDock(root.querySelector('#dockhost'));

    async function draw() {
        const rows = (await targets(user)).filter((t) => t.order.id === orderId);
        if (!rows.length) {
            headEl.innerHTML = '';
            bodyEl.innerHTML = emptyState('조정요청 대상이 아닙니다.'
                + ' 접수된 조정요청·작업요청이 있고 아직 상차되지 않은 주문만 표시됩니다.',
            { label: '조정요청 목록으로', href: '#/adjust' });
            dockCtl.hide();
            return;
        }

        const o = rows[0].order;
        const done = Boolean(o.extra_done_at);
        const opt = await stepOpt(o);

        headEl.innerHTML = orderHead(o, {
            meta: `${seqTag(o.seq, '차수')} ${esc(o.customer)} · ${esc(o.vehicle_type)}`
                + ` · 출고 ${esc(o.ship_req_date ?? '미정')}`,
        }) + stepBar(visibleSteps(o, opt));
        bindOrderHead(headEl);

        bodyEl.innerHTML = `
${workNoteHtml(o)}
${rows.map((t) => `
<div class="m-block">
  <div class="m-block__head">
    <span class="m-block__title">${t.source === 'adjust' ? '조정요청 내용' : '작업요청 내용'}</span>
    ${sourceTag(t)}
  </div>
  <p class="m-packing">${esc(t.content)}</p>
  <p class="m-note">${t.due_date ? `완료요청일 ${esc(t.due_date)} · ` : ''}
    등록 ${esc(fmtDateTime(t.created_at))}</p>
</div>`).join('')}
<div class="m-kv">
  <div class="m-kv__row"><span class="m-kv__k">작업자</span>
    <span class="m-kv__v">${o.extra_worker ? esc(o.extra_worker) : '-'}</span></div>
  <div class="m-kv__row"><span class="m-kv__k">작업완료</span>
    <span class="m-kv__v">${done ? esc(fmtDateTime(o.extra_done_at)) : '-'}</span></div>
</div>
${!o.inspect_done_at ? `
<div class="m-guide">
  <p>아직 검수작업이 완료되지 않았습니다. 요청 내용은 확인할 수 있지만
    작업완료 처리는 검수작업을 마친 뒤에 가능합니다.</p>
  <a class="m-btn m-btn--primary" href="#/inspect/${esc(o.id)}">검수작업으로</a>
</div>` : ''}
${editable ? '' : '<p class="m-note">처리 권한이 없어 조회만 가능합니다.</p>'}`;

        syncDock(done);
    }

    /** 처리 후 공통 뒷정리 - 실패 문구는 데이터 계층이 준 것을 그대로 쓴다 */
    async function run(fn, msg) {
        try {
            await fn();
            toast(msg, 'success');
        } catch (err) {
            toast(err.message, 'error');
        }
        await draw();
    }

    /** 하단 독 - 지금 할 수 있는 동작 하나만 남긴다 */
    function syncDock(done) {
        if (!editable) {
            dockCtl.hide();
            return;
        }
        dockCtl.set(done ? {
            mode: 'action',
            primary: { label: '완료 취소', tone: 'danger' },
            onPrimary: doCancel,
        } : {
            mode: 'action',
            primary: { label: '작업완료', tone: 'go', icon: 'check' },
            onPrimary: doDone,
        });
    }

    function doDone() {
        // 검수 전 처리 차단은 db.setExtraWorkDone 이 판단한다
        return run(() => db.setExtraWorkDone(orderId, true, user), '요청 작업을 완료했습니다.');
    }

    async function doCancel() {
        if (!await confirmDialog('작업 완료를 취소하시겠습니까?')) return;
        await run(() => db.setExtraWorkDone(orderId, false, user), '작업 완료를 취소했습니다.');
    }

    await draw();
    const unwatch = db.subscribe(pollGuard(root, draw), 8000);
    return () => {
        dockCtl.destroy();
        unwatch();
    };
}
