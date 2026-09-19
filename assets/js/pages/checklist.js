/**
 * 업무체크리스트 화면 (셸) - 탭 전환 · 공유 상태 · 실시간 구독만 맡는다.
 *
 *   탭1 업무체크리스트 - **오늘 내가 빠뜨리면 안 되는 것**을 훑고 체크하는 목록.
 *                      「일일 | 전체」 세그먼트로 그 날짜 대상만 볼지 확인내용 전부를 볼지 고른다
 *                      (checklist/daily.js)
 *   탭2 업무프로세스   - 좌 업무구분 트리 · 중 흐름 도식 · 우 체크리스트 표의 세 칸 화면
 *                      (checklist/process.js · flowview.js · form.js)
 *
 * 주기·담당자 상속·상황 발생·어제 미체크 판정은 화면이 하지 않는다. db.checklistTable() ·
 * db.canCheckItem() 이 준 결과만 그린다 (docs/checklist.md). 앱(mobile/screens/checklist.js ·
 * process.js)도 같다.
 */
import { can } from '../auth.js';
import * as db from '../db.js';
import { esc, today } from '../util.js';
import { drawToday } from './checklist/daily.js';
import { disposeManage, drawManage } from './checklist/process.js';

/** 화면 상태 - 다른 화면에 다녀와도 유지한다 */
const state = {
    tab: 'today',
    date: today(),
    assignee: 'me',                    // 'me' | 'all' | 사용자 id
    scope: 'daily',                    // 탭1: 'daily' 그 날짜 대상만 | 'all' 확인내용 전부
    showDone: false,                   // 탭1: 완료 줄을 펼쳐 보이기 (세그먼트 「전체」)
    openDone: new Set(),               // 탭1: 「완료 N건 보기」 로 펼쳐 둔 업무항목 id
    division: null,                    // 탭2: 보고 있는 업무구분 id ('' = 미분류)
    group: null,                       // 탭2: 보고 있는 업무항목 id
    edit: false,                       // 탭2: 편집 모드 (도구 표시)
    quick: null,                       // 탭2: 열려 있는 빠른 추가 입력칸 {hostId, kind, label}
    open: new Set(),                   // 탭2: 상세를 펼쳐 둔 프로세스·상황 id
    pick: null,                        // 탭2: 도식에서 고른 단계 (우측 설명 표가 그 단계를 보여 준다)
    step: null,                        // 탭2: 열려 있는 「다음 단계」 입력칸 {fromId}
    link: null,                        // 탭2: 연결 모드 {fromId, block:Set, caption}
    pane: 'flow',                      // 탭2: 좁은 화면에서 보는 칸 ('nav' | 'flow' | 'side')
    side: false,                       // 탭2: 중간 폭에서 우측 서랍을 열어 둘지
};

export async function render(root, { user }) {
    const canManage = can(user, 'manageChecklist');
    if (!canManage && state.tab === 'manage') state.tab = 'today';

    const TABS = [
        { key: 'today', label: '일일체크리스트' },
        ...(canManage ? [{ key: 'manage', label: '업무프로세스' }] : []),
    ];

    root.innerHTML = `
<div class="card">
  <div class="card__head">
    <h2>업무체크리스트</h2>
    <span class="tag tag--gray" id="head-sum"></span>
  </div>
  <div class="tabs" id="cl-tabs"></div>
  <div class="card__body" id="cl-body"></div>
</div>`;

    const body = root.querySelector('#cl-body');
    const headSum = root.querySelector('#head-sum');
    let users = [];

    function drawTabs() {
        root.querySelector('#cl-tabs').innerHTML = TABS.map((t) => `
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
        users = (await db.listUsers()).filter((u) => u.active !== false);
        drawTabs();
        if (state.tab === 'manage') {
            headSum.textContent = '';
            await drawManage({ state, body, user, users, reload });
        } else {
            // 🔑 업무프로세스 탭을 떠나면 문서 리스너(연결 모드 Esc·인쇄)를 걷는다
            state.link = null;
            disposeManage();
            await drawToday({ state, body, headSum, user, users, canManage, reload });
        }
    }

    /**
     * 실시간 갱신 - **편집 중에는 다시 그리지 않는다.**
     * 통째로 다시 그리면 열어 둔 인라인 폼과 입력하던 값이 사라진다.
     */
    function guarded() {
        const el = document.activeElement;
        if (el && body.contains(el) && el.matches('input, textarea, select')) return;
        if (document.querySelector('.modal-back')) return;
        // 빠른 추가·단계 입력칸 · 간선 팝오버 · 아직 저장하지 않은 우측 설명 표의 입력값
        const editing = '.pm-quick__form, .pm-port--form, .pm-epop, .pm-side .is-dirty';
        if (body.querySelector(editing)) return;
        reload();
    }

    await reload();
    const unwatch = db.subscribe(guarded);
    return () => {
        document.body.classList.remove('cl-printing');
        disposeManage();
        unwatch();
    };
}
