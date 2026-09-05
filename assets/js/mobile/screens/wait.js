/**
 * 상차대기 (모바일 앱) - **조회 전용**.
 *
 *   #/wait   적치가 끝났고 아직 상차되지 않은 묶음 목록 → 적치 로케이션 시트
 *
 * 🔑 묶음과 조회 범위 제한은 db.listStowWaiting 이 함께 판단한다.
 * 화면이 행을 먼저 걸러내면 묶음 대표가 바뀌어 파렛트 수가 어긋난다.
 * 상차 처리와 파렛트 내리기는 상차작업(#/load) 에서 한다.
 */
import { formatLocation, stowStatus, STOW_STATUS } from '../../config.js';
import { can } from '../../auth.js';
import * as db from '../../db.js';
import { icon } from '../../icons.js';
import { esc, num } from '../../util.js';
import {
    emptyState, tag, seqTag, plusBadge, card, sheet, pollGuard, closeAllSheets,
} from '../ui.js';

/** 적치 진행 상태 → 배지 색 */
const TONE = {
    [STOW_STATUS.DONE]: 'green',
    [STOW_STATUS.ING]: 'blue',
    [STOW_STATUS.WAIT]: 'gray',
};

/** 조회 조건 - 다른 화면에 다녀와도 유지한다 */
const filter = { keyword: '' };

export async function render(root, { user }) {
    root.innerHTML = `
<label class="m-search">
  ${icon('search', 'm-icon')}
  <input type="search" id="f-kw" placeholder="주문번호 · 거래처명"
         value="${esc(filter.keyword)}" aria-label="검색">
</label>
<p class="m-sum" id="sum"></p>
<p class="m-listtitle">상차대기 (적치완료 · 상차 전)</p>
<div id="list"></div>`;

    const listEl = root.querySelector('#list');
    const sumEl = root.querySelector('#sum');

    async function reload() {
        draw(await db.listStowWaiting({
            createdBy: can(user, 'viewAll') ? undefined : user.id,
        }));
    }

    function draw(groups) {
        const kw = filter.keyword.trim().toLowerCase();
        const shown = kw
            ? groups.filter((g) => g.rows
                .map((r) => `${r.order_no} ${r.rep_no ?? ''} ${r.customer}`)
                .join(' ').toLowerCase().includes(kw))
            : groups;
        const plt = shown.reduce((n, g) => n + g.pallets.length, 0);
        sumEl.innerHTML = shown.length ? `
<span>묶음 <b>${num(shown.length)}</b></span>
<span>파렛트 <b>${num(plt)}</b></span>` : '';

        listEl.innerHTML = shown.length
            ? shown.map(waitCard).join('')
            : emptyState(kw ? '검색 결과가 없습니다.' : '상차대기 건이 없습니다.');

        listEl.querySelectorAll('.m-card[data-id]').forEach((el) => {
            el.addEventListener('click', async () => {
                const g = await db.getLoadGroup(el.dataset.id);
                if (g) openLocations(g);
            });
        });
    }

    root.querySelector('#f-kw').addEventListener('input', (e) => {
        filter.keyword = e.target.value;
        reload();
    });

    await reload();
    const unwatch = db.subscribe(pollGuard(root, reload), 8000);
    return () => {
        closeAllSheets();
        unwatch();
    };
}

/** 목록 카드 한 장 - 로케이션은 첫 칸만 보여주고 나머지는 시트에서 본다 */
function waitCard(g) {
    const o = g.head;
    const locs = g.pallets.filter((p) => p.location).map((p) => formatLocation(p.location));
    const done = locs.length;
    const total = g.pallets.length;
    const body = `
<span class="m-card__cust">${esc(o.customer)}</span>
<span class="m-card__meta">${seqTag(o.seq, '차수')} ${esc(o.vehicle_type)}
  · 출고 ${esc(o.ship_req_date ?? '미정')} · 파렛트 ${num(total)}</span>
<span class="m-card__meta">${locs.length
        ? `${esc(locs[0])}${locs.length > 1 ? ` 외 ${locs.length - 1}` : ''}`
        : '로케이션 미지정'}</span>`;

    return card(esc(o.rep_no || o.order_no), body, {
        badges: `${o.rep_no ? tag('대표', 'amber') : ''}${plusBadge(g.rows.length)}`,
        status: tag(stowStatus(done, total), TONE[stowStatus(done, total)] ?? 'gray'),
        attrs: { id: o.id },
        tap: true,
    });
}

/** 적치 로케이션 시트 - 파렛트별로 어디에 있는지 확인만 한다 */
function openLocations(g) {
    const o = g.head;
    const row = (k, v) => `
<div class="m-kv__row"><span class="m-kv__k">${esc(k)}</span>
  <span class="m-kv__v">${v}</span></div>`;
    const dash = '<span class="m-muted">-</span>';

    return sheet(`${o.rep_no || o.order_no} 적치 로케이션`, `
${g.rows.length > 1
        ? `<p class="m-note">묶인 주문 ${g.rows.length}건이 함께 실립니다`
          + ` (${esc(g.rows.map((r) => r.order_no).join(', '))}).</p>`
        : ''}
<div class="m-kv">
  ${row('거래처명', esc(o.customer))}
  ${row('출고요청일', `<b>${esc(o.ship_req_date ?? '미정')}</b>`)}
  ${row('출고형태', esc(o.vehicle_type))}
  ${row('박스수', o.box_count ? `${num(o.box_count)} 박스` : dash)}
  ${row('파렛트', `${num(g.pallets.length)} PLT`)}
</div>
<p class="m-listtitle">파렛트</p>
${g.pallets.map((p) => `
<div class="m-pallet">
  ${seqTag(p.seq, '차')}
  <span class="m-pallet__name">${esc(p.label)}</span>
  <span class="m-pallet__loc">${p.location
        ? `<b>${esc(formatLocation(p.location))}</b>` : '<span class="m-muted">미지정</span>'}</span>
</div>`).join('')}
<p class="m-note">상차 처리와 파렛트 내리기는 상차작업 화면에서 합니다.</p>`);
}
