/**
 * 재고실사표 (모바일 앱).
 *
 *   #/stock   적치가 끝나고 아직 상차되지 않은 파렛트를 로케이션 순으로 나열 + CSV 내려받기
 *
 * 대표님 결정 H - **앱에서는 인쇄를 하지 않는다.** 인쇄는 웹 화면에서 한다.
 * 나중에 제품검수 기능과 함께 인쇄를 붙일 수 있게 툴바(#toolbar) 자리는 비워 둔다.
 * 적치확인·비고는 현장에서 손으로 적는 칸이라 빈 값으로 내보낸다 (웹과 같다).
 */
import { formatLocation } from '../../config.js';
import { can } from '../../auth.js';
import * as db from '../../db.js';
import { icon } from '../../icons.js';
import {
    esc, num, today, downloadCsv, toast,
} from '../../util.js';
import { emptyState, pollGuard } from '../ui.js';

/** CSV 머리글 - 웹 재고실사표와 같은 순서 */
const HEADERS = ['로케이션', '주문번호', '거래처명', '적치확인', '비고'];

export async function render(root, { user }) {
    root.innerHTML = `
<p class="m-note">적치가 끝나고 아직 상차되지 않은 파렛트입니다.
  적치확인·비고는 현장에서 직접 적는 칸이라 비워 둡니다.</p>
<div class="m-toolbar" id="toolbar">
  <span class="m-toolbar__count" id="count"></span>
  ${can(user, 'download') ? `
  <button class="m-btn m-btn--primary m-btn--sm" type="button" id="btn-csv">
    ${icon('sheet', 'm-icon')}<span>내려받기</span></button>` : ''}
</div>
<div id="list"></div>`;

    const listEl = root.querySelector('#list');
    const countEl = root.querySelector('#count');
    let rows = [];

    async function reload() {
        rows = await stockRows(user);
        countEl.textContent = `${num(rows.length)}건`;
        listEl.innerHTML = rows.length
            ? rows.map((r) => `
<div class="m-stockrow">
  <b class="m-stockrow__loc">${esc(r.location)}</b>
  <span class="m-stockrow__no">${esc(r.order_no)}</span>
  <span class="m-stockrow__cust">${esc(r.customer)}</span>
</div>`).join('')
            : emptyState('대상이 없습니다. (적치완료 · 상차 전 파렛트만 나옵니다)');
    }

    root.querySelector('#btn-csv')?.addEventListener('click', () => {
        if (!rows.length) {
            toast('내려받을 대상이 없습니다.', 'error');
            return;
        }
        downloadCsv(`재고실사표_${today()}.csv`, HEADERS,
            rows.map((r) => [r.location, r.order_no, r.customer, '', '']));
    });

    await reload();
    const unwatch = db.subscribe(pollGuard(root, reload), 8000);
    return unwatch;
}

/**
 * 재고실사표 행 - 로케이션이 들어간 파렛트를 로케이션 순으로 모은다.
 * 대상 판정(적치완료 · 상차 전)과 조회 범위 제한은 db.listStowWaiting 이 한다 -
 * 상차대기 화면과 같은 묶음을 본다.
 */
async function stockRows(user) {
    const groups = await db.listStowWaiting({
        createdBy: can(user, 'viewAll') ? undefined : user.id,
    });
    return groups
        .flatMap((g) => g.pallets.filter((p) => p.location).map((p) => ({
            location: formatLocation(p.location),
            // 라벨과 같은 번호로 찾을 수 있게 묶음 대표주문번호를 보여준다
            order_no: g.head.rep_no || g.head.order_no,
            customer: g.head.customer,
        })))
        .sort((a, b) => a.location.localeCompare(b.location));
}
