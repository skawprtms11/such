/**
 * 유통가공작업 화면 (셸) - 탭 전환 · 공유 상태 · 실시간 구독만 맡는다 (docs/processing.md).
 *
 *   탭1 작업현황   - 작업 등록·수정·삭제, 목록, 작업지시서 생성 (processing/jobs.js)
 *   탭2 부자재관리 - 재고·입출고. 이번에는 **자리만** 만든다 (§14)
 *   탭3 작업캘린더 - 월 달력에 작업 기간 막대 (processing/calendar.js)
 *   탭4 작업마스터 - 제품별 구성품(BOM) 등록 (processing/master.js)
 *
 * 진행상태 판정·LOT 검증·마스터 조회는 화면이 하지 않는다. `db.processStatus()` ·
 * `db.createProcessJob()` 이 준 결과만 그린다 - 같은 판정을 화면마다 새로 짜면 모집단이 갈린다.
 */
import * as db from '../db.js';
import { esc, today } from '../util.js';
import { drawCalendar } from './processing/calendar.js';
import { drawJobs } from './processing/jobs.js';
import { drawMaster } from './processing/master.js';

/** 화면 상태 - 다른 화면에 다녀와도 유지한다 */
const state = {
    tab: 'jobs',
    from: '',
    to: '',
    status: '',
    keyword: '',
    month: today().slice(0, 7),
    masterKeyword: '',
    masterWorkType: '',
};

const TABS = [
    { key: 'jobs', label: '작업현황' },
    { key: 'material', label: '부자재관리' },
    { key: 'calendar', label: '작업캘린더' },
    { key: 'master', label: '작업마스터' },
];

export async function render(root, { user }) {
    root.innerHTML = `
<div class="card">
  <div class="card__head">
    <h2>유통가공작업</h2>
  </div>
  <div class="tabs" id="pc-tabs"></div>
  <div class="card__body" id="pc-body"></div>
</div>`;

    const body = root.querySelector('#pc-body');

    function drawTabs() {
        root.querySelector('#pc-tabs').innerHTML = TABS.map((t) => `
<button class="tabs__btn ${t.key === state.tab ? 'is-active' : ''}"
        type="button" data-tab="${esc(t.key)}">${esc(t.label)}</button>`).join('');
        root.querySelectorAll('[data-tab]').forEach((el) => {
            el.addEventListener('click', () => {
                state.tab = el.dataset.tab;
                reload();
            });
        });
    }

    async function reload() {
        drawTabs();
        const arg = { state, body, user, reload };
        if (state.tab === 'calendar') await drawCalendar(arg);
        else if (state.tab === 'master') await drawMaster(arg);
        else if (state.tab === 'material') {
            // 재고·입출고 모델이 정해지지 않았다. 쓰이지 않을 스키마를 먼저 만들지 않는다 (§14)
            body.innerHTML = '<div class="empty">부자재관리 화면은 준비 중입니다.</div>';
        } else await drawJobs(arg);
    }

    /**
     * 실시간 갱신 가드 🔑 - **입력 중이거나 팝업이 열려 있으면 다시 그리지 않는다.**
     * LOT 을 여러 줄 입력하는 중에 리렌더가 돌면 입력값이 통째로 날아간다.
     */
    function guarded() {
        const el = document.activeElement;
        if (el && body.contains(el) && el.matches('input, textarea, select')) return;
        if (document.querySelector('.modal-back')) return;
        reload();
    }

    await reload();
    return db.subscribe(guarded);
}
