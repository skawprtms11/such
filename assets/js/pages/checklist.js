/**
 * 업무체크리스트 화면.
 *
 *   탭1 일일체크리스트 - **오늘 내가 빠뜨리면 안 되는 것**을 훑고 체크하는 목록.
 *                      업무구분·업무항목은 계층 머리글, 줄은 체크항목 하나. 미완료 먼저,
 *                      완료는 접는다. 어제 밀린 항목은 줄 안에 표시한다. 상황(입고수량오류 등)은
 *                      프로세스 줄 뒤 칩으로 「발생」 처리하면 대응 항목이 아래 줄로 끼어든다
 *   탭2 업무프로세스   - **매뉴얼처럼 읽는 세로 흐름.** 왼쪽 트리(업무구분 › 업무항목)에서 고르면
 *                      단계 카드 한 줄기가 나온다. 상황은 카드 안 주황 블록(「X 발생 시」 → 대응 단계 →
 *                      처리 후 다음 단계). 편집 모드: ✎ 속성 모달 · 드래그 정렬 · 이름 입력 후 Enter 추가
 *
 * 주기·담당자 상속·상황 발생·어제 미체크 판정은 화면이 하지 않는다. db.dailyTable() ·
 * db.canCheckItem() 이 준 결과만 그린다 (docs/checklist.md). 앱(mobile/screens/checklist.js ·
 * process.js)도 같다.
 */
import { can } from '../auth.js';
import * as db from '../db.js';
import { icon } from '../icons.js';
import {
    CHECK_CYCLE, CHECK_CYCLES, CHECK_KIND, CHECK_KINDS, CHECK_TEMPLATES, WEEKDAYS, cycleLabel,
} from '../config.js';
import {
    esc, num, rate, toast, today, addDays, fmtDateTime, confirmDialog, promptDialog, openModal,
} from '../util.js';

/** 화면 상태 - 다른 화면에 다녀와도 유지한다 */
const state = {
    tab: 'today',
    date: today(),
    assignee: 'me',                    // 'me' | 'all' | 사용자 id
    showDone: false,                   // 일일: 완료 줄을 펼쳐 보이기 (세그먼트 「전체」)
    openDone: new Set(),               // 일일: 「완료 N건 보기」 로 펼쳐 둔 업무항목 id
    division: null,                    // 업무프로세스: 보고 있는 업무구분 id ('' = 미분류)
    group: null,                       // 업무프로세스: 보고 있는 업무항목 id
    edit: false,                       // 업무프로세스: 편집 모드 (도구 표시)
    quick: null,                       // 업무프로세스: 열려 있는 빠른 추가 입력칸 {hostId, kind, label}
};

/** 업무구분이 없는 옛 업무항목을 담는 가상 업무구분 (스키마 마이그레이션 전 데이터 · mock) */
const UNSORTED_ID = '';

/** ①②③ 원문자 - 프로세스 순번 캡션용 (20 넘으면 숫자 그대로) */
function circled(n) {
    return n >= 1 && n <= 20 ? String.fromCodePoint(0x2460 + n - 1) : String(n);
}

/** 아이콘 버튼 한 개 - 문구 대신 아이콘만 두므로 aria-label·title 로 뜻을 알린다 */
function iconBtn(name, label, attr, cls = 'btn btn--icon btn--sm') {
    return `<button class="${cls}" type="button" ${attr}
        aria-label="${esc(label)}" title="${esc(label)}">${icon(name, 'icon icon--sm')}</button>`;
}

/** 아이콘 + 짧은 글자 버튼 (「+ 체크항목」 같은 것) */
function textBtn(name, label, attr, cls = 'btn btn--sm') {
    return `<button class="${cls}" type="button" ${attr}>
        ${icon(name, 'icon icon--sm')}<span>${esc(label)}</span></button>`;
}

/** 두 칸 세그먼트 (미완료|전체 · 개요|상세) */
function segHtml(id, items, cur) {
    return `<span class="seg" id="${id}">${items.map(([k, label]) => `
<button class="seg__btn ${k === cur ? 'is-active' : ''}" type="button" data-seg="${esc(k)}"
  >${esc(label)}</button>`).join('')}</span>`;
}

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
        type="button" data-tab="${t.key}">${esc(t.label)}</button>`).join('');
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
            await drawManage(body, user, users, reload);
        } else {
            await drawToday(body, headSum, user, users, canManage, reload);
        }
    }

    /**
     * 실시간 갱신 - **편집 중에는 다시 그리지 않는다.**
     * 통째로 다시 그리면 열어 둔 인라인 폼과 입력하던 값이 사라진다.
     */
    function guarded() {
        const el = document.activeElement;
        if (el && body.contains(el) && el.matches('input, textarea, select')) return;
        if (document.querySelector('.modal-back') || body.querySelector('.pm-quick__form')) return;
        reload();
    }

    await reload();
    const unwatch = db.subscribe(guarded);
    return () => {
        document.body.classList.remove('cl-printing');
        unwatch();
    };
}

/* ============================== 탭1 일일체크리스트 ============================== */

/** 담당자 필터를 db 조회 조건으로 바꾼다 ('나' 는 로그인 사용자) */
function assigneeFilter(user) {
    if (state.assignee === 'all') return {};
    return { assignee: state.assignee === 'me' ? user.id : state.assignee };
}

async function drawToday(body, headSum, user, users, canManage, reload) {
    const f = assigneeFilter(user);
    const table = await db.dailyTable(state.date, f);
    const sum = await db.checklistSummary(state.date, f);
    const pct = rate(sum.done, sum.total);
    const rows = await db.dueItems(state.date, f);

    headSum.textContent = `${num(sum.done)} / ${num(sum.total)}`;

    body.className = 'card__body';
    body.innerHTML = `
<div class="toolbar">
  <div class="cl-datenav">
    ${iconBtn('back', '이전 날짜', 'id="btn-prev"')}
    <input type="date" id="f-date" value="${esc(state.date)}" aria-label="날짜">
    ${iconBtn('next', '다음 날짜', 'id="btn-next"')}
    <button class="btn btn--sm" id="btn-today" type="button">오늘</button>
  </div>
  <label class="field" style="flex:0 0 170px">
    <span class="field__label">담당자</span>
    <select id="f-assignee" ${canManage ? '' : 'disabled'}>
      <option value="me" ${state.assignee === 'me' ? 'selected' : ''}>나</option>
      ${canManage ? `
      <option value="all" ${state.assignee === 'all' ? 'selected' : ''}>전체</option>
      ${users.map((u) => `
      <option value="${esc(u.id)}" ${state.assignee === u.id ? 'selected' : ''}
        >${esc(u.name)}</option>`).join('')}` : ''}
    </select>
  </label>
  ${segHtml('seg-done', [['open', '미완료'], ['all', '전체']], state.showDone ? 'all' : 'open')}
  <div class="toolbar__spacer"></div>
  <div class="cl-progress">
    <span class="cl-progress__num">남은 ${num(sum.total - sum.done)} · ${num(sum.done)} / ${num(sum.total)}</span>
    <div class="bar"><div class="bar__fill ${pct === 100 ? 'is-done' : ''}"
      style="width:${pct}%"></div></div>
  </div>
  ${sum.raised ? `<span class="tag tag--amber">상황 발생 ${num(sum.raised)}건</span>` : ''}
  ${sum.missed ? `
  <button class="btn btn--sm cl-missed" id="btn-missed" type="button"
    >어제 미체크 ${num(sum.missed)}건 →</button>` : ''}
</div>
${table.divisions.length ? `<div class="dq">${table.divisions.map((d) => `
<div class="dq-div"><span class="dq-div__name">${esc(d.name)}</span>
  <span class="dq-div__cnt">${num(d.done)} / ${num(d.total)}</span></div>
${d.groups.map((g) => groupHtml(g, user)).join('')}`).join('')}</div>`
        : '<p class="empty">이 날짜에 해야 할 항목이 없습니다.</p>'}`;

    body.querySelector('#btn-prev').addEventListener('click', () => {
        state.date = addDays(state.date, -1);
        reload();
    });
    body.querySelector('#btn-next').addEventListener('click', () => {
        state.date = addDays(state.date, 1);
        reload();
    });
    body.querySelector('#btn-today').addEventListener('click', () => {
        state.date = today();
        reload();
    });
    body.querySelector('#f-date').addEventListener('change', (e) => {
        state.date = e.target.value || today();
        reload();
    });
    body.querySelector('#f-assignee').addEventListener('change', (e) => {
        state.assignee = e.target.value;
        reload();
    });
    body.querySelectorAll('#seg-done [data-seg]').forEach((el) => {
        el.addEventListener('click', () => {
            state.showDone = el.dataset.seg === 'all';
            reload();
        });
    });
    body.querySelector('#btn-missed')?.addEventListener('click', () => {
        state.date = sum.prevDate;
        reload();
    });
    body.querySelectorAll('[data-fold]').forEach((el) => {
        el.addEventListener('click', () => {
            const id = el.dataset.fold;
            if (state.openDone.has(id)) state.openDone.delete(id);
            else state.openDone.add(id);
            reload();
        });
    });

    /** 체크/해제 */
    body.querySelectorAll('[data-check]').forEach((el) => {
        el.addEventListener('change', async () => {
            const row = rows.find((r) => r.id === el.dataset.check);
            try {
                await db.setCheck(row.id, state.date, el.checked, row.check?.memo ?? '', user);
                await reload();
            } catch (err) {
                el.checked = !el.checked;
                toast(err.message, 'error');
            }
        });
    });
    body.querySelectorAll('[data-title]').forEach((el) => {
        el.addEventListener('click', () => {
            body.querySelector(`[data-check="${el.dataset.title}"]:not([disabled])`)?.click();
        });
    });
    body.querySelectorAll('[data-memo]').forEach((el) => {
        el.addEventListener('click', async () => {
            const row = rows.find((r) => r.id === el.dataset.memo);
            if (!row.check) {
                toast('체크한 뒤에 메모를 남길 수 있습니다.', 'info');
                return;
            }
            const memo = await promptDialog('메모 (비우면 지워집니다)', row.check.memo ?? '');
            if (memo === null) return;
            try {
                await db.setCheck(row.id, state.date, true, memo, user);
                await reload();
            } catch (err) {
                toast(err.message, 'error');
            }
        });
    });

    /** 상황 발생 - 내용을 적고 발생 처리하면 대응 절차의 체크항목이 아래 줄로 끼어든다 */
    body.querySelectorAll('[data-raise]').forEach((el) => {
        el.addEventListener('click', async () => {
            const memo = await promptDialog(`「${el.dataset.name}」 발생 내용 (선택)`, '');
            if (memo === null) return;
            try {
                await db.setCheck(el.dataset.raise, state.date, true, memo, user);
                await reload();
            } catch (err) {
                toast(err.message, 'error');
            }
        });
    });
    body.querySelectorAll('[data-sit-memo]').forEach((el) => {
        el.addEventListener('click', async () => {
            const memo = await promptDialog('발생 내용 (비우면 지워집니다)', el.dataset.value ?? '');
            if (memo === null) return;
            try {
                await db.setCheck(el.dataset.sitMemo, state.date, true, memo, user);
                await reload();
            } catch (err) {
                toast(err.message, 'error');
            }
        });
    });
    body.querySelectorAll('[data-dismiss]').forEach((el) => {
        el.addEventListener('click', async () => {
            const ok = await confirmDialog(
                `「${el.dataset.name}」 발생을 해제할까요?\n이 상황 아래 오늘 체크한 기록도 함께 지워집니다.`,
            );
            if (!ok) return;
            try {
                await db.setCheck(el.dataset.dismiss, state.date, false, '', user);
                await reload();
            } catch (err) {
                toast(err.message, 'error');
            }
        });
    });
}

/**
 * 업무항목 한 묶음 - 왼쪽 이름 칸, 오른쪽에 미완료 줄(업무 순서)과 상황 칩, 그 뒤 완료 줄.
 * 완료 줄은 세그먼트가 「전체」이거나 「완료 N건 보기」 를 눌렀을 때만 펼친다.
 */
function groupHtml(g, user) {
    const open = state.showDone || state.openDone.has(g.item.id);
    const done = [];
    const parts = [];
    g.sections.forEach((sec) => {
        sec.rows.forEach((r) => {
            if (r.check) done.push({ r, sec });
            else parts.push(rowHtml(r, sec, user));
        });
        if (sec.situations.length) parts.push(sitChips(sec.situations, user));
    });
    if (done.length) {
        if (!state.showDone) {
            parts.push(`
<button class="dq-fold" type="button" data-fold="${esc(g.item.id)}">
  ${icon(open ? 'down' : 'next', 'icon icon--sm')}완료 ${num(done.length)}건 ${open ? '접기' : '보기'}</button>`);
        }
        if (open) parts.push(done.map(({ r, sec }) => rowHtml(r, sec, user)).join(''));
    }
    if (!parts.length) parts.push('<p class="dq-empty">할 항목이 없습니다.</p>');
    const allDone = g.total > 0 && g.done === g.total;
    return `
<div class="dq-grp">
  <div class="dq-grp__name">${esc(g.name)}
    <small class="${allDone ? 'is-done' : ''}">${num(g.done)} / ${num(g.total)}</small></div>
  <div class="dq-grp__rows">${parts.join('')}</div>
</div>`;
}

/** 프로세스 캡션 - `① 하차 파렛트수 확인 › ⚠ 입고수량오류 › ① 수량 차이 기록` */
function pathCaption(sec) {
    if (!sec.path.length) return '단독 업무';
    return sec.path.map((n) => (n.sit
        ? `<span class="is-sit">${icon('issues', 'icon icon--sm')}${esc(n.title)}</span>`
        : `${circled(n.no)} ${esc(n.title)}`)).join(' › ');
}

/** 체크 줄 하나 */
function rowHtml(r, sec, user) {
    const locked = !db.canCheckItem(user, r);
    const done = !!r.check;
    const isStep = r.kind === CHECK_KIND.PROCESS;
    const doneAt = done
        ? `${esc(fmtDateTime(r.check.checked_at).slice(11))} ${esc(r.check.checked_by_name)}`
        : '';
    return `
<div class="dq-row ${done ? 'is-done' : ''} ${locked ? 'is-locked' : ''} ${sec.sit ? 'is-sit' : ''}">
  <input type="checkbox" data-check="${esc(r.id)}" ${done ? 'checked' : ''}
         ${locked ? 'disabled' : ''} aria-label="${esc(r.title)}">
  <span class="dq-row__main" data-title="${esc(r.id)}">
    <span class="dq-row__title">
      ${isStep ? '<span class="dq-row__step">단계 완료</span>' : ''}
      <span>${esc(r.title)}</span>
      ${r.late && !done ? '<span class="dq-late">어제 미체크</span>' : ''}
    </span>
    ${r.description ? `<span class="dq-row__desc">${esc(r.description)}</span>` : ''}
    <span class="dq-row__proc">${pathCaption(sec)}${isStep ? '' : ` · ${esc(cycleLabel(r))}`}</span>
  </span>
  <span class="dq-row__who">${whoCell(r)}</span>
  <span class="dq-row__at">${doneAt}</span>
  ${iconBtn('memo', r.check?.memo ? `메모: ${r.check.memo}` : '메모',
        `data-memo="${esc(r.id)}"`, `btn btn--icon btn--sm ${r.check?.memo ? 'is-on' : ''}`)}
</div>`;
}

/** 담당 칸 - 정담당자 이름, 부담당자가 있으면 아래 작은 글씨. 아무도 없으면 「공통」 */
function whoCell(r) {
    const subs = r.assignee_eff_subs ?? [];
    if (!r.assignee_eff_name && !subs.length) return '공통';
    return `${esc(r.assignee_eff_name)}${subs.length
        ? `<small class="dq-row__sub">부 ${esc(subs.map((s) => s.name).join(', '))}</small>` : ''}`;
}

/** 프로세스에 달린 상황 칩 줄 - 발생 전은 점선 「발생」, 발생하면 주황 실선 + 내용·해제 */
function sitChips(situations, user) {
    return `
<div class="dq-sits">
  <span class="dq-sits__label">${icon('issues', 'icon icon--sm')}상황</span>
  ${situations.map((s) => {
        const mine = db.canCheckItem(user, s.item);
        const id = esc(s.item.id);
        const name = esc(s.item.title);
        if (!s.active) {
            return `
  <button class="cl-chip" type="button" data-raise="${id}" data-name="${name}"
          ${mine ? '' : 'disabled'} title="${esc(s.item.description || '눌러서 발생 처리')}">
    ${name} <span class="cl-chip__act">발생</span></button>`;
        }
        const a = s.active;
        const note = `${esc(fmtDateTime(a.checked_at).slice(11))} ${esc(a.checked_by_name)}`
            + (a.memo ? ` · ${esc(a.memo)}` : '');
        return `
  <span class="cl-chip is-active">
    ${name} 발생
    <span class="cl-chip__note">${note}</span>
    ${mine ? iconBtn('memo', '발생 내용', `data-sit-memo="${id}" data-value="${esc(a.memo ?? '')}"`,
        `btn btn--icon btn--sm ${a.memo ? 'is-on' : ''}`) : ''}
    ${mine ? iconBtn('close', '발생 해제', `data-dismiss="${id}" data-name="${name}"`) : ''}
  </span>`;
    }).join('')}
</div>`;
}

/* ============================== 탭2 업무프로세스 (매뉴얼) ============================== */

/**
 * 트리 노드 → 화면 VM. 프로세스 모양 { item, no, rows(체크항목), subs(하위 프로세스), situations }
 * 순번(no)은 같은 상위 안의 프로세스 순서다.
 */
function treeToVM(node, no) {
    const vm = { item: node.item, no, rows: [], subs: [], situations: [] };
    let subNo = 0;
    node.children.forEach((c) => {
        if (c.item.kind === CHECK_KIND.CHECK) vm.rows.push(c.item);
        else if (c.item.kind === CHECK_KIND.SITUATION) vm.situations.push(treeToSitVM(c));
        else {
            subNo += 1;
            vm.subs.push(treeToVM(c, subNo));
        }
    });
    return vm;
}

function treeToSitVM(node) {
    const vm = { item: node.item, rows: [], subs: [] };
    let subNo = 0;
    node.children.forEach((c) => {
        if (c.item.kind === CHECK_KIND.CHECK) vm.rows.push(c.item);
        else if (c.item.kind === CHECK_KIND.PROCESS) {
            subNo += 1;
            vm.subs.push(treeToVM(c, subNo));
        }
    });
    return vm;
}

/** 업무항목 노드 한 그루 → { item, processes, loose } */
function groupVM(tree) {
    const processes = [];
    const loose = [];
    let no = 0;
    tree.children.forEach((c) => {
        if (c.item.kind === CHECK_KIND.CHECK) loose.push(c.item);
        else if (c.item.kind === CHECK_KIND.PROCESS) {
            no += 1;
            processes.push(treeToVM(c, no));
        }
    });
    return { item: tree.item, processes, loose };
}

/** 담당자 표시 - 정담당자 · 부담당자(여러 명) */
function whoHtml(it) {
    const subs = it.sub_assignees ?? [];
    if (!it.assignee_name && !subs.length) return '';
    return `<span class="pm-who">${icon('account', 'icon icon--sm')}${esc(it.assignee_name)}${subs.length
        ? `<small>부 ${esc(subs.map((s) => s.name).join(', '))}</small>` : ''}</span>`;
}

/** 편집 도구 - 드래그 손잡이 (편집 모드에서만 보인다) */
function gripHtml() {
    return `<span class="pm-tools"><span class="pm-grip" title="끌어서 순서 바꾸기"
        >${icon('menu', 'icon icon--sm')}</span></span>`;
}

/** 편집 도구 - 속성 열기 ✎ */
function openBtn(item, what) {
    return `<span class="pm-tools">${iconBtn('edit', `${what} 수정`, `data-open="${esc(item.id)}"`)}</span>`;
}

/** 드래그 정렬 대상 속성 - 같은 상위·같은 종류끼리만 자리를 바꾼다 */
function dragAttr(item, parentId) {
    return `data-item="${esc(item.id)}" data-parent="${esc(parentId)}" data-kind="${esc(item.kind)}"`;
}

/** 일일체크리스트 포함 토글 - 켠 항목만 일일체크리스트에 나온다 */
function dailyToggle(item) {
    return `
<label class="cl-daily ${item.daily ? 'is-on' : ''}" title="일일체크리스트에 포함">
  <input type="checkbox" data-daily="${esc(item.id)}" ${item.daily ? 'checked' : ''}>
  <span>일일</span>
</label>`;
}

/**
 * 빠른 추가 줄 - 「+ 체크항목」 「+ 상황」 … 을 누르면 이름 입력칸이 열리고 Enter 로 바로 등록된다.
 * 등록 뒤에도 입력칸이 열린 채라 연달아 넣을 수 있다 (state.quick).
 */
function quickBar(item, main = false) {
    const kinds = db.allowedChildKinds(item.kind);
    const label = {
        [CHECK_KIND.CHECK]: item.kind === CHECK_KIND.GROUP ? '단독 체크항목' : '체크항목',
        [CHECK_KIND.SITUATION]: '상황',
        [CHECK_KIND.PROCESS]: item.kind === CHECK_KIND.GROUP ? '다음 프로세스'
            : (item.kind === CHECK_KIND.SITUATION ? '대응 프로세스' : '하위 프로세스'),
    };
    return `
<div class="pm-quick ${main ? 'pm-quick--main' : ''}" data-quick-host="${esc(item.id)}">
  ${kinds.map((k) => textBtn('plus', label[k],
        `data-quick="${esc(item.id)}" data-kind="${esc(k)}" data-label="${esc(label[k])}"`,
        `btn btn--sm pm-add ${main && k === CHECK_KIND.PROCESS ? 'btn--primary' : ''}`)).join('')}
</div>`;
}

/** 체크항목 한 줄 */
function checkRow(r, parentId) {
    const subs = r.sub_assignees ?? [];
    const who = `${r.assignee_name ? ` · ${esc(r.assignee_name)}` : ''}${subs.length
        ? ` · 부 ${esc(subs.map((s) => s.name).join(', '))}` : ''}`;
    return `
<div class="pm-check ${r.active === false ? 'is-off' : ''} ${r.daily ? '' : 'is-skip'}" ${dragAttr(r, parentId)}>
  ${gripHtml()}
  ${icon('square', 'icon icon--sm pm-check__box')}
  <span class="pm-check__title">${esc(r.title)}
    ${r.description ? `<small>${esc(r.description)}</small>` : ''}</span>
  <span class="pm-check__meta">${esc(cycleLabel(r))}${who}</span>
  ${r.daily ? '' : '<span class="tag tag--gray pm-skip">일일 제외</span>'}
  ${r.active === false ? '<span class="tag tag--gray">비활성</span>' : ''}
  <span class="pm-tools">${dailyToggle(r)}</span>
  ${openBtn(r, '체크항목')}
</div>`;
}

/** 「처리 후 ③ 입고검수 로 이어집니다」 - 상황 블록 끝 문구 */
function mergeText(next) {
    return next
        ? `처리가 끝나면 <b>${circled(next.no)} ${esc(next.item.title)}</b> 로 이어집니다`
        : '처리가 끝나면 흐름을 마칩니다';
}

/**
 * 상황 블록 - 카드 안의 주황 상자. 「X 발생 시」 → 대응 체크항목·대응 단계 → 처리 후 다음 단계.
 * @param {object} next 이 상황을 처리한 뒤 돌아갈 단계 VM (없으면 null)
 */
function sitHtml(s, parentId, next) {
    const it = s.item;
    return `
<div class="pm-sit ${it.active === false ? 'is-off' : ''}" ${dragAttr(it, parentId)}>
  <div class="pm-sit__head">
    ${gripHtml()}
    ${icon('issues', 'icon icon--sm')}
    <strong>${esc(it.title)} 발생 시</strong>
    ${it.description ? `<small>${esc(it.description)}</small>` : ''}
    ${whoHtml(it)}
    ${it.active === false ? '<span class="tag tag--gray">비활성</span>' : ''}
    <span class="toolbar__spacer"></span>
    ${openBtn(it, '상황')}
  </div>
  ${s.rows.length ? `<div class="pm-checks">${s.rows.map((r) => checkRow(r, it.id)).join('')}</div>` : ''}
  ${s.subs.length ? `<div class="pm-chain">${s.subs.map((p, i) => stepHtml(p, {
        parentId: it.id, next: s.subs[i + 1] ?? null, sub: true, last: i === s.subs.length - 1,
    })).join('')}</div>` : ''}
  ${!s.rows.length && !s.subs.length ? '<p class="pm-note">대응 절차 없음 · 발생 내용만 기록합니다</p>' : ''}
  ${state.edit ? quickBar(it) : ''}
  <div class="pm-sit__merge">${icon('reply', 'icon icon--sm')}${mergeText(next)}</div>
</div>`;
}

/**
 * 단계 카드 - 왼쪽 순번 레일 + 카드(체크항목 · 하위 프로세스 사슬 · 상황 블록 · 빠른 추가).
 * @param {{parentId:string, next:object|null, sub:boolean, last:boolean}} o
 */
function stepHtml(p, o) {
    const it = p.item;
    const leaf = !p.rows.length && !p.subs.length;
    return `
<div class="pm-step ${o.sub ? 'pm-step--sub' : ''} ${o.last ? 'is-last' : ''} ${it.active === false ? 'is-off' : ''}"
     ${dragAttr(it, o.parentId)}>
  <div class="pm-step__rail"><span class="pm-no">${p.no}</span></div>
  <div class="pm-card">
    <div class="pm-card__head">
      ${gripHtml()}
      <span class="pm-card__title">${esc(it.title)}</span>
      ${it.description ? `<span class="pm-card__desc">${esc(it.description)}</span>` : ''}
      ${whoHtml(it)}
      ${it.active === false ? '<span class="tag tag--gray">비활성</span>' : ''}
      ${leaf && !it.daily ? '<span class="tag tag--gray pm-skip">일일 제외</span>' : ''}
      ${leaf ? `<span class="pm-tools">${dailyToggle(it)}</span>` : ''}
      <span class="toolbar__spacer"></span>
      ${openBtn(it, '프로세스')}
    </div>
    ${p.rows.length ? `<div class="pm-checks">${p.rows.map((r) => checkRow(r, it.id)).join('')}</div>` : ''}
    ${leaf ? '<p class="pm-note">체크항목 없음 · 단계 자체를 체크합니다</p>' : ''}
    ${p.subs.length ? `<div class="pm-chain">${p.subs.map((s, i) => stepHtml(s, {
        parentId: it.id, next: p.subs[i + 1] ?? o.next, sub: true, last: i === p.subs.length - 1,
    })).join('')}</div>` : ''}
    ${p.situations.map((s) => sitHtml(s, it.id, o.next)).join('')}
    ${state.edit ? quickBar(it) : ''}
  </div>
</div>`;
}

/** 업무항목 한 벌의 흐름 - 단계 카드 한 줄기 + 단독 업무 + (편집) 다음 프로세스 추가 */
function flowHtml(g) {
    const steps = g.processes;
    if (!steps.length && !g.loose.length && !state.edit) {
        return '<p class="pm-empty">아직 프로세스가 없습니다. 「편집」을 켜고 첫 프로세스 이름을 입력하세요.</p>';
    }
    const parts = steps.map((p, i) => stepHtml(p, {
        parentId: g.item.id, next: steps[i + 1] ?? null, sub: false,
        last: i === steps.length - 1 && !g.loose.length,
    }));
    if (g.loose.length) {
        parts.push(`
<div class="pm-step pm-step--loose is-last">
  <div class="pm-step__rail"><span class="pm-no">${icon('square', 'icon icon--sm')}</span></div>
  <div class="pm-card">
    <div class="pm-card__head">
      <span class="pm-card__title">단독 업무</span>
      <span class="pm-card__desc">흐름과 상관없이 그때그때 하는 일</span>
    </div>
    <div class="pm-checks">${g.loose.map((r) => checkRow(r, g.item.id)).join('')}</div>
  </div>
</div>`);
    }
    return `<div class="pm-flow">${parts.join('')}${state.edit ? quickBar(g.item, true) : ''}</div>`;
}

async function drawManage(body, user, users, reload) {
    const divisions = await db.listChecklistDivisions();
    // 업무구분 없는 옛 업무항목이 있으면 「미분류」 를 마지막에 붙인다 (옮길 수 있게)
    const orphans = await db.listChecklistGroups(null);
    const navDivs = [
        ...divisions,
        ...(orphans.length
            ? [{ id: UNSORTED_ID, title: '미분류', kind: CHECK_KIND.DIVISION, active: true }]
            : []),
    ];
    const groupsBy = {};
    for (const d of navDivs) {
        groupsBy[d.id] = d.id === UNSORTED_ID ? orphans : await db.listChecklistGroups(d.id);
    }
    if (!navDivs.some((d) => d.id === state.division)) state.division = navDivs[0]?.id ?? null;
    const division = navDivs.find((d) => d.id === state.division) ?? null;
    const isUnsorted = division?.id === UNSORTED_ID;
    const groups = division ? groupsBy[division.id] : [];
    if (!groups.some((g) => g.id === state.group)) state.group = groups[0]?.id ?? null;
    const group = groups.find((g) => g.id === state.group) ?? null;
    const rows = group
        ? await db.listChecklistItems({ root: group.id, includeInactive: true })
        : [];
    const tree = group ? db.checklistTree(rows)[0] : null;
    const gvm = tree ? groupVM(tree) : null;
    const templates = (division && !isUnsorted ? Object.keys(CHECK_TEMPLATES) : [])
        .filter((name) => !groups.some((g) => g.title === name));
    const allGroups = Object.values(groupsBy).flat();
    const findItem = (id) => rows.find((r) => r.id === id)
        ?? allGroups.find((g) => g.id === id)
        ?? divisions.find((d) => d.id === id);

    body.className = `card__body cl-manage ${state.edit ? 'is-edit' : ''}`;
    body.innerHTML = `
<div class="pm">
  <aside class="pm-nav">
    <div class="pm-nav__head">
      <span>업무구분 › 업무항목</span>
      <span class="toolbar__spacer"></span>
      <span class="pm-tools">${textBtn('plus', '업무구분', 'id="btn-add-division"', 'btn btn--sm btn--primary')}</span>
    </div>
    ${navDivs.map((d) => `
    <div class="pm-nav__div ${d.id === state.division ? 'is-active' : ''} ${d.active ? '' : 'is-off'}">
      <button class="pm-nav__divbtn" type="button" data-nav-div="${esc(d.id)}">
        ${icon('checklist', 'icon icon--sm')}<span>${esc(d.title)}</span>
        <small>${num(groupsBy[d.id].length)}</small></button>
      ${d.id === UNSORTED_ID ? '' : openBtn(d, '업무구분')}
    </div>
    <div class="pm-nav__grps">
      ${groupsBy[d.id].map((g) => `
      <button class="pm-nav__grp ${g.id === state.group ? 'is-active' : ''} ${g.active ? '' : 'is-off'}"
              type="button" data-nav-grp="${esc(g.id)}" data-nav-in="${esc(d.id)}">${esc(g.title)}</button>`).join('')}
      ${d.id === UNSORTED_ID ? '' : `<span class="pm-tools">${textBtn('plus', '업무항목',
        `data-add="${esc(d.id)}" data-kind="${CHECK_KIND.GROUP}"`, 'btn btn--sm pm-add pm-nav__add')}</span>`}
    </div>`).join('')}
    ${navDivs.length ? '' : '<p class="pm-nav__empty">업무구분이 없습니다.<br>「편집」을 켜고 업무구분을 추가하세요.</p>'}
  </aside>
  <section class="pm-main">
    <header class="pm-head">
      ${group ? `
      <span class="pm-head__crumb">${esc(division.title)} ›</span>
      <strong class="pm-head__title">${esc(group.title)}</strong>
      ${group.description ? `<span class="pm-head__desc">${esc(group.description)}</span>` : ''}
      ${whoHtml(group)}
      ${group.active ? '' : '<span class="tag tag--gray">비활성</span>'}
      ${openBtn(group, '업무항목')}
      <span class="pm-tools">${textBtn('sheet', '복제', `data-dup="${esc(group.id)}"`)}</span>`
        : `<span class="pm-head__desc">${division
            ? (isUnsorted ? '업무구분이 정해지지 않은 업무항목입니다. ✎ 로 업무구분을 고르세요'
                : '왼쪽에서 업무항목을 고르거나 「업무항목」 을 추가하세요')
            : '왼쪽에서 업무구분을 추가해 시작하세요'}</span>`}
      <div class="pm-head__actions">
        ${templates.map((name) => `<span class="pm-tools">${textBtn('checklist', `견본: ${name}`, `data-seed="${esc(name)}"`)}</span>`).join('')}
        <button class="btn btn--sm ${state.edit ? 'btn--primary' : ''}" type="button" id="btn-edit">
          ${icon('edit', 'icon icon--sm')}<span>${state.edit ? '편집 끝' : '편집'}</span></button>
        ${group ? textBtn('sheet', '인쇄', 'id="btn-print"') : ''}
      </div>
    </header>
    ${state.edit && group ? `
    <p class="pm-guide">
      위에서 아래로가 업무 순서입니다. 카드의 ${icon('menu', 'icon icon--sm')} 를 끌어 순서를 바꾸고,
      ${icon('edit', 'icon icon--sm')} 로 이름·담당자·주기를 고칩니다.
      「+ 체크항목」 「+ 상황」 은 이름을 적고 Enter 만 누르면 바로 들어갑니다.
    </p>` : ''}
    ${gvm ? flowHtml(gvm) : ''}
  </section>
</div>`;

    body.querySelectorAll('[data-nav-div]').forEach((el) => {
        el.addEventListener('click', () => {
            if (state.division === el.dataset.navDiv) return;
            state.division = el.dataset.navDiv;
            state.group = null;
            state.quick = null;
            reload();
        });
    });
    body.querySelectorAll('[data-nav-grp]').forEach((el) => {
        el.addEventListener('click', () => {
            state.division = el.dataset.navIn;
            state.group = el.dataset.navGrp;
            state.quick = null;
            reload();
        });
    });
    body.querySelector('#btn-edit').addEventListener('click', () => {
        state.edit = !state.edit;
        state.quick = null;
        reload();
    });
    body.querySelector('#btn-print')?.addEventListener('click', () => {
        document.body.classList.add('cl-printing');
        const off = () => {
            document.body.classList.remove('cl-printing');
            window.removeEventListener('afterprint', off);
        };
        window.addEventListener('afterprint', off);
        window.print();
    });

    /**
     * 속성 모달 - 종류별 폼 + 삭제 · 순서(↑↓). 등록(item 없음)과 수정(item 있음)이 같은 폼을 쓴다.
     * @param {{item?:object, parentId?:string|null, kind:string}} o
     */
    function openForm({ item = null, parentId = null, kind }) {
        const parent = parentId ? findItem(parentId) : null;
        const label = CHECK_KINDS[kind];
        const m = openModal(`${label} ${item ? '수정' : '추가'}`,
            formHtml(item, kind, parent, users, divisions), {
                footer: `
<div class="pm-mfoot">
  ${item ? `
  <button class="btn btn--sm btn--danger" type="button" data-del>${icon('trash', 'icon icon--sm')}<span>삭제</span></button>
  <span class="pm-mfoot__order">순서
    ${iconBtn('up', '순서 위로', 'data-move="up"')}
    ${iconBtn('down', '순서 아래로', 'data-move="down"')}</span>` : ''}
  <span class="toolbar__spacer"></span>
  <button class="btn btn--sm" type="button" data-cancel>취소</button>
  <button class="btn btn--sm btn--primary" type="submit" form="pm-form">${icon('save', 'icon icon--sm')}<span>저장</span></button>
</div>`,
            });
        const form = m.body.querySelector('form');
        const sync = () => {
            if (!form.elements.cycle) return;
            const cycle = form.elements.cycle.value;
            form.querySelector('[data-when="weekly"]').hidden = cycle !== CHECK_CYCLE.WEEKLY;
            form.querySelector('[data-when="monthly"]').hidden = cycle !== CHECK_CYCLE.MONTHLY;
        };
        form.elements.cycle?.addEventListener('change', sync);
        sync();
        form.elements.title.focus();
        m.root.querySelector('[data-cancel]').addEventListener('click', m.close);

        // 부담당자 - 「+」 로 줄을 더하고 ✕ 로 뺀다 (줄은 동적으로 생기므로 폼에 위임)
        form.querySelector('[data-add-sub]').addEventListener('click', () => {
            form.querySelector('[data-subs]')
                .insertAdjacentHTML('beforeend', subRowHtml(users, ''));
            form.querySelector('[data-subs] .cl-subs__row:last-child select').focus();
        });
        form.addEventListener('click', (e) => {
            const del = e.target.closest('[data-del-sub]');
            if (del) del.closest('.cl-subs__row').remove();
        });

        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const f = new FormData(form);
            const payload = {
                kind,
                title: f.get('title'),
                description: f.get('description'),
                cycle: f.get('cycle') ?? CHECK_CYCLE.DAILY,
                weekday: Number(f.get('weekday') ?? 1),
                monthday: Number(f.get('monthday') ?? 1),
                assignee_id: f.get('assignee_id') || null,
                sub_assignee_ids: f.getAll('sub_assignee_ids').filter(Boolean),
                active: f.get('active') === 'on',
                daily: f.get('daily') === 'on',
                // 업무항목은 폼에서 업무구분을 고른다 (수정 시 다른 업무구분으로 옮길 수 있다)
                parent_id: kind === CHECK_KIND.GROUP && f.has('parent_id')
                    ? (f.get('parent_id') || null) : (parentId ?? null),
            };
            try {
                if (item) {
                    await db.updateChecklistItem(item.id, payload, user);
                    if (kind === CHECK_KIND.GROUP && payload.parent_id) {
                        state.division = payload.parent_id;
                    }
                } else {
                    const made = await db.createChecklistItem(payload, user);
                    if (kind === CHECK_KIND.DIVISION) state.division = made.id;
                    if (kind === CHECK_KIND.GROUP) {
                        state.division = payload.parent_id ?? UNSORTED_ID;
                        state.group = made.id;
                    }
                }
                toast(item ? '수정했습니다.' : '등록했습니다.', 'success');
                m.close();
                await reload();
            } catch (err) {
                toast(err.message, 'error');
            }
        });
        m.root.querySelectorAll('[data-move]').forEach((el) => {
            el.addEventListener('click', async () => {
                try {
                    await db.moveChecklistItem(item.id, el.dataset.move, user);
                    await reload();
                } catch (err) {
                    toast(err.message, 'error');
                }
            });
        });
        m.root.querySelector('[data-del]')?.addEventListener('click', async () => {
            const kids = item.kind === CHECK_KIND.DIVISION || item.kind === CHECK_KIND.GROUP
                ? (await db.listChecklistItems({ root: item.id, includeInactive: true })).length - 1
                : countDescendants(rows, item.id);
            const msg = kids
                ? `${label} 「${item.title}」 아래 항목 ${kids}개도 함께 삭제됩니다. 계속할까요?`
                : `${label} 「${item.title}」을(를) 삭제할까요?`;
            if (!(await confirmDialog(msg))) return;
            try {
                await db.deleteChecklistItem(item.id, user);
                toast('삭제했습니다.', 'success');
                m.close();
                await reload();
            } catch (err) {
                toast(err.message, 'error');
            }
        });
    }

    body.querySelector('#btn-add-division')
        .addEventListener('click', () => openForm({ kind: CHECK_KIND.DIVISION }));
    body.querySelectorAll('[data-add]').forEach((el) => {
        el.addEventListener('click', () => {
            openForm({ parentId: el.dataset.add, kind: el.dataset.kind });
        });
    });
    body.querySelectorAll('[data-open]').forEach((el) => {
        el.addEventListener('click', () => {
            const item = findItem(el.dataset.open);
            openForm({ item, parentId: item.parent_id, kind: item.kind });
        });
    });
    body.querySelector('[data-dup]')?.addEventListener('click', async () => {
        const msg = `「${group.title}」 을(를) 프로세스·상황·체크항목까지 통째로 복제할까요?`;
        if (!(await confirmDialog(msg))) return;
        try {
            const r = await db.duplicateChecklistGroup(group.id, user);
            state.group = r.group.id;
            toast(`「${r.group.title}」 으로 항목 ${num(r.count)}개를 복제했습니다.`, 'success');
            await reload();
        } catch (err) {
            toast(err.message, 'error');
        }
    });
    body.querySelectorAll('[data-seed]').forEach((el) => {
        el.addEventListener('click', async () => {
            const name = el.dataset.seed;
            const msg = `「${division.title}」 아래에 「${name}」 견본 업무항목을 만들까요?\n`
                + '만든 뒤 자유롭게 고칠 수 있습니다.';
            if (!(await confirmDialog(msg))) return;
            try {
                const r = await db.seedChecklistTemplate(name, division.id, user);
                state.group = r.group.id;
                toast(`항목 ${num(r.count)}개를 등록했습니다.`, 'success');
                await reload();
            } catch (err) {
                toast(err.message, 'error');
            }
        });
    });
    body.querySelectorAll('[data-daily]').forEach((el) => {
        el.addEventListener('change', async () => {
            try {
                await db.updateChecklistItem(el.dataset.daily, { daily: el.checked }, user);
                await reload();
            } catch (err) {
                el.checked = !el.checked;
                toast(err.message, 'error');
            }
        });
    });

    /* ---- 빠른 추가: 이름 입력 후 Enter. 등록 뒤에도 입력칸을 열어 둔다 ---- */
    function openQuick(hostId, kind, label) {
        const bar = body.querySelector(`[data-quick-host="${hostId}"]`);
        if (!bar) return;
        state.quick = { hostId, kind, label };
        bar.innerHTML = `
<form class="pm-quick__form">
  <span class="tag tag--blue">${esc(label)}</span>
  <input type="text" name="title" maxlength="100" autocomplete="off"
         placeholder="이름을 입력하고 Enter (Esc 로 닫기)">
  <button class="btn btn--sm btn--primary" type="submit">추가</button>
  ${iconBtn('close', '닫기', 'data-quick-close')}
</form>`;
        const form = bar.querySelector('form');
        const input = form.elements.title;
        input.focus();
        const closeQuick = () => {
            state.quick = null;
            reload();
        };
        bar.querySelector('[data-quick-close]').addEventListener('click', closeQuick);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeQuick();
        });
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const title = input.value.trim();
            if (!title) return;
            try {
                await db.createChecklistItem({
                    kind, title, parent_id: hostId, daily: kind === CHECK_KIND.CHECK,
                }, user);
                toast(`「${title}」 을(를) 추가했습니다.`, 'success');
                await reload();          // state.quick 이 남아 있어 같은 자리에 입력칸이 다시 열린다
            } catch (err) {
                toast(err.message, 'error');
            }
        });
    }
    body.querySelectorAll('[data-quick]').forEach((el) => {
        el.addEventListener('click', () => {
            openQuick(el.dataset.quick, el.dataset.kind, el.dataset.label);
        });
    });
    if (state.quick && body.querySelector(`[data-quick-host="${state.quick.hostId}"]`)) {
        openQuick(state.quick.hostId, state.quick.kind, state.quick.label);
    } else {
        state.quick = null;
    }

    if (state.edit) bindDrag(body, user, reload);
}

/**
 * 드래그 정렬 - 손잡이(pm-grip)를 잡아야 끌린다 (입력칸 글자 선택과 부딪히지 않게).
 * 같은 상위(data-parent)·같은 종류(data-kind) 사이에서만 놓을 수 있다.
 */
function bindDrag(body, user, reload) {
    let drag = null;
    const clearMarks = () => body.querySelectorAll('.is-drop-before, .is-drop-after')
        .forEach((x) => x.classList.remove('is-drop-before', 'is-drop-after'));
    const before = (el, e) => {
        const r = el.getBoundingClientRect();
        return e.clientY < r.top + r.height / 2;
    };

    body.querySelectorAll('.pm-grip').forEach((grip) => {
        const el = grip.closest('[data-item]');
        grip.addEventListener('mousedown', () => el.setAttribute('draggable', 'true'));
        grip.addEventListener('touchstart', () => el.setAttribute('draggable', 'true'),
            { passive: true });
    });

    body.querySelectorAll('[data-item][data-parent]').forEach((el) => {
        el.addEventListener('dragstart', (e) => {
            if (el.getAttribute('draggable') !== 'true') return;
            e.stopPropagation();
            drag = { id: el.dataset.item, parent: el.dataset.parent, kind: el.dataset.kind };
            el.classList.add('is-dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', el.dataset.item);
        });
        el.addEventListener('dragend', () => {
            el.classList.remove('is-dragging');
            el.removeAttribute('draggable');
            clearMarks();
            drag = null;
        });
        const accepts = () => drag && drag.id !== el.dataset.item
            && drag.parent === el.dataset.parent && drag.kind === el.dataset.kind;
        el.addEventListener('dragover', (e) => {
            if (!accepts()) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'move';
            clearMarks();
            el.classList.add(before(el, e) ? 'is-drop-before' : 'is-drop-after');
        });
        el.addEventListener('drop', async (e) => {
            if (!accepts()) return;
            e.preventDefault();
            e.stopPropagation();
            const isBefore = before(el, e);
            const sel = `[data-item][data-parent="${drag.parent}"][data-kind="${drag.kind}"]`;
            const ids = [...body.querySelectorAll(sel)].map((x) => x.dataset.item)
                .filter((id) => id !== drag.id);
            const at = ids.indexOf(el.dataset.item);
            ids.splice(isBefore ? at : at + 1, 0, drag.id);
            const parentId = drag.parent;
            clearMarks();
            try {
                await db.reorderChecklistItems(parentId, ids, user);
                await reload();
            } catch (err) {
                toast(err.message, 'error');
            }
        });
    });
}

/** 하위 항목 수 (자기 제외) */
function countDescendants(rows, id) {
    return rows.filter((r) => r.parent_id === id)
        .reduce((n, r) => n + 1 + countDescendants(rows, r.id), 0);
}

/** 부담당자 한 줄 - 사용자 선택 + 빼기 */
function subRowHtml(users, curId) {
    return `
<div class="cl-subs__row">
  <select name="sub_assignee_ids">
    <option value="">선택</option>
    ${users.map((u) => `
    <option value="${esc(u.id)}" ${u.id === curId ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}
  </select>
  ${iconBtn('close', '부담당자 빼기', 'data-del-sub')}
</div>`;
}

/** 속성 폼 - 종류에 따라 필드가 다르다 (등록·수정 같은 마크업). 모달 안에 세로로 놓인다 */
function formHtml(item, kind, parent, users, divisions = []) {
    const cycle = item?.cycle ?? CHECK_CYCLE.DAILY;
    const isCheck = kind === CHECK_KIND.CHECK;
    const isSit = kind === CHECK_KIND.SITUATION;
    const isGroup = kind === CHECK_KIND.GROUP;
    const titleLabel = {
        division: '업무구분 이름', group: '업무항목 이름', process: '프로세스명',
        situation: '상황명', check: '항목명',
    }[kind];
    const descLabel = {
        division: '설명', group: '설명', process: '설명',
        situation: '어떤 때인지 (대응 요령)', check: '설명',
    }[kind];
    const placeholder = {
        division: '예: 입고, 출고, 반품', group: '예: B2B출고, B2C출고',
        process: '예: 입고검수', situation: '예: 입고수량오류', check: '예: LOT 확인',
    }[kind] ?? '';
    const curParent = parent?.id ?? '';
    return `
<form class="cl-form" id="pm-form">
  ${parent && !isGroup ? `<p class="cl-form__parent">${esc(CHECK_KINDS[parent.kind])} 「${esc(parent.title)}」 아래</p>` : ''}
  <label class="field field--full">
    <span class="field__label">${esc(titleLabel)} *</span>
    <input type="text" name="title" required maxlength="100" value="${esc(item?.title ?? '')}"
           placeholder="${esc(placeholder)}">
  </label>
  ${isGroup ? `
  <label class="field field--full">
    <span class="field__label">업무구분</span>
    <select name="parent_id" ${divisions.length ? 'required' : ''}>
      ${curParent ? '' : '<option value="">미분류</option>'}
      ${divisions.map((d) => `
      <option value="${esc(d.id)}" ${d.id === curParent ? 'selected' : ''}>${esc(d.title)}</option>`).join('')}
    </select>
  </label>` : ''}
  <label class="field field--full">
    <span class="field__label">${esc(descLabel)}</span>
    <input type="text" name="description" maxlength="200"
           value="${esc(item?.description ?? '')}">
  </label>
  ${isCheck ? `
  <label class="field">
    <span class="field__label">주기</span>
    <select name="cycle">
      ${Object.entries(CHECK_CYCLES).map(([k, v]) => `
      <option value="${esc(k)}" ${k === cycle ? 'selected' : ''}>${esc(v)}</option>`).join('')}
    </select>
  </label>
  <label class="field" data-when="weekly">
    <span class="field__label">요일</span>
    <select name="weekday">
      ${WEEKDAYS.map((w, i) => `
      <option value="${i}" ${i === Number(item?.weekday ?? 1) ? 'selected' : ''}
        >${esc(w)}</option>`).join('')}
    </select>
  </label>
  <label class="field" data-when="monthly">
    <span class="field__label">일자</span>
    <input type="number" name="monthday" min="1" max="31" value="${Number(item?.monthday ?? 1)}">
  </label>` : ''}
  <label class="field">
    <span class="field__label">정담당자${isSit || isCheck ? '' : ' (아래 항목이 따릅니다)'}</span>
    <select name="assignee_id">
      <option value="">${parent || isGroup ? '상위 담당 따름' : '공통'}</option>
      ${users.map((u) => `
      <option value="${esc(u.id)}" ${u.id === item?.assignee_id ? 'selected' : ''}
        >${esc(u.name)}</option>`).join('')}
    </select>
  </label>
  <div class="field">
    <span class="field__label">부담당자 (여러 명 · 정담당자 대신 체크할 수 있습니다)</span>
    <div class="cl-subs" data-subs>
      ${(item?.sub_assignees ?? []).map((s) => subRowHtml(users, s.id)).join('')}
    </div>
    ${textBtn('plus', '부담당자 추가', 'data-add-sub', 'btn btn--sm pm-add')}
  </div>
  <div class="cl-form__checks">
    ${isCheck || kind === CHECK_KIND.PROCESS ? `
    <label class="check" title="${isCheck ? '켜면 일일체크리스트에 나옵니다' : '체크항목이 없는 단계일 때 단계 자체를 일일체크리스트에 넣습니다'}">
      <input type="checkbox" name="daily" ${item ? (item.daily ? 'checked' : '') : (isCheck ? 'checked' : '')}>
      <span>일일체크리스트 포함</span>
    </label>` : ''}
    <label class="check">
      <input type="checkbox" name="active" ${item?.active === false ? '' : 'checked'}>
      <span>활성</span>
    </label>
  </div>
</form>`;
}
