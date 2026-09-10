/**
 * 업무체크리스트 화면.
 *
 *   탭1 일일체크리스트 - **오늘 내가 빠뜨리면 안 되는 것**을 훑고 체크하는 목록.
 *                      업무구분·업무항목은 계층 머리글, 줄은 체크항목 하나. 미완료 먼저,
 *                      완료는 접는다. 어제 밀린 항목은 줄 안에 표시한다. 상황(입고수량오류 등)은
 *                      프로세스 줄 뒤 칩으로 「발생」 처리하면 대응 항목이 아래 줄로 끼어든다
 *   탭2 업무프로세스   - **매뉴얼처럼 읽는 플로우차트.** 업무구분 → 업무항목을 고르면 시작 → 프로세스
 *                      박스 → 판단 마름모(상황 발생?) → 분기 레인(대응 단계) → 합류 → 완료.
 *                      개요/상세 두 배율, 편집 모드(도구는 이때만), 인쇄
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
    esc, num, rate, toast, today, addDays, fmtDateTime, confirmDialog, promptDialog,
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
    detail: false,                     // 업무프로세스: 상세(체크항목 펼침) 배율
    edit: false,                       // 업무프로세스: 편집 모드 (도구 표시)
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
        if (body.querySelector('.cl-form')) return;
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
  <span class="dq-row__who">${esc(r.assignee_eff_name || '공통')}</span>
  <span class="dq-row__at">${doneAt}</span>
  ${iconBtn('memo', r.check?.memo ? `메모: ${r.check.memo}` : '메모',
        `data-memo="${esc(r.id)}"`, `btn btn--icon btn--sm ${r.check?.memo ? 'is-on' : ''}`)}
</div>`;
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

/* ============================== 탭2 업무프로세스 (플로우차트) ============================== */

/**
 * 플로우차트 - 업무항목 한 벌. 가운데 줄기(시작 → 프로세스 → 완료)에 상황마다
 * 판단 마름모를 두고, 「예」 는 오른쪽 분기 레인(대응 단계) → 합류, 「아니오」 는 아래로.
 * 편집 도구(fc-tools)는 편집 모드에서만 보인다 (.cl-manage.is-edit).
 * @param {{item, processes:Array, loose:Array}} g treeToVM 으로 만든 업무항목 VM
 */
function flowHtml(g) {
    if (!g.processes.length && !g.loose.length) {
        return '<p class="empty">아직 프로세스가 없습니다. 편집 모드에서 「프로세스 추가」로 시작하세요.</p>';
    }
    const parts = [];
    // 상황 분기 뒤에는 「아니오」 화살표가 이미 다음 단계를 가리키므로 화살표를 또 그리지 않는다
    let needArrow = false;
    g.processes.forEach((p) => {
        if (needArrow) parts.push('<div class="fc-row"><div class="fc-arrow"></div></div>');
        parts.push(`<div class="fc-row">${stepHtml(p, false)}</div>`);
        const isLast = p === g.processes.at(-1) && !g.loose.length;
        p.situations.forEach((s, i) => {
            parts.push(branchHtml(s, i === 0, isLast && i === p.situations.length - 1));
        });
        needArrow = !p.situations.length;
    });
    if (g.loose.length) {
        if (needArrow) parts.push('<div class="fc-row"><div class="fc-arrow"></div></div>');
        parts.push(`
<div class="fc-row">
  <div class="fc-step fc-loose">
    <div class="fc-step__head"><span class="fc-step__title">단독 업무</span>
      <span class="fc-step__desc">흐름 없이 그때그때 하는 일</span></div>
    <div class="fc-step__sum">체크 ${num(g.loose.length)}</div>
    <div class="fc-step__body">${g.loose.map(editRow).join('')}</div>
  </div>
</div>`);
    }
    return `<div class="fc ${state.detail || state.edit ? 'is-detail' : ''}">${parts.join('')}</div>
<div class="fc-legend">
  <span><i></i>프로세스 (체크항목 수 · 담당)</span>
  <span><i class="dia"></i>판단 — 상황 발생?</span>
  <span><i class="dash"></i>분기 레인 — 대응 단계, 끝나면 합류</span>
</div>`;
}

/** 프로세스 박스 - 개요는 요약 한 줄, 상세는 체크항목 목록. 하위 프로세스는 안쪽 사슬 */
function stepHtml(p, sub) {
    const it = p.item;
    const inactive = it.active === false;
    const leaf = !p.rows.length && !p.subs.length;
    const who = it.assignee_name
        ? `<span class="fb-card__who">${icon('account', 'icon icon--sm')}${esc(it.assignee_name)}</span>`
        : '';
    const sum = [
        p.rows.length ? `체크 ${num(p.rows.length)}` : (leaf ? '단계 완료 체크' : ''),
        p.subs.length ? `하위 ${num(p.subs.length)}` : '',
        p.situations.length ? `상황 ${num(p.situations.length)}` : '',
    ].filter(Boolean).join(' · ');
    return `
<div class="fc-step ${sub ? 'fc-step--sub' : ''} ${inactive ? 'is-off' : ''}" data-proc="${esc(it.id)}">
  <div class="fc-step__head">
    <span class="fb-no">${sub ? `${icon('forward', 'icon icon--sm')}${p.no}` : p.no}</span>
    <span class="fc-step__title">${esc(it.title)}</span>
    ${it.description ? `<span class="fc-step__desc">${esc(it.description)}</span>` : ''}
    ${who}
    ${inactive ? '<span class="tag tag--gray">비활성</span>' : ''}
    ${leaf ? `<span class="fc-tools">${dailyToggle(it)}</span>` : ''}
    <span class="toolbar__spacer"></span>
    <span class="fc-tools">${toolsHtml(it)}</span>
  </div>
  <div data-slot="${esc(it.id)}"></div>
  <div class="fc-step__sum">${esc(sum)}</div>
  <div class="fc-step__body">
    ${p.rows.map(editRow).join('')}
    ${p.subs.length ? `
    <div class="fc-sub">
      ${p.subs.map((s, i) => `
      ${i ? '<div class="fc-arrow fc-arrow--sm"></div>' : ''}
      ${stepHtml(s, true)}
      ${s.situations.map(subBranchHtml).join('')}`).join('')}
    </div>` : ''}
    <div class="fc-tools fc-add">${addButtons(it)}</div>
  </div>
</div>`;
}

/**
 * 판단 마름모 + 분기 레인 한 단 (최상위 프로세스의 상황).
 * first 가 아니면 앞 상황의 「아니오」 화살표가 이미 있어 앞 화살표를 빼고,
 * last 면 아래로 가는 「아니오」 화살표를 뺀다 (뒤에 단계가 없다)
 */
function branchHtml(s, first = true, last = false) {
    return `
${first ? '<div class="fc-row"><div class="fc-arrow"></div></div>' : ''}
<div class="fc-row fc-branch">
  <div class="fc-branch__main">
    <div class="fc-diamond"><span>${esc(s.item.title)}<br>발생?</span></div>
    <span class="fc-branch__yes"></span>
  </div>
  ${laneHtml(s)}
</div>
${last ? '' : '<div class="fc-row"><div class="fc-arrow fc-arrow--no"></div></div>'}`;
}

/** 카드 안 하위 프로세스의 상황 - 옆에 둘 자리가 없어 아래에 레인만 붙인다 */
function subBranchHtml(s) {
    return `
<div class="fc-arrow fc-arrow--sm"></div>
<div class="fc-lane fc-lane--inline ${s.item.active === false ? 'is-off' : ''}">
  ${laneInner(s, true)}
</div>`;
}

/** 분기 레인 - 상황 설명, 대응 단계 사슬, 합류 표시 */
function laneHtml(s) {
    return `<div class="fc-lane ${s.item.active === false ? 'is-off' : ''}">${laneInner(s, false)}</div>`;
}

function laneInner(s, inline) {
    const it = s.item;
    return `
  <div class="fc-lane__head">
    ${icon('issues', 'icon icon--sm')}${inline ? `${esc(it.title)} 발생 시` : `${esc(it.title)} 발생 시`}
    ${it.description ? `<small>${esc(it.description)}</small>` : ''}
    ${it.active === false ? '<span class="tag tag--gray">비활성</span>' : ''}
    <span class="toolbar__spacer"></span>
    <span class="fc-tools">${toolsHtml(it)}</span>
  </div>
  <div data-slot="${esc(it.id)}"></div>
  ${s.rows.length ? `<div class="fc-step__body" style="display:block">${s.rows.map(editRow).join('')}</div>` : ''}
  ${s.subs.map((p, i) => `
  ${i ? '<div class="fc-arrow fc-arrow--sm"></div>' : '<div class="fc-arrow fc-arrow--sm"></div>'}
  ${stepHtml(p, true)}`).join('')}
  ${!s.rows.length && !s.subs.length ? '<p class="fb-card__empty">대응 절차 없음 · 발생 내용만 기록</p>' : ''}
  <div class="fc-tools fc-add">${addButtons(it)}</div>
  <div class="fc-lane__merge">↩ 다음 단계로 합류</div>`;
}

/** 일일체크리스트 포함 토글 - 켠 항목만 일일체크리스트에 나온다 */
function dailyToggle(item) {
    return `
<label class="cl-daily ${item.daily ? 'is-on' : ''}" title="일일체크리스트에 포함">
  <input type="checkbox" data-daily="${esc(item.id)}" ${item.daily ? 'checked' : ''}>
  <span>일일</span>
</label>`;
}

/** 체크항목 한 줄 (플로우차트 상세 · 편집 도구는 편집 모드에서만) */
function editRow(r) {
    return `
<div class="cl-item cl-item--edit ${r.active === false ? 'is-off' : ''} ${r.daily ? '' : 'is-skip'}">
  <span class="fc-tools">${dailyToggle(r)}</span>
  <span class="cl-kind cl-kind--check">${icon('square', 'icon icon--sm')}</span>
  <span class="cl-item__title">${esc(r.title)}
    ${r.description ? `<span class="cl-item__desc">${esc(r.description)}</span>` : ''}</span>
  <span class="cl-item__cycle">${esc(cycleLabel(r))}${r.daily ? '' : ' · 일일 제외'}</span>
  <span class="cl-item__who">${esc(r.assignee_name || '')}</span>
  ${r.active === false ? '<span class="tag tag--gray">비활성</span>' : ''}
  <span class="fc-tools">${toolsHtml(r)}</span>
</div>
<div data-slot="${esc(r.id)}"></div>`;
}

/** 트리 노드를 플로우차트 VM(프로세스 모양)으로 바꾼다 */
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

async function drawManage(body, user, users, reload) {
    const divisions = await db.listChecklistDivisions();
    // 업무구분 없는 옛 업무항목이 있으면 「미분류」 탭을 마지막에 붙인다 (옮길 수 있게)
    const orphans = await db.listChecklistGroups(null);
    const divTabs = [
        ...divisions,
        ...(orphans.length
            ? [{ id: UNSORTED_ID, title: '미분류', kind: CHECK_KIND.DIVISION, active: true }]
            : []),
    ];
    if (!divTabs.some((d) => d.id === state.division)) state.division = divTabs[0]?.id ?? null;
    const division = divTabs.find((d) => d.id === state.division) ?? null;
    const isUnsorted = division?.id === UNSORTED_ID;

    let groups = [];
    if (division) groups = isUnsorted ? orphans : await db.listChecklistGroups(division.id);
    if (!groups.some((g) => g.id === state.group)) state.group = groups[0]?.id ?? null;
    const group = groups.find((g) => g.id === state.group) ?? null;
    const rows = group
        ? await db.listChecklistItems({ root: group.id, includeInactive: true })
        : [];
    const tree = group ? db.checklistTree(rows)[0] : null;    // 업무항목 노드 한 그루
    let gvm = null;
    if (tree) {
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
        gvm = { item: tree.item, processes, loose };
    }
    const templates = (division && !isUnsorted ? Object.keys(CHECK_TEMPLATES) : [])
        .filter((name) => !groups.some((g) => g.title === name));
    const who = (it) => (it.assignee_name
        ? `<span class="fb-card__who">${icon('account', 'icon icon--sm')}${esc(it.assignee_name)}</span>`
        : '');

    body.className = `card__body cl-manage ${state.edit ? 'is-edit' : ''}`;
    body.innerHTML = `
<div class="cl-gbar cl-gbar--div">
  <div class="cl-gtabs" role="tablist">
    <span class="cl-gtabs__label">업무구분</span>
    ${divTabs.map((d) => `
    <button class="cl-gtab cl-gtab--div ${d.id === state.division ? 'is-active' : ''} ${d.active ? '' : 'is-off'}"
            type="button" role="tab" data-division="${esc(d.id)}">${esc(d.title)}</button>`).join('')}
    ${divTabs.length ? '' : '<span class="cl-gtabs__empty">업무구분이 없습니다. 편집 모드에서 「업무구분 추가」로 시작하세요.</span>'}
  </div>
  <div class="cl-gbar__actions">
    ${segHtml('seg-zoom', [['over', '개요'], ['detail', '상세']], state.detail || state.edit ? 'detail' : 'over')}
    <button class="btn btn--sm ${state.edit ? 'btn--primary' : ''}" type="button" id="btn-edit">
      ${icon('edit', 'icon icon--sm')}<span>${state.edit ? '편집 끝' : '편집'}</span></button>
    ${group ? textBtn('sheet', '인쇄', 'id="btn-print"') : ''}
    <span class="fc-tools">${textBtn('plus', '업무구분 추가', 'id="btn-add-division"', 'btn btn--primary btn--sm')}</span>
  </div>
</div>
<div data-slot="root"></div>
${division ? `
<div class="cl-ghead cl-ghead--div">
  <span class="cl-kind cl-kind--div">${icon('checklist', 'icon icon--sm')}</span>
  <strong class="cl-ghead__title">${esc(division.title)}</strong>
  ${isUnsorted ? '<span class="cl-ghead__desc">업무구분이 정해지지 않은 업무항목 — 편집 모드의 수정에서 업무구분을 고르세요</span>' : `
  ${division.description ? `<span class="cl-ghead__desc">${esc(division.description)}</span>` : ''}
  ${who(division)}
  ${division.active ? '' : '<span class="tag tag--gray">비활성</span>'}
  <span class="fc-tools">${toolsHtml(division, '업무구분')}</span>`}
  <span class="toolbar__spacer"></span>
  ${isUnsorted ? '' : `<span class="fc-tools">
  ${templates.map((name) => textBtn('checklist', `견본: ${name}`, `data-seed="${esc(name)}"`)).join('')}
  ${textBtn('plus', '업무항목 추가', `data-add="${esc(division.id)}" data-kind="${CHECK_KIND.GROUP}"`, 'btn btn--primary btn--sm')}</span>`}
</div>
${isUnsorted ? '' : `<div data-slot="${esc(division.id)}"></div>`}
<div class="cl-gbar">
  <div class="cl-gtabs" role="tablist">
    <span class="cl-gtabs__label">업무항목</span>
    ${groups.map((g) => `
    <button class="cl-gtab ${g.id === state.group ? 'is-active' : ''} ${g.active ? '' : 'is-off'}"
            type="button" role="tab" data-group="${esc(g.id)}">
      ${icon('checklist', 'icon icon--sm')}<span>${esc(g.title)}</span></button>`).join('')}
    ${groups.length ? '' : '<span class="cl-gtabs__empty">이 업무구분에 업무항목이 없습니다. 편집 모드에서 「업무항목 추가」 또는 견본으로 시작하세요.</span>'}
  </div>
</div>` : ''}
${group ? `
<div class="cl-ghead cl-print-keep">
  <span class="cl-kind cl-kind--group">${icon('checklist', 'icon icon--sm')}</span>
  <span class="cl-ghead__crumb">${esc(division.title)} ›</span>
  <strong class="cl-ghead__title">${esc(group.title)}</strong>
  ${group.description ? `<span class="cl-ghead__desc">${esc(group.description)}</span>` : ''}
  ${who(group)}
  ${group.active ? '' : '<span class="tag tag--gray">비활성</span>'}
  <span class="fc-tools">
    ${toolsHtml(group, '업무항목')}
    ${textBtn('sheet', '복제', `data-dup="${esc(group.id)}"`)}
  </span>
  <span class="toolbar__spacer"></span>
  <span class="fc-tools">
  ${textBtn('plus', '프로세스 추가', `data-add="${esc(group.id)}" data-kind="${CHECK_KIND.PROCESS}"`, 'btn btn--primary btn--sm')}
  ${textBtn('plus', '단독 체크항목', `data-add="${esc(group.id)}" data-kind="${CHECK_KIND.CHECK}"`)}
  </span>
</div>
<div data-slot="${esc(group.id)}"></div>
${state.edit ? `
<p class="cl-guide">
  프로세스 박스의 순서가 업무 순서입니다. 상황은 프로세스에 달아 두면 「발생?」 판단과 분기 레인으로 그려집니다.
  체크항목 앞의 <span class="cl-daily is-on"><span>일일</span></span> 을 켠 것만 일일체크리스트에 나옵니다.
  담당자를 비우면 상위(프로세스 → 업무항목 → 업무구분)의 담당자를 따릅니다.
</p>` : ''}
${flowHtml(gvm)}` : ''}`;

    body.querySelectorAll('[data-division]').forEach((el) => {
        el.addEventListener('click', () => {
            state.division = el.dataset.division;
            state.group = null;
            reload();
        });
    });
    body.querySelectorAll('[data-group]').forEach((el) => {
        el.addEventListener('click', () => {
            state.group = el.dataset.group;
            reload();
        });
    });
    body.querySelectorAll('#seg-zoom [data-seg]').forEach((el) => {
        el.addEventListener('click', () => {
            state.detail = el.dataset.seg === 'detail';
            if (!state.detail) state.edit = false;      // 개요로 돌아가면 편집도 끝난다
            reload();
        });
    });
    body.querySelector('#btn-edit').addEventListener('click', () => {
        state.edit = !state.edit;
        if (state.edit) state.detail = true;
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

    /** 슬롯에 인라인 폼을 연다. slotId 는 부모 노드 id 또는 'root' */
    function openForm(slotId, item, parentId, kind) {
        body.querySelectorAll('[data-slot]').forEach((s) => { s.innerHTML = ''; });
        const slot = body.querySelector(`[data-slot="${slotId}"]`);
        if (!slot) return;
        const parent = parentId
            ? (rows.find((r) => r.id === parentId) ?? groups.find((g) => g.id === parentId)
                ?? divisions.find((d) => d.id === parentId))
            : null;
        slot.innerHTML = formHtml(item, kind, parent, users, divisions);
        const form = slot.querySelector('form');

        const sync = () => {
            if (!form.elements.cycle) return;
            const cycle = form.elements.cycle.value;
            form.querySelector('[data-when="weekly"]').hidden = cycle !== CHECK_CYCLE.WEEKLY;
            form.querySelector('[data-when="monthly"]').hidden = cycle !== CHECK_CYCLE.MONTHLY;
        };
        form.elements.cycle?.addEventListener('change', sync);
        sync();
        form.elements.title.focus();

        form.querySelector('[data-cancel]').addEventListener('click', () => {
            slot.innerHTML = '';
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
                    if (kind === CHECK_KIND.GROUP) state.group = made.id;
                }
                toast(item ? '수정했습니다.' : '등록했습니다.', 'success');
                await reload();
            } catch (err) {
                toast(err.message, 'error');
            }
        });
    }

    body.querySelector('#btn-add-division')
        .addEventListener('click', () => openForm('root', null, null, CHECK_KIND.DIVISION));
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
    body.querySelectorAll('[data-add]').forEach((el) => {
        el.addEventListener('click', () => {
            openForm(el.dataset.add, null, el.dataset.add, el.dataset.kind);
        });
    });
    body.querySelectorAll('[data-edit]').forEach((el) => {
        el.addEventListener('click', () => {
            const item = rows.find((r) => r.id === el.dataset.edit)
                ?? groups.find((g) => g.id === el.dataset.edit)
                ?? divisions.find((d) => d.id === el.dataset.edit);
            openForm(item.id, item, item.parent_id, item.kind);
        });
    });
    body.querySelectorAll('[data-move]').forEach((el) => {
        el.addEventListener('click', async () => {
            try {
                await db.moveChecklistItem(el.dataset.move, el.dataset.dir, user);
                await reload();
            } catch (err) {
                toast(err.message, 'error');
            }
        });
    });
    body.querySelectorAll('[data-del]').forEach((el) => {
        el.addEventListener('click', async () => {
            const item = rows.find((r) => r.id === el.dataset.del)
                ?? groups.find((g) => g.id === el.dataset.del)
                ?? divisions.find((d) => d.id === el.dataset.del);
            const kids = item.kind === CHECK_KIND.DIVISION
                ? (await db.listChecklistItems({ root: item.id, includeInactive: true })).length - 1
                : countDescendants(rows, item.id);
            const label = CHECK_KINDS[item.kind];
            const msg = kids
                ? `${label} 「${item.title}」 아래 항목 ${kids}개도 함께 삭제됩니다. 계속할까요?`
                : `${label} 「${item.title}」을(를) 삭제할까요?`;
            if (!(await confirmDialog(msg))) return;
            try {
                await db.deleteChecklistItem(item.id, user);
                toast('삭제했습니다.', 'success');
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

/** 이 노드 아래에 추가할 수 있는 종류 버튼들 */
function addButtons(item) {
    const kinds = db.allowedChildKinds(item.kind);
    const label = {
        [CHECK_KIND.CHECK]: '체크항목',
        [CHECK_KIND.SITUATION]: '상황',
        [CHECK_KIND.PROCESS]: item.kind === CHECK_KIND.SITUATION ? '대응 프로세스' : '하위 프로세스',
    };
    return kinds.map((k) => textBtn('plus', label[k],
        `data-add="${esc(item.id)}" data-kind="${esc(k)}"`, 'btn btn--sm btn--ghost')).join('');
}

/** 순서·수정·삭제 도구 (편집 모드) */
function toolsHtml(item, what = '') {
    const w = what ? `${what} ` : '';
    return `
  ${iconBtn('up', `${w}순서 위로`, `data-move="${esc(item.id)}" data-dir="up"`)}
  ${iconBtn('down', `${w}순서 아래로`, `data-move="${esc(item.id)}" data-dir="down"`)}
  ${iconBtn('edit', `${w}수정`, `data-edit="${esc(item.id)}"`)}
  ${iconBtn('trash', `${w}삭제`, `data-del="${esc(item.id)}"`, 'btn btn--icon btn--sm btn--danger')}`;
}

/** 인라인 편집 폼 - 종류에 따라 필드가 다르다 (등록·수정 같은 마크업) */
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
    }[kind] ?? '';
    const curParent = parent?.id ?? '';
    return `
<form class="cl-form">
  <div class="cl-form__head">
    <span class="tag tag--blue">${esc(CHECK_KINDS[kind])} ${item ? '수정' : '추가'}</span>
    ${parent && !isGroup ? `<span class="cl-form__parent">${esc(CHECK_KINDS[parent.kind])} 「${esc(parent.title)}」 아래</span>` : ''}
  </div>
  <label class="field">
    <span class="field__label">${esc(titleLabel)} *</span>
    <input type="text" name="title" required maxlength="100" value="${esc(item?.title ?? '')}"
           placeholder="${esc(placeholder)}">
  </label>
  ${isGroup ? `
  <label class="field" style="flex:0 0 160px">
    <span class="field__label">업무구분</span>
    <select name="parent_id" ${divisions.length ? 'required' : ''}>
      ${curParent ? '' : '<option value="">미분류</option>'}
      ${divisions.map((d) => `
      <option value="${esc(d.id)}" ${d.id === curParent ? 'selected' : ''}>${esc(d.title)}</option>`).join('')}
    </select>
  </label>` : ''}
  <label class="field">
    <span class="field__label">${esc(descLabel)}</span>
    <input type="text" name="description" maxlength="200"
           value="${esc(item?.description ?? '')}">
  </label>
  ${isCheck ? `
  <label class="field" style="flex:0 0 110px">
    <span class="field__label">주기</span>
    <select name="cycle">
      ${Object.entries(CHECK_CYCLES).map(([k, v]) => `
      <option value="${esc(k)}" ${k === cycle ? 'selected' : ''}>${esc(v)}</option>`).join('')}
    </select>
  </label>
  <label class="field" data-when="weekly" style="flex:0 0 90px">
    <span class="field__label">요일</span>
    <select name="weekday">
      ${WEEKDAYS.map((w, i) => `
      <option value="${i}" ${i === Number(item?.weekday ?? 1) ? 'selected' : ''}
        >${esc(w)}</option>`).join('')}
    </select>
  </label>
  <label class="field" data-when="monthly" style="flex:0 0 90px">
    <span class="field__label">일자</span>
    <input type="number" name="monthday" min="1" max="31" value="${Number(item?.monthday ?? 1)}">
  </label>` : ''}
  <label class="field" style="flex:0 0 160px">
    <span class="field__label">담당자${isSit || isCheck ? '' : ' (기본)'}</span>
    <select name="assignee_id">
      <option value="">${parent || isGroup ? '상위 담당 따름' : '공통'}</option>
      ${users.map((u) => `
      <option value="${esc(u.id)}" ${u.id === item?.assignee_id ? 'selected' : ''}
        >${esc(u.name)}</option>`).join('')}
    </select>
  </label>
  ${isCheck || kind === CHECK_KIND.PROCESS ? `
  <label class="check" title="${isCheck ? '켜면 일일체크리스트에 나옵니다' : '체크항목이 없는 단계일 때 단계 자체를 일일체크리스트에 넣습니다'}">
    <input type="checkbox" name="daily" ${item ? (item.daily ? 'checked' : '') : (isCheck ? 'checked' : '')}>
    <span>일일체크리스트 포함</span>
  </label>` : ''}
  <label class="check">
    <input type="checkbox" name="active" ${item?.active === false ? '' : 'checked'}>
    <span>활성</span>
  </label>
  <span class="toolbar__spacer"></span>
  ${iconBtn('close', '취소', 'data-cancel')}
  <button class="btn btn--icon btn--sm btn--primary" type="submit"
          aria-label="저장" title="저장">${icon('save', 'icon icon--sm')}</button>
</form>`;
}
