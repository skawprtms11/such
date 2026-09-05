/**
 * 주문처리현황 (모바일 앱) - **조회 전용**.
 *
 *   #/status   탭(현재진행 · 출고완료 · 출고취소) · 검색 · 카드 목록 → 상세 시트
 *
 * 단계를 이 화면에서 바꾸지 않는다. 완료처리는 웹 화면에서만 한다.
 * 상차라벨 인쇄도 앱에는 두지 않는다 (대표님 결정 H - 앱은 조회·CSV 만).
 *
 * 탭 구분과 기간 조건은 웹 주문처리현황(docs/status.md)과 같다.
 *   현재진행 - 완료처리도 취소도 되지 않은 주문 (기간 제한 없음)
 *   출고완료 - 완료처리한 달 기준
 *   출고취소 - 취소한 달 기준
 */
import { can } from '../../auth.js';
import { visibleSteps, stepRate, loadDone } from '../../steps.js';
import * as db from '../../db.js';
import { icon } from '../../icons.js';
import {
    esc, num, today, fmtDateTime,
} from '../../util.js';
import {
    emptyState, tag, seqTag, card, stepBar, sheet, pollGuard, closeAllSheets,
} from '../ui.js';

/** 화면 탭 - 웹 주문처리현황과 같은 구분이다 (표시용 라벨이라 화면이 갖는다) */
const TABS = [
    { key: 'active', label: '현재진행' },
    { key: 'done', label: '출고완료' },
    { key: 'canceled', label: '출고취소' },
];

/** 조회 조건 - 다른 화면에 다녀와도 유지한다 */
const filter = { tab: 'active', keyword: '', month: today().slice(0, 7) };

/** 이 주문이 그 탭에 속하는지 (웹과 같은 판정) */
function inTab(o, tab) {
    if (tab === 'canceled') return Boolean(o.canceled_at);
    if (tab === 'done') return Boolean(o.closed_at) && !o.canceled_at;
    return !o.closed_at && !o.canceled_at;
}

/** 기간 조건 - 현재진행은 보지 않고, 나머지는 완료처리·취소한 달로 좁힌다 */
function inPeriod(o, tab, month) {
    if (tab === 'active' || !month) return true;
    const at = tab === 'canceled' ? o.canceled_at : o.closed_at;
    return String(at).slice(0, 7) === month;
}

export async function render(root, { user }) {
    root.innerHTML = `
<div class="m-seg" id="tabs">
  ${TABS.map((t) => `
  <button class="m-seg__btn ${t.key === filter.tab ? 'is-active' : ''}" type="button"
          data-tab="${t.key}">${esc(t.label)}</button>`).join('')}
</div>
<label class="m-search">
  ${icon('search', 'm-icon')}
  <input type="search" id="f-kw" placeholder="주문번호 · 거래처명"
         value="${esc(filter.keyword)}" aria-label="검색">
</label>
<label class="m-monthbar" id="monthbar">
  <span class="m-monthbar__label">조회 월</span>
  <input type="month" id="f-month" value="${esc(filter.month)}" aria-label="조회 월">
</label>
<p class="m-sum" id="sum"></p>
<div id="list"></div>`;

    const listEl = root.querySelector('#list');
    const sumEl = root.querySelector('#sum');
    const monthBar = root.querySelector('#monthbar');
    let rows = [];
    let opts = { tasks: {}, adjusts: {} };

    async function reload() {
        const [all, tasks, adjusts] = await Promise.all([
            db.listOrders({
                createdBy: can(user, 'viewAll') ? undefined : user.id,
                keyword: filter.keyword,
            }),
            db.extraTaskMap(),
            db.adjustMap(),
        ]);
        opts = { tasks, adjusts };
        rows = all.filter((o) => inTab(o, filter.tab) && inPeriod(o, filter.tab, filter.month));
        draw();
    }

    function draw() {
        monthBar.hidden = filter.tab === 'active';
        const closed = rows.filter((o) => o.closed_at || o.canceled_at).length;
        sumEl.innerHTML = rows.length ? `
<span>주문 <b>${num(rows.length)}</b></span>
<span>진행중 <b>${num(rows.length - closed)}</b></span>
<span>상차완료 <b>${num(rows.filter(loadDone).length)}</b></span>` : '';

        listEl.innerHTML = rows.length
            ? rows.map((o) => statusCard(o, stepOptOf(o))).join('')
            : emptyState('조회된 주문이 없습니다.');
    }

    /** 단계 계산 조건 - 요청작업·조정작업은 주문 필드만으로 알 수 없다 */
    function stepOptOf(o) {
        return { task: Boolean(opts.tasks[o.order_no]), adjust: opts.adjusts[o.id] };
    }

    root.querySelectorAll('[data-tab]').forEach((el) => {
        el.addEventListener('click', () => {
            filter.tab = el.dataset.tab;
            root.querySelectorAll('[data-tab]').forEach((b) => {
                b.classList.toggle('is-active', b.dataset.tab === filter.tab);
            });
            reload();
        });
    });

    root.querySelector('#f-kw').addEventListener('input', (e) => {
        filter.keyword = e.target.value;
        reload();
    });

    root.querySelector('#f-month').addEventListener('change', (e) => {
        filter.month = e.target.value;
        reload();
    });

    listEl.addEventListener('click', (e) => {
        const row = e.target.closest('.m-card[data-id]');
        if (!row) return;
        const o = rows.find((x) => x.id === row.dataset.id);
        if (o) openDetail(o, stepOptOf(o));
    });

    await reload();
    const unwatch = db.subscribe(pollGuard(root, reload), 8000);
    return () => {
        closeAllSheets();
        unwatch();
    };
}

/** 목록 카드 한 장 - 마지막으로 끝난 단계와 진행률만 보여준다 */
function statusCard(o, opt) {
    const steps = visibleSteps(o, opt);
    const done = steps.filter((s) => s.done);
    const state = o.canceled_at ? tag('취소', 'red')
        : o.closed_at ? tag('출고완료', 'green')
            : done.length ? tag(done.at(-1).label, 'blue') : tag('미착수', 'gray');
    const body = `
<span class="m-card__cust">${esc(o.customer)}</span>
<span class="m-card__meta">${seqTag(o.seq, '차수')} ${esc(o.vehicle_type)}
  · 출고 ${esc(o.ship_req_date ?? '미정')}</span>`;

    return card(esc(o.order_no), body, {
        badges: `${o.rep_no ? tag('대표', 'amber') : ''}`,
        status: state,
        bar: { done: done.length, total: steps.length, label: `${stepRate(o, opt)}%` },
        attrs: { id: o.id },
        tap: true,
    });
}

/** 상세 시트 - 좁은 목록에서 뺀 항목까지 모두 보여준다 (조회 전용) */
function openDetail(o, opt) {
    const steps = visibleSteps(o, opt);
    const dash = '<span class="m-muted">-</span>';
    const row = (k, v) => `
<div class="m-kv__row"><span class="m-kv__k">${esc(k)}</span>
  <span class="m-kv__v">${v}</span></div>`;

    return sheet(`${o.order_no} · ${o.seq}차수`, `
${stepBar(steps)}
<div class="m-kv">
  ${o.rep_no ? row('대표주문번호', `<b>${esc(o.rep_no)}</b>`) : ''}
  ${row('거래처명', esc(o.customer))}
  ${row('진행상태', o.canceled_at ? tag('취소', 'red')
        : o.closed_at ? tag('출고완료', 'green') : `<b>${stepRate(o, opt)}%</b> 진행`)}
  ${row('구분', o.region ? esc(o.region) : dash)}
  ${row('팀명', o.team_name ? esc(o.team_name) : dash)}
  ${row('출고요청일', `<b>${esc(o.ship_req_date ?? '미정')}</b>`)}
  ${row('출고형태', esc(o.vehicle_type))}
  ${row('파렛트수', o.pallet_count ? `${num(o.pallet_count)} PLT` : dash)}
  ${row('박스수', o.box_count ? `${num(o.box_count)} 박스` : dash)}
  ${row('요청사항', o.request_note ? esc(o.request_note) : dash)}
  ${row('비고', o.remark ? esc(o.remark) : dash)}
</div>
<p class="m-listtitle">처리현황</p>
<div class="m-kv">
  ${steps.map((s) => row(s.label, s.doneAt ? esc(fmtDateTime(s.doneAt)) : dash)).join('')}
  ${o.closed_at ? row('출고완료', esc(fmtDateTime(o.closed_at))) : ''}
  ${o.canceled_at ? row('출고취소', esc(fmtDateTime(o.canceled_at))) : ''}
</div>
<p class="m-note">완료처리와 상차라벨 인쇄는 웹 화면에서 합니다.</p>`);
}
