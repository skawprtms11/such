/**
 * 업무체크리스트 화면.
 *
 *   탭1 일일체크리스트 - 업무프로세스 탭에서 지정한 **체크항목만** 표(업무항목 · 프로세스 ·
 *                      체크리스트)로 보고 항목마다 완료 체크한다. 상황(입고수량오류 등)은
 *                      프로세스 줄 아래 칩으로 「발생」 처리하면 대응 절차의 체크항목이
 *                      그 아래 줄로 끼어든다
 *   탭2 업무프로세스   - 구조도(보드) 위에서 업무항목 → 프로세스 → 체크항목/상황 → 대응 프로세스를
 *                      등록·정렬·수정한다 (manageChecklist). 업무항목은 사용자가 만든다
 *
 * 주기·담당자 상속·상황 발생 판정은 화면이 하지 않는다. db.dailyTable() · db.canCheckItem()
 * 이 준 결과만 그린다 (docs/checklist.md). 앱 화면(mobile/screens/checklist.js)도 같다.
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
    group: null,                       // 업무프로세스 탭에서 보고 있는 업무항목 id
};

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
    return db.subscribe(guarded);
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

    body.innerHTML = `
<div class="toolbar">
  <div class="cl-datenav">
    ${iconBtn('back', '이전 날짜', 'id="btn-prev"')}
    <input type="date" id="f-date" value="${esc(state.date)}" aria-label="날짜">
    ${iconBtn('next', '다음 날짜', 'id="btn-next"')}
    <button class="btn btn--sm" id="btn-today" type="button">오늘</button>
  </div>
  <label class="field" style="flex:0 0 180px">
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
  <div class="toolbar__spacer"></div>
  <div class="cl-progress">
    <span class="cl-progress__num">${num(sum.done)} / ${num(sum.total)}</span>
    <div class="bar"><div class="bar__fill ${pct === 100 ? 'is-done' : ''}"
      style="width:${pct}%"></div></div>
  </div>
  ${sum.raised ? `<span class="tag tag--amber">상황 발생 ${num(sum.raised)}건</span>` : ''}
  ${sum.missed ? `
  <button class="btn btn--sm cl-missed" id="btn-missed" type="button"
    >어제 미체크 ${num(sum.missed)}건</button>` : ''}
</div>
${table.groups.length ? `
<div class="table-wrap">
  <table class="grid dl">
    <thead>
      <tr>
        <th class="dl__c-group">업무항목</th>
        <th class="dl__c-proc">프로세스</th>
        <th class="dl__c-check"></th>
        <th>체크리스트</th>
        <th class="dl__c-done">완료</th>
        <th class="dl__c-memo"></th>
      </tr>
    </thead>
    <tbody>${table.groups.map((g) => groupRows(g, user)).join('')}</tbody>
  </table>
</div>` : '<p class="empty">이 날짜에 해야 할 항목이 없습니다.</p>'}`;

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
    body.querySelector('#btn-missed')?.addEventListener('click', () => {
        state.date = sum.prevDate;
        reload();
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

/** 구간 하나가 차지하는 줄 수 (체크항목 줄 + 상황 칩 줄) */
function sectionSpan(sec) {
    return sec.rows.length + (sec.situations.length ? 1 : 0);
}

/** 업무항목 한 묶음의 표 줄들 - 업무항목·프로세스 칸은 rowspan 으로 한 번만 쓴다 */
function groupRows(g, user) {
    const span = g.sections.reduce((n, s) => n + sectionSpan(s), 0);
    if (!span) return '';
    const allDone = g.total > 0 && g.done === g.total;
    const groupCell = `
<td class="dl__group" rowspan="${span}">
  <span class="dl__group-name">${esc(g.name)}</span>
  <span class="tag ${allDone ? 'tag--green' : 'tag--gray'}">${num(g.done)} / ${num(g.total)}</span>
</td>`;
    let first = true;
    return g.sections.map((sec) => {
        const html = sectionRows(sec, user, first ? groupCell : '');
        first = false;
        return html;
    }).join('');
}

/** 구간(프로세스) 하나의 줄들 - 프로세스 칸은 첫 줄에만 rowspan 으로 */
function sectionRows(sec, user, groupCell) {
    const span = sectionSpan(sec);
    const done = sec.rows.filter((r) => r.check).length;
    const inSit = !!sec.sit;
    const procCell = `
<td class="dl__proc ${inSit ? 'is-sit' : ''}" rowspan="${span}">
  ${sec.path.length ? pathHtml(sec.path, sec.sit) : '<span class="dl__proc-name">단독 업무</span>'}
  ${sec.rows.length ? `<span class="dl__proc-cnt">${num(done)} / ${num(sec.rows.length)}</span>` : ''}
</td>`;
    const lines = sec.rows.map((r, i) => `
<tr class="dl__row ${r.check ? 'is-done' : ''} ${inSit ? 'is-sit' : ''}">
  ${i === 0 ? groupCell : ''}
  ${i === 0 ? procCell : ''}
  ${itemCells(r, user)}
</tr>`);
    if (sec.situations.length) {
        lines.push(`
<tr class="dl__sitrow">
  ${sec.rows.length ? '' : groupCell}
  ${sec.rows.length ? '' : procCell}
  <td colspan="4">${sitChips(sec.situations, user)}</td>
</tr>`);
    }
    return lines.join('');
}

/** 프로세스 경로 - `상위 › 하위`. 상황 아래 구간이면 상황명을 주황으로 */
function pathHtml(path, sit) {
    return path.map((name, i) => {
        const isSit = sit && name === sit.title;
        const last = i === path.length - 1;
        const cls = isSit ? 'dl__proc-sit' : (last ? 'dl__proc-name' : 'dl__proc-parent');
        const mark = isSit ? icon('issues', 'icon icon--sm') : '';
        return `<span class="${cls}">${mark}${esc(name)}</span>`;
    }).join('<span class="dl__proc-sep">›</span>');
}

/** 체크항목 줄의 셀들 - 체크 · 체크리스트 · 완료 · 메모 */
function itemCells(r, user) {
    const locked = !db.canCheckItem(user, r);
    const done = !!r.check;
    const isStep = r.kind === CHECK_KIND.PROCESS;
    const meta = `${isStep ? '' : `${esc(cycleLabel(r))} · `}${esc(r.assignee_eff_name || '공통')}`;
    const doneAt = done
        ? `${esc(fmtDateTime(r.check.checked_at).slice(11))} ${esc(r.check.checked_by_name)}`
        : '';
    return `
  <td class="dl__c-check">
    <input type="checkbox" data-check="${esc(r.id)}" ${done ? 'checked' : ''}
           ${locked ? 'disabled' : ''} aria-label="${esc(r.title)}">
  </td>
  <td class="dl__item ${locked ? 'is-locked' : ''}" data-title="${esc(r.id)}">
    ${isStep ? '<span class="dl__item-step">단계 완료</span>' : ''}
    <span class="dl__item-title">${esc(r.title)}</span>
    ${r.description ? `<span class="dl__item-desc">${esc(r.description)}</span>` : ''}
    <span class="dl__item-meta">${meta}</span>
  </td>
  <td class="dl__c-done">${done ? `<span class="dl__done">${doneAt}</span>` : ''}</td>
  <td class="dl__c-memo">${iconBtn('memo', r.check?.memo ? `메모: ${r.check.memo}` : '메모',
        `data-memo="${esc(r.id)}"`, `btn btn--icon btn--sm ${r.check?.memo ? 'is-on' : ''}`)}</td>`;
}

/** 프로세스에 달린 상황 칩 줄 - 발생 전은 점선 「발생」, 발생하면 주황 실선 + 내용·해제 */
function sitChips(situations, user) {
    return `
<div class="dl__sits">
  <span class="dl__sits-label">${icon('issues', 'icon icon--sm')}상황</span>
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

/* ============================== 탭2 업무프로세스 (구조도 보드) ============================== */

/**
 * 보드가 그리는 프로세스 VM 모양
 *   { item, no, rows, subs, situations: [{ item, rows, subs }] }
 * 트리를 이 모양으로 바꿔 넣는다 (treeToVM).
 */

/** 구조도 보드 - 프로세스 카드가 세로로 이어지고(화살표), 상황은 카드 오른쪽 분기 칸에 놓인다 */
function boardHtml(g) {
    const rows = g.processes.map((p, i) => `
${i ? '<div class="fb-link"></div>' : ''}
<div class="fb-row">
  <div class="fb-main">${procCardHtml(p, false)}</div>
  ${branchHtml(p.situations)}
</div>`);
    if (g.loose.length) {
        rows.push(`
${rows.length ? '<div class="fb-link fb-link--dashed"></div>' : ''}
<div class="fb-row">
  <div class="fb-main">
    <div class="fb-card fb-card--loose">
      <div class="fb-card__head"><span class="fb-card__title">단독 업무</span>
        <span class="fb-card__desc">흐름 없이 그때그때 하는 일</span></div>
      <div class="fb-card__body">${g.loose.map(rowHtml).join('')}</div>
    </div>
  </div>
</div>`);
    }
    if (!rows.length) return '<p class="empty">아직 프로세스가 없습니다. 「프로세스 추가」로 시작하세요.</p>';
    return `<div class="fb">${rows.join('')}</div>`;
}

/** 상황 분기 칸 - 프로세스 카드 오른쪽. 상황이 없으면 비운다 */
function branchHtml(situations) {
    if (!situations.length) return '';
    return `<div class="fb-branch">${situations.map(sitCardHtml).join('')}</div>`;
}

/** 프로세스 카드 - 안에 체크항목, 하위 프로세스 사슬(fb-chain), 추가 버튼이 들어간다 */
function procCardHtml(p, sub) {
    const inactive = p.item.active === false;
    const who = p.item.assignee_name
        ? `<span class="fb-card__who">${icon('account', 'icon icon--sm')}${esc(p.item.assignee_name)}</span>`
        : '';
    return `
<div class="fb-card fb-card--proc ${sub ? 'fb-card--sub' : ''} ${inactive ? 'is-off' : ''}"
     data-proc="${esc(p.item.id)}">
  <div class="fb-card__head">
    <span class="fb-no">${sub ? `${icon('forward', 'icon icon--sm')}${p.no}` : p.no}</span>
    <span class="fb-card__title">${esc(p.item.title)}</span>
    ${p.item.description ? `<span class="fb-card__desc">${esc(p.item.description)}</span>` : ''}
    ${who}
    ${inactive ? '<span class="tag tag--gray">비활성</span>' : ''}
    ${!p.rows.length && !p.subs.length ? dailyToggle(p.item) : ''}
    <span class="toolbar__spacer"></span>${toolsHtml(p.item)}
  </div>
  <div data-slot="${esc(p.item.id)}"></div>
  <div class="fb-card__body">
    ${!p.rows.length && !p.subs.length
        ? '<p class="fb-card__empty">체크항목이 없으면 단계 자체를 체크합니다 (「일일」 로 포함 여부 지정)</p>' : ''}
    ${p.rows.map(rowHtml).join('')}
    ${p.subs.length ? `
    <div class="fb-chain">
      ${p.subs.map((s, i) => `
      ${i ? '<div class="fb-link fb-link--sm"></div>' : ''}
      <div class="fb-row fb-row--sub">
        <div class="fb-main">${procCardHtml(s, true)}</div>
        ${branchHtml(s.situations)}
      </div>`).join('')}
    </div>` : ''}
    <div class="fb-card__add">${addButtons(p.item)}</div>
  </div>
</div>`;
}

/** 상황 카드 - 프로세스 카드 오른쪽 분기 칸. 대응 프로세스·체크항목 편집 도구가 붙는다 */
function sitCardHtml(s) {
    const inactive = s.item.active === false;
    return `
<div class="fb-card fb-card--sit ${inactive ? 'is-off' : ''}">
  <div class="fb-card__head">
    <span class="fb-no fb-no--sit">${icon('issues', 'icon icon--sm')}</span>
    <span class="fb-card__title">${esc(s.item.title)}</span>
    ${inactive ? '<span class="tag tag--gray">비활성</span>' : ''}
    <span class="toolbar__spacer"></span>
    ${toolsHtml(s.item)}
  </div>
  <div data-slot="${esc(s.item.id)}"></div>
  ${s.item.description ? `<p class="fb-card__desc fb-card__desc--block">${esc(s.item.description)}</p>` : ''}
  <div class="fb-card__body">
    ${s.rows.map(rowHtml).join('')}
    ${s.subs.length ? `
    <div class="fb-chain">
      ${s.subs.map((p, i) => `
      ${i ? '<div class="fb-link fb-link--sm"></div>' : ''}
      <div class="fb-row fb-row--sub"><div class="fb-main">${procCardHtml(p, true)}</div></div>`).join('')}
    </div>` : ''}
    ${!s.rows.length && !s.subs.length ? '<p class="fb-card__empty">대응 절차를 추가하세요</p>' : ''}
    <div class="fb-card__add">${addButtons(s.item)}</div>
  </div>
</div>`;
}

/** 일일체크리스트 포함 토글 - 켠 항목만 일일체크리스트에 나온다 */
function dailyToggle(item) {
    return `
<label class="cl-daily ${item.daily ? 'is-on' : ''}" title="일일체크리스트에 포함">
  <input type="checkbox" data-daily="${esc(item.id)}" ${item.daily ? 'checked' : ''}>
  <span>일일</span>
</label>`;
}

/** 체크항목 한 줄 (편집 도구 포함) */
function rowHtml(r) {
    return `
<div class="cl-item cl-item--edit ${r.active === false ? 'is-off' : ''} ${r.daily ? '' : 'is-skip'}">
  ${dailyToggle(r)}
  <span class="cl-item__title">${esc(r.title)}
    ${r.description ? `<span class="cl-item__desc">${esc(r.description)}</span>` : ''}</span>
  <span class="cl-item__cycle">${esc(cycleLabel(r))}</span>
  <span class="cl-item__who">${esc(r.assignee_name || '')}</span>
  ${r.active === false ? '<span class="tag tag--gray">비활성</span>' : ''}
  ${toolsHtml(r)}
</div>
<div data-slot="${esc(r.id)}"></div>`;
}

/** 트리 노드를 보드 VM(프로세스 모양)으로 바꾼다 */
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
    const groups = await db.listChecklistGroups();
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
    const templates = Object.keys(CHECK_TEMPLATES)
        .filter((name) => !groups.some((g) => g.title === name));

    body.innerHTML = `
<div class="cl-gbar">
  <div class="cl-gtabs" role="tablist">
    ${groups.map((g) => `
    <button class="cl-gtab ${g.id === state.group ? 'is-active' : ''} ${g.active ? '' : 'is-off'}"
            type="button" role="tab" data-group="${esc(g.id)}">
      ${icon('checklist', 'icon icon--sm')}<span>${esc(g.title)}</span></button>`).join('')}
    ${groups.length ? '' : '<span class="cl-gtabs__empty">업무항목이 없습니다. 오른쪽 「업무항목 추가」로 시작하세요.</span>'}
  </div>
  <div class="cl-gbar__actions">
    ${templates.map((name) => textBtn('checklist', `견본: ${name}`, `data-seed="${esc(name)}"`)).join('')}
    ${textBtn('plus', '업무항목 추가', 'id="btn-add-group"', 'btn btn--primary btn--sm')}
  </div>
</div>
<div data-slot="root"></div>
${group ? `
<div class="cl-ghead">
  <span class="cl-kind cl-kind--group">${icon('checklist', 'icon icon--sm')}</span>
  <strong class="cl-ghead__title">${esc(group.title)}</strong>
  ${group.description ? `<span class="cl-ghead__desc">${esc(group.description)}</span>` : ''}
  ${group.assignee_name ? `<span class="fb-card__who">${icon('account', 'icon icon--sm')}${esc(group.assignee_name)}</span>` : ''}
  ${group.active ? '' : '<span class="tag tag--gray">비활성</span>'}
  ${iconBtn('up', '업무항목 순서 위로', `data-move="${esc(group.id)}" data-dir="up"`)}
  ${iconBtn('down', '업무항목 순서 아래로', `data-move="${esc(group.id)}" data-dir="down"`)}
  ${iconBtn('edit', '업무항목 수정', `data-edit="${esc(group.id)}"`)}
  ${iconBtn('trash', '업무항목 삭제', `data-del="${esc(group.id)}"`, 'btn btn--icon btn--sm btn--danger')}
  <span class="toolbar__spacer"></span>
  ${textBtn('plus', '프로세스 추가', `data-add="${esc(group.id)}" data-kind="${CHECK_KIND.PROCESS}"`, 'btn btn--primary btn--sm')}
  ${textBtn('plus', '단독 체크항목', `data-add="${esc(group.id)}" data-kind="${CHECK_KIND.CHECK}"`)}
</div>
<div data-slot="${esc(group.id)}"></div>
<p class="cl-guide">
  <span class="fb-no">1</span> 프로세스 카드는 위에서 아래로 업무 순서이고,
  <span class="fb-no fb-no--sit">${icon('issues', 'icon icon--sm')}</span> 상황은 카드 오른쪽 분기에 놓입니다.
  체크항목 앞의 <span class="cl-daily is-on"><span>일일</span></span> 을 켠 것만 일일체크리스트에 나옵니다.
  담당자를 비우면 상위(프로세스 → 업무항목)의 담당자를 따릅니다.
</p>
${boardHtml(gvm)}` : ''}`;

    body.querySelectorAll('[data-group]').forEach((el) => {
        el.addEventListener('click', () => {
            state.group = el.dataset.group;
            reload();
        });
    });

    /** 슬롯에 인라인 폼을 연다. slotId 는 부모 노드 id 또는 'root' */
    function openForm(slotId, item, parentId, kind) {
        body.querySelectorAll('[data-slot]').forEach((s) => { s.innerHTML = ''; });
        const slot = body.querySelector(`[data-slot="${slotId}"]`);
        if (!slot) return;
        const parent = parentId
            ? (rows.find((r) => r.id === parentId) ?? groups.find((g) => g.id === parentId))
            : null;
        slot.innerHTML = formHtml(item, kind, parent, users);
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
                parent_id: parentId ?? null,
            };
            try {
                if (item) await db.updateChecklistItem(item.id, payload, user);
                else {
                    const made = await db.createChecklistItem(payload, user);
                    if (kind === CHECK_KIND.GROUP) state.group = made.id;
                }
                toast(item ? '수정했습니다.' : '등록했습니다.', 'success');
                await reload();
            } catch (err) {
                toast(err.message, 'error');
            }
        });
    }

    body.querySelector('#btn-add-group')
        .addEventListener('click', () => openForm('root', null, null, CHECK_KIND.GROUP));
    body.querySelectorAll('[data-seed]').forEach((el) => {
        el.addEventListener('click', async () => {
            const name = el.dataset.seed;
            const msg = `「${name}」 견본 업무항목을 만들까요?\n만든 뒤 자유롭게 고칠 수 있습니다.`;
            if (!(await confirmDialog(msg))) return;
            try {
                const r = await db.seedChecklistTemplate(name, user);
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
                ?? groups.find((g) => g.id === el.dataset.edit);
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
                ?? groups.find((g) => g.id === el.dataset.del);
            const kids = countDescendants(rows, item.id);
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

/** 순서·수정·삭제 도구 (업무프로세스 탭) */
function toolsHtml(item) {
    return `
  ${iconBtn('up', '위로', `data-move="${esc(item.id)}" data-dir="up"`)}
  ${iconBtn('down', '아래로', `data-move="${esc(item.id)}" data-dir="down"`)}
  ${iconBtn('edit', '수정', `data-edit="${esc(item.id)}"`)}
  ${iconBtn('trash', '삭제', `data-del="${esc(item.id)}"`, 'btn btn--icon btn--sm btn--danger')}`;
}

/** 인라인 편집 폼 - 종류에 따라 필드가 다르다 (등록·수정 같은 마크업) */
function formHtml(item, kind, parent, users) {
    const cycle = item?.cycle ?? CHECK_CYCLE.DAILY;
    const isCheck = kind === CHECK_KIND.CHECK;
    const isSit = kind === CHECK_KIND.SITUATION;
    const titleLabel = {
        group: '업무항목 이름', process: '프로세스명', situation: '상황명', check: '항목명',
    }[kind];
    const descLabel = {
        group: '설명', process: '설명', situation: '어떤 때인지 (대응 요령)', check: '설명',
    }[kind];
    return `
<form class="cl-form">
  <div class="cl-form__head">
    <span class="tag tag--blue">${esc(CHECK_KINDS[kind])} ${item ? '수정' : '추가'}</span>
    ${parent ? `<span class="cl-form__parent">${esc(CHECK_KINDS[parent.kind])} 「${esc(parent.title)}」 아래</span>` : ''}
  </div>
  <label class="field">
    <span class="field__label">${esc(titleLabel)} *</span>
    <input type="text" name="title" required maxlength="100" value="${esc(item?.title ?? '')}"
           placeholder="${kind === CHECK_KIND.GROUP ? '예: 입고, 출고, 반품' : ''}">
  </label>
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
      <option value="">${parent ? '상위 담당 따름' : '공통'}</option>
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
